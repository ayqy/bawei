import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { execSync, spawn } from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';

const ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts/mowen-image-upload');
const RUN_ID = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const LOG_PATH = path.join(ARTIFACTS_DIR, `probe-${RUN_ID}.ndjson`);
const SCREENSHOT_PATH = path.join(ARTIFACTS_DIR, `probe-${RUN_ID}.png`);

const USER_DATA_DIR = path.resolve(process.cwd(), process.env.CHROME_PROFILE_DIR || 'artifacts/chrome-cdp-live-profile-v8');
const KEEP_BROWSER_OPEN = String(process.env.KEEP_BROWSER_OPEN || '1') !== '0';
const BOOTSTRAP_PROFILE = String(process.env.BOOTSTRAP_PROFILE || '1') !== '0';
const SANITIZE_PROFILE = String(process.env.SANITIZE_PROFILE || '1') !== '0';
const PROFILE_BOOTSTRAP_MARK = '.bootstrap-from-chrome.done';
const BOOTSTRAP_SOURCE_DIR = path.resolve(
  process.env.SOURCE_CHROME_USER_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/Google/Chrome')
);

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

function resolveCftBinary() {
  const byEnv = String(process.env.CFT_BINARY || '').trim();
  if (byEnv) {
    const absByEnv = path.resolve(byEnv);
    if (!fs.existsSync(absByEnv)) throw new Error(`CFT_BINARY 不存在：${absByEnv}`);
    return absByEnv;
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

function cleanChromeSingletonLocks(userDataDir) {
  for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(userDataDir, file), { force: true });
    } catch {
      // ignore
    }
  }
}

function profileCopyFilter(src, sourceRoot) {
  const rel = path.relative(sourceRoot, src);
  if (!rel || rel === '.') return true;
  const normalized = rel.replaceAll('\\', '/');

  if (normalized === 'Default') return true;

  const allowPrefixes = [
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Network',
    'Default/Local Storage',
    'Default/IndexedDB',
    'Default/Session Storage',
    'Default/Storage',
    'Default/Shared Storage',
    'Default/WebStorage',
    'Default/Service Worker/Database',
    'Default/Service Worker/ScriptCache',
  ];

  if (allowPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return true;
  }

  const allowFiles = new Set([
    'Default/Web Data',
    'Default/Web Data-journal',
    'Default/Login Data',
    'Default/Login Data-journal',
  ]);

  return allowFiles.has(normalized);
}

function sanitizeProfileStartupState(userDataDir) {
  const defaultDir = path.join(userDataDir, 'Default');
  if (!fs.existsSync(defaultDir)) return;

  try {
    fs.rmSync(path.join(defaultDir, 'Sessions'), { recursive: true, force: true });
  } catch {
    // ignore
  }

  for (const file of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    try {
      fs.rmSync(path.join(defaultDir, file), { force: true });
    } catch {
      // ignore
    }
  }
}

function maybeBootstrapProfileFromChrome(userDataDir) {
  if (!BOOTSTRAP_PROFILE) return;
  const markFile = path.join(userDataDir, PROFILE_BOOTSTRAP_MARK);
  if (fs.existsSync(markFile)) return;

  if (!fs.existsSync(BOOTSTRAP_SOURCE_DIR)) {
    console.log(`[profile-bootstrap] 跳过：未找到源目录 ${BOOTSTRAP_SOURCE_DIR}`);
    return;
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  console.log(`[profile-bootstrap] 首次引导登录态：${BOOTSTRAP_SOURCE_DIR} -> ${userDataDir}`);

  fs.cpSync(BOOTSTRAP_SOURCE_DIR, userDataDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    dereference: true,
    filter: (src) => profileCopyFilter(src, BOOTSTRAP_SOURCE_DIR),
  });

  cleanChromeSingletonLocks(userDataDir);
  if (SANITIZE_PROFILE) sanitizeProfileStartupState(userDataDir);
  fs.writeFileSync(markFile, `${nowIso()}\n`, 'utf8');
  console.log('[profile-bootstrap] 完成');
}

function ensureArtifacts() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, '');
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

async function buildTestPngBase64() {
  const buf = await sharp({
    create: { width: 280, height: 180, channels: 3, background: { r: 240, g: 90, b: 50 } },
  })
    .png()
    .toBuffer();
  return buf.toString('base64');
}

async function runProbe(page, pngBase64) {
  const variants = [
    {
      name: 'prepare:fileSize-only + upload:x:file_name=File.name',
      prepare: (fileSize) => ({ appSource: 1, bizSource: 6, params: { fileSize } }),
      xFileName: (file) => file.name,
    },
    {
      name: 'prepare:fileSize+fileName+mimeType + upload:x:file_name=File.name',
      prepare: (fileSize, fileName, mimeType) => ({ appSource: 1, bizSource: 6, params: { fileSize, fileName, mimeType } }),
      xFileName: (file) => file.name,
    },
    {
      name: 'prepare:fileSize-only + upload:x:file_name=encodeURIComponent(File.name)',
      prepare: (fileSize) => ({ appSource: 1, bizSource: 6, params: { fileSize } }),
      xFileName: (file) => encodeURIComponent(file.name),
    },
  ];

  for (const variant of variants) {
    console.log(`\n[probe] variant: ${variant.name}`);
    appendLog({ ts: nowIso(), kind: 'variant', name: variant.name });

    const result = await page.evaluate(
      async ({ pngBase64, variantName, variantIndex }) => {
        const decode = (b64) => {
          const bin = atob(b64);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
          return out;
        };

        const payloadVariants = [
          {
            prepare: (fileSize) => ({ appSource: 1, bizSource: 6, params: { fileSize } }),
            xFileName: (file) => file.name,
          },
          {
            prepare: (fileSize, fileName, mimeType) => ({ appSource: 1, bizSource: 6, params: { fileSize, fileName, mimeType } }),
            xFileName: (file) => file.name,
          },
          {
            prepare: (fileSize) => ({ appSource: 1, bizSource: 6, params: { fileSize } }),
            xFileName: (file) => encodeURIComponent(file.name),
          },
        ];

        const variant = payloadVariants[variantIndex];
        if (!variant) throw new Error(`unknown variantIndex: ${variantIndex}`);

        const editor = document.querySelector('.ProseMirror[contenteditable=\"true\"]');
        if (!editor) return { ok: false, stage: 'precheck', error: '未找到 .ProseMirror 编辑器（可能未登录/未打开编辑器）', url: location.href };
        editor.focus();

        const bytes = decode(pngBase64);
        const blob = new Blob([bytes], { type: 'image/png' });
        const file = new File([blob], 'bawei-probe.png', { type: 'image/png' });

        const prepareBody = variant.prepare(file.size, file.name, file.type);
        const prepareRes = await fetch('https://misc.mowen.cn/api/file/v1/upload/prepare', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-mo-ver-wxa': '1.69.3',
          },
          body: JSON.stringify(prepareBody),
        });
        const prepareText = await prepareRes.text();
        let prepareJson = null;
        try {
          prepareJson = JSON.parse(prepareText);
        } catch {
          // ignore
        }
        const form = prepareJson?.form || null;
        if (!form || typeof form !== 'object') {
          return {
            ok: false,
            stage: 'prepare',
            url: location.href,
            prepareStatus: prepareRes.status,
            prepareText: prepareText.slice(0, 1200),
          };
        }
        const endpoint = String(form.endpoint || '').trim();
        if (!endpoint) return { ok: false, stage: 'prepare', error: 'prepare 响应缺少 endpoint', form };

        const fd = new FormData();
        for (const [k, v] of Object.entries(form)) {
          if (k === 'endpoint') continue;
          if (k === 'x:file_name') {
            fd.append(k, variant.xFileName(file));
            continue;
          }
          fd.append(k, String(v ?? ''));
        }
        fd.append('file', file, file.name);

        const uploadRes = await fetch(endpoint, { method: 'POST', body: fd, credentials: 'omit' });
        const uploadText = await uploadRes.text();
        let uploadJson = null;
        try {
          uploadJson = JSON.parse(uploadText);
        } catch {
          // ignore
        }
        return {
          ok: uploadRes.ok,
          stage: 'upload',
          url: location.href,
          prepareStatus: prepareRes.status,
          prepareBody,
          fileMeta: { name: file.name, type: file.type, size: file.size },
          formSummary: {
            endpoint,
            key: String(form.key || ''),
            callbackPresent: Boolean(form.callback),
            x_file_id: String(form['x:file_id'] || ''),
            x_file_uid: String(form['x:file_uid'] || ''),
            x_file_name: String(form['x:file_name'] || ''),
          },
          uploadStatus: uploadRes.status,
          uploadText: uploadText.slice(0, 2000),
          uploadJson,
        };
      },
      { pngBase64, variantName: variant.name, variantIndex: variants.indexOf(variant) }
    );

    appendLog({ ts: nowIso(), kind: 'result', variant: variant.name, result });
    console.log(`[probe] ok=${result.ok} stage=${result.stage} uploadStatus=${result.uploadStatus ?? 'n/a'}`);

    if (result.ok) {
      console.log('[probe] ✅ upload ok');
      return { ok: true, variant: variant.name, result };
    }
  }

  return { ok: false };
}

async function main() {
  ensureArtifacts();
  maybeBootstrapProfileFromChrome(USER_DATA_DIR);
  cleanChromeSingletonLocks(USER_DATA_DIR);

  console.log('[probe] build extension (为了复用同一 profile/环境)...');
  execSync('npm run build', { stdio: 'inherit' });

  const cftBinary = resolveCftBinary();

  const args = [
    '--profile-directory=Default',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    '--window-size=1440,960',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
  ];

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    executablePath: cftBinary,
    args,
  });

  let chromeProcess = null;
  try {
    // 对于 launchPersistentContext，Playwright 自己管理进程；这里仅兼容 KEEP_BROWSER_OPEN=0 时的主动关闭行为。
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
        if (url.includes('/api/file/v1/upload/prepare') || url.includes('priv-sdn.mowen.cn')) {
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

    console.log('[probe] goto mowen editor...');
    await page.goto('https://note.mowen.cn/editor', { waitUntil: 'domcontentloaded', timeout: 120_000 });

    const loginDeadline = Date.now() + 10 * 60_000;
    while (Date.now() < loginDeadline) {
      if (!String(page.url()).includes('account.mowen.cn/auth')) break;
      console.log('[probe] 检测到未登录/跳转登录页，等待登录态恢复...');
      await page.waitForTimeout(1500);
    }

    await page.waitForSelector('.ProseMirror[contenteditable=\"true\"]', { timeout: 10 * 60_000 });

    const pngBase64 = await buildTestPngBase64();
    const probeResult = await runProbe(page, pngBase64);
    appendLog({ ts: nowIso(), kind: 'done', probeResult });

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true }).catch(() => {});
    console.log(`[probe] screenshot -> ${SCREENSHOT_PATH}`);

    if (!probeResult.ok) {
      throw new Error('mowen 图片上传探测：所有变体均失败，请查看 ndjson 日志');
    }
  } finally {
    if (!KEEP_BROWSER_OPEN) {
      try {
        await context.close();
      } catch {
        // ignore
      }
      if (chromeProcess && !chromeProcess.killed) {
        try {
          chromeProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    } else {
      console.log(`[probe] KEEP_BROWSER_OPEN=1，保留浏览器打开（profile=${USER_DATA_DIR}）`);
    }
  }
}

main().catch((e) => {
  console.error('\n❌ mowen image upload probe failed:', e);
  process.exit(1);
});

