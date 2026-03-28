type BridgeRichContentToken =
  | {
      kind: 'html';
      html: string;
    }
  | {
      kind: 'image';
      src: string;
      alt?: string;
    };

type BridgeView = Window & typeof globalThis;

const IMAGE_FETCH_MESSAGE_TIMEOUT_MS = 45_000;
const IMAGE_FETCH_MAX_ATTEMPTS = 2;
const IMAGE_FALLBACK_CLICK_MAX = 12;
const IMAGE_PROXY_ENDPOINT = 'https://read.useai.online/api/image-proxy?url=';
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_MIN_BYTES = 32;

function normalizeProxyImageUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const outer = new URL(value);
    const isProxy = outer.hostname.toLowerCase() === 'read.useai.online' && outer.pathname.startsWith('/api/image-proxy');
    if (!isProxy) return outer.toString();
    const innerRaw = String(outer.searchParams.get('url') || '').trim();
    if (!innerRaw) return outer.toString();
    try {
      const inner = new URL(innerRaw);
      if (inner.hash) inner.hash = '';
      outer.searchParams.set('url', inner.toString());
      return outer.toString();
    } catch {
      return outer.toString();
    }
  } catch {
    return value;
  }
}

function buildDirectFetchCandidates(rawUrl: string): string[] {
  const input = normalizeProxyImageUrl(rawUrl);
  if (!input) return [];
  const out: string[] = [];

  const push = (url: string) => {
    const v = String(url || '').trim();
    if (!v) return;
    if (!out.includes(v)) out.push(v);
  };

  try {
    const u = new URL(input);
    const isProxy = u.hostname.toLowerCase() === 'read.useai.online' && u.pathname.startsWith('/api/image-proxy');
    if (isProxy) {
      const innerRaw = String(u.searchParams.get('url') || '').trim();
      if (innerRaw) {
        try {
          const inner = new URL(innerRaw);
          if (inner.protocol === 'http:' && (inner.hostname.toLowerCase().endsWith('.qpic.cn') || inner.hostname.toLowerCase().endsWith('.qlogo.cn'))) {
            inner.protocol = 'https:';
          }
          if (inner.hash) inner.hash = '';
          push(inner.toString());
        } catch {
          // ignore
        }
      }
    }

    push(input);
    if (!isProxy && (u.protocol === 'https:' || u.protocol === 'http:')) {
      push(normalizeProxyImageUrl(`${IMAGE_PROXY_ENDPOINT}${encodeURIComponent(u.toString())}`));
    }
  } catch {
    // ignore
  }

  return out;
}

function looksLikeImageBinary(mimeType: string, buffer: ArrayBuffer, size: number): boolean {
  const mt = String(mimeType || '').toLowerCase();
  const byteLen = Number(size || buffer?.byteLength || 0);
  if (!byteLen || byteLen < IMAGE_MIN_BYTES) return false;

  const head = new Uint8Array(buffer.slice(0, Math.min(16, byteLen)));
  const ascii = (from: number, len: number) => {
    try {
      return String.fromCharCode(...Array.from(head.slice(from, from + len)));
    } catch {
      return '';
    }
  };

  if (mt.includes('png')) {
    if (byteLen < 64) return false;
    return head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  }
  if (mt.includes('jpeg') || mt.includes('jpg')) {
    if (byteLen < 64) return false;
    return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  }
  if (mt.includes('gif')) {
    const sig = ascii(0, 6);
    return sig === 'GIF87a' || sig === 'GIF89a';
  }
  if (mt.includes('webp')) {
    return ascii(0, 4) === 'RIFF' && head.length >= 12 && ascii(8, 4) === 'WEBP';
  }
  if (mt.includes('svg')) {
    return false;
  }

  return byteLen >= 128;
}

async function fetchImageAsFileByDirectFetch(url: string): Promise<File> {
  const candidate = String(url || '').trim();
  if (!candidate) throw new Error('empty image url');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_MESSAGE_TIMEOUT_MS);
  try {
    const res = await fetch(candidate, { credentials: 'omit', signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`direct fetch failed: ${res.status}`);

    const mimeType = String(res.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith('image/')) throw new Error(`direct fetch unexpected content-type: ${mimeType || 'empty'}`);

    const buffer = await res.arrayBuffer();
    const size = Number(buffer?.byteLength || 0);
    if (!size) throw new Error('direct fetch empty image');
    if (size > IMAGE_MAX_BYTES) throw new Error(`direct fetch image too large: ${size}`);
    if (!looksLikeImageBinary(mimeType, buffer, size)) {
      throw new Error(`direct fetch invalid image binary: mime=${mimeType || 'empty'} size=${size}`);
    }

    const ext = pickFileExtension(mimeType);
    return new File([buffer], `image.${ext}`, { type: mimeType });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('direct fetch timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function bridgeViewOf(node: unknown): BridgeView {
  try {
    const n = node as { ownerDocument?: Document | null } | null;
    const doc = n?.ownerDocument || null;
    return (doc?.defaultView || window) as BridgeView;
  } catch {
    return window as BridgeView;
  }
}

function pickFileExtension(mimeType: string): string {
  const mt = String(mimeType || '').toLowerCase();
  if (mt.includes('png')) return 'png';
  if (mt.includes('jpeg') || mt.includes('jpg')) return 'jpg';
  if (mt.includes('webp')) return 'webp';
  if (mt.includes('gif')) return 'gif';
  if (mt.includes('svg')) return 'svg';
  return 'png';
}

function base64ToArrayBuffer(input: string): ArrayBuffer {
  const base64 = String(input || '').trim();
  if (!base64) throw new Error('empty image buffer');
  let binary = '';
  try {
    binary = atob(base64);
  } catch (error) {
    throw new Error(`invalid base64 image buffer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function fetchImageAsFile(jobId: string, url: string): Promise<File> {
  let lastError: unknown = null;
  let bridgeError: unknown = null;
  const normalizedInput = normalizeProxyImageUrl(url);

  for (let attempt = 1; attempt <= IMAGE_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = (await Promise.race([
        chrome.runtime.sendMessage({
          type: V3_FETCH_IMAGE,
          jobId,
          url: normalizedInput,
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('fetch image message timeout')), IMAGE_FETCH_MESSAGE_TIMEOUT_MS);
        }),
      ])) as {
        success?: boolean;
        error?: string;
        mimeType?: string;
        buffer?: ArrayBuffer;
        bufferBase64?: string;
        size?: number;
      };

      if (!res?.success) {
        const reason = String(res?.error || 'fetch image failed');
        throw new Error(`${reason} | imageUrl=${String(normalizedInput || url).slice(0, 320)}`);
      }
      const mimeType = String(res.mimeType || 'image/png');
      const size = Number(res.size || 0);
      const buffer = (() => {
        if (typeof res.bufferBase64 === 'string' && res.bufferBase64.trim()) return base64ToArrayBuffer(res.bufferBase64);
        if (res.buffer instanceof ArrayBuffer) return res.buffer;
        return null;
      })();
      if (!buffer || !size) {
        const keys = (() => {
          try {
            return Object.keys(res || {}).slice(0, 10);
          } catch {
            return [];
          }
        })();
        const base64Len = typeof res.bufferBase64 === 'string' ? res.bufferBase64.length : -1;
        const bufferTag = (() => {
          try {
            return Object.prototype.toString.call(res.buffer);
          } catch {
            return '<unknown>';
          }
        })();
        const bufferKeysSample = (() => {
          try {
            if (!res.buffer || typeof res.buffer !== 'object') return '';
            return Object.keys(res.buffer as unknown as Record<string, unknown>)
              .slice(0, 8)
              .join(',');
          } catch {
            return '';
          }
        })();
        const bufferSample0 = (() => {
          try {
            const anyBuf = res.buffer as unknown as Record<string, unknown>;
            const value = anyBuf?.['0'];
            return typeof value === 'number' ? String(value) : typeof value;
          } catch {
            return '';
          }
        })();
        const bufferByteLength = (() => {
          try {
            return (res.buffer as ArrayBuffer | undefined)?.byteLength || 0;
          } catch {
            return 0;
          }
        })();
        throw new Error(
          `empty image buffer (size=${size} keys=${keys.join(',')} base64Len=${base64Len} bufferTag=${bufferTag} bufferKeys=${bufferKeysSample} buffer0=${bufferSample0} bufferByteLength=${bufferByteLength})`
        );
      }
      if (buffer.byteLength !== size) throw new Error(`invalid image buffer size: ${buffer.byteLength}/${size}`);
      if (!looksLikeImageBinary(mimeType, buffer, size)) {
        throw new Error(`invalid image binary: mime=${mimeType || 'empty'} size=${size}`);
      }
      const ext = pickFileExtension(mimeType);
      return new File([buffer], `image.${ext}`, { type: mimeType });
    } catch (error) {
      lastError = error;
      bridgeError = error;
      if (attempt < IMAGE_FETCH_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 450));
      }
    }
  }

  const fallbackCandidates = buildDirectFetchCandidates(normalizedInput || url);
  const fallbackErrors: string[] = [];
  for (const candidate of fallbackCandidates) {
    try {
      return await fetchImageAsFileByDirectFetch(candidate);
    } catch (error) {
      lastError = error;
      fallbackErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (bridgeError && fallbackErrors.length) {
    throw new Error(
      `fetch image failed (bridge + direct). bridge=${bridgeError instanceof Error ? bridgeError.message : String(bridgeError)} | direct=${fallbackErrors
        .slice(-2)
        .join(' | ')}`
    );
  }
  throw lastError instanceof Error ? lastError : new Error('fetch image failed');
}

function scoreImageFileInput(input: HTMLInputElement, index: number): number {
  const accept = String(input.getAttribute('accept') || '').toLowerCase();
  const name = String(input.getAttribute('name') || '').toLowerCase();
  const id = String(input.id || '').toLowerCase();
  const cls = String(input.className || '').toLowerCase();
  const parentText = String(input.closest('form,section,article,div')?.textContent || '').slice(0, 200).toLowerCase();

  const isImageAccept = accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg') || accept.includes('webp');
  const looksImage = name.includes('image') || id.includes('image') || cls.includes('image') || cls.includes('upload');
  const inImageDialog = parentText.includes('选择图片') || parentText.includes('上传图片') || parentText.includes('插图') || parentText.includes('image');
  const inCoverArea = parentText.includes('封面') || parentText.includes('cover');

  let score = 0;
  if (isImageAccept) score += 10;
  if (looksImage) score += 4;
  if (inImageDialog) score += 6;
  if (inCoverArea) score -= 6;
  score += Math.min(index, 30) * 0.1;
  return score;
}

function findImageFileInputsNear(doc: Document): HTMLInputElement[] {
  const inputs = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  return inputs
    .map((input, index) => ({ input, score: scoreImageFileInput(input, index) }))
    .sort((a, b) => b.score - a.score)
    .map((it) => it.input);
}

async function tryInputsAndWaitInserted(
  inputs: HTMLInputElement[],
  file: File,
  waitInserted: () => Promise<void>
): Promise<boolean> {
  for (const input of inputs) {
    try {
      setFilesToInput(input, [file]);
      await waitInserted();
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

function isVisibleElement(node: Element | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

function findToolbarImageButtons(doc: Document): HTMLElement[] {
  const selectors = [
    'button[aria-label*="图片" i]',
    'button[title*="图片" i]',
    'button[aria-label*="image" i]',
    'button[title*="image" i]',
    'button[aria-label*="上传" i]',
    'button[title*="上传" i]',
    '[role="button"][aria-label*="图片" i]',
    '[role="button"][title*="图片" i]',
    '[role="button"][aria-label*="image" i]',
    '[role="button"][title*="image" i]',
  ];

  const out: HTMLElement[] = [];
  for (const selector of selectors) {
    const nodes = Array.from(doc.querySelectorAll(selector)).filter(isVisibleElement);
    for (const node of nodes) {
      if (!out.includes(node)) out.push(node);
      if (out.length >= IMAGE_FALLBACK_CLICK_MAX) return out;
    }
  }

  const fuzzy = Array.from(doc.querySelectorAll<HTMLElement>('button,[role="button"],a,span,div'))
    .filter((node) => {
      if (!isVisibleElement(node)) return false;
      const txt = `${node.textContent || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('aria-label') || ''}`.toLowerCase();
      return txt.includes('图片') || txt.includes('插图') || txt.includes('上传') || txt.includes('image') || txt.includes('upload');
    })
    .slice(0, IMAGE_FALLBACK_CLICK_MAX);

  for (const node of fuzzy) {
    if (!out.includes(node)) out.push(node);
    if (out.length >= IMAGE_FALLBACK_CLICK_MAX) break;
  }

  return out;
}

export async function insertImageAtCursor(params: {
  jobId: string;
  imageUrl: string;
  editorRoot: HTMLElement;
}): Promise<void> {
  const editorRoot = params.editorRoot;
  const doc = editorRoot.ownerDocument;
  const topDoc = document;

  const file = await fetchImageAsFile(params.jobId, params.imageUrl);

  const beforeCount = (() => {
    try {
      return editorRoot.querySelectorAll('img').length;
    } catch {
      return 0;
    }
  })();
  const beforeSources = (() => {
    try {
      return new Set(
        Array.from(editorRoot.querySelectorAll<HTMLImageElement>('img'))
          .map((img) => String(img.getAttribute('src') || '').trim())
          .filter(Boolean)
      );
    } catch {
      return new Set<string>();
    }
  })();

  const waitInserted = async () => {
    await retryUntil(
      async () => {
        const imgs = Array.from(editorRoot.querySelectorAll<HTMLImageElement>('img'));
        const sources = imgs.map((img) => String(img.getAttribute('src') || '').trim()).filter(Boolean);
        const hasNewSource = sources.some((src) => src && !beforeSources.has(src));
        if (hasNewSource || imgs.length > beforeCount) return true;
        throw new Error('img not inserted yet');
      },
      { timeoutMs: 45_000, intervalMs: 600 }
    );
  };

  // Ensure editor is focused
  try {
    simulateClick(editorRoot);
  } catch {
    // ignore
  }
  try {
    simulateFocus(editorRoot);
  } catch {
    // ignore
  }

  // Method A: paste files
  try {
    simulatePasteFiles(editorRoot, [file]);
    await waitInserted();
    return;
  } catch {
    // ignore
  }

  // Method B: drop files
  try {
    simulateDropFiles(editorRoot, [file]);
    await waitInserted();
    return;
  } catch {
    // ignore
  }

  // Method C: file input
  try {
    const inputs = findImageFileInputsNear(doc);
    if (inputs.length) {
      const ok = await tryInputsAndWaitInserted(inputs, file, waitInserted);
      if (ok) return;
    }
  } catch {
    // ignore
  }

  // Method D: file input from top-level document (iframe editor toolbar often lives in parent document)
  try {
    if (topDoc !== doc) {
      const inputs = findImageFileInputsNear(topDoc);
      if (inputs.length) {
        const ok = await tryInputsAndWaitInserted(inputs, file, waitInserted);
        if (ok) return;
      }
    }
  } catch {
    // ignore
  }

  // Method E: click toolbar "image/upload" button then inject file to latest/new input
  try {
    const docs = topDoc === doc ? [doc] : [doc, topDoc];
    for (const docCandidate of docs) {
      const beforeInputs = new Set(Array.from(docCandidate.querySelectorAll<HTMLInputElement>('input[type="file"]')));
      const buttons = findToolbarImageButtons(docCandidate);
      for (const btn of buttons) {
        try {
          simulateClick(btn);
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 220));

        const nowInputs = Array.from(docCandidate.querySelectorAll<HTMLInputElement>('input[type="file"]'));
        const newInputs = nowInputs.filter((input) => !beforeInputs.has(input));
        const candidateInputs = newInputs.length ? newInputs : nowInputs;
        const scored = candidateInputs
          .map((input, index) => ({ input, score: scoreImageFileInput(input, index + 100) }))
          .sort((a, b) => b.score - a.score)
          .map((it) => it.input);

        const fallback = docCandidate === topDoc ? [] : findImageFileInputsNear(topDoc);
        const ok = await tryInputsAndWaitInserted([...scored, ...fallback], file, waitInserted);
        if (ok) {
          return;
        }
      }
    }
  } catch {
    // ignore
  }

  // Last resort: try dispatch paste on editor body / top-level body
  try {
    simulatePasteFiles(doc.body as HTMLElement, [file]);
    await waitInserted();
    return;
  } catch {
    // ignore
  }
  try {
    if (topDoc !== doc && topDoc.body) {
      simulatePasteFiles(topDoc.body, [file]);
      await waitInserted();
      return;
    }
  } catch {
    // ignore
  }

  throw new Error('image insert failed');
}

export async function fillEditorByTokens(params: {
  jobId: string;
  tokens: BridgeRichContentToken[];
  editorRoot: HTMLElement;
  writeMode: 'html' | 'text';
  onImageProgress?: (current: number, total: number, imageUrl: string) => Promise<void> | void;
  insertImageAtCursorOverride?: (args: { jobId: string; imageUrl: string; editorRoot: HTMLElement }) => Promise<void>;
}): Promise<void> {
  const editorRoot = params.editorRoot;
  const doc = editorRoot.ownerDocument;
  const view = bridgeViewOf(editorRoot);
  const isProseMirrorRoot = (() => {
    try {
      return editorRoot.classList.contains('ProseMirror');
    } catch {
      return false;
    }
  })();

  const tokens = Array.isArray(params.tokens) ? params.tokens : [];
  const imageTotal = tokens.filter((t) => t?.kind === 'image').length;
  let imageIndex = 0;

  // Clear editor first
  try {
    simulateClick(editorRoot);
  } catch {
    // ignore
  }
  try {
    simulateFocus(editorRoot);
  } catch {
    // ignore
  }
  try {
    doc.execCommand('selectAll', false);
    doc.execCommand('delete', false);
  } catch {
    // ignore
  }
  // ProseMirror 场景下，execCommand('delete') 偶发不生效；用 insertHTML 覆写为一个空段落兜底清空。
  try {
    if (isProseMirrorRoot) {
      const hasLeft = (() => {
        try {
          const textLen = String(editorRoot.textContent || '').replace(/\s+/g, '').length;
          const imgCount = editorRoot.querySelectorAll('img').length;
          return textLen > 0 || imgCount > 0;
        } catch {
          return false;
        }
      })();
      if (hasLeft) {
        doc.execCommand('selectAll', false);
        doc.execCommand('insertHTML', false, '<p><br/></p>');
      }
    }
  } catch {
    // ignore
  }
  if (!isProseMirrorRoot) {
    try {
      if (params.writeMode === 'text') {
        (editorRoot as HTMLElement).innerText = '';
      } else {
        (editorRoot as HTMLElement).innerHTML = '';
      }
    } catch {
      // ignore
    }
  }

  const insertText = (text: string) => {
    const t = String(text || '');
    if (!t) return;
    try {
      const ok = doc.execCommand('insertText', false, t);
      if (ok) return;
    } catch {
      // ignore
    }
    try {
      (editorRoot as HTMLElement).innerText = ((editorRoot as HTMLElement).innerText || '') + t;
      editorRoot.dispatchEvent(new view.InputEvent('input', { bubbles: true, cancelable: true, data: t, inputType: 'insertText' }));
      editorRoot.dispatchEvent(new view.CompositionEvent('compositionend', { bubbles: true, data: t }));
    } catch {
      // ignore
    }
  };

  const waitDomTick = async () => {
    await new Promise<void>((resolve) => {
      try {
        view.requestAnimationFrame(() => resolve());
      } catch {
        setTimeout(() => resolve(), 0);
      }
    });
  };

  // 给编辑器一点时间完成清空（尤其是 ProseMirror）
  await waitDomTick();

  const insertHtml = async (html: string) => {
    const h = String(html || '');
    if (!h.trim()) return;
    const plain = htmlToPlainTextSafe(h);
    const baselineLen = (() => {
      try {
        return String(editorRoot.textContent || '').length;
      } catch {
        return 0;
      }
    })();

    const hasGrowth = (): boolean => {
      try {
        const now = String(editorRoot.textContent || '').length;
        return now - baselineLen > Math.min(20, Math.max(4, Math.round(plain.replace(/\s+/g, '').length * 0.15)));
      } catch {
        return false;
      }
    };

    const tryPasteEvent = () => {
      try {
        const dt = new view.DataTransfer();
        try {
          dt.setData('text/html', h);
        } catch {
          // ignore
        }
        try {
          dt.setData('text/plain', plain);
        } catch {
          // ignore
        }

        try {
          const ev = new (view as unknown as { ClipboardEvent: typeof ClipboardEvent }).ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dt,
          } as unknown as ClipboardEventInit);
          editorRoot.dispatchEvent(ev);
          return true;
        } catch {
          // ignore
        }

        const ev = new view.Event('paste', { bubbles: true, cancelable: true });
        (ev as unknown as { clipboardData?: DataTransfer }).clipboardData = dt;
        editorRoot.dispatchEvent(ev);
        return true;
      } catch {
        return false;
      }
    };

    if (tryPasteEvent()) {
      await waitDomTick();
      if (hasGrowth()) return;
    }

    try {
      const ok = doc.execCommand('insertHTML', false, h);
      if (ok) {
        await waitDomTick();
        if (hasGrowth()) return;
      }
    } catch {
      // ignore
    }
    // Fallback to text if insertHTML is blocked
    insertText(htmlToPlainTextSafe(h) + '\n');
  };

  for (const token of tokens) {
    if (!token) continue;

    try {
      simulateClick(editorRoot);
    } catch {
      // ignore
    }
    try {
      simulateFocus(editorRoot);
    } catch {
      // ignore
    }

    if (token.kind === 'html') {
      if (params.writeMode === 'html') {
        await insertHtml(token.html);
      } else {
        insertText(htmlToPlainTextSafe(token.html) + '\n');
      }
      continue;
    }

    if (token.kind === 'image') {
      imageIndex += 1;
      try {
        await params.onImageProgress?.(imageIndex, imageTotal, token.src);
      } catch {
        // ignore
      }
      const insertFn = params.insertImageAtCursorOverride || insertImageAtCursor;
      await insertFn({ jobId: params.jobId, imageUrl: token.src, editorRoot });
      continue;
    }
  }
}
