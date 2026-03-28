import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';

const RUN_ID = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts/mowen-image-paste');
const LOG_PATH = path.join(ARTIFACTS_DIR, `paste-probe-${RUN_ID}.ndjson`);
const SCREENSHOT_PATH = path.join(ARTIFACTS_DIR, `paste-probe-${RUN_ID}.png`);
const IMAGE_DIR = path.join(ARTIFACTS_DIR, 'images');

const USER_DATA_DIR = path.resolve(process.cwd(), process.env.CHROME_PROFILE_DIR || 'artifacts/chrome-cdp-live-profile-v8');
const KEEP_BROWSER_OPEN = String(process.env.KEEP_BROWSER_OPEN || '1') !== '0';
const CFT_BINARY = String(process.env.CFT_BINARY || '').trim() || null;

const IMAGE_URL = String(process.env.IMAGE_URL || '').trim();
const IMAGE_PATH = String(process.env.IMAGE_PATH || '').trim();

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

async function fetchAsPngFile() {
  if (IMAGE_PATH) {
    const abs = path.resolve(IMAGE_PATH);
    if (!fs.existsSync(abs)) throw new Error(`IMAGE_PATH 不存在：${abs}`);
    const outPath = path.join(IMAGE_DIR, `input-${RUN_ID}.png`);
    await sharp(abs).png().toFile(outPath);
    return outPath;
  }

  if (IMAGE_URL) {
    const url = IMAGE_URL;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`IMAGE_URL 下载失败：${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const outPath = path.join(IMAGE_DIR, `download-${RUN_ID}.png`);
    await sharp(buf).png().toFile(outPath);
    return outPath;
  }

  const outPath = path.join(IMAGE_DIR, `generated-${RUN_ID}.png`);
  await sharp({
    create: { width: 320, height: 200, channels: 3, background: { r: 255, g: 120, b: 60 } },
  })
    .png()
    .toFile(outPath);
  return outPath;
}

function copyPngToClipboard(pngPath) {
  const abs = path.resolve(pngPath);
  const script = `set the clipboard to (read (POSIX file \"${abs.replaceAll('\"', '\\\\\"')}\") as «class PNGf»)`;
  execFileSync('osascript', ['-e', script], { stdio: 'ignore' });
  const info = String(execFileSync('osascript', ['-e', 'clipboard info'], { stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
  return info;
}

function shouldLogUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('.mowen.cn') || u.hostname === 'mowen.cn') return true;
    if (u.hostname.endsWith('.aliyuncs.com')) return true;
    return false;
  } catch {
    return false;
  }
}

function pickHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k || '').toLowerCase();
    if (!key) continue;
    if (key === 'cookie' || key === 'authorization' || key === 'proxy-authorization') continue;
    if (key === 'user-agent' || key === 'referer' || key === 'origin' || key === 'content-type' || key.startsWith('x-')) {
      out[key] = String(v || '').slice(0, 1200);
    }
  }
  return out;
}

async function waitForEditorReady(page) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const url = String(page.url() || '');
    if (!url.includes('account.mowen.cn/auth')) break;
    console.log('[paste-probe] 检测到登录页，等待登录态恢复...');
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

async function pasteAndWaitUploaded(page) {
  const selector = '.ProseMirror[contenteditable=\"true\"]';
  await page.click(selector, { timeout: 30_000 });

  const before = await page.evaluate(() => {
    const root = document.querySelector('.ProseMirror');
    return {
      imgCount: root ? root.querySelectorAll('img').length : 0,
      figureCount: root ? root.querySelectorAll('figure').length : 0,
      htmlSnippet: String(root?.innerHTML || '').slice(0, 800),
    };
  });
  appendLog({ ts: nowIso(), kind: 'before', ...before });

  const waitPrepare = page.waitForResponse((res) => res.url().includes('/api/file/v1/upload/prepare') && res.status() === 200, {
    timeout: 120_000,
  });
  const waitUpload = page.waitForResponse((res) => res.url().includes('priv-sdn.mowen.cn/') && res.status() === 200, { timeout: 120_000 });
  const waitDraft = page.waitForResponse((res) => res.url().includes('/api/note/wxa/v1/note/draft') && res.status() === 200, { timeout: 120_000 });

  await page.keyboard.press('Meta+V');

  const [prepareRes, uploadRes, draftRes] = await Promise.all([waitPrepare, waitUpload, waitDraft]);
  const uploadText = await uploadRes.text().catch(() => '');

  const after = await page.evaluate(() => {
    const root = document.querySelector('.ProseMirror');
    if (!root) return { imgCount: 0, figureCount: 0, htmlSnippet: '' };
    return {
      imgCount: root.querySelectorAll('img').length,
      figureCount: root.querySelectorAll('figure').length,
      htmlSnippet: String(root.innerHTML || '').slice(0, 1200),
    };
  });

  const result = {
    prepareStatus: prepareRes.status(),
    uploadStatus: uploadRes.status(),
    draftStatus: draftRes.status(),
    uploadSnippet: String(uploadText || '').slice(0, 800),
    after,
  };
  appendLog({ ts: nowIso(), kind: 'after', ...result });
  return result;
}

async function main() {
  ensureArtifacts();

  console.log('[paste-probe] 准备图片（转 PNG）...');
  const pngPath = await fetchAsPngFile();
  appendLog({ ts: nowIso(), kind: 'png_ready', pngPath });

  console.log('[paste-probe] 复制图片到系统剪贴板（AppleScript PNGf）...');
  const clipboardInfo = copyPngToClipboard(pngPath);
  appendLog({ ts: nowIso(), kind: 'clipboard_info', clipboardInfo });
  if (!clipboardInfo.includes('PNGf')) {
    throw new Error(`剪贴板未检测到 PNGf（clipboard info: ${clipboardInfo}）`);
  }

  console.log('[paste-probe] 启动 Chrome for Testing（persistent profile）...');
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

    page.on('request', (req) => {
      try {
        const url = req.url();
        if (!shouldLogUrl(url)) return;
        appendLog({
          ts: nowIso(),
          kind: 'request',
          url,
          method: req.method(),
          headers: pickHeaders(req.headers()),
          postDataSnippet: String(req.postData() || '').slice(0, 1200),
          page: page.url(),
        });
      } catch {
        // ignore
      }
    });

    page.on('response', async (res) => {
      try {
        const url = res.url();
        if (!shouldLogUrl(url)) return;
        const status = res.status();
        let bodySnippet = '';
        if (url.includes('/api/file/v1/upload/prepare') || url.includes('priv-sdn.mowen.cn') || url.includes('/oss/upload/callback')) {
          bodySnippet = String(await res.text().catch(() => '')).slice(0, 2000);
        }
        appendLog({
          ts: nowIso(),
          kind: 'response',
          url,
          status,
          method: res.request().method(),
          headers: pickHeaders(res.headers()),
          bodySnippet,
          page: page.url(),
        });
      } catch {
        // ignore
      }
    });

    console.log('[paste-probe] 打开墨问编辑器...');
    await page.goto('https://note.mowen.cn/editor', { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await waitForEditorReady(page);

    console.log('[paste-probe] 清空编辑器并粘贴图片...');
    await clearEditor(page);
    let after = null;
    try {
      after = await pasteAndWaitUploaded(page);
    } finally {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true }).catch(() => {});
      appendLog({ ts: nowIso(), kind: 'screenshot', path: SCREENSHOT_PATH });
      console.log(`[paste-probe] screenshot -> ${SCREENSHOT_PATH}`);
    }

    if (!after || after.prepareStatus !== 200 || after.uploadStatus !== 200 || after.draftStatus !== 200) {
      throw new Error(`图片粘贴/上传未通过：${JSON.stringify(after || {})}`);
    }

    console.log('[paste-probe] ✅ 图片已粘贴并完成上传（prepare/upload/draft 均 200）');
    appendLog({ ts: nowIso(), kind: 'done', ok: true, after });
  } finally {
    if (!KEEP_BROWSER_OPEN) {
      await context.close().catch(() => {});
    } else {
      console.log(`[paste-probe] KEEP_BROWSER_OPEN=1，保留浏览器打开（profile=${USER_DATA_DIR}）`);
    }
  }
}

main().catch((e) => {
  console.error('\\n❌ mowen image paste probe failed:', e);
  process.exit(1);
});
