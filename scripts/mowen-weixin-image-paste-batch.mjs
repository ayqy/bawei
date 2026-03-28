import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';

const RUN_ID = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts/mowen-weixin-image-paste');
const LOG_PATH = path.join(ARTIFACTS_DIR, `weixin-image-paste-${RUN_ID}.ndjson`);
const IMAGE_DIR = path.join(ARTIFACTS_DIR, 'images');
const SCREENSHOT_DIR = path.join(ARTIFACTS_DIR, 'screenshots');

const USER_DATA_DIR = path.resolve(process.cwd(), process.env.CHROME_PROFILE_DIR || 'artifacts/chrome-cdp-live-profile-v8');
const KEEP_BROWSER_OPEN = String(process.env.KEEP_BROWSER_OPEN || '1') !== '0';
const CFT_BINARY = String(process.env.CFT_BINARY || '').trim() || null;

const ARTICLE_URL =
  String(process.env.ARTICLE_URL || '').trim() || 'https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg';
const START_INDEX = Number.parseInt(String(process.env.START_INDEX || '0'), 10) || 0;
const MAX_IMAGES = Number.parseInt(String(process.env.MAX_IMAGES || '0'), 10) || 0;
const RETRIES = Math.max(1, Number.parseInt(String(process.env.RETRIES || '3'), 10) || 3);
const POST_IMAGE_WAIT_MS = Math.max(0, Number.parseInt(String(process.env.POST_IMAGE_WAIT_MS || '5000'), 10) || 5000);

const SHOULD_INCLUDE_NON_MMBIZ = String(process.env.INCLUDE_NON_MMBIZ || '0') === '1';
const USE_OS_PASTE_FALLBACK = String(process.env.USE_OS_PASTE_FALLBACK || '1') !== '0';

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

function decodeHtmlAttributeValue(raw) {
  return String(raw || '').replaceAll('&amp;', '&');
}

function pickImageUrlFromImgTag(imgTag) {
  const dataSrc = /data-src=\"([^\"]+)\"/i.exec(imgTag)?.[1] || '';
  const src = /src=\"([^\"]+)\"/i.exec(imgTag)?.[1] || '';
  const dataSrcDecoded = decodeHtmlAttributeValue(dataSrc);
  const srcDecoded = decodeHtmlAttributeValue(src);

  if (dataSrcDecoded.startsWith('http')) return dataSrcDecoded;
  if (srcDecoded.startsWith('http')) return srcDecoded;
  return '';
}

function shouldKeepImageUrl(url) {
  const u = String(url || '');
  if (!u.startsWith('http')) return false;
  if (u.includes('pic_blank.gif')) return false;
  if (u.includes('res.wx.qq.com/')) return false;
  if (!SHOULD_INCLUDE_NON_MMBIZ) {
    if (!u.includes('mmbiz.qpic.cn')) return false;
  }
  return true;
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

function extractImageUrlsInOrder(html) {
  const extractJsContentHtml = () => {
    const raw = String(html || '');
    const idIdx = raw.indexOf('id="js_content"');
    if (idIdx < 0) return '';
    const tagStart = raw.lastIndexOf('<', idIdx);
    if (tagStart < 0) return '';
    const openEnd = raw.indexOf('>', tagStart);
    if (openEnd < 0) return '';
    const openTag = raw.slice(tagStart, openEnd + 1);
    const tagName = /^<([a-zA-Z0-9]+)/.exec(openTag)?.[1]?.toLowerCase();
    if (!tagName) return '';

    const openNeedle = `<${tagName}`;
    const closeNeedle = `</${tagName}`;
    let depth = 1;
    let cursor = openEnd + 1;

    while (cursor < raw.length) {
      const nextOpen = raw.indexOf(openNeedle, cursor);
      const nextClose = raw.indexOf(closeNeedle, cursor);
      if (nextClose < 0) return '';
      if (nextOpen >= 0 && nextOpen < nextClose) {
        depth += 1;
        cursor = nextOpen + openNeedle.length;
        continue;
      }
      depth -= 1;
      if (depth === 0) {
        return raw.slice(openEnd + 1, nextClose);
      }
      cursor = nextClose + closeNeedle.length;
    }
    return '';
  };

  const scopeHtml = extractJsContentHtml() || String(html || '');
  const ordered = [];
  for (const m of scopeHtml.matchAll(/<img\b[^>]*>/gi)) {
    const imgTag = m[0];
    const url = pickImageUrlFromImgTag(imgTag);
    if (!shouldKeepImageUrl(url)) continue;
    ordered.push(url);
  }

  const uniq = [];
  const seen = new Set();
  for (const u of ordered) {
    if (seen.has(u)) continue;
    seen.add(u);
    uniq.push(u);
  }
  return uniq;
}

function sha1Short(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex').slice(0, 10);
}

async function downloadImageToPng(url, idx) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`图片下载失败：${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 64) throw new Error(`图片响应过小（${buf.length} bytes）：${url}`);

  const outPath = path.join(IMAGE_DIR, `${String(idx).padStart(3, '0')}-${sha1Short(url)}.png`);
  await sharp(buf).png().toFile(outPath);
  return outPath;
}

function copyPngToClipboard(pngPath) {
  const abs = path.resolve(pngPath);
  const script = `set the clipboard to (read (POSIX file \"${abs.replaceAll('\"', '\\\\\"')}\") as «class PNGf»)`;
  execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
  const info = String(execFileSync('osascript', ['-e', 'clipboard info'], { stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
  return info;
}

function pasteByOsKeystroke(appName) {
  if (process.platform !== 'darwin') return;
  const script = [
    `tell application \"${appName}\" to activate`,
    'delay 0.15',
    'tell application \"System Events\" to keystroke \"v\" using {command down}',
  ].join('\n');
  execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
}

async function waitForEditorReady(page) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const url = String(page.url() || '');
    if (!url.includes('account.mowen.cn/auth')) break;
    console.log('[weixin-image-paste] 检测到登录页，等待登录态恢复...');
    await page.waitForTimeout(1500);
  }

  const editorDeadline = Date.now() + 10 * 60_000;
  while (Date.now() < editorDeadline) {
    let handle = null;
    try {
      handle = await page.$('.ProseMirror[contenteditable=\"true\"]');
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
  await page.click('.ProseMirror[contenteditable=\"true\"]', { timeout: 30_000 });
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
}

async function pasteOneImageWithRetry(page, { idx, url, pngPath }) {
  const selector = '.ProseMirror[contenteditable=\"true\"]';
  const appName = 'Google Chrome for Testing';

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    const before = await page.evaluate(() => {
      const root = document.querySelector('.ProseMirror');
      return { imgCount: root ? root.querySelectorAll('img').length : 0 };
    });

    appendLog({ ts: nowIso(), kind: 'paste_attempt', idx, attempt, url, pngPath, before });
    console.log(`[weixin-image-paste] [${idx}] attempt ${attempt}/${RETRIES} 粘贴图片...`);

    await page.click(selector, { timeout: 30_000 });

    const waitPrepare = page.waitForResponse((res) => res.url().includes('/api/file/v1/upload/prepare'), { timeout: 120_000 });
    const waitUpload = page.waitForResponse((res) => res.url().includes('priv-sdn.mowen.cn/'), { timeout: 120_000 });
    const waitDraft = page
      .waitForResponse((res) => res.url().includes('/api/note/wxa/v1/note/draft'), { timeout: 120_000 })
      .catch(() => null);

    let pasteError = null;
    try {
      await page.keyboard.press('Meta+V');
    } catch (e) {
      pasteError = String(e || '');
    }

    if (pasteError && USE_OS_PASTE_FALLBACK) {
      appendLog({ ts: nowIso(), kind: 'paste_playwright_failed', idx, attempt, pasteError });
      pasteByOsKeystroke(appName);
    }

    let prepareRes = null;
    let uploadRes = null;
    let draftRes = null;
    try {
      [prepareRes, uploadRes, draftRes] = await Promise.all([waitPrepare, waitUpload, waitDraft]);
    } catch (e) {
      const screenshotPath = path.join(
        SCREENSHOT_DIR,
        `paste-failed-${RUN_ID}-img${String(idx).padStart(3, '0')}-attempt${attempt}.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      appendLog({
        ts: nowIso(),
        kind: 'paste_timeout',
        idx,
        attempt,
        url,
        error: String(e || ''),
        screenshotPath,
      });
      await page.waitForTimeout(1200);
      continue;
    }

    const prepareStatus = prepareRes?.status?.() ?? -1;
    const uploadStatus = uploadRes?.status?.() ?? -1;
    const draftStatus = draftRes?.status?.() ?? -1;

    const after = await page.evaluate(() => {
      const root = document.querySelector('.ProseMirror');
      return { imgCount: root ? root.querySelectorAll('img').length : 0 };
    });

    appendLog({
      ts: nowIso(),
      kind: 'paste_result',
      idx,
      attempt,
      url,
      prepare: { status: prepareStatus, url: prepareRes?.url?.() },
      upload: { status: uploadStatus, url: uploadRes?.url?.() },
      draft: { status: draftStatus, url: draftRes?.url?.() },
      after,
    });

    const ok = prepareStatus === 200 && uploadStatus === 200 && after.imgCount >= before.imgCount + 1;
    if (ok) {
      console.log(`[weixin-image-paste] [${idx}] ✅ 上传成功（prepare=${prepareStatus} upload=${uploadStatus}）`);
      return { ok: true, attempt, prepareStatus, uploadStatus, draftStatus };
    }

    const screenshotPath = path.join(
      SCREENSHOT_DIR,
      `paste-bad-${RUN_ID}-img${String(idx).padStart(3, '0')}-attempt${attempt}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    appendLog({
      ts: nowIso(),
      kind: 'paste_bad_status',
      idx,
      attempt,
      url,
      prepareStatus,
      uploadStatus,
      draftStatus,
      before,
      after,
      screenshotPath,
    });

    await page.waitForTimeout(1200);
    if (after.imgCount > before.imgCount) {
      await page.keyboard.press('Meta+Z').catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  return { ok: false, attempts: RETRIES };
}

async function main() {
  ensureArtifacts();
  appendLog({ ts: nowIso(), kind: 'start', ARTICLE_URL, START_INDEX, MAX_IMAGES, RETRIES, POST_IMAGE_WAIT_MS });

  console.log('[weixin-image-paste] 拉取微信文章 HTML（移动 UA）...');
  const html = await fetchWeixinArticleHtml(ARTICLE_URL);
  appendLog({ ts: nowIso(), kind: 'weixin_html', size: html.length });

  const urls = extractImageUrlsInOrder(html);
  const slice = urls.slice(START_INDEX, MAX_IMAGES > 0 ? START_INDEX + MAX_IMAGES : undefined);
  console.log(`[weixin-image-paste] 抽取图片：总计 ${urls.length}，本次处理 ${slice.length}`);
  appendLog({ ts: nowIso(), kind: 'image_urls', total: urls.length, picked: slice.length, urls: slice });

  if (!slice.length) throw new Error('未抽取到可用图片 URL（可能被过滤规则排除）');

  console.log('[weixin-image-paste] 启动 Chrome for Testing（persistent profile）...');
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

    console.log('[weixin-image-paste] 打开墨问编辑器...');
    await page.goto('https://note.mowen.cn/editor', { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await waitForEditorReady(page);

    console.log('[weixin-image-paste] 清空编辑器...');
    await clearEditor(page);

    for (let i = 0; i < slice.length; i += 1) {
      const idx = START_INDEX + i;
      const url = slice[i];
      console.log(`[weixin-image-paste] [${idx}] 下载并转 PNG...`);
      const pngPath = await downloadImageToPng(url, idx);
      appendLog({ ts: nowIso(), kind: 'png_ready', idx, url, pngPath });

      console.log(`[weixin-image-paste] [${idx}] 写入系统剪贴板 PNGf...`);
      const clipboardInfo = copyPngToClipboard(pngPath);
      appendLog({ ts: nowIso(), kind: 'clipboard_info', idx, url, clipboardInfo });
      if (!clipboardInfo.includes('PNGf')) throw new Error(`剪贴板未检测到 PNGf：${clipboardInfo}`);

      const result = await pasteOneImageWithRetry(page, { idx, url, pngPath });
      if (!result.ok) throw new Error(`[${idx}] 图片多次粘贴/上传失败，已中断（见 artifacts 日志与截图）`);

      appendLog({ ts: nowIso(), kind: 'post_image_wait', idx, waitMs: POST_IMAGE_WAIT_MS });
      await page.waitForTimeout(POST_IMAGE_WAIT_MS);
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(600);
    }

    console.log('[weixin-image-paste] ✅ 本批次图片全部上传成功');
    appendLog({ ts: nowIso(), kind: 'done', ok: true });
  } finally {
    if (!KEEP_BROWSER_OPEN) {
      await context.close().catch(() => {});
    } else {
      console.log(`[weixin-image-paste] KEEP_BROWSER_OPEN=1，保留浏览器打开（profile=${USER_DATA_DIR}）`);
    }
  }
}

main().catch((e) => {
  console.error('\\n❌ mowen weixin image paste batch failed:', e);
  process.exit(1);
});
