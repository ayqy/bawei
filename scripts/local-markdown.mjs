import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp']
]);

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unquote(value) {
  const text = String(value || '').trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

export function splitMarkdownFrontMatter(rawMarkdown) {
  const source = String(rawMarkdown || '').replace(/^\uFEFF/, '');
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { attributes: {}, body: source };

  const attributes = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!item) continue;
    attributes[item[1]] = unquote(item[2]);
  }
  return { attributes, body: source.slice(match[0].length) };
}

function plainHeading(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function extractMarkdownTitle(body, attributes, markdownPath) {
  const metadataTitle = plainHeading(attributes.title || '');
  const headingMatch = String(body || '').match(/^#\s+(.+?)\s*#*\s*$/m);
  const headingTitle = plainHeading(headingMatch?.[1] || '');
  const filenameTitle = path.basename(markdownPath, path.extname(markdownPath)).trim();
  const title = metadataTitle || headingTitle || filenameTitle;

  let contentBody = String(body || '');
  if (headingMatch && (!metadataTitle || metadataTitle === headingTitle)) {
    contentBody =
      `${contentBody.slice(0, headingMatch.index)}${contentBody.slice((headingMatch.index || 0) + headingMatch[0].length)}`.replace(
        /^\s*\r?\n/,
        ''
      );
  }

  return { title, body: contentBody };
}

function sourceUrlFromAttributes(attributes) {
  const raw = String(
    attributes.source_url || attributes.sourceUrl || attributes.source || ''
  ).trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Markdown source_url 不是有效 URL：${raw}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Markdown source_url 仅支持 http/https：${raw}`);
  }
  return parsed.toString();
}

function stripUrlSuffix(value) {
  return String(value || '').replace(/[?#].*$/, '');
}

function createLocalAssetResolver({ markdownDir, origin, assets }) {
  return (rawHref) => {
    const href = String(rawHref || '').trim();
    if (!href) throw new Error('Markdown 图片地址为空');
    if (/^https?:\/\//i.test(href)) return href;
    if (/^data:/i.test(href)) {
      throw new Error('本地 Markdown 暂不接受 data: 图片；请改为图片文件路径或 http/https URL');
    }

    let assetPath;
    if (/^file:/i.test(href)) {
      try {
        assetPath = fileURLToPath(new URL(href));
      } catch {
        throw new Error(`无法解析本地图片 URL：${href}`);
      }
    } else {
      const decoded = decodeURIComponent(stripUrlSuffix(href));
      assetPath = path.isAbsolute(decoded) ? decoded : path.resolve(markdownDir, decoded);
    }

    let stat;
    try {
      stat = fs.statSync(assetPath);
    } catch {
      throw new Error(`Markdown 本地图片不存在：${assetPath}`);
    }
    if (!stat.isFile()) throw new Error(`Markdown 图片不是文件：${assetPath}`);
    if (stat.size <= 0 || stat.size > MAX_LOCAL_IMAGE_BYTES) {
      throw new Error(`Markdown 本地图片大小必须在 1B~10MB：${assetPath}`);
    }

    const ext = path.extname(assetPath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES.get(ext);
    if (!mimeType) {
      throw new Error(`Markdown 本地图片格式不支持（支持 png/jpg/gif/webp/avif）：${assetPath}`);
    }

    const key = crypto.createHash('sha256').update(assetPath).digest('hex').slice(0, 24);
    const route = `/assets/${key}${ext}`;
    assets.set(route, { path: assetPath, mimeType, size: stat.size });
    return `${origin}${route}`;
  };
}

function rewriteRawHtmlImages(html, resolveImageHref) {
  return String(html || '').replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi,
    (_all, prefix, quote, href) => {
      const resolved = resolveImageHref(href);
      return `${prefix}${quote}${escapeHtml(resolved)}${quote}`;
    }
  );
}

async function listenLocalServer(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

export async function prepareLocalMarkdown(markdownFile) {
  const markdownPath = path.resolve(String(markdownFile || '').trim());
  if (!markdownFile) throw new Error('缺少 Markdown 文件路径');

  let markdownStat;
  try {
    markdownStat = fs.statSync(markdownPath);
  } catch {
    throw new Error(`Markdown 文件不存在：${markdownPath}`);
  }
  if (!markdownStat.isFile()) throw new Error(`Markdown 路径不是文件：${markdownPath}`);

  const rawMarkdown = fs.readFileSync(markdownPath, 'utf8');
  const { attributes, body: bodyWithTitle } = splitMarkdownFrontMatter(rawMarkdown);
  const { title, body } = extractMarkdownTitle(bodyWithTitle, attributes, markdownPath);
  if (!title) throw new Error(`无法从 Markdown 提取标题：${markdownPath}`);

  const assets = new Map();
  const sourceRoute = `/source/${encodeURIComponent(path.basename(markdownPath))}`;
  const server = http.createServer((request, response) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      // keep default
    }

    if (pathname === sourceRoute) {
      response.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Length': Buffer.byteLength(rawMarkdown),
        'Cache-Control': 'no-store'
      });
      if (request.method === 'HEAD') response.end();
      else response.end(rawMarkdown);
      return;
    }

    const asset = assets.get(pathname);
    if (!asset) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': asset.mimeType,
      'Content-Length': asset.size,
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(asset.path).pipe(response);
  });

  await listenLocalServer(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('无法启动本地 Markdown 图片服务');
  }
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const resolveImageHref = createLocalAssetResolver({
      markdownDir: path.dirname(markdownPath),
      origin,
      assets
    });
    const renderer = new marked.Renderer();
    renderer.image = ({ href, title: imageTitle, text }) => {
      const src = resolveImageHref(href);
      const titleAttr = imageTitle ? ` title="${escapeHtml(imageTitle)}"` : '';
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${titleAttr}>`;
    };

    const rendered = marked.parse(body, { async: false, gfm: true, renderer });
    const contentHtml = rewriteRawHtmlImages(rendered, resolveImageHref).trim();
    if (!contentHtml) throw new Error(`Markdown 正文为空：${markdownPath}`);

    const declaredSourceUrl = sourceUrlFromAttributes(attributes);
    const sourceUrl = declaredSourceUrl || `${origin}${sourceRoute}`;
    const contentHash = crypto.createHash('sha256').update(rawMarkdown).digest('hex');
    const identity = `bawei-markdown:${contentHash}`;

    return {
      identity,
      markdownPath,
      assetCount: assets.size,
      hasDurableSourceUrl: !!declaredSourceUrl,
      article: {
        title,
        contentHtml,
        sourceUrl
      },
      close: async () => {
        await new Promise((resolve) => server.close(() => resolve()));
      }
    };
  } catch (error) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw error;
  }
}
