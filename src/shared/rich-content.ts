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

const RC_IMAGE_PROXY_ENDPOINT = 'https://read.useai.online/api/image-proxy?url=';

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

function rcIsProxyUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.hostname === 'read.useai.online' && u.pathname.startsWith('/api/image-proxy');
  } catch {
    return false;
  }
}

function rcStripHash(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.hash) u.hash = '';
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function rcDecodeProxyTarget(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (!(u.hostname === 'read.useai.online' && u.pathname.startsWith('/api/image-proxy'))) return '';
    const target = String(u.searchParams.get('url') || '').trim();
    if (!target) return '';
    const inner = new URL(target);
    if (inner.protocol !== 'https:' && inner.protocol !== 'http:') return '';
    return rcStripHash(inner.toString());
  } catch {
    return '';
  }
}

export function toProxyImageUrl(raw: string, baseUrl: string): string {
  const normalized = rcNormalizeImageUrl(raw, baseUrl);
  if (!normalized) return '';

  if (normalized.startsWith('data:') || normalized.startsWith('blob:')) return '';
  if (rcIsProxyUrl(normalized)) return normalized;

  try {
    const u = new URL(normalized);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  } catch {
    return '';
  }

  return `${RC_IMAGE_PROXY_ENDPOINT}${encodeURIComponent(normalized)}`;
}

export function toTokenImageUrl(raw: string, baseUrl: string): string {
  const normalized = rcNormalizeImageUrl(raw, baseUrl);
  if (!normalized) return '';
  if (normalized.startsWith('data:') || normalized.startsWith('blob:')) return '';

  if (rcIsProxyUrl(normalized)) {
    const target = rcDecodeProxyTarget(normalized);
    if (target) return `${RC_IMAGE_PROXY_ENDPOINT}${encodeURIComponent(target)}`;
    return rcStripHash(normalized);
  }

  try {
    const u = new URL(normalized);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    const direct = rcStripHash(u.toString());
    return `${RC_IMAGE_PROXY_ENDPOINT}${encodeURIComponent(direct)}`;
  } catch {
    return '';
  }
}

export function rewriteHtmlImageUrlsToProxy(contentHtml: string, baseUrl: string): string {
  const html = String(contentHtml || '');
  if (!html) return '';

  const container = document.createElement('div');
  container.innerHTML = html;

  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
  for (const img of images) {
    const raw = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src') || '';
    const proxied = toProxyImageUrl(raw, baseUrl);
    if (!proxied) continue;

    if (img.hasAttribute('src')) img.setAttribute('src', proxied);
    if (img.hasAttribute('data-src')) img.setAttribute('data-src', proxied);
    if (img.hasAttribute('data-original')) img.setAttribute('data-original', proxied);

    // 兜底：确保后续提取时能读到代理地址
    if (!img.hasAttribute('src') && !img.hasAttribute('data-src') && !img.hasAttribute('data-original')) {
      img.setAttribute('src', proxied);
    }
  }

  return container.innerHTML;
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
    const plain = htmlToPlainTextSafe(h);
    if (!plain) return;
    tokens.push({ kind: 'html', html: `<p>${rcEscapeAttr(plain)}</p>` });
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
    const url = toTokenImageUrl(raw, baseUrl);
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
