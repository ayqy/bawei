import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ALL_CHANNELS = [
  'csdn',
  'tencent-cloud-dev',
  'cnblogs',
  'oschina',
  'woshipm',
  'mowen',
  'sspai',
  'baijiahao',
  'toutiao',
  'feishu-docs',
];

const CHANNEL_ENTRY_URLS = {
  csdn: 'https://mp.csdn.net/mp_blog/creation/editor',
  'tencent-cloud-dev': 'https://cloud.tencent.com/developer/article/write',
  cnblogs: 'https://i.cnblogs.com/posts/edit',
  oschina: 'https://www.oschina.net/blog/write',
  woshipm: 'https://www.woshipm.com/writing',
  mowen: 'https://note.mowen.cn/editor',
  sspai: 'https://sspai.com/write',
  baijiahao: 'https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1',
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  'feishu-docs': 'https://wuxinxuexi.feishu.cn/drive/folder/PyWAfSFwrlMgiydvlHectMn2nSd',
};

const LOGIN_URL_RULES = {
  csdn: [/passport\.csdn\.net\/login/i, /\/login/i],
  'tencent-cloud-dev': [/cloud\.tencent\.com\/login/i, /\/account\/login/i, /\/login/i],
  cnblogs: [/account\.cnblogs\.com\/signin/i, /\/signin/i, /\/login/i],
  oschina: [/oschina\.net\/home\/login/i, /\/login/i],
  woshipm: [/passport/i, /\/login/i, /\/signin/i],
  mowen: [/\/login/i, /\/signin/i],
  sspai: [/\/login/i, /\/signin/i],
  baijiahao: [/passport/i, /\/login/i],
  toutiao: [/\/auth\/page\/login/i, /\/login/i],
  'feishu-docs': [/passport\.feishu\.cn/i, /\/login/i, /\/signin/i],
};

const PER_CHANNEL_TIMEOUT_MS = 10 * 60_000;
const NO_PROGRESS_TIMEOUT_MS = Number(process.env.NO_PROGRESS_TIMEOUT_MS || 180_000);
const LOOP_INTERVAL_MS = 3000;
const CHROME_CDP_PORT = Number(process.env.CDP_PORT || 52607);
const STORAGE_STATE_PATH = String(process.env.STORAGE_STATE_PATH || 'tmp/mcp-storageState.json').trim();
const KEEP_BROWSER_OPEN = String(process.env.KEEP_BROWSER_OPEN || '1') !== '0';
const USE_BACKGROUND_DIRECT = String(process.env.USE_BACKGROUND_DIRECT || '1') !== '0';
const BOOTSTRAP_PROFILE = String(process.env.BOOTSTRAP_PROFILE || '1') !== '0';
const SANITIZE_PROFILE = String(process.env.SANITIZE_PROFILE || '1') !== '0';
const PROFILE_BOOTSTRAP_MARK = '.bootstrap-from-chrome.done';
const BOOTSTRAP_SOURCE_DIR = path.resolve(
  process.env.SOURCE_CHROME_USER_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/Google/Chrome')
);

function abs(p) {
  return path.resolve(process.cwd(), p);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function forceBypassProxyForLocalCdp() {
  const prevNoProxy = String(process.env.NO_PROXY || process.env.no_proxy || '');
  const required = ['127.0.0.1', 'localhost'];
  const nextNoProxy = Array.from(new Set(prevNoProxy.split(',').concat(required).map((s) => s.trim()).filter(Boolean))).join(',');
  process.env.NO_PROXY = nextNoProxy;
  process.env.no_proxy = nextNoProxy;

  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    if (process.env[key]) {
      delete process.env[key];
    }
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

  // 仅引导站点登录态相关数据，避免把扩展/启动偏好复制进来导致 service worker 启动失败。
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

  for (const dir of ['Extensions', 'Extension State', 'Extension Scripts', 'Extension Rules', 'Extension Cookies']) {
    try {
      fs.rmSync(path.join(defaultDir, dir), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  const cleanPreferenceFile = (prefPath) => {
    try {
      if (!fs.existsSync(prefPath)) return;
      const parsed = JSON.parse(fs.readFileSync(prefPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return;
      if (!parsed.profile || typeof parsed.profile !== 'object') parsed.profile = {};
      if (!parsed.session || typeof parsed.session !== 'object') parsed.session = {};
      parsed.profile.exit_type = 'Normal';
      parsed.profile.exited_cleanly = true;
      parsed.session.restore_on_startup = 5;
      parsed.session.startup_urls = [];
      if (parsed.extensions && typeof parsed.extensions === 'object') {
        delete parsed.extensions;
      }
      fs.writeFileSync(prefPath, JSON.stringify(parsed));
    } catch {
      // ignore
    }
  };

  cleanPreferenceFile(path.join(defaultDir, 'Preferences'));
  cleanPreferenceFile(path.join(defaultDir, 'Secure Preferences'));
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
  sanitizeProfileStartupState(userDataDir);
  fs.writeFileSync(markFile, `${nowIso()}\n`, 'utf8');
  console.log('[profile-bootstrap] 完成');
}

function normalizeBadge(badge) {
  const raw = String(badge || '').trim();
  if (!raw) return 'not_started';
  const text = raw.toLowerCase();

  if (text === 'success' || text.includes('成功')) return 'success';
  if (text === 'running' || text.includes('进行中')) return 'running';
  if (text === 'waiting_user' || text === 'waiting' || text.includes('等待处理')) return 'waiting_user';
  if (text === 'not_logged_in' || text === 'not-logged-in' || text.includes('未登录')) return 'not_logged_in';
  if (text === 'failed' || text.includes('失败')) return 'failed';
  if (text === 'not_started' || text === 'not-started' || text === 'pending' || text.includes('未开始')) return 'not_started';

  return 'unknown';
}

function createProgress(articleUrl) {
  const channels = {};
  for (const id of ALL_CHANNELS) channels[id] = { status: 'pending', notes: '', updatedAt: nowIso(), attempts: 0 };
  return { updatedAt: nowIso(), articleUrl, channels };
}

function loadProgress(filePath, articleUrl) {
  try {
    if (!fs.existsSync(filePath)) return createProgress(articleUrl);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.channels) return createProgress(articleUrl);
    parsed.articleUrl = articleUrl;
    for (const id of ALL_CHANNELS) {
      if (!parsed.channels[id]) parsed.channels[id] = { status: 'pending', notes: '', updatedAt: nowIso(), attempts: 0 };
      if (parsed.channels[id].attempts == null) parsed.channels[id].attempts = 0;
      if (parsed.channels[id].updatedAt == null) parsed.channels[id].updatedAt = nowIso();
      if (parsed.channels[id].status === 'running') parsed.channels[id].status = 'pending';
    }
    return parsed;
  } catch {
    return createProgress(articleUrl);
  }
}

function saveProgress(filePath, progress) {
  progress.updatedAt = nowIso();
  fs.writeFileSync(filePath, `${JSON.stringify(progress, null, 2)}\n`);
}

function createLoginAudit(articleUrl) {
  const channels = {};
  for (const id of ALL_CHANNELS) channels[id] = { status: 'unknown', reason: '', url: '', updatedAt: nowIso() };
  return { updatedAt: nowIso(), articleUrl, channels };
}

function saveLoginAudit(filePath, audit) {
  audit.updatedAt = nowIso();
  fs.writeFileSync(filePath, `${JSON.stringify(audit, null, 2)}\n`);
}

function updateChannelProgress(progress, channelId, status, notes) {
  const row = progress.channels[channelId] || { status: 'pending', notes: '', attempts: 0, updatedAt: nowIso() };
  row.status = status;
  row.notes = String(notes || '').trim();
  row.updatedAt = nowIso();
  progress.channels[channelId] = row;
}

function incAttempt(progress, channelId) {
  const row = progress.channels[channelId] || { status: 'pending', notes: '', attempts: 0, updatedAt: nowIso() };
  row.attempts = Number(row.attempts || 0) + 1;
  row.updatedAt = nowIso();
  progress.channels[channelId] = row;
}

function containsImageFail(text) {
  const t = String(text || '');
  return t.includes('图片自动上传失败') || t.includes('请手动上传') || t.includes('image insert failed') || t.includes('fetch image failed');
}

function isBlockingRuntimeResult(status) {
  return status === 'not_logged_in' || status === 'failed' || status === 'waiting_user' || status === 'timeout' || status === 'stalled';
}

function normalizeSameSite(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'lax') return 'Lax';
  if (raw === 'strict') return 'Strict';
  if (raw === 'none' || raw === 'no_restriction') return 'None';
  return undefined;
}

async function maybeImportStorageState(context) {
  const statePath = STORAGE_STATE_PATH ? abs(STORAGE_STATE_PATH) : '';
  if (!statePath || !fs.existsSync(statePath)) return;

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return;
  }

  const rawCookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const nowSec = Math.floor(Date.now() / 1000);
  const cookies = rawCookies
    .map((cookie) => {
      const name = String(cookie?.name || '').trim();
      const value = String(cookie?.value || '');
      const domain = String(cookie?.domain || '').trim();
      const pathValue = String(cookie?.path || '/').trim() || '/';
      if (!name || !domain) return null;

      const out = {
        name,
        value,
        domain,
        path: pathValue,
        httpOnly: !!cookie?.httpOnly,
        secure: !!cookie?.secure,
      };

      const expires = Number(cookie?.expires);
      if (Number.isFinite(expires) && expires > nowSec + 30) {
        out.expires = expires;
      }
      const sameSite = normalizeSameSite(cookie?.sameSite);
      if (sameSite) out.sameSite = sameSite;
      return out;
    })
    .filter(Boolean);

  if (cookies.length) {
    try {
      await context.addCookies(cookies);
      console.log(`[storage-state] cookies imported: ${cookies.length}`);
    } catch (error) {
      console.log(`[storage-state] cookies import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const allowHosts = [
    'mp.csdn.net',
    'cloud.tencent.com',
    'i.cnblogs.com',
    'www.oschina.net',
    'www.woshipm.com',
    'note.mowen.cn',
    'sspai.com',
    'baijiahao.baidu.com',
    'mp.toutiao.com',
    'wuxinxuexi.feishu.cn',
    'accounts.feishu.cn',
  ];

  const origins = Array.isArray(parsed?.origins) ? parsed.origins : [];
  for (const originItem of origins) {
    const origin = String(originItem?.origin || '').trim();
    if (!origin) continue;
    let host = '';
    try {
      host = new URL(origin).hostname;
    } catch {
      continue;
    }
    if (!allowHosts.includes(host)) continue;

    const storageEntries = Array.isArray(originItem?.localStorage) ? originItem.localStorage : [];
    if (!storageEntries.length) continue;

    const page = await context.newPage();
    try {
      await gotoWithRetry(page, origin);
      await page.evaluate((entries) => {
        for (const item of entries || []) {
          const key = String(item?.name || '');
          if (!key) continue;
          const value = String(item?.value || '');
          try {
            localStorage.setItem(key, value);
          } catch {
            // ignore
          }
        }
      }, storageEntries);
    } catch {
      // ignore
    } finally {
      await page.close().catch(() => {});
    }
  }
  console.log('[storage-state] origin localStorage import done');
}

function killPortListeners(port) {
  try {
    const pids = String(execSync(`lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`) || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function tryGetWsUrl(port) {
  return new Promise((resolve) => {
    http
      .get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const obj = JSON.parse(data || '{}');
            resolve(String(obj.webSocketDebuggerUrl || ''));
          } catch {
            resolve('');
          }
        });
      })
      .on('error', () => resolve(''));
  });
}

function tryGetTargets(port) {
  return new Promise((resolve) => {
    http
      .get(`http://127.0.0.1:${port}/json/list`, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const arr = JSON.parse(data || '[]');
            resolve(Array.isArray(arr) ? arr : []);
          } catch {
            resolve([]);
          }
        });
      })
      .on('error', () => resolve([]));
  });
}

function hasBaweiExtensionServiceWorker(targets) {
  return targets.some((t) => String(t?.type || '') === 'service_worker' && String(t?.url || '').includes('/src/background.js'));
}

async function waitBaweiExtensionReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await tryGetTargets(port);
    if (hasBaweiExtensionServiceWorker(targets)) return true;
    await sleep(600);
  }
  return false;
}

async function ensureChromeAndGetWs(params) {
  const { port, userDataDir, distDir } = params;

  const existingWs = await tryGetWsUrl(port);
  if (existingWs) {
    const ready = await waitBaweiExtensionReady(port, 3000);
    if (ready) {
      console.log(`[cdp] 复用现有实例（port=${port}）`);
      return { ws: existingWs, chromeProcess: null, reused: true };
    }
    console.log(`[cdp] 端口 ${port} 已有实例但未检测到 bawei 扩展，准备重启`);
  }

  killPortListeners(port);
  maybeBootstrapProfileFromChrome(userDataDir);
  cleanChromeSingletonLocks(userDataDir);
  if (SANITIZE_PROFILE) sanitizeProfileStartupState(userDataDir);

  const cftBinary = resolveCftBinary();
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
    '--window-size=1440,960',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    'about:blank',
  ];

  const chromeProcess = spawn(cftBinary, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = false;
  chromeProcess.once('exit', (code, signal) => {
    exited = true;
    console.log(`[chrome] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });
  chromeProcess.stderr?.on('data', (buf) => {
    const line = String(buf || '').trim();
    if (!line) return;
    if (line.includes('DevTools listening on') || line.includes('Network service crashed')) return;

    const noisy = [
      '_TIPropertyValueIsValid',
      'imkxpc_setApplicationProperty',
      'SharedImageManager::ProduceOverlay',
      'Invalid mailbox',
      'socket_manager.cc',
      'google_apis/gcm',
      'SetApplicationIsDaemon',
      'q-signature=',
    ];
    if (noisy.some((k) => line.includes(k))) return;

    if (/error|fatal|crash|exception/i.test(line)) {
      console.log(`[chrome:stderr] ${line}`);
    }
  });

  const deadline = Date.now() + 60_000;
  let ws = '';
  while (Date.now() < deadline) {
    if (exited) break;
    ws = await tryGetWsUrl(port);
    if (ws) {
      const ready = await waitBaweiExtensionReady(port, 30_000);
      if (!ready) {
        console.log('[cdp] Chrome 已启动，但暂未检测到扩展 service_worker，后续在 bridge 阶段继续拉起');
      }
      return { ws, chromeProcess, reused: false };
    }
    await sleep(700);
  }

  if (exited) {
    throw new Error(`Chrome for Testing 启动后提前退出（port=${port}）`);
  }
  throw new Error(`无法连接 Chrome DevTools（port=${port}）`);
}

async function gotoWithRetry(page, url) {
  const timeouts = [60_000, 120_000, 180_000];
  let lastErr = null;
  for (let i = 0; i < timeouts.length; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeouts[i] });
      return;
    } catch (e) {
      lastErr = e;
      console.log(`[goto] 失败：${url}（${i + 1}/${timeouts.length}），${e?.message || e}`);
      await sleep(2000);
    }
  }
  throw lastErr || new Error(`goto failed: ${url}`);
}

async function readRuntimeState(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('#bawei-v2-runtime-state');
      if (!el) return null;
      const raw = String(el.textContent || '').trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    });
  } catch {
    return null;
  }
}

async function waitForPanel(page) {
  await page.waitForLoadState('domcontentloaded');
  const deadline = Date.now() + 12 * 60_000;
  let lastHint = 0;
  let lastProbeLog = 0;
  let probeTimeoutStreak = 0;

  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('mp/wappoc_appmsgcaptcha') || url.includes('secitptpage/verify')) {
      if (Date.now() - lastHint > 8000) {
        console.log('[微信] 命中验证页，等待恢复...');
        lastHint = Date.now();
      }
      await sleep(3000);
      continue;
    }

    let probe = null;
    try {
      probe = await withTimeout(
        page.evaluate(() => {
          const panel = document.querySelector('#bawei-v2-panel');
          const launcher = document.querySelector('#bawei-v2-launcher');
          const mirror = document.querySelector('#bawei-v2-runtime-state');
          const panelVisible = (() => {
            if (!(panel instanceof HTMLElement)) return false;
            const rect = panel.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const s = getComputedStyle(panel);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
            return true;
          })();
          return {
            hasPanel: !!panel,
            hasLauncher: !!launcher,
            hasMirror: !!mirror,
            panelVisible,
          };
        }),
        10_000,
        'probeWechatPanel'
      );
    } catch (error) {
      probeTimeoutStreak += 1;
      console.log(`[wechat-panel] probe timeout: ${error instanceof Error ? error.message : String(error)}`);
      if (probeTimeoutStreak >= 3) {
        probeTimeoutStreak = 0;
        console.log('[wechat-panel] probe 连续超时，尝试刷新微信文章页');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => {});
      }
      await sleep(1200);
      continue;
    }
    probeTimeoutStreak = 0;
    const hasPanel = !!probe?.hasPanel;
    const hasLauncher = !!probe?.hasLauncher;
    const hasMirror = !!probe?.hasMirror;
    const panelVisible = !!probe?.panelVisible;
    if (Date.now() - lastProbeLog > 15_000) {
      console.log(`[wechat-panel] probe url=${url} hasPanel=${hasPanel} hasLauncher=${hasLauncher} hasMirror=${hasMirror}`);
      lastProbeLog = Date.now();
    }

    if (!hasPanel) {
      if (hasLauncher) {
        await page.click('#bawei-v2-launcher').catch(() => {});
      } else if (hasMirror) {
        await page
          .evaluate(() => {
            try {
              window.dispatchEvent(new CustomEvent('bawei-v2-ensure-panel', { detail: { action: 'show' } }));
            } catch {
              // ignore
            }
            const launcher = document.querySelector('#bawei-v2-launcher');
            if (launcher instanceof HTMLElement) launcher.click();
          })
          .catch(() => {});
      }
      await sleep(1000);
      continue;
    }

    if (!panelVisible) {
      if (hasLauncher) await page.click('#bawei-v2-launcher').catch(() => {});
      else if (hasMirror) {
        await page
          .evaluate(() => {
            try {
              window.dispatchEvent(new CustomEvent('bawei-v2-ensure-panel', { detail: { action: 'show' } }));
            } catch {
              // ignore
            }
          })
          .catch(() => {});
      }
      await sleep(500);
      continue;
    }

    return;
  }

  throw new Error('等待扩展面板注入超时');
}

async function ensureWechatPanelReady(page, articleUrl, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await gotoWithRetry(page, articleUrl);
      await withTimeout(waitForPanel(page), 180_000, `waitForPanel:${label}:#${attempt}`);
      return;
    } catch (error) {
      lastError = error;
      console.log(`[wechat-panel] ensure failed (${attempt}/3): ${error instanceof Error ? error.message : String(error)}`);
      await sleep(2000);
    }
  }
  throw lastError || new Error('ensureWechatPanelReady failed');
}

async function runtimeEvaluateByWs(wsUrl, expression) {
  return await withTimeout(
    new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);

      const closeSafe = () => {
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        } catch {
          // ignore
        }
      };

      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        closeSafe();
        fn(value);
      };

      ws.addEventListener('open', () => {
        try {
          ws.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: {
                expression,
                awaitPromise: true,
                returnByValue: true,
              },
            })
          );
        } catch (error) {
          done(reject, error);
        }
      });

      ws.addEventListener('message', (event) => {
        let payload;
        try {
          payload = JSON.parse(String(event.data || ''));
        } catch {
          return;
        }
        if (!payload || payload.id !== 1) return;

        if (payload.error) {
          done(reject, new Error(String(payload.error.message || payload.error.code || 'Runtime.evaluate failed')));
          return;
        }

        if (payload.result?.exceptionDetails) {
          const text = String(payload.result.exceptionDetails.text || payload.result.result?.description || 'Runtime.evaluate exception');
          done(reject, new Error(text));
          return;
        }

        const resultObj = payload.result?.result || {};
        if (Object.prototype.hasOwnProperty.call(resultObj, 'value')) {
          done(resolve, resultObj.value);
          return;
        }
        if (Object.prototype.hasOwnProperty.call(resultObj, 'unserializableValue')) {
          done(resolve, resultObj.unserializableValue);
          return;
        }
        done(resolve, null);
      });

      ws.addEventListener('error', () => {
        done(reject, new Error('CDP worker websocket error'));
      });

      ws.addEventListener('close', () => {
        if (!settled) done(reject, new Error('CDP worker websocket closed before response'));
      });
    }),
    20_000,
    'runtimeEvaluateByWs'
  );
}

async function findBackgroundWorkerTarget() {
  const targets = await tryGetTargets(CHROME_CDP_PORT);
  const worker = targets.find(
    (t) => String(t?.type || '') === 'service_worker' && String(t?.url || '').includes('/src/background.js') && t?.webSocketDebuggerUrl
  );
  return worker || null;
}

async function createBackgroundBridge() {
  const deadline = Date.now() + 120_000;
  let noTargetCount = 0;
  while (Date.now() < deadline) {
    const target = await findBackgroundWorkerTarget();
    if (!target) {
      noTargetCount += 1;
      if (noTargetCount % 10 === 0) {
        const targets = await tryGetTargets(CHROME_CDP_PORT).catch(() => []);
        console.log(
          `[background-bridge] waiting worker... seenTargets=${Array.isArray(targets) ? targets.length : 0} sample=${(targets || [])
            .slice(0, 3)
            .map((t) => `${t?.type}:${String(t?.url || '').slice(0, 80)}`)
            .join(' | ')}`
        );
      }
      await sleep(1200);
      continue;
    }

    const wsUrl = String(target.webSocketDebuggerUrl || '').trim();
    if (!wsUrl) {
      await sleep(1200);
      continue;
    }

    try {
      const probe = await runtimeEvaluateByWs(
        wsUrl,
        `(() => ({
          runtimeId: String(chrome?.runtime?.id || ''),
          hasDirect: typeof globalThis.__BAWEI_V2_DISPATCH_DIRECT === 'function',
          hasRuntimeDirect: typeof chrome?.runtime?.__BAWEI_V2_DISPATCH_DIRECT === 'function',
          hasChromeDirect: typeof chrome?.__BAWEI_V2_DISPATCH_DIRECT === 'function'
        }))()`
      );
      const runtimeId = String(probe?.runtimeId || '');
      if (runtimeId) {
        console.log(
          `[background-bridge] worker ready runtimeId=${runtimeId} hasDirect=${Boolean(probe?.hasDirect)} hasRuntimeDirect=${Boolean(
            probe?.hasRuntimeDirect
          )} hasChromeDirect=${Boolean(probe?.hasChromeDirect)}`
        );
        return { wsUrl, runtimeId };
      }
    } catch (error) {
      console.log(`[background-bridge] probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(1200);
  }
  throw new Error('未找到扩展 background service worker target');
}

async function evalInBackground(bridge, expression) {
  return await runtimeEvaluateByWs(bridge.wsUrl, expression);
}

async function loadArticlePayloadFromBackground(bridge, articleUrl) {
  const expression = `(() => (async () => {
    const all = await chrome.storage.local.get(null);
    const jobs = Object.entries(all || {})
      .filter(([k, v]) => k.startsWith('bawei_v2_job_') && v && typeof v === 'object' && v.article && typeof v.article.contentHtml === 'string')
      .map(([, v]) => v)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    const expected = ${JSON.stringify(articleUrl)};
    const hit = jobs.find((j) => String(j?.article?.sourceUrl || '') === expected) || jobs[0] || null;
    if (!hit) return null;
    const article = hit.article || {};
    return {
      title: String(article.title || ''),
      contentHtml: String(article.contentHtml || ''),
      sourceUrl: String(article.sourceUrl || expected || ''),
      contentTokens: Array.isArray(article.contentTokens) ? article.contentTokens : undefined,
    };
  })())()`;
  return await evalInBackground(bridge, expression);
}

async function sendBackgroundMessage(bridge, message) {
  const expression = `(() => (async () => {
    const req = ${JSON.stringify(message)};
    const fn =
      globalThis.__BAWEI_V2_DISPATCH_DIRECT ||
      chrome?.runtime?.__BAWEI_V2_DISPATCH_DIRECT ||
      chrome?.__BAWEI_V2_DISPATCH_DIRECT;
    if (typeof fn !== 'function') {
      return { success: false, error: '__BAWEI_V2_DISPATCH_DIRECT not found' };
    }
    return await fn(req);
  })())()`;
  return await evalInBackground(bridge, expression);
}

async function startSingleChannelJobDirect(bridge, channelId, article) {
  const response = await sendBackgroundMessage(bridge, {
    type: 'V2_START_JOB',
    action: 'publish',
    focusChannel: channelId,
    channels: [channelId],
    article,
  });
  if (!response?.success || !response?.jobId) {
    console.log(`[publish:${channelId}] direct start response=`, response);
    throw new Error(response?.error || `V2_START_JOB failed: ${channelId}`);
  }
  console.log(`[publish:${channelId}] direct started jobId=${response.jobId}`);
  return String(response.jobId);
}

async function getJobStateDirect(bridge, jobId) {
  const expression = `(() => (async () => {
    const key = ${JSON.stringify(`bawei_v2_state_${jobId}`)};
    const out = await chrome.storage.local.get(key);
    return out?.[key] || null;
  })())()`;
  return await evalInBackground(bridge, expression);
}

async function waitSingleChannelResultDirect({ bridge, jobId, channelId, progress, progressPath }) {
  const timeoutMs = channelId === 'sspai' ? Math.min(PER_CHANNEL_TIMEOUT_MS, 180_000) : PER_CHANNEL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastNotes = '';
  let lastProgressAt = Date.now();

  while (Date.now() < deadline) {
    let row = null;
    try {
      const state = await withTimeout(getJobStateDirect(bridge, jobId), 10_000, `getJobStateDirect:${channelId}`);
      row = state?.[channelId] || null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      updateChannelProgress(progress, channelId, 'running', `读取后台状态失败重试 | ${reason}`);
      saveProgress(progressPath, progress);
      await sleep(Math.min(6_000, LOOP_INTERVAL_MS * 2));
      continue;
    }

    const status = normalizeBadge(String(row?.status || '').trim());
    const progressText = String(row?.userMessage || row?.stage || '').trim();
    const notes = `${row?.status || status} | ${progressText}`.trim();
    const now = Date.now();

    if (notes !== lastNotes) {
      lastNotes = notes;
      lastProgressAt = now;
    }

    if (status !== 'not_started') {
      updateChannelProgress(progress, channelId, status, notes);
      saveProgress(progressPath, progress);
    }

    if (status === 'success') {
      const diag = `${String(row?.userMessage || '')}\n${String(row?.userSuggestion || '')}\n${String(row?.devDetails?.message || '')}`.trim();
      if (containsImageFail(`${notes}\n${diag}`)) {
        const failNotes = `成功态拦截：检测到图片失败痕迹\n${diag || notes}`;
        updateChannelProgress(progress, channelId, 'failed', failNotes);
        saveProgress(progressPath, progress);
        return { status: 'failed', notes: failNotes };
      } else {
        updateChannelProgress(progress, channelId, 'success', `发布成功 | ${progressText}`);
        saveProgress(progressPath, progress);
        return { status: 'success' };
      }
    }

    if (status === 'not_logged_in') return { status: 'not_logged_in', notes };
    if (status === 'waiting_user' || status === 'failed') return { status: 'failed', notes };

    if (status !== 'success' && now - lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
      return { status: 'stalled', notes: `${status} | ${notes}` };
    }
    if (channelId === 'sspai' && status === 'running' && String(row?.stage || '') === 'fillContent' && now - lastProgressAt > 90_000) {
      return { status: 'stalled', notes: 'sspai fillContent no progress (90s)' };
    }

    await sleep(LOOP_INTERVAL_MS);
  }

  return { status: 'timeout' };
}

async function setFocusChannel(page, channelId) {
  await page.evaluate((value) => {
    const sel = document.querySelector('#bawei-v2-focus-channel');
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }, channelId);
}

async function setActionPublish(page) {
  await page.check('input[name="bawei_v2_action"][value="publish"]').catch(() => {});
}

async function setChannelSelection(page, wantedSet) {
  for (const id of ALL_CHANNELS) {
    const sel = `#bawei-v2-run-${id}`;
    if (!(await page.locator(sel).count())) continue;
    await page.setChecked(sel, wantedSet.has(id));
  }
}

async function waitStartReady(page) {
  await page.waitForFunction(() => {
    const btn = document.querySelector('#bawei-v2-start');
    if (!(btn instanceof HTMLButtonElement)) return false;
    const txt = String(btn.textContent || '');
    return !btn.disabled && (txt.includes('开始') || txt.toLowerCase().includes('start'));
  }, null, { timeout: 120_000 });
}

async function stopIfExecuting(page) {
  const shouldStop = await page.evaluate(() => {
    const btn = document.querySelector('#bawei-v2-start');
    if (!(btn instanceof HTMLButtonElement)) return false;
    const txt = String(btn.textContent || '');
    return !btn.disabled && (txt.includes('停止') || txt.toLowerCase().includes('stop'));
  });
  if (!shouldStop) return;
  await page.click('#bawei-v2-start').catch(() => {});
  await sleep(1200);
  await waitStartReady(page).catch(() => {});
}

async function readRows(page) {
  return await page.evaluate((channelIds) => {
    const out = {};
    const statusToBadge = (status) => {
      const s = String(status || '').trim();
      if (s === 'success') return '成功';
      if (s === 'running') return '进行中';
      if (s === 'waiting_user') return '等待处理';
      if (s === 'not_logged_in') return '未登录';
      if (s === 'failed') return '失败';
      if (s === 'not_started') return '未开始';
      return s;
    };

    let mirrorState = null;
    let mirrorRunChannels = [];
    try {
      const mirror = document.querySelector('#bawei-v2-runtime-state');
      const raw = String(mirror?.textContent || '').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const maybeState = parsed.state;
          if (maybeState && typeof maybeState === 'object') mirrorState = maybeState;
          if (Array.isArray(parsed.runChannels)) {
            mirrorRunChannels = parsed.runChannels.filter((x) => typeof x === 'string');
          }
        }
      }
    } catch {
      // ignore
    }

    for (const id of channelIds) {
      const cb = document.querySelector(`#bawei-v2-run-${id}`);
      const mirrorRow = mirrorState && typeof mirrorState === 'object' ? mirrorState[id] : null;

      if (cb) {
        const row = cb.closest('div');
        const right = row?.querySelector(':scope > div');
        const spans = Array.from(right?.querySelectorAll('span') || []);
        const badgeRaw = (spans[0]?.textContent || '').trim();
        const progressRaw = (spans[1]?.textContent || '').trim();
        const btn = right?.querySelector('button');

        const mirrorStatus = String(mirrorRow?.status || '').trim();
        const mirrorProgress = String(mirrorRow?.userMessage || mirrorRow?.stage || '').trim();
        const badge = badgeRaw || statusToBadge(mirrorStatus);
        const progress = progressRaw || mirrorProgress;
        const buttonText = (btn?.textContent || '').trim();

        out[id] = {
          exists: true,
          checked: !!cb.checked,
          badge,
          progress,
          hasButton: !!btn || mirrorStatus === 'waiting_user' || mirrorStatus === 'failed' || mirrorStatus === 'not_logged_in',
          buttonText: buttonText || (mirrorStatus === 'waiting_user' ? '继续' : mirrorStatus === 'failed' || mirrorStatus === 'not_logged_in' ? '重试' : ''),
        };
        continue;
      }

      if (mirrorRow && typeof mirrorRow === 'object') {
        const mirrorStatus = String(mirrorRow.status || 'not_started').trim();
        const mirrorProgress = String(mirrorRow.userMessage || mirrorRow.stage || '').trim();
        out[id] = {
          exists: true,
          checked: mirrorRunChannels.length ? mirrorRunChannels.includes(id) : true,
          badge: statusToBadge(mirrorStatus),
          progress: mirrorProgress,
          hasButton: mirrorStatus === 'waiting_user' || mirrorStatus === 'failed' || mirrorStatus === 'not_logged_in',
          buttonText: mirrorStatus === 'waiting_user' ? '继续' : mirrorStatus === 'failed' || mirrorStatus === 'not_logged_in' ? '重试' : '',
        };
        continue;
      }

      out[id] = { exists: false, checked: false, badge: '', progress: '', hasButton: false, buttonText: '' };
    }
    return out;
  }, ALL_CHANNELS);
}

async function readDiagnosis(page, channelId) {
  await setFocusChannel(page, channelId);
  await sleep(200);
  const text = await page
    .evaluate((id) => {
      const diag = document.querySelector('#bawei-v2-diagnosis');
      const direct = String(diag?.textContent || '').trim();
      if (direct) return direct;

      try {
        const mirror = document.querySelector('#bawei-v2-runtime-state');
        const raw = String(mirror?.textContent || '').trim();
        if (!raw) return '';
        const parsed = JSON.parse(raw);
        const st = parsed?.state?.[id];
        if (!st) return '';
        const parts = [
          String(st.status || ''),
          String(st.stage || ''),
          String(st.userMessage || ''),
          String(st.userSuggestion || ''),
        ].filter(Boolean);
        return parts.join(' | ');
      } catch {
        return '';
      }
    }, channelId)
    .catch(() => '');
  return String(text || '').trim();
}

async function inspectLoginStateOnPage(page, channelId) {
  const info = await page.evaluate(() => {
    const bodyText = String(document.body?.innerText || '').slice(0, 5000);
    const hasPwd = !!document.querySelector('input[type="password"]');
    const hasLoginBtn = Array.from(document.querySelectorAll('button,a,div,span')).some((el) => {
      const t = String(el.textContent || '').trim();
      if (!t) return false;
      return /登录|登入|sign in|log in|继续登录|扫码登录|手机号登录/i.test(t);
    });
    const hasCaptchaHints = /验证码|安全验证|风控|请完成验证|访问异常|环境异常|行为验证|滑动验证|captcha|human verification/i.test(bodyText);
    const hasLoggedInHints = /个人中心|退出登录|发文章|创作中心|发布入口|写文章|我的主页/i.test(bodyText);
    return { bodyText, hasPwd, hasLoginBtn, hasCaptchaHints, hasLoggedInHints };
  });

  const url = String(page.url() || '');
  const lowUrl = url.toLowerCase();
  const byUrl = (LOGIN_URL_RULES[channelId] || []).some((r) => r.test(lowUrl)) || /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i.test(lowUrl);
  const strictLoginText = /请登录|未登录|登录后继续|登录即可|请先登录|扫码登录|手机号登录|sign in|log in/i.test(info.bodyText || '');
  const byDom = (info.hasPwd && info.hasLoginBtn) || strictLoginText;

  if (info.hasLoggedInHints && !byDom) return { status: 'logged_in', reason: 'logged-in-dom-hints', url };
  if (byUrl || byDom) return { status: 'not_logged_in', reason: byUrl ? 'login-url' : 'login-dom', url };
  if (info.hasCaptchaHints) return { status: 'unknown', reason: 'captcha-or-risk-page', url };
  return { status: 'logged_in', reason: 'entry-page-accessible', url };
}

async function auditLoginStatus(context, audit, auditPath) {
  const loginPages = new Map();

  for (const channelId of ALL_CHANNELS) {
    const entry = CHANNEL_ENTRY_URLS[channelId];
    const page = await context.newPage();
    try {
      await gotoWithRetry(page, entry);
      await sleep(2200);
      const result = await inspectLoginStateOnPage(page, channelId);
      audit.channels[channelId] = { status: result.status, reason: result.reason, url: result.url, updatedAt: nowIso() };
      const needManual =
        result.status === 'not_logged_in' || (result.status === 'unknown' && String(result.reason || '').includes('captcha-or-risk-page'));
      if (needManual) loginPages.set(channelId, page);
      else await page.close().catch(() => {});
      console.log(`[login-audit] ${channelId}: ${result.status} (${result.reason}) ${result.url}`);
    } catch (error) {
      audit.channels[channelId] = {
        status: 'unknown',
        reason: `audit-error: ${error instanceof Error ? error.message : String(error)}`,
        url: String(page.url() || entry),
        updatedAt: nowIso(),
      };
      await page.close().catch(() => {});
      console.log(`[login-audit] ${channelId}: unknown (${error instanceof Error ? error.message : String(error)})`);
    }
    saveLoginAudit(auditPath, audit);
  }

  return loginPages;
}

async function ensureLoginPageOpen(context, loginPages, channelId) {
  let page = loginPages.get(channelId);
  if (!page || page.isClosed()) {
    page = await context.newPage();
    loginPages.set(channelId, page);
    await gotoWithRetry(page, CHANNEL_ENTRY_URLS[channelId]).catch(() => {});
  }
  return page;
}

async function startSingleChannelJob(page, channelId) {
  console.log(`[publish:${channelId}] start job prepare`);
  await withTimeout(waitForPanel(page), 13 * 60_000, `waitForPanel:${channelId}`);
  await withTimeout(stopIfExecuting(page), 45_000, `stopIfExecuting:${channelId}`);
  await withTimeout(waitStartReady(page), 90_000, `waitStartReady:${channelId}`);
  await withTimeout(setActionPublish(page), 10_000, `setActionPublish:${channelId}`);
  await withTimeout(setFocusChannel(page, channelId), 10_000, `setFocusChannel:${channelId}`);
  await withTimeout(setChannelSelection(page, new Set([channelId])), 12_000, `setChannelSelection:${channelId}`);
  await withTimeout(
    page.evaluate(() => {
      const btn = document.querySelector('#bawei-v2-start');
      if (!(btn instanceof HTMLButtonElement)) throw new Error('start button not found');
      setTimeout(() => {
        try {
          btn.click();
        } catch {
          // ignore
        }
      }, 0);
    }),
    10_000,
    `clickStart:${channelId}`
  );
  console.log(`[publish:${channelId}] start clicked`);
  await sleep(1200);
}

async function waitSingleChannelResult({ page, channelId, progress, progressPath }) {
  const deadline = Date.now() + PER_CHANNEL_TIMEOUT_MS;
  let lastNotes = '';
  let lastProgressAt = Date.now();
  let readRowsFailCount = 0;

  while (Date.now() < deadline) {
    let rows;
    try {
      rows = await withTimeout(readRows(page), 15_000, `readRows:${channelId}`);
      readRowsFailCount = 0;
    } catch (error) {
      readRowsFailCount += 1;
      const reason = error instanceof Error ? error.message : String(error);
      updateChannelProgress(progress, channelId, 'running', `读取面板超时重试（${readRowsFailCount}/8） | ${reason}`);
      saveProgress(progressPath, progress);
      if (readRowsFailCount >= 8) {
        return { status: 'stalled', notes: `readRows连续超时：${reason}` };
      }
      await sleep(Math.min(8_000, LOOP_INTERVAL_MS * 2));
      continue;
    }
    const row = rows[channelId] || { badge: '', progress: '', hasButton: false, buttonText: '' };
    const status = normalizeBadge(row.badge);
    const notes = `${row.badge || status} | ${row.progress || ''}`.trim();
    const now = Date.now();

    if (notes !== lastNotes) {
      lastNotes = notes;
      lastProgressAt = now;
    }

    if (status !== 'not_started') {
      updateChannelProgress(progress, channelId, status, notes);
      saveProgress(progressPath, progress);
    }

    if (status === 'success') {
      const diag = await withTimeout(readDiagnosis(page, channelId), 10_000, `readDiagnosis:${channelId}`).catch(() => '');
      if (containsImageFail(`${notes}\n${diag}`)) {
        const failNotes = `成功态拦截：检测到图片失败痕迹\n${diag || notes}`;
        updateChannelProgress(progress, channelId, 'failed', failNotes);
        saveProgress(progressPath, progress);
        return { status: 'failed', notes: failNotes };
      } else {
        updateChannelProgress(progress, channelId, 'success', `发布成功 | ${row.progress || ''}`);
        saveProgress(progressPath, progress);
        return { status: 'success' };
      }
    }

    if (status === 'not_logged_in') return { status: 'not_logged_in', notes };
    if (status === 'waiting_user' || status === 'failed') return { status: 'failed', notes };

    if (status !== 'success' && now - lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
      return { status: 'stalled', notes: `${status} | ${notes}` };
    }

    await sleep(LOOP_INTERVAL_MS);
  }

  return { status: 'timeout' };
}

async function extractArticlePayloadFromPage(page) {
  return await page.evaluate(() => {
    const title =
      String(document.querySelector('#activity-name')?.textContent || '').trim() ||
      String(document.querySelector('.rich_media_title')?.textContent || '').trim() ||
      String(document.title || '').trim();
    const root =
      document.querySelector('#js_content') ||
      document.querySelector('.rich_media_content') ||
      document.querySelector('.rich_media_area_primary');
    const contentHtml = String(root?.innerHTML || '').trim();
    return {
      title,
      contentHtml,
      sourceUrl: String(location.href || ''),
    };
  });
}

async function main() {
  forceBypassProxyForLocalCdp();

  const distDir = abs('dist');
  const articleUrl = String(process.argv[2] || 'https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg').trim();
  const progressPath = abs('tmp/mcp-publish-progress.json');
  const auditPath = abs('tmp/mcp-login-audit.json');
  const userDataDir = abs(process.env.CHROME_PROFILE_DIR || 'tmp/chrome-cdp-live-profile-v8');

  if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`未找到扩展产物：${path.join(distDir, 'manifest.json')}（请先 npm run build）`);
  }

  const progress = loadProgress(progressPath, articleUrl);
  const audit = createLoginAudit(articleUrl);
  saveProgress(progressPath, progress);
  saveLoginAudit(auditPath, audit);

  const cdp = await ensureChromeAndGetWs({
    port: CHROME_CDP_PORT,
    userDataDir,
    distDir,
  });
  console.log('[cdp] connected ws:', cdp.ws, `reused=${cdp.reused}`);

  let browser = null;
  try {
    browser = await chromium.connectOverCDP(cdp.ws);
    const context = browser.contexts()[0];
    if (!context) throw new Error('CDP context 不存在');

    for (const p of context.pages()) {
      try {
        if (!p.isClosed()) await p.close();
      } catch {
        // ignore
      }
    }
    const wechatPage = await context.newPage();
    wechatPage.on('console', (msg) => {
      try {
        const type = msg.type();
        const text = msg.text();
        if (type === 'error' || /bawei|WeChat content script|publish panel|Failed to initialize/i.test(text)) {
          console.log(`[wechat-console:${type}] ${text}`);
        }
      } catch {
        // ignore
      }
    });
    wechatPage.on('pageerror', (err) => {
      console.log(`[wechat-pageerror] ${err?.message || err}`);
    });
    wechatPage.on('dialog', async (dialog) => {
      try {
        console.log(`[wechat-dialog] type=${dialog.type()} message=${dialog.message()}`);
        await dialog.dismiss();
      } catch {
        // ignore
      }
    });

    console.log('[main] open article', articleUrl);
    await gotoWithRetry(wechatPage, articleUrl).catch(() => {});

    let directMode = USE_BACKGROUND_DIRECT;
    if (!directMode) {
      console.log('[main] wait panel...');
      await ensureWechatPanelReady(wechatPage, articleUrl, 'main');
      console.log('[main] panel ready');
    } else {
      console.log('[main] 使用 background 直连模式（跳过面板依赖）');
    }

    console.log('[main] attach background bridge...');
    let backgroundBridge = await withTimeout(createBackgroundBridge(), 120_000, 'createBackgroundBridge');
    console.log('[main] background bridge ready');

    let articlePayloadForRun = null;
    if (directMode) {
      articlePayloadForRun = await withTimeout(
        loadArticlePayloadFromBackground(backgroundBridge, articleUrl).catch(() => null),
        45_000,
        'loadArticlePayloadFromBackground'
      ).catch(() => null);
      if (!articlePayloadForRun?.title || !articlePayloadForRun?.contentHtml) {
        const fallback = await withTimeout(extractArticlePayloadFromPage(wechatPage), 20_000, 'extractArticlePayloadFromPage').catch(() => null);
        if (fallback?.title && fallback?.contentHtml) {
          articlePayloadForRun = {
            title: fallback.title,
            contentHtml: fallback.contentHtml,
            sourceUrl: fallback.sourceUrl || articleUrl,
          };
        }
      }
      if (!articlePayloadForRun?.title || !articlePayloadForRun?.contentHtml) {
        throw new Error('background 直连模式未能获取文章 payload（请先在微信页启动过一次任务，或确保文章正文可见）');
      }
      console.log(`[main] article payload ready: title=${String(articlePayloadForRun.title).slice(0, 32)} htmlLen=${String(articlePayloadForRun.contentHtml).length}`);
    }

    await maybeImportStorageState(context);

    console.log('[main] start login audit...');
    const loginPages = await auditLoginStatus(context, audit, auditPath);
    console.log('[main] login audit done');

    const blockedByLogin = [];
    for (const channelId of ALL_CHANNELS) {
      const auditStatus = audit.channels[channelId]?.status || 'unknown';
      const auditReason = String(audit.channels[channelId]?.reason || '');
      if (auditStatus === 'not_logged_in' || (auditStatus === 'unknown' && auditReason.includes('captcha-or-risk-page'))) {
        blockedByLogin.push(channelId);
        updateChannelProgress(progress, channelId, 'failed', `登录审计阻塞：${auditReason || 'not_logged_in'}`);
      } else if (progress.channels[channelId].status !== 'success') {
        updateChannelProgress(progress, channelId, 'pending', '登录审计通过，等待发布');
      }
    }
    saveProgress(progressPath, progress);

    if (blockedByLogin.length) {
      console.log(`[main] 登录审计阻塞渠道（本轮直接失败）: ${blockedByLogin.join(', ')}`);
    }

    console.log('[main] start single-pass publish（仅执行 pending 渠道）');
    const pending = ALL_CHANNELS.filter((id) => progress.channels[id].status === 'pending').sort((a, b) => {
      const score = (id) => {
        if (id === 'sspai') return 3;
        if (id === 'csdn') return 2;
        if (id === 'tencent-cloud-dev') return 1;
        return 0;
      };
      return score(a) - score(b);
    });

    if (!pending.length) {
      console.log('\n✅ 全部渠道发布成功（10/10）');
      saveProgress(progressPath, progress);
      return;
    }

    console.log(`\n===== publish-single-pass =====`);
    console.log(`pending(${pending.length}): ${pending.join(', ')}`);

    for (const channelId of pending) {
      const current = progress.channels[channelId]?.status;
      if (current === 'success') continue;

      incAttempt(progress, channelId);
      updateChannelProgress(progress, channelId, 'running', `开始第 ${progress.channels[channelId].attempts} 次发布尝试`);
      saveProgress(progressPath, progress);
      console.log(`[publish] ${channelId}: attempt=${progress.channels[channelId].attempts}`);

      let jobIdForChannel = '';
      try {
        if (directMode) {
          try {
            jobIdForChannel = await startSingleChannelJobDirect(backgroundBridge, channelId, articlePayloadForRun);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (reason.includes('target') || reason.includes('session')) {
              backgroundBridge = await createBackgroundBridge();
              jobIdForChannel = await startSingleChannelJobDirect(backgroundBridge, channelId, articlePayloadForRun);
            } else {
              throw error;
            }
          }
        } else {
          await startSingleChannelJob(wechatPage, channelId);
        }
      } catch (error) {
        updateChannelProgress(progress, channelId, 'failed', `启动发布失败：${error instanceof Error ? error.message : String(error)}`);
        saveProgress(progressPath, progress);
        continue;
      }

      let result = directMode
        ? await waitSingleChannelResultDirect({
            bridge: backgroundBridge,
            jobId: jobIdForChannel,
            channelId,
            progress,
            progressPath,
          })
        : await waitSingleChannelResult({
            page: wechatPage,
            channelId,
            progress,
            progressPath,
          });

      if (result.status === 'success') {
        console.log(`[publish] ${channelId}: success`);
        continue;
      }

      if (result.status === 'timeout') {
        const diag = directMode
          ? JSON.stringify(((await getJobStateDirect(backgroundBridge, jobIdForChannel).catch(() => null)) || {})[channelId] || {})
          : await withTimeout(readDiagnosis(wechatPage, channelId), 10_000, `readDiagnosis:${channelId}`).catch(() => '');
        result = { status: 'timeout', notes: `单渠道超时\n${diag}` };
      }

      if (result.status === 'stalled') {
        const diag = directMode
          ? JSON.stringify(((await getJobStateDirect(backgroundBridge, jobIdForChannel).catch(() => null)) || {})[channelId] || {})
          : await withTimeout(readDiagnosis(wechatPage, channelId), 10_000, `readDiagnosis:${channelId}`).catch(() => '');
        result = {
          status: 'stalled',
          notes: `无进度超时（${Math.round(NO_PROGRESS_TIMEOUT_MS / 1000)}s）\n${result.notes || ''}\n${diag}`,
        };
      }

      if (result.status === 'not_logged_in') {
        let loginUrl = CHANNEL_ENTRY_URLS[channelId];
        try {
          const p = await ensureLoginPageOpen(context, loginPages, channelId);
          loginUrl = String(p.url() || CHANNEL_ENTRY_URLS[channelId]);
        } catch {
          // ignore
        }
        audit.channels[channelId] = {
          status: 'not_logged_in',
          reason: 'publish-runtime-detected',
          url: loginUrl,
          updatedAt: nowIso(),
        };
        saveLoginAudit(auditPath, audit);
      }

      if (isBlockingRuntimeResult(result.status)) {
        const reasonMap = {
          not_logged_in: '发布中检测到未登录（阻塞）',
          waiting_user: '发布中进入 waiting_user（阻塞）',
          failed: '渠道返回 failed（阻塞）',
          timeout: '发布超时（阻塞）',
          stalled: '发布无进度超时（阻塞）',
        };
        const head = reasonMap[result.status] || `阻塞状态：${result.status}`;
        updateChannelProgress(progress, channelId, 'failed', `${head}\n${result.notes || ''}`);
        saveProgress(progressPath, progress);
        console.log(`[publish] ${channelId}: blocking -> failed`);
        continue;
      }
    }

    const successCount = ALL_CHANNELS.filter((id) => progress.channels[id].status === 'success').length;
    saveProgress(progressPath, progress);
    if (successCount === ALL_CHANNELS.length) {
      console.log(`\n✅ 全部渠道发布成功（${successCount}/${ALL_CHANNELS.length}）`);
    } else {
      const failedChannels = ALL_CHANNELS.filter((id) => progress.channels[id].status !== 'success');
      console.log(`\n❌ 单次运行结束：成功 ${successCount}/${ALL_CHANNELS.length}，失败渠道：${failedChannels.join(', ')}`);
      throw new Error(`单次运行未达成 10/10：${failedChannels.join(', ')}`);
    }
  } finally {
    if (!KEEP_BROWSER_OPEN) {
      try {
        await browser?.close();
      } catch {
        // ignore
      }
      if (cdp.chromeProcess && !cdp.chromeProcess.killed) {
        try {
          cdp.chromeProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
  }
}

main().catch((e) => {
  console.error('\n❌ live publish via chrome cdp failed:', e);
  process.exit(1);
});
