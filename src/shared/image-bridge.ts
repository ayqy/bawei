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

  push(input);

  try {
    const u = new URL(input);
    const isProxy = u.hostname.toLowerCase() === 'read.useai.online' && u.pathname.startsWith('/api/image-proxy');
    if (!isProxy && (u.protocol === 'https:' || u.protocol === 'http:')) {
      push(normalizeProxyImageUrl(`${IMAGE_PROXY_ENDPOINT}${encodeURIComponent(u.toString())}`));
    }
  } catch {
    // ignore
  }

  return out;
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

export async function fetchImageAsFile(jobId: string, url: string): Promise<File> {
  let lastError: unknown = null;
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
        size?: number;
      };

      if (!res?.success) {
        const reason = String(res?.error || 'fetch image failed');
        throw new Error(`${reason} | imageUrl=${String(normalizedInput || url).slice(0, 320)}`);
      }
      const mimeType = String(res.mimeType || 'image/png');
      const buffer = res.buffer as ArrayBuffer;
      const size = Number(res.size || 0);
      if (!buffer || !size) throw new Error('empty image buffer');
      const ext = pickFileExtension(mimeType);
      return new File([buffer], `image.${ext}`, { type: mimeType });
    } catch (error) {
      lastError = error;
      if (attempt < IMAGE_FETCH_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 450));
      }
    }
  }

  const fallbackCandidates = buildDirectFetchCandidates(normalizedInput || url);
  for (const candidate of fallbackCandidates) {
    try {
      return await fetchImageAsFileByDirectFetch(candidate);
    } catch (error) {
      lastError = error;
    }
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
  try {
    if (params.writeMode === 'text') {
      (editorRoot as HTMLElement).innerText = '';
    } else {
      (editorRoot as HTMLElement).innerHTML = '';
    }
  } catch {
    // ignore
  }

  const insertText = (text: string) => {
    const t = String(text || '');
    if (!t) return;
    try {
      doc.execCommand('insertText', false, t);
      return;
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

  const insertHtml = (html: string) => {
    const h = String(html || '');
    if (!h.trim()) return;
    try {
      doc.execCommand('insertHTML', false, h);
      return;
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
        insertHtml(token.html);
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
