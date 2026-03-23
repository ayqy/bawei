type RcRichContentToken =
  | {
      kind: 'html';
      html: string;
    }
  | {
      kind: 'image';
      src: string;
      alt?: string;
    };

function rcEscapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function rcNormalizeImageUrl(raw: string, baseUrl: string): string {
  const v = String(raw || '').trim();
  if (!v) return '';
  try {
    return new URL(v, baseUrl || location.href).toString();
  } catch {
    return v;
  }
}

export function htmlToPlainTextSafe(html: string): string {
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return String(tmp.textContent || tmp.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

export function buildRichContentTokens(params: {
  contentHtml: string;
  baseUrl: string;
  sourceUrl: string;
}): RcRichContentToken[] {
  const contentHtml = String(params?.contentHtml || '');
  const baseUrl = String(params?.baseUrl || '');
  const sourceUrl = String(params?.sourceUrl || '');

  const container = document.createElement('div');
  container.innerHTML = contentHtml;

  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
  const tokens: RcRichContentToken[] = [];

  const pushHtml = (html: string) => {
    const h = String(html || '').trim();
    if (!h) return;
    if (/<img\b/i.test(h)) return; // safety: html token must not include img
    tokens.push({ kind: 'html', html: h });
  };

  let startNode: Node = container;
  let startOffset = 0;

  const cloneBetween = (endBefore: Node) => {
    try {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEndBefore(endBefore);
      const frag = range.cloneContents();
      const tmp = document.createElement('div');
      tmp.appendChild(frag);
      pushHtml(tmp.innerHTML);
    } catch {
      // ignore
    }
  };

  const moveStartAfter = (node: Node) => {
    try {
      const parent = node.parentNode;
      if (!parent) return;
      const idx = Array.prototype.indexOf.call(parent.childNodes, node);
      startNode = parent;
      startOffset = Math.max(0, idx + 1);
    } catch {
      // ignore
    }
  };

  for (const img of images) {
    cloneBetween(img);

    const raw = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src') || '';
    const url = rcNormalizeImageUrl(raw, baseUrl);
    if (url) {
      const alt = (img.getAttribute('alt') || '').trim();
      tokens.push({ kind: 'image', src: url, alt: alt || undefined });
    }

    moveStartAfter(img);
  }

  // Remaining HTML after last image
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(container, container.childNodes.length);
    const frag = range.cloneContents();
    const tmp = document.createElement('div');
    tmp.appendChild(frag);
    pushHtml(tmp.innerHTML);
  } catch {
    // ignore
  }

  // Append source URL to the end
  if (sourceUrl) {
    const safe = rcEscapeAttr(sourceUrl);
    pushHtml(`\n<p><br/></p><p>原文链接：<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a></p>`);
  }

  return tokens;
}
