import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';

const RUN_ID = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts/mowen-weixin-publish');
const LOG_PATH = path.join(ARTIFACTS_DIR, `weixin-publish-${RUN_ID}.ndjson`);
const IMAGE_DIR = path.join(ARTIFACTS_DIR, 'images');
const SCREENSHOT_DIR = path.join(ARTIFACTS_DIR, 'screenshots');
const EXTRACT_PATH = path.join(ARTIFACTS_DIR, `extract-${RUN_ID}.json`);

const USER_DATA_DIR = path.resolve(process.cwd(), process.env.CHROME_PROFILE_DIR || 'artifacts/chrome-cdp-live-profile-v8');
const KEEP_BROWSER_OPEN = String(process.env.KEEP_BROWSER_OPEN || '1') !== '0';
const CFT_BINARY = String(process.env.CFT_BINARY || '').trim() || null;

const ARTICLE_URL =
  String(process.env.ARTICLE_URL || '').trim() || 'https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg';
const POST_IMAGE_WAIT_MS = Math.max(0, Number.parseInt(String(process.env.POST_IMAGE_WAIT_MS || '5000'), 10) || 5000);
const IMAGE_RETRIES = Math.max(1, Number.parseInt(String(process.env.IMAGE_RETRIES || '3'), 10) || 3);

const EDITOR_SELECTOR = '.ProseMirror[contenteditable="true"]';

function nowIso() {
  return new Date().toISOString();
}

function appendLog(payload) {
  try {
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(payload)}\n`);
  } catch {
    // ignore
  }
}

function ensureArtifacts() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, '');
}

function resolveCftBinary() {
  if (CFT_BINARY) {
    const abs = path.resolve(CFT_BINARY);
    if (!fs.existsSync(abs)) throw new Error(`CFT_BINARY 不存在：${abs}`);
    return abs;
  }

  const cacheRoot = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (!fs.existsSync(cacheRoot)) {
    throw new Error(`未找到 Playwright 浏览器缓存目录：${cacheRoot}`);
  }

  const chromiumDirs = fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^chromium-\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));

  for (const dirName of chromiumDirs) {
    const base = path.join(cacheRoot, dirName);
    const candidates = [
      path.join(base, 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
      path.join(base, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  throw new Error('未找到 Chrome for Testing 可执行文件，请先执行 `npx playwright install chromium`');
}

async function fetchWeixinArticleHtml(url) {
  const ua =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800322c) NetType/WIFI Language/zh_CN';
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': ua } });
  if (!res.ok) throw new Error(`微信文章拉取失败：${res.status} ${res.statusText}`);
  const html = await res.text();
  if (!html.includes('js_content') || !html.includes('rich_media_content')) {
    throw new Error('微信文章 HTML 不包含 js_content/rich_media_content（可能 UA 不正确或被风控）');
  }
  return html;
}

function sha1Short(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex').slice(0, 10);
}

async function downloadImageToPng(url, idx) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0',
      referer: ARTICLE_URL,
    },
  });
  if (!res.ok) throw new Error(`图片下载失败：${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 64) throw new Error(`图片响应过小（${buf.length} bytes）：${url}`);

  const outPath = path.join(IMAGE_DIR, `${String(idx).padStart(3, '0')}-${sha1Short(url)}.png`);
  await sharp(buf).png().toFile(outPath);
  return outPath;
}

async function copyPngToClipboard(pngPath) {
  const abs = path.resolve(pngPath);
  const script = `set the clipboard to (read (POSIX file \"${abs.replaceAll('\"', '\\\\\"')}\") as «class PNGf»)`;
  let lastInfo = '';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
    const info = String(execFileSync('osascript', ['-e', 'clipboard info'], { stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
    lastInfo = info;
    if (info.includes('PNGf')) return info;
    await new Promise((r) => setTimeout(r, 200));
  }

  return lastInfo;
}

async function waitForEditorReady(page) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const url = String(page.url() || '');
    if (!url.includes('account.mowen.cn/auth')) break;
    console.log('[mowen-publish] 检测到登录页，等待登录态恢复...');
    await page.waitForTimeout(1500);
  }

  const editorDeadline = Date.now() + 10 * 60_000;
  while (Date.now() < editorDeadline) {
    let handle = null;
    try {
      handle = await page.$(EDITOR_SELECTOR);
    } catch (e) {
      if (String(e || '').includes('Execution context was destroyed')) {
        await page.waitForTimeout(450);
        continue;
      }
      throw e;
    }
    if (handle) return;

    let bodyText = '';
    try {
      bodyText = await page.evaluate(() => String(document.body?.innerText || ''));
    } catch (e) {
      if (String(e || '').includes('Execution context was destroyed')) {
        await page.waitForTimeout(450);
        continue;
      }
      throw e;
    }

    if (bodyText.includes('未保存') && bodyText.includes('草稿') && bodyText.includes('恢复')) {
      const cancel = page.locator('text=取消').first();
      if (await cancel.count()) {
        await cancel.click().catch(() => {});
        await page.waitForTimeout(900);
        continue;
      }
      const close = page.locator('text=不恢复').first();
      if (await close.count()) {
        await close.click().catch(() => {});
        await page.waitForTimeout(900);
        continue;
      }
    }

    const writeBtn = page.locator('text=写笔记').first();
    if (await writeBtn.count()) {
      await writeBtn.click().catch(() => {});
      await page.waitForTimeout(1200);
      continue;
    }

    await page.waitForTimeout(450);
  }

  throw new Error('未检测到 .ProseMirror 编辑器（可能需要先点击“写笔记”或登录态失效）');
}

async function clearEditor(page) {
  await page.click(EDITOR_SELECTOR, { timeout: 30_000 });
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
}

async function pasteHtmlFragment(page, html) {
  const payload = { selector: EDITOR_SELECTOR, html: String(html || '') };
  await page.locator(EDITOR_SELECTOR).focus({ timeout: 30_000 });

  const result = await page.evaluate(({ selector, html }) => {
    const root = document.querySelector(selector);
    if (!root) return { ok: false, reason: 'editor_not_found' };

    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    for (const node of Array.from(tmp.querySelectorAll('img,script,style,iframe'))) {
      node.remove();
    }
    const cleaned = String(tmp.innerHTML || '').trim();
    if (!cleaned) return { ok: true, skipped: true };

    const plain = String(tmp.textContent || tmp.innerText || '');
    let dispatched = false;

    try {
      const dt = new DataTransfer();
      try {
        dt.setData('text/html', cleaned);
      } catch {
        // ignore
      }
      try {
        dt.setData('text/plain', plain);
      } catch {
        // ignore
      }

      try {
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        root.dispatchEvent(ev);
        dispatched = true;
      } catch {
        const ev = new Event('paste', { bubbles: true, cancelable: true });
        (ev).clipboardData = dt;
        root.dispatchEvent(ev);
        dispatched = true;
      }
    } catch {
      // ignore
    }

    if (!dispatched) {
      try {
        document.execCommand('insertHTML', false, cleaned);
        dispatched = true;
      } catch {
        // ignore
      }
    }

    return { ok: true, dispatched, cleanedLen: cleaned.length, plainLen: plain.length };
  }, payload);

  appendLog({ ts: nowIso(), kind: 'paste_html', ok: result?.ok, result });
  await page.waitForTimeout(180);
}

async function pasteImageFromClipboardAndWait(page, { idx, url, pngPath }) {
  await page.locator(EDITOR_SELECTOR).focus({ timeout: 30_000 });

  for (let attempt = 1; attempt <= IMAGE_RETRIES; attempt += 1) {
    appendLog({ ts: nowIso(), kind: 'paste_image_attempt', idx, attempt, url, pngPath });
    console.log(`[mowen-publish] [img ${idx}] attempt ${attempt}/${IMAGE_RETRIES} 粘贴图片...`);

    const waitPrepare = page.waitForResponse((res) => res.url().includes('/api/file/v1/upload/prepare') && res.status() === 200, {
      timeout: 120_000,
    });
    const waitUpload = page.waitForResponse((res) => res.url().includes('priv-sdn.mowen.cn/') && res.status() === 200, { timeout: 120_000 });
    const waitDraft = page.waitForResponse((res) => res.url().includes('/api/note/wxa/v1/note/draft') && res.status() === 200, { timeout: 120_000 });

    await page.keyboard.press('Meta+V');

    try {
      const [prepareRes, uploadRes, draftRes] = await Promise.all([waitPrepare, waitUpload, waitDraft]);
      appendLog({
        ts: nowIso(),
        kind: 'paste_image_ok',
        idx,
        attempt,
        url,
        prepare: { url: prepareRes.url(), status: prepareRes.status() },
        upload: { url: uploadRes.url(), status: uploadRes.status() },
        draft: { url: draftRes.url(), status: draftRes.status() },
      });

      appendLog({ ts: nowIso(), kind: 'post_image_wait', idx, waitMs: POST_IMAGE_WAIT_MS });
      await page.waitForTimeout(POST_IMAGE_WAIT_MS);
      await page.keyboard.press('ArrowRight').catch(() => {});
      await page.keyboard.press('ArrowRight').catch(() => {});
      await page.waitForTimeout(120);
      return;
    } catch (e) {
      const screenshotPath = path.join(SCREENSHOT_DIR, `paste-image-failed-${RUN_ID}-${String(idx).padStart(3, '0')}-a${attempt}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      appendLog({ ts: nowIso(), kind: 'paste_image_fail', idx, attempt, url, error: String(e || ''), screenshotPath });
      await page.waitForTimeout(1200);
      continue;
    }
  }

  throw new Error(`[img ${idx}] 图片多次粘贴/上传失败（见 artifacts 日志与截图）`);
}

async function extractWeixinModelInPage(page, html, articleUrl) {
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  return await page.evaluate((sourceUrl) => {
    const strip = (input) =>
      String(input || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const titleEl = document.querySelector('#activity-name');
    const title = strip(titleEl?.innerHTML || titleEl?.textContent || '');

    const js = document.querySelector('#js_content');
    if (!js) return { ok: false, error: 'js_content_not_found', title };

    const toImageUrl = (img) => {
      const raw =
        img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src') || '';
      const url = String(raw || '').trim();
      if (!url.startsWith('http')) return '';
      if (url.includes('pic_blank.gif')) return '';
      if (url.includes('res.wx.qq.com/')) return '';
      return url;
    };

    const tokens = [];
    const images = Array.from(js.querySelectorAll('img'));

    const pushHtml = (html) => {
      const tmp = document.createElement('div');
      tmp.innerHTML = String(html || '');
      for (const node of Array.from(tmp.querySelectorAll('img,script,style,iframe'))) {
        node.remove();
      }
      const cleaned = String(tmp.innerHTML || '').trim();
      if (!cleaned) return;
      const plain = String(tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
      const hasBreak = !!tmp.querySelector('br,hr');
      if (!plain && !hasBreak) return;
      tokens.push({ kind: 'html', html: cleaned });
    };

    let startNode = js;
    let startOffset = 0;

    const cloneBetween = (endBefore) => {
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

    const moveStartAfter = (node) => {
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
      const url = toImageUrl(img);
      if (url) tokens.push({ kind: 'image', src: url, alt: (img.getAttribute('alt') || '').trim() || undefined });
      moveStartAfter(img);
    }

    try {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(js, js.childNodes.length);
      const frag = range.cloneContents();
      const tmp = document.createElement('div');
      tmp.appendChild(frag);
      pushHtml(tmp.innerHTML);
    } catch {
      // ignore
    }

    const safe = String(sourceUrl || '').trim();
    if (safe) {
      pushHtml(`<p><br/></p><p>原文链接：<a href=\"${safe}\" target=\"_blank\" rel=\"noreferrer noopener\">${safe}</a></p>`);
    }

    return { ok: true, title, tokens };
  }, articleUrl);
}

async function assertEditorQuality(page, { title, expectedImages, sourceUrl }) {
  const out = await page.evaluate(
    ({ selector, title, expectedImages, sourceUrl }) => {
      const root = document.querySelector(selector);
      const text = String(root?.innerText || root?.textContent || '');
      const firstLine = text.split('\n')[0]?.trim() || '';
      const pCount = root ? root.querySelectorAll('p').length : 0;
      const imgCount = root ? root.querySelectorAll('img').length : 0;
      const hasSource = !!(sourceUrl && text.includes(sourceUrl));
      return { firstLine, pCount, imgCount, hasSource, expectedImages };
    },
    { selector: EDITOR_SELECTOR, title, expectedImages, sourceUrl },
  );

  if (String(out.firstLine || '').trim() !== String(title || '').trim()) throw new Error(`标题未单独成行：${out.firstLine}`);
  if (Number(out.pCount || 0) < 3) throw new Error(`段落数量异常：${out.pCount}`);
  if (expectedImages && Number(out.imgCount || 0) < expectedImages) {
    throw new Error(`图片数量不完整：${out.imgCount}/${expectedImages}`);
  }
  if (!out.hasSource) throw new Error('未检测到原文链接');

  appendLog({ ts: nowIso(), kind: 'quality_ok', out });
}

async function main() {
  ensureArtifacts();
  appendLog({ ts: nowIso(), kind: 'start', ARTICLE_URL, POST_IMAGE_WAIT_MS, IMAGE_RETRIES });

  console.log('[mowen-publish] 拉取微信文章 HTML（移动 UA）...');
  const html = await fetchWeixinArticleHtml(ARTICLE_URL);
  appendLog({ ts: nowIso(), kind: 'weixin_html', size: html.length });

  console.log('[mowen-publish] 启动 Chrome for Testing（persistent profile）...');
  const cftBinary = resolveCftBinary();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    executablePath: cftBinary,
    args: [
      '--profile-directory=Default',
      '--disable-blink-features=AutomationControlled',
      '--lang=zh-CN',
      '--window-size=1440,960',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
    ],
  });

  try {
    const page = await context.newPage();

    console.log('[mowen-publish] 解析文章内容为 tokens（DOM Range 分段）...');
    const model = await extractWeixinModelInPage(page, html, ARTICLE_URL);
    if (!model?.ok) throw new Error(model?.error || 'extract failed');
    const title = String(model.title || '').trim();
    const tokens = Array.isArray(model.tokens) ? model.tokens : [];
    const expectedImages = tokens.filter((t) => t?.kind === 'image').length;
    fs.writeFileSync(EXTRACT_PATH, JSON.stringify({ title, expectedImages, tokens }, null, 2));
    appendLog({ ts: nowIso(), kind: 'extract_done', title, expectedImages, tokenCount: tokens.length, extractPath: EXTRACT_PATH });

    console.log('[mowen-publish] 打开墨问编辑器并写入内容...');
    await page.goto('https://note.mowen.cn/editor', { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await waitForEditorReady(page);
    await clearEditor(page);

    await page.click(EDITOR_SELECTOR, { timeout: 30_000 });
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');

    let imageIndex = 0;
    for (const token of tokens) {
      if (!token) continue;
      if (token.kind === 'html') {
        await pasteHtmlFragment(page, token.html);
        continue;
      }
      if (token.kind === 'image') {
        imageIndex += 1;
        const idx = imageIndex;
        const url = String(token.src || '').trim();
        console.log(`[mowen-publish] [img ${idx}/${expectedImages}] 下载并转 PNG...`);
        const pngPath = await downloadImageToPng(url, idx);
        appendLog({ ts: nowIso(), kind: 'png_ready', idx, url, pngPath });

        console.log(`[mowen-publish] [img ${idx}/${expectedImages}] 写入系统剪贴板 PNGf...`);
        const clipboardInfo = await copyPngToClipboard(pngPath);
        appendLog({ ts: nowIso(), kind: 'clipboard_info', idx, url, clipboardInfo });
        if (!clipboardInfo.includes('PNGf')) throw new Error(`剪贴板未检测到 PNGf：${clipboardInfo}`);

        await pasteImageFromClipboardAndWait(page, { idx, url, pngPath });
        continue;
      }
    }

    const filledScreenshot = path.join(SCREENSHOT_DIR, `filled-${RUN_ID}.png`);
    await page.screenshot({ path: filledScreenshot, fullPage: true }).catch(() => {});
    appendLog({ ts: nowIso(), kind: 'screenshot', label: 'filled', path: filledScreenshot });

    await assertEditorQuality(page, { title, expectedImages, sourceUrl: ARTICLE_URL });

    console.log('[mowen-publish] 点击发布...');
    await page.locator('text=发布').first().click({ timeout: 30_000 });
    appendLog({ ts: nowIso(), kind: 'clicked_publish' });

    const publishDeadline = Date.now() + 60_000;
    while (Date.now() < publishDeadline) {
      const url = String(page.url() || '');
      const bodyText = await page.evaluate(() => String(document.body?.innerText || '')).catch(() => '');
      if (url.includes('/detail/') || bodyText.includes('发布成功') || bodyText.includes('已发布')) break;
      await page.waitForTimeout(800);
    }

    const publishedScreenshot = path.join(SCREENSHOT_DIR, `published-${RUN_ID}.png`);
    await page.screenshot({ path: publishedScreenshot, fullPage: true }).catch(() => {});
    appendLog({ ts: nowIso(), kind: 'screenshot', label: 'published', path: publishedScreenshot, url: page.url() });

    const verify = await page.evaluate((sourceUrl) => {
      const text = String(document.body?.innerText || '');
      return { sourceUrlPresent: !!(sourceUrl && text.includes(sourceUrl)), url: location.href };
    }, ARTICLE_URL);
    appendLog({ ts: nowIso(), kind: 'verify_detail', verify });
    if (!verify?.sourceUrlPresent) throw new Error('发布后验收失败：详情页未检测到原文链接');

    console.log('[mowen-publish] ✅ 已发布并通过验收（详情页含原文链接）');
    appendLog({ ts: nowIso(), kind: 'done', ok: true });
  } finally {
    if (!KEEP_BROWSER_OPEN) {
      await context.close().catch(() => {});
    } else {
      console.log(`[mowen-publish] KEEP_BROWSER_OPEN=1，保留浏览器打开（profile=${USER_DATA_DIR}）`);
    }
  }
}

main().catch((e) => {
  console.error('\\n❌ mowen weixin publish failed:', e);
  process.exit(1);
});
