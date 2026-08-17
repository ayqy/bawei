import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { getChannelIds } from './channel-config.mjs';

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

export function extractChannelVariants(markdownBody) {
  const source = String(markdownBody || '');
  const variants = {};
  const blockPattern = /<!--\s*bawei:variant\s+([a-z0-9-]+)\s*-->([\s\S]*?)<!--\s*\/bawei:variant\s*-->/gi;
  const defaultBody = source.replace(blockPattern, (_full, rawChannelId, variantBody) => {
    const channelId = String(rawChannelId || '').trim();
    if (!getChannelIds().includes(channelId)) throw new Error(`Markdown 渠道变体使用未知渠道：${channelId}`);
    if (Object.prototype.hasOwnProperty.call(variants, channelId)) throw new Error(`Markdown 渠道变体重复：${channelId}`);
    const normalizedBody = String(variantBody || '').trim();
    if (!/^#\s+.+$/m.test(normalizedBody)) throw new Error(`Markdown 渠道变体必须包含 H1 标题：${channelId}`);
    variants[channelId] = normalizedBody;
    return '';
  });

  if (/<!--\s*(?:bawei:variant\b|\/bawei:variant\s*-->)/i.test(defaultBody)) {
    throw new Error('Markdown 渠道变体标记不完整或嵌套非法');
  }
  return { defaultBody: defaultBody.trim(), variants };
}

export function validateWoshipmVariant(markdownBody) {
  const text = String(markdownBody || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const requirements = [
    ['用户问题', /用户问题|真实问题|问题场景/],
    ['产品决策', /产品决策|设计决策|为什么这样设计/],
    ['取舍', /取舍|权衡|没有选择/],
    ['适用边界', /适用边界|适合谁|不适合|边界/],
    ['可复用洞察', /可复用|洞察|启发|方法论/],
  ];
  const missing = requirements.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label);
  if (missing.length) throw new Error(`人人都是产品经理渠道变体缺少：${missing.join('、')}`);
  return true;
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

    const digest = crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
    const key = digest.slice(0, 24);
    const route = `/assets/${key}${ext}`;
    assets.set(route, { path: assetPath, mimeType, size: stat.size, digest });
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

function normalizeMarkdownForHash(markdown) {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function imageDigestsFromHtml(contentHtml, assets) {
  const digests = [];
  const matches = String(contentHtml || '').matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi);
  for (const match of matches) {
    const raw = String(match[1] || '').trim();
    let asset = null;
    try {
      asset = assets.get(new URL(raw).pathname) || null;
    } catch {
      // Keep the remote URL identity below.
    }
    digests.push(asset?.digest || `url:${stripUrlSuffix(raw)}`);
  }
  return digests;
}

export function buildChannelContentHash({ channelId, title, markdown, imageDigests, sourceUrl }) {
  const stable = JSON.stringify({
    channelId: String(channelId || ''),
    title: String(title || '').trim(),
    markdown: normalizeMarkdownForHash(markdown),
    imageDigests: Array.isArray(imageDigests) ? imageDigests.map((item) => String(item || '')) : [],
    sourceUrl: String(sourceUrl || '').trim(),
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
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

async function closeLocalServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fallback = setTimeout(finish, 2_000);
    fallback.unref?.();

    server.close(() => {
      clearTimeout(fallback);
      finish();
    });
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
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
  const { attributes, body: bodyWithVariants } = splitMarkdownFrontMatter(rawMarkdown);
  const { defaultBody, variants } = extractChannelVariants(bodyWithVariants);
  const { title, body } = extractMarkdownTitle(defaultBody, attributes, markdownPath);
  if (!title) throw new Error(`无法从 Markdown 提取标题：${markdownPath}`);

  const assets = new Map();
  const server = http.createServer((request, response) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      // keep default
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
    const declaredSourceUrl = sourceUrlFromAttributes(attributes);
    const sourceMarkdownHash = crypto.createHash('sha256').update(rawMarkdown).digest('hex');
    const identity = `bawei-markdown:${sourceMarkdownHash}`;

    const renderArticle = (channelId, selectedTitle, selectedBody) => {
      const renderer = new marked.Renderer();
      renderer.image = ({ href, title: imageTitle, text }) => {
        const src = resolveImageHref(href);
        const titleAttr = imageTitle ? ` title="${escapeHtml(imageTitle)}"` : '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${titleAttr}>`;
      };

      const rendered = marked.parse(selectedBody, { async: false, gfm: true, renderer });
      const contentHtml = rewriteRawHtmlImages(rendered, resolveImageHref).trim();
      if (!contentHtml) throw new Error(`Markdown 正文为空：${markdownPath} (${channelId})`);
      const imageDigests = imageDigestsFromHtml(contentHtml, assets);
      const contentHash = buildChannelContentHash({
        channelId,
        title: selectedTitle,
        markdown: selectedBody,
        imageDigests,
        sourceUrl: declaredSourceUrl,
      });

      return {
        article: {
          title: selectedTitle,
          contentHtml,
          sourceUrl: declaredSourceUrl,
        },
        markdown: selectedBody,
        contentHash,
        expectedImageCount: imageDigests.length,
        imageDigests,
      };
    };

    const channelArticles = {};
    for (const channelId of getChannelIds()) {
      const variantSource = variants[channelId];
      if (variantSource) {
        const extracted = extractMarkdownTitle(variantSource, {}, markdownPath);
        channelArticles[channelId] = renderArticle(channelId, extracted.title, extracted.body);
      } else {
        channelArticles[channelId] = renderArticle(channelId, title, body);
      }
    }

    return {
      identity,
      sourceMarkdownHash,
      markdownPath,
      assetCount: assets.size,
      hasDurableSourceUrl: !!declaredSourceUrl,
      article: channelArticles.csdn.article,
      channelArticles,
      variants,
      close: async () => {
        await closeLocalServer(server);
      }
    };
  } catch (error) {
    await closeLocalServer(server);
    throw error;
  }
}
