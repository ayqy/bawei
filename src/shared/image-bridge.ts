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
  const res = await chrome.runtime.sendMessage({
    type: V3_FETCH_IMAGE,
    jobId,
    url,
  });
  if (!res?.success) throw new Error(res?.error || 'fetch image failed');
  const mimeType = String(res.mimeType || 'image/png');
  const buffer = res.buffer as ArrayBuffer;
  const size = Number(res.size || 0);
  if (!buffer || !size) throw new Error('empty image buffer');
  const ext = pickFileExtension(mimeType);
  return new File([buffer], `image.${ext}`, { type: mimeType });
}

function isWeChatCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)qpic\.cn$/i.test(u.hostname) || /(^|\.)qlogo\.cn$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function findImageFileInputNear(doc: Document): HTMLInputElement | null {
  const inputs = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  const scored = inputs
    .map((input) => {
      const accept = String(input.getAttribute('accept') || '').toLowerCase();
      const name = String(input.getAttribute('name') || '').toLowerCase();
      const id = String(input.id || '').toLowerCase();
      const cls = String(input.className || '').toLowerCase();
      const isImageAccept = accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg') || accept.includes('webp');
      const looksImage = name.includes('image') || id.includes('image') || cls.includes('image') || cls.includes('upload');
      const score = (isImageAccept ? 10 : 0) + (looksImage ? 3 : 0);
      return { input, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.input || null;
}

export async function insertImageAtCursor(params: {
  jobId: string;
  imageUrl: string;
  editorRoot: HTMLElement;
}): Promise<void> {
  const editorRoot = params.editorRoot;
  const doc = editorRoot.ownerDocument;

  const file = await fetchImageAsFile(params.jobId, params.imageUrl);

  const before = (() => {
    try {
      return editorRoot.querySelectorAll('img').length;
    } catch {
      return 0;
    }
  })();

  const waitInserted = async () => {
    await retryUntil(
      async () => {
        const imgs = Array.from(editorRoot.querySelectorAll<HTMLImageElement>('img'));
        if (imgs.length <= before) throw new Error('img count not increased');
        const ok = imgs.some((img) => {
          const src = String(img.getAttribute('src') || '').trim();
          if (!src) return false;
          if (src.startsWith('blob:') || src.startsWith('data:')) return true;
          return !isWeChatCdnUrl(src);
        });
        if (!ok) throw new Error('img src not updated yet');
        return true;
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
    const input = findImageFileInputNear(doc);
    if (input) {
      setFilesToInput(input, [file]);
      await waitInserted();
      return;
    }
  } catch {
    // ignore
  }

  // Last resort: try dispatch paste on document (some editors listen at document level)
  try {
    simulatePasteFiles(doc.body as HTMLElement, [file]);
    await waitInserted();
    return;
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
      await insertImageAtCursor({ jobId: params.jobId, imageUrl: token.src, editorRoot });
      continue;
    }
  }
}
