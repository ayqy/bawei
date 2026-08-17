import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { prepareLocalMarkdown, validateWoshipmVariant } from './local-markdown.mjs';
import { getChannelConfig, getChannelIds } from './channel-config.mjs';
import {
  getLedgerDecision,
  loadPublicationLedger,
  savePublicationLedger,
  upsertPublicationOutcome
} from './publication-ledger.mjs';
import { verifyPublicationAnonymously } from './publication-verifier.mjs';

const ALL_CHANNELS = getChannelIds();

const LIVE_PUBLISH_CHANNELS_RAW = String(process.env.LIVE_PUBLISH_CHANNELS || '').trim();
const LIVE_PUBLISH_FORCE_CHANNELS_RAW = String(
  process.env.LIVE_PUBLISH_FORCE_CHANNELS || ''
).trim();
const LIVE_PUBLISH_REQUIRE_EXISTING_CHROME =
  String(process.env.LIVE_PUBLISH_REQUIRE_EXISTING_CHROME || '1') === '1';
const LIVE_PUBLISH_PRESERVE_EXISTING_PAGES =
  String(process.env.LIVE_PUBLISH_PRESERVE_EXISTING_PAGES || '1') === '1';
const LIVE_PUBLISH_ACTION_RAW = String(process.env.LIVE_PUBLISH_ACTION || 'publish')
  .trim()
  .toLowerCase();

function parseActiveChannels(raw) {
  const text = String(raw || '').trim();
  if (!text) return [...ALL_CHANNELS];

  const uniq = Array.from(
    new Set(
      text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
  const filtered = uniq.filter((id) => ALL_CHANNELS.includes(id));
  if (!filtered.length) {
    throw new Error(
      `LIVE_PUBLISH_CHANNELS 解析为空（raw=${text || 'empty'}），可用渠道：${ALL_CHANNELS.join(', ')}`
    );
  }
  return filtered;
}

function parseOptionalChannels(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const uniq = Array.from(
    new Set(
      text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
  return uniq.filter((id) => ALL_CHANNELS.includes(id));
}

function parseLivePublishAction(raw) {
  if (raw === 'draft' || raw === 'publish') return raw;
  throw new Error(`LIVE_PUBLISH_ACTION 非法（raw=${raw || 'empty'}），可用值：draft, publish`);
}

const ACTIVE_CHANNELS = parseActiveChannels(LIVE_PUBLISH_CHANNELS_RAW);
const FORCE_RERUN_CHANNELS = parseOptionalChannels(LIVE_PUBLISH_FORCE_CHANNELS_RAW);
const LIVE_PUBLISH_ACTION = parseLivePublishAction(LIVE_PUBLISH_ACTION_RAW);
const LIVE_ACTION_LABEL = LIVE_PUBLISH_ACTION === 'draft' ? 'draft' : 'publish';
const LIVE_ACTION_TEXT = LIVE_PUBLISH_ACTION === 'draft' ? '草稿' : '发布';
const LIVE_ACTION_SUCCESS_TEXT = LIVE_PUBLISH_ACTION === 'draft' ? '草稿保存成功' : '发布成功';

const CHANNEL_ENTRY_URLS = Object.fromEntries(
  ALL_CHANNELS.map((channelId) => [channelId, getChannelConfig(channelId).entryUrl])
);

// 避免登录审计打开“写作页”触发站点的“编辑窗口已打开”锁；审计只需要判断登录态即可。
const LOGIN_AUDIT_ENTRY_URLS = Object.fromEntries(
  ALL_CHANNELS.map((channelId) => [channelId, getChannelConfig(channelId).loginAuditUrl])
);

const LOGIN_URL_RULES = Object.fromEntries(
  ALL_CHANNELS.map((channelId) => [
    channelId,
    getChannelConfig(channelId).loginUrlPatterns.map((pattern) => new RegExp(pattern, 'i'))
  ])
);

const LOGIN_AUDIT_STRICT_TEXT_RULES = {
  oschina:
    /请登录|未登录|登录后继续|登录即可|请先登录|扫码登录|手机号登录|登录|注册|sign in|log in/i,
  woshipm:
    /请登录|未登录|登录后继续|登录即可|请先登录|扫码登录|手机号登录|注册\s*\|\s*登录|立即登录|点我注册|登录人人都是产品经理即可获得以下权益|sign in|log in/i
};

const LOGIN_AUDIT_LOGGED_HINT_RULES = {
  oschina: /写博客|我的博客|博客广场|动弹|消息|设置|个人空间|退出登录|我的主页/i,
  woshipm: /发布文章|我的文章|草稿箱|账号设置|退出登录|个人中心|创作中心/i
};

const PER_CHANNEL_TIMEOUT_MS = Number(
  process.env.PER_CHANNEL_TIMEOUT_MS ||
    (ACTIVE_CHANNELS.includes('sspai') ? 45 * 60_000 : 10 * 60_000)
);
const NO_PROGRESS_TIMEOUT_MS_BASE = Number(process.env.NO_PROGRESS_TIMEOUT_MS || 180_000);
const NO_PROGRESS_TIMEOUT_MS = ACTIVE_CHANNELS.includes('sspai')
  ? Math.max(NO_PROGRESS_TIMEOUT_MS_BASE, 15 * 60_000)
  : NO_PROGRESS_TIMEOUT_MS_BASE;
const LOOP_INTERVAL_MS = 3000;
const CHROME_CDP_PORT = Number(process.env.CDP_PORT || 52607);
const DEFAULT_ARTICLE_URL = 'https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg';
const STORAGE_STATE_PATH = String(
  process.env.STORAGE_STATE_PATH || 'artifacts/live-publish/mcp-storageState.json'
).trim();
const KEEP_BROWSER_OPEN = String(process.env.KEEP_BROWSER_OPEN || '1') !== '0';
const WAIT_FOR_LOGIN = String(process.env.WAIT_FOR_LOGIN || '1') !== '0';
const LOGIN_WAIT_TIMEOUT_MS = Number(process.env.LOGIN_WAIT_TIMEOUT_MS || 10 * 60_000);
const USE_BACKGROUND_DIRECT = String(process.env.USE_BACKGROUND_DIRECT || '1') !== '0';
const BOOTSTRAP_PROFILE = String(process.env.BOOTSTRAP_PROFILE || '0') !== '0';
const BOOTSTRAP_PROFILE_REFRESH = String(process.env.BOOTSTRAP_PROFILE_REFRESH || '0') === '1';
const SANITIZE_PROFILE = String(process.env.SANITIZE_PROFILE || '1') !== '0';
const PROFILE_BOOTSTRAP_MARK = '.bootstrap-from-chrome.done';
const BOOTSTRAP_SOURCE_DIR = path.resolve(
  process.env.SOURCE_CHROME_USER_DATA_DIR ||
    path.join(os.homedir(), 'Library/Application Support/Google/Chrome')
);

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"<unserializable>"';
  }
}

function abs(p) {
  return path.resolve(process.cwd(), p);
}

function canonicalUrlKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}`;
  } catch {
    return s;
  }
}

const LOGIN_AUDIT_EXISTING_PAGE_RULES = {
  csdn: [/^https:\/\/mp\.csdn\.net\/mp_blog\/creation\/editor/i],
  'tencent-cloud-dev': [
    /^https:\/\/cloud\.tencent\.com\/developer\/article\/write/i,
    /^https:\/\/cloud\.tencent\.com\/developer\/creator\/article/i
  ],
  cnblogs: [/^https:\/\/i\.cnblogs\.com\/posts\/edit/i],
  oschina: [
    /^https:\/\/my\.oschina\.net\/u\/[^/]+\/blog\/(?:ai-)?write/i,
    /^https:\/\/(?:www|my)\.oschina\.net\/.*\/blog\/write/i,
    /^https:\/\/www\.oschina\.net\/blog\/write/i
  ],
  woshipm: [/^https:\/\/www\.woshipm\.com\/writing/i],
  mowen: [/^https:\/\/note\.mowen\.cn\/editor/i],
  sspai: [
    /^https:\/\/sspai\.com\/write/i,
    /^https:\/\/sspai\.com\/my(?:[/?#]|$)/i,
    /^https:\/\/sspai\.com\/whoops(?:[/?#]|$)/i
  ],
  baijiahao: [/^https:\/\/baijiahao\.baidu\.com\/builder\/rc\/edit/i],
  toutiao: [/^https:\/\/mp\.toutiao\.com\/profile_v4\/graphic\/publish/i],
  'feishu-docs': [
    /^https:\/\/wuxinxuexi\.feishu\.cn\/docx\//i,
    /^https:\/\/wuxinxuexi\.feishu\.cn\/drive\/folder\//i
  ]
};

function findExistingChannelAuditPage(context, channelId) {
  const rules = LOGIN_AUDIT_EXISTING_PAGE_RULES[channelId] || [];
  const pages = context
    .pages()
    .slice()
    .reverse()
    .filter((page) => {
      const url = String(page.url() || '');
      if (!url || /mp\.weixin\.qq\.com\/s\//i.test(url)) return false;
      return rules.some((rule) => rule.test(url));
    });

  return pages[0] || null;
}

function dumpArticlePayloadToArtifacts(articlePayload, articleUrl) {
  try {
    if (!articlePayload) return;
    const outDir = abs('artifacts/live-publish');
    fs.mkdirSync(outDir, { recursive: true });

    const html = String(articlePayload.contentHtml || '');
    const tokenImages = Array.isArray(articlePayload.contentTokens)
      ? articlePayload.contentTokens
          .filter(
            (t) => t && typeof t === 'object' && t.kind === 'image' && typeof t.src === 'string'
          )
          .map((t) => String(t.src || '').trim())
          .filter(Boolean)
      : [];

    const htmlImages = Array.from(
      new Set(
        (html.match(/https:\/\/read\.useai\.online\/api\/image-proxy\?url=[^"'\s<>]+/g) || [])
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );

    const dump = {
      dumpedAt: nowIso(),
      articleUrl: String(articleUrl || ''),
      title: String(articlePayload.title || ''),
      sourceUrl: String(articlePayload.sourceUrl || ''),
      htmlLen: html.length,
      tokenImageCount: tokenImages.length,
      htmlImageCount: htmlImages.length,
      tokenImages: tokenImages.slice(0, 50),
      htmlImages: htmlImages.slice(0, 50),
      contentTokensPresent: Array.isArray(articlePayload.contentTokens),
      contentHtml: html,
      contentTokens: Array.isArray(articlePayload.contentTokens)
        ? articlePayload.contentTokens
        : undefined
    };

    const outPath = path.join(outDir, `article-payload-${Date.now()}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(dump, null, 2)}\n`, 'utf8');
    console.log('[main] article payload dumped ->', outPath);
  } catch (error) {
    console.log(
      '[main] article payload dump failed:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

function ensureArtifactsDirExists(p) {
  try {
    fs.mkdirSync(path.dirname(abs(p)), { recursive: true });
  } catch {
    // ignore
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function attachAutoDismissDialogs(page, label) {
  try {
    page.on('dialog', async (dialog) => {
      try {
        const type = dialog.type();
        const message = dialog.message();
        console.log(`[dialog:${label}] type=${type} message=${message}`);
        if (type === 'beforeunload' || type === 'confirm') await dialog.accept().catch(() => {});
        else await dialog.dismiss().catch(() => {});
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

function installContextDialogAutoDismiss(context, label) {
  try {
    for (const p of context.pages()) attachAutoDismissDialogs(p, label);
  } catch {
    // ignore
  }
  try {
    context.on('page', (p) => attachAutoDismissDialogs(p, label));
  } catch {
    // ignore
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timeout after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function installNetworkLogger(context, label) {
  const wantDomains =
    label === 'mowen'
      ? [
          'note.mowen.cn',
          'account.mowen.cn',
          'user.mowen.cn',
          'pub-sdn-001.mowen.cn',
          'pub-sdn-002.mowen.cn',
          'pub-sdn-003.mowen.cn',
          'up.qiniu.com',
          'upload.qiniu.com',
          'upload.qiniup.com'
        ]
      : label === 'tencent-cloud-dev'
        ? ['cloud.tencent.com', 'developer-private-1258344699.cos.ap-guangzhou.myqcloud.com']
        : [
            'sspai.com',
            'cdnfile.sspai.com',
            'cdn-static.sspai.com',
            'up.qiniu.com',
            'upload.qiniu.com',
            'upload.qiniup.com'
          ];
  const logPath = abs(`artifacts/live-publish/network-${label}-${Date.now()}.ndjson`);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '');
  } catch {
    // ignore
  }

  const shouldLogUrl = (url) => {
    try {
      const u = new URL(url);
      if (label === 'mowen') {
        if (wantDomains.includes(u.hostname)) return true;
        if (u.hostname === 'mowen.cn' || u.hostname.endsWith('.mowen.cn')) return true;
        if (
          u.hostname.endsWith('.qiniu.com') ||
          u.hostname === 'up.qiniu.com' ||
          u.hostname === 'upload.qiniu.com' ||
          u.hostname === 'upload.qiniup.com'
        )
          return true;
        if (
          u.hostname.endsWith('.aliyuncs.com') ||
          u.hostname.endsWith('.myqcloud.com') ||
          u.hostname.endsWith('.cos.ap-shanghai.myqcloud.com')
        ) {
          return true;
        }
        return false;
      }
      if (label === 'tencent-cloud-dev') {
        if (wantDomains.includes(u.hostname)) return true;
        if (u.hostname.endsWith('.myqcloud.com')) return true;
        if (u.hostname.endsWith('.tencent.com')) return true;
        if (u.href.includes('article?action=')) return true;
        return false;
      }
      if (wantDomains.includes(u.hostname)) return true;
      if (u.hostname.endsWith('.sspai.com')) return true;
      if (u.hostname.endsWith('.qiniu.com')) return true;
      return false;
    } catch {
      return false;
    }
  };

  const append = (payload) => {
    try {
      fs.appendFileSync(logPath, `${safeJsonStringify(payload)}\n`);
    } catch {
      // ignore
    }
  };

  const pickHeaders = (headers) => {
    const out = {};
    try {
      for (const [k, v] of Object.entries(headers || {})) {
        const key = String(k || '').toLowerCase();
        if (!key) continue;
        if (key === 'cookie' || key === 'authorization' || key === 'proxy-authorization') continue;
        if (
          key === 'user-agent' ||
          key === 'referer' ||
          key === 'origin' ||
          key === 'content-type' ||
          key.startsWith('x-')
        ) {
          out[key] = String(v || '').slice(0, 1200);
        }
      }
    } catch {
      // ignore
    }
    return out;
  };

  const seen = new WeakSet();
  const attach = (page) => {
    try {
      if (seen.has(page)) return;
      seen.add(page);
    } catch {
      // ignore
    }

    try {
      page.on('requestfailed', (req) => {
        try {
          const url = req.url();
          if (!shouldLogUrl(url)) return;
          append({
            ts: nowIso(),
            kind: 'requestfailed',
            url,
            method: req.method(),
            failure: req.failure() || null,
            page: page.url()
          });
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }

    try {
      page.on('request', (req) => {
        void (async () => {
          try {
            const url = req.url();
            const method = req.method();
            if (method === 'GET' && !shouldLogUrl(url)) return;
            if (!shouldLogUrl(url) && method !== 'GET') return;

            let host = '';
            let isQiniu = false;
            try {
              const u = new URL(url);
              host = u.hostname;
              isQiniu =
                host.endsWith('.qiniu.com') ||
                host === 'up.qiniu.com' ||
                host === 'upload.qiniu.com' ||
                host === 'upload.qiniup.com';
            } catch {
              // ignore
            }

            let postDataSnippet = '';
            let postDataSize = null;
            try {
              const buf = req.postDataBuffer();
              if (buf) postDataSize = buf.byteLength;
            } catch {
              // ignore
            }
            if (method !== 'GET' && !isQiniu) {
              try {
                const text = req.postData();
                if (text) {
                  const raw = String(text);
                  const limit = url.includes('/api/v1/matrix/editor/article/update')
                    ? 40_000
                    : url.includes('/api/v1/matrix/editor/article/auto/save')
                      ? 12_000
                      : 3000;
                  postDataSnippet = raw.slice(0, limit);
                }
              } catch {
                // ignore
              }
            }

            const allHeaders = await req.allHeaders().catch(() => null);
            const headers = allHeaders || req.headers();
            const cookieNames = (() => {
              try {
                const raw = String(headers?.cookie || headers?.Cookie || '');
                if (!raw) return [];
                return raw
                  .split(';')
                  .map(
                    (p) =>
                      String(p || '')
                        .trim()
                        .split('=')[0]
                  )
                  .filter(Boolean)
                  .slice(0, 80);
              } catch {
                return [];
              }
            })();

            append({
              ts: nowIso(),
              kind: 'request',
              url,
              method,
              resourceType: req.resourceType(),
              page: page.url(),
              host,
              postDataSize,
              postDataSnippet,
              headers: pickHeaders(headers),
              cookieNames
            });
          } catch {
            // ignore
          }
        })();
      });
    } catch {
      // ignore
    }

    try {
      page.on('response', async (res) => {
        try {
          const url = res.url();
          const status = res.status();
          if (status < 400 && !shouldLogUrl(url)) return;

          let bodySnippet = '';
          try {
            const headers = res.headers();
            const ct = String(headers?.['content-type'] || '');
            const isText =
              ct.includes('application/json') ||
              ct.includes('text/plain') ||
              ct.includes('application/xml') ||
              ct.includes('text/xml') ||
              ct.includes('application/xhtml') ||
              ct.includes('text/html');
            const forceText = label === 'mowen' && status !== 200;
            if (forceText || isText || status >= 400) {
              const text = await res.text().catch(() => '');
              const limit =
                label === 'mowen' && url.includes('/api/file/v1/upload/prepare') ? 12_000 : 1600;
              bodySnippet = String(text || '').slice(0, limit);
            }
          } catch {
            // ignore
          }

          append({
            ts: nowIso(),
            kind: 'response',
            url,
            status,
            method: res.request().method(),
            page: page.url(),
            bodySnippet
          });
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  };

  try {
    for (const p of context.pages()) attach(p);
  } catch {
    // ignore
  }
  try {
    context.on('page', attach);
  } catch {
    // ignore
  }

  console.log(`[network] ${label} logging -> ${logPath}`);
}

function forceBypassProxyForLocalCdp() {
  const prevNoProxy = String(process.env.NO_PROXY || process.env.no_proxy || '');
  const required = ['127.0.0.1', 'localhost'];
  const nextNoProxy = Array.from(
    new Set(
      prevNoProxy
        .split(',')
        .concat(required)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ).join(',');
  process.env.NO_PROXY = nextNoProxy;
  process.env.no_proxy = nextNoProxy;

  for (const key of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy'
  ]) {
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
      path.join(
        base,
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      ),
      path.join(
        base,
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      )
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  throw new Error(
    '未找到 Chrome for Testing 可执行文件，请先执行 `npx playwright install chromium`'
  );
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
    'Default/Service Worker/ScriptCache'
  ];

  if (
    allowPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
  ) {
    return true;
  }

  const allowFiles = new Set([
    'Default/Web Data',
    'Default/Web Data-journal',
    'Default/Login Data',
    'Default/Login Data-journal'
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

  for (const dir of [
    'Extensions',
    'Extension State',
    'Extension Scripts',
    'Extension Rules',
    'Extension Cookies'
  ]) {
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
  if (!fs.existsSync(BOOTSTRAP_SOURCE_DIR)) {
    console.log(`[profile-bootstrap] 跳过：未找到源目录 ${BOOTSTRAP_SOURCE_DIR}`);
    return;
  }

  const firstSync = !fs.existsSync(markFile);
  if (!firstSync && !BOOTSTRAP_PROFILE_REFRESH) {
    console.log(`[profile-bootstrap] 跳过：目标 profile 已初始化，继续复用 ${userDataDir}`);
    return;
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log(
    `[profile-bootstrap] ${firstSync ? '首次引导' : '刷新'}登录态：${BOOTSTRAP_SOURCE_DIR} -> ${userDataDir}`
  );

  fs.cpSync(BOOTSTRAP_SOURCE_DIR, userDataDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: true,
    filter: (src) => profileCopyFilter(src, BOOTSTRAP_SOURCE_DIR)
  });

  cleanChromeSingletonLocks(userDataDir);
  sanitizeProfileStartupState(userDataDir);
  fs.writeFileSync(markFile, `${nowIso()}\n`, 'utf8');
  console.log(`[profile-bootstrap] ${firstSync ? '完成' : '已刷新'}`);
}

function normalizeBadge(badge) {
  const raw = String(badge || '').trim();
  if (!raw) return 'not_started';
  const text = raw.toLowerCase();

  if (text === 'success' || text.includes('成功')) return 'success';
  if (
    text === 'pending_review' ||
    text === 'pending-review' ||
    text.includes('审核中') ||
    text.includes('待审核')
  )
    return 'pending_review';
  if (
    text === 'rejected' ||
    text.includes('退回') ||
    text.includes('未通过') ||
    text.includes('拒绝')
  )
    return 'rejected';
  if (text === 'running' || text.includes('进行中')) return 'running';
  if (text === 'waiting_user' || text === 'waiting' || text.includes('等待处理'))
    return 'waiting_user';
  if (text === 'not_logged_in' || text === 'not-logged-in' || text.includes('未登录'))
    return 'not_logged_in';
  if (text === 'failed' || text.includes('失败')) return 'failed';
  if (
    text === 'not_started' ||
    text === 'not-started' ||
    text === 'pending' ||
    text.includes('未开始')
  )
    return 'not_started';

  return 'unknown';
}

function createProgress(articleUrl) {
  const channels = {};
  for (const id of ALL_CHANNELS)
    channels[id] = { status: 'pending', notes: '', updatedAt: nowIso(), attempts: 0 };
  return { updatedAt: nowIso(), articleUrl, channels };
}

function loadProgress(filePath, articleUrl) {
  try {
    if (!fs.existsSync(filePath)) return createProgress(articleUrl);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.channels)
      return createProgress(articleUrl);
    const previousArticleKey = canonicalUrlKey(parsed.articleUrl);
    const nextArticleKey = canonicalUrlKey(articleUrl);
    const articleChanged =
      !!previousArticleKey && !!nextArticleKey && previousArticleKey !== nextArticleKey;
    parsed.articleUrl = articleUrl;
    for (const id of ALL_CHANNELS) {
      if (!parsed.channels[id])
        parsed.channels[id] = { status: 'pending', notes: '', updatedAt: nowIso(), attempts: 0 };
      if (parsed.channels[id].attempts == null) parsed.channels[id].attempts = 0;
      if (parsed.channels[id].updatedAt == null) parsed.channels[id].updatedAt = nowIso();
      if (parsed.channels[id].status === 'running') parsed.channels[id].status = 'pending';
    }
    if (articleChanged) {
      for (const id of ACTIVE_CHANNELS) {
        parsed.channels[id] = {
          ...parsed.channels[id],
          status: 'pending',
          notes: `切换文章后自动重置：${articleUrl}`,
          updatedAt: nowIso(),
          attempts: 0
        };
      }
    }
    for (const id of FORCE_RERUN_CHANNELS) {
      parsed.channels[id] = {
        ...parsed.channels[id],
        status: 'pending',
        notes: '按 LIVE_PUBLISH_FORCE_CHANNELS 强制重跑',
        updatedAt: nowIso()
      };
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
  for (const id of ALL_CHANNELS)
    channels[id] = { status: 'unknown', reason: '', url: '', updatedAt: nowIso() };
  return { updatedAt: nowIso(), articleUrl, channels };
}

function saveLoginAudit(filePath, audit) {
  audit.updatedAt = nowIso();
  fs.writeFileSync(filePath, `${JSON.stringify(audit, null, 2)}\n`);
}

function updateChannelProgress(progress, channelId, status, notes) {
  const row = progress.channels[channelId] || {
    status: 'pending',
    notes: '',
    attempts: 0,
    updatedAt: nowIso()
  };
  row.status = status;
  row.notes = String(notes || '').trim();
  row.updatedAt = nowIso();
  progress.channels[channelId] = row;
}

function incAttempt(progress, channelId) {
  const row = progress.channels[channelId] || {
    status: 'pending',
    notes: '',
    attempts: 0,
    updatedAt: nowIso()
  };
  row.attempts = Number(row.attempts || 0) + 1;
  row.updatedAt = nowIso();
  progress.channels[channelId] = row;
}

function summarizeRunProgress(progress) {
  const groups = {
    success: [],
    pending_review: [],
    rejected: [],
    waiting_user: [],
    failed: [],
    not_logged_in: [],
    skipped_duplicate: []
  };
  for (const channelId of ACTIVE_CHANNELS) {
    const row = progress.channels[channelId] || {};
    const notes = String(row.notes || '');
    if (row.status === 'success') {
      if (notes.includes('防重跳过')) groups.skipped_duplicate.push(channelId);
      else groups.success.push(channelId);
    } else if (row.status === 'pending_review') groups.pending_review.push(channelId);
    else if (row.status === 'rejected') groups.rejected.push(channelId);
    else if (row.status === 'waiting_user') groups.waiting_user.push(channelId);
    else if (row.status === 'not_logged_in') groups.not_logged_in.push(channelId);
    else groups.failed.push(channelId);
  }
  return groups;
}

function printRunSummary(progress) {
  const groups = summarizeRunProgress(progress);
  const publicSuccessCount = groups.success.length + groups.skipped_duplicate.length;
  console.log(`\n===== publication-summary =====`);
  console.log(
    `公开成功 ${publicSuccessCount}/${ACTIVE_CHANNELS.length}: ${[...groups.success, ...groups.skipped_duplicate].join(', ') || '-'}`
  );
  console.log(`待审 ${groups.pending_review.length}: ${groups.pending_review.join(', ') || '-'}`);
  console.log(`退回 ${groups.rejected.length}: ${groups.rejected.join(', ') || '-'}`);
  console.log(`待人工验证 ${groups.waiting_user.length}: ${groups.waiting_user.join(', ') || '-'}`);
  console.log(`失败 ${groups.failed.length}: ${groups.failed.join(', ') || '-'}`);
  console.log(`未登录 ${groups.not_logged_in.length}: ${groups.not_logged_in.join(', ') || '-'}`);
  console.log(
    `防重跳过 ${groups.skipped_duplicate.length}: ${groups.skipped_duplicate.join(', ') || '-'}`
  );
  return { ...groups, publicSuccessCount };
}

function containsImageFail(text) {
  const t = String(text || '');
  return (
    t.includes('图片自动上传失败') ||
    t.includes('请手动上传') ||
    t.includes('image insert failed') ||
    t.includes('fetch image failed')
  );
}

function isBlockingRuntimeResult(status) {
  return (
    status === 'not_logged_in' ||
    status === 'failed' ||
    status === 'waiting_user' ||
    status === 'timeout' ||
    status === 'stalled'
  );
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
        secure: !!cookie?.secure
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
      console.log(
        `[storage-state] cookies import failed: ${error instanceof Error ? error.message : String(error)}`
      );
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
    'accounts.feishu.cn'
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

function httpRequestText({ method, url }) {
  return new Promise((resolve) => {
    const req = http.request(url, { method }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(String(data || '')));
    });
    req.on('error', () => resolve(''));
    req.end();
  });
}

async function tryOpenBlankPage(port) {
  const body = await httpRequestText({ method: 'PUT', url: `http://127.0.0.1:${port}/json/new` });
  try {
    const parsed = JSON.parse(body || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function tryCloseTarget(port, id) {
  if (!id) return false;
  await httpRequestText({
    method: 'GET',
    url: `http://127.0.0.1:${port}/json/close/${encodeURIComponent(String(id))}`
  });
  return true;
}

async function cleanupChromePagesKeepBlank(port) {
  const targets = await tryGetTargets(port);
  const pages = targets.filter((t) => String(t?.type || '') === 'page');
  if (!pages.length) return;

  let keep = pages.find((p) => String(p?.url || '') === 'about:blank') || null;
  if (!keep) {
    keep = await tryOpenBlankPage(port);
  }
  const keepId = String(keep?.id || '').trim();

  for (const p of pages) {
    const id = String(p?.id || '').trim();
    if (!id) continue;
    if (keepId && id === keepId) continue;
    await tryCloseTarget(port, id).catch(() => false);
  }
}

function isExtensionServiceWorkerTarget(target) {
  return (
    String(target?.type || '') === 'service_worker' &&
    String(target?.url || '').startsWith('chrome-extension://')
  );
}

function isLikelyBaweiWorkerUrl(url) {
  const s = String(url || '');
  return (
    s.includes('/src/background.js') ||
    s.endsWith('/background.js') ||
    s.endsWith('/service_worker.js')
  );
}

function hasBaweiExtensionServiceWorker(targets) {
  return targets.some((t) => isExtensionServiceWorkerTarget(t) && isLikelyBaweiWorkerUrl(t?.url));
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
  const { port, userDataDir, distDir, forceRestart, requireExisting } = params;

  const existingWs = await tryGetWsUrl(port);
  if (existingWs) {
    const ready = await waitBaweiExtensionReady(port, 3000);
    if (requireExisting) {
      if (!ready) {
        console.log(
          `[cdp] 警告：端口 ${port} 未检测到扩展 service_worker，继续复用并在 bridge 阶段拉起`
        );
      }
      console.log(`[cdp] 复用现有实例（port=${port}）`);
      return { ws: existingWs, chromeProcess: null, reused: true };
    }
    if (ready && !forceRestart) {
      console.log(`[cdp] 复用现有实例（port=${port}）`);
      return { ws: existingWs, chromeProcess: null, reused: true };
    }
    console.log(`[cdp] ${forceRestart ? '强制重启' : '准备重启'}：port=${port}`);
  } else if (requireExisting) {
    throw new Error(
      `未检测到可复用的 Chrome CDP 实例（port=${port}），请先执行：npm run live:open`
    );
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
    'about:blank'
  ];

  const keepOpen = KEEP_BROWSER_OPEN;
  const chromeProcess = spawn(
    cftBinary,
    args,
    keepOpen
      ? { detached: true, stdio: 'ignore' }
      : { detached: false, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (keepOpen) {
    try {
      chromeProcess.unref();
    } catch {
      // ignore
    }
  }

  let exited = false;
  chromeProcess.once('exit', (code, signal) => {
    exited = true;
    console.log(`[chrome] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  });
  if (!keepOpen) {
    chromeProcess.stderr?.on('data', (buf) => {
      const line = String(buf || '').trim();
      if (!line) return;
      if (line.includes('DevTools listening on') || line.includes('Network service crashed'))
        return;

      const noisy = [
        '_TIPropertyValueIsValid',
        'imkxpc_setApplicationProperty',
        'SharedImageManager::ProduceOverlay',
        'Invalid mailbox',
        'socket_manager.cc',
        'google_apis/gcm',
        'SetApplicationIsDaemon',
        'q-signature='
      ];
      if (noisy.some((k) => line.includes(k))) return;

      if (/error|fatal|crash|exception/i.test(line)) {
        console.log(`[chrome:stderr] ${line}`);
      }
    });
  }

  const deadline = Date.now() + 60_000;
  let ws = '';
  while (Date.now() < deadline) {
    if (exited) break;
    ws = await tryGetWsUrl(port);
    if (ws) {
      const ready = await waitBaweiExtensionReady(port, 30_000);
      if (!ready) {
        console.log(
          '[cdp] Chrome 已启动，但暂未检测到扩展 service_worker，后续在 bridge 阶段继续拉起'
        );
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

async function refreshBaweiExtensionInExistingChrome(context, distDir) {
  const expectedManifest = JSON.parse(
    fs.readFileSync(path.join(path.resolve(distDir), 'manifest.json'), 'utf8')
  );
  const expectedVersion = String(expectedManifest?.version || '').trim();
  if (!expectedVersion) throw new Error('dist/manifest.json 缺少 version，无法校验扩展刷新');

  const extensionsPage = await context.newPage();
  let wakePage = null;
  try {
    await extensionsPage.goto('chrome://extensions/', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    });

    const refreshed = await extensionsPage.evaluate(
      async ({ expectedPath, expectedName, expectedVersion }) => {
        const getExtensions = () =>
          new Promise((resolve, reject) => {
            chrome.developerPrivate.getExtensionsInfo(
              { includeDisabled: true, includeTerminated: true },
              (items) => {
                const error = chrome.runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve(Array.isArray(items) ? items : []);
              }
            );
          });
        const setEnabled = (extensionId, enabled) =>
          new Promise((resolve, reject) => {
            chrome.management.setEnabled(extensionId, enabled, () => {
              const error = chrome.runtime.lastError;
              if (error) reject(new Error(error.message));
              else resolve();
            });
          });
        const sleepInPage = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalizePath = (value) => String(value || '').replace(/\/+$/, '');

        const items = await getExtensions();
        const expected = normalizePath(expectedPath);
        const extension =
          items.find((item) => normalizePath(item.path) === expected) ||
          items.find(
            (item) =>
              item.name === expectedName && String(item.location || '').toUpperCase() === 'UNPACKED'
          );
        if (!extension?.id) throw new Error(`未找到 ${expectedName} 的 unpacked extension`);

        const loadedVersion = String(extension.version || '').trim();
        if (loadedVersion !== expectedVersion) {
          return {
            id: extension.id,
            state: String(extension.state || ''),
            version: loadedVersion,
            requiresRestart: true
          };
        }

        // publish:markdown 会先原子重建 dist。Chrome 可能在目录短暂缺失时把
        // unpacked extension 标为 disabled；版本未变化时显式禁用再启用，可在不重启
        // 浏览器、不替换 Profile 的前提下重新加载刚完成的脚本构建。manifest 版本变化
        // 必须由同一 Profile 的受控浏览器重启加载，不能继续沿用缓存 manifest。
        if (extension.state === 'ENABLED') {
          await setEnabled(extension.id, false);
          await sleepInPage(250);
        }
        await setEnabled(extension.id, true);
        await sleepInPage(750);

        const afterItems = await getExtensions();
        const after = afterItems.find((item) => item.id === extension.id);
        return {
          id: extension.id,
          state: String(after?.state || ''),
          version: String(after?.version || '')
        };
      },
      { expectedPath: path.resolve(distDir), expectedName: 'bawei', expectedVersion }
    );

    if (refreshed?.requiresRestart) {
      throw new Error(
        `现有浏览器加载的是 bawei ${refreshed.version || 'unknown'}，构建版本为 ${expectedVersion}；必须使用同一 Profile 受控重启后再继续，禁止以旧 manifest 执行`
      );
    }

    if (
      !refreshed?.id ||
      refreshed.state !== 'ENABLED' ||
      refreshed.version !== expectedVersion
    ) {
      throw new Error(
        `现有浏览器中的 bawei 扩展刷新失败（state=${refreshed?.state || 'missing'} version=${refreshed?.version || 'missing'} expected=${expectedVersion}）`
      );
    }

    let workers = await findBackgroundWorkerTargets();
    if (!workers.length) {
      wakePage = await context.newPage();
      await wakePage
        .goto(`chrome-extension://${refreshed.id}/src/devtools/devtools.html`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000
        })
        .catch(() => {});
      await wakePage
        .evaluate(async () => {
          try {
            await chrome.runtime.sendMessage({ type: '__BAWEI_WAKE__' });
          } catch {
            // Unknown wake messages are expected; sending it is enough to start the worker.
          }
        })
        .catch(() => {});

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        workers = await findBackgroundWorkerTargets();
        if (workers.length) break;
        await sleep(300);
      }
    }

    if (!workers.length) throw new Error('bawei 扩展已启用，但 background service worker 未启动');
    console.log('[cdp] 已在现有浏览器中刷新 bawei 扩展（Profile 与登录态保持不变）');
  } finally {
    await wakePage?.close().catch(() => {});
    await extensionsPage.close().catch(() => {});
  }
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
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0')
              return false;
            return true;
          })();
          return {
            hasPanel: !!panel,
            hasLauncher: !!launcher,
            hasMirror: !!mirror,
            panelVisible
          };
        }),
        10_000,
        'probeWechatPanel'
      );
    } catch (error) {
      probeTimeoutStreak += 1;
      console.log(
        `[wechat-panel] probe timeout: ${error instanceof Error ? error.message : String(error)}`
      );
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
      console.log(
        `[wechat-panel] probe url=${url} hasPanel=${hasPanel} hasLauncher=${hasLauncher} hasMirror=${hasMirror}`
      );
      lastProbeLog = Date.now();
    }

    if (!hasPanel) {
      if (hasLauncher) {
        await page.click('#bawei-v2-launcher').catch(() => {});
      } else if (hasMirror) {
        await page
          .evaluate(() => {
            try {
              window.dispatchEvent(
                new CustomEvent('bawei-v2-ensure-panel', { detail: { action: 'show' } })
              );
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
              window.dispatchEvent(
                new CustomEvent('bawei-v2-ensure-panel', { detail: { action: 'show' } })
              );
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
      console.log(
        `[wechat-panel] ensure failed (${attempt}/3): ${error instanceof Error ? error.message : String(error)}`
      );
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
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
            ws.close();
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
                returnByValue: true
              }
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
          done(
            reject,
            new Error(
              String(payload.error.message || payload.error.code || 'Runtime.evaluate failed')
            )
          );
          return;
        }

        if (payload.result?.exceptionDetails) {
          const text = String(
            payload.result.exceptionDetails.text ||
              payload.result.result?.description ||
              'Runtime.evaluate exception'
          );
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

async function findBackgroundWorkerTargets() {
  const targets = await tryGetTargets(CHROME_CDP_PORT);
  return (targets || [])
    .filter((t) => isExtensionServiceWorkerTarget(t) && t?.webSocketDebuggerUrl)
    .sort((a, b) => {
      const aScore = isLikelyBaweiWorkerUrl(a?.url) ? 1 : 0;
      const bScore = isLikelyBaweiWorkerUrl(b?.url) ? 1 : 0;
      return bScore - aScore;
    });
}

async function createBackgroundBridge() {
  const deadline = Date.now() + 120_000;
  let noTargetCount = 0;
  while (Date.now() < deadline) {
    const targets = await findBackgroundWorkerTargets();
    if (!targets.length) {
      noTargetCount += 1;
      if (noTargetCount % 10 === 0) {
        console.log(
          `[background-bridge] waiting worker... seenTargets=${Array.isArray(targets) ? targets.length : 0} sample=${(
            targets || []
          )
            .slice(0, 3)
            .map((t) => `${t?.type}:${String(t?.url || '').slice(0, 80)}`)
            .join(' | ')}`
        );
      }
      await sleep(1200);
      continue;
    }

    for (const target of targets) {
      const wsUrl = String(target.webSocketDebuggerUrl || '').trim();
      if (!wsUrl) continue;

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
        const hasAnyDirect =
          Boolean(probe?.hasDirect) ||
          Boolean(probe?.hasRuntimeDirect) ||
          Boolean(probe?.hasChromeDirect);
        if (runtimeId && hasAnyDirect) {
          console.log(
            `[background-bridge] worker ready runtimeId=${runtimeId} hasDirect=${Boolean(probe?.hasDirect)} hasRuntimeDirect=${Boolean(
              probe?.hasRuntimeDirect
            )} hasChromeDirect=${Boolean(probe?.hasChromeDirect)}`
          );
          return { wsUrl, runtimeId };
        }
      } catch (error) {
        console.log(
          `[background-bridge] probe failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
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
    const canonicalKey = (raw) => {
      const s = String(raw || '').trim();
      if (!s) return '';
      try {
        const u = new URL(s);
        return u.origin + u.pathname;
      } catch {
        return s;
      }
    };

    const expectedKey = canonicalKey(expected);
    const hit = expectedKey
      ? jobs.find((j) => canonicalKey(String(j?.article?.sourceUrl || '')) === expectedKey) || null
      : jobs[0] || null;
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
    action: LIVE_PUBLISH_ACTION,
    focusChannel: channelId,
    channels: [channelId],
    article
  });
  if (!response?.success || !response?.jobId) {
    console.log(`[${LIVE_ACTION_LABEL}:${channelId}] direct start response=`, response);
    throw new Error(response?.error || `V2_START_JOB failed: ${channelId}`);
  }
  console.log(`[${LIVE_ACTION_LABEL}:${channelId}] direct started jobId=${response.jobId}`);
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
  const deadline = Date.now() + PER_CHANNEL_TIMEOUT_MS;
  let lastNotes = '';
  let lastProgressAt = Date.now();

  while (Date.now() < deadline) {
    let row = null;
    try {
      const state = await withTimeout(
        getJobStateDirect(bridge, jobId),
        10_000,
        `getJobStateDirect:${channelId}`
      );
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
    const diag = [
      notes,
      String(row?.userSuggestion || '').trim(),
      String(row?.devDetails?.message || '').trim()
    ]
      .filter(Boolean)
      .join('\n');
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
      const diag =
        `${String(row?.userMessage || '')}\n${String(row?.userSuggestion || '')}\n${String(row?.devDetails?.message || '')}`.trim();
      if (containsImageFail(`${notes}\n${diag}`)) {
        const failNotes = `成功态拦截：检测到图片失败痕迹\n${diag || notes}`;
        updateChannelProgress(progress, channelId, 'failed', failNotes);
        saveProgress(progressPath, progress);
        return { status: 'failed', notes: failNotes };
      } else {
        const normalizedSuccess = LIVE_PUBLISH_ACTION === 'draft' ? 'success' : 'pending_review';
        updateChannelProgress(
          progress,
          channelId,
          normalizedSuccess,
          LIVE_PUBLISH_ACTION === 'draft'
            ? `${LIVE_ACTION_SUCCESS_TEXT} | ${progressText}`
            : `已提交，等待匿名公开验收 | ${progressText}`
        );
        saveProgress(progressPath, progress);
        return { status: normalizedSuccess, row, notes: diag };
      }
    }

    if (status === 'pending_review' || status === 'rejected') return { status, row, notes: diag };

    if (status === 'not_logged_in') return { status: 'not_logged_in', notes: diag };
    if (status === 'waiting_user') return { status: 'waiting_user', row, notes: diag };
    if (status === 'failed') return { status: 'failed', row, notes: diag };

    if (status !== 'success' && now - lastProgressAt > NO_PROGRESS_TIMEOUT_MS) {
      return { status: 'stalled', notes: `${status} | ${notes}` };
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

async function setActionMode(page, action) {
  await page.check(`input[name="bawei_v2_action"][value="${action}"]`).catch(() => {});
}

async function setChannelSelection(page, wantedSet) {
  for (const id of ALL_CHANNELS) {
    const sel = `#bawei-v2-run-${id}`;
    if (!(await page.locator(sel).count())) continue;
    await page.setChecked(sel, wantedSet.has(id));
  }
}

async function waitStartReady(page) {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('#bawei-v2-start');
      if (!(btn instanceof HTMLButtonElement)) return false;
      const txt = String(btn.textContent || '');
      return !btn.disabled && (txt.includes('开始') || txt.toLowerCase().includes('start'));
    },
    null,
    { timeout: 120_000 }
  );
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
          hasButton:
            !!btn ||
            mirrorStatus === 'waiting_user' ||
            mirrorStatus === 'failed' ||
            mirrorStatus === 'not_logged_in',
          buttonText:
            buttonText ||
            (mirrorStatus === 'waiting_user'
              ? '继续'
              : mirrorStatus === 'failed' || mirrorStatus === 'not_logged_in'
                ? '重试'
                : '')
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
          hasButton:
            mirrorStatus === 'waiting_user' ||
            mirrorStatus === 'failed' ||
            mirrorStatus === 'not_logged_in',
          buttonText:
            mirrorStatus === 'waiting_user'
              ? '继续'
              : mirrorStatus === 'failed' || mirrorStatus === 'not_logged_in'
                ? '重试'
                : ''
        };
        continue;
      }

      out[id] = {
        exists: false,
        checked: false,
        badge: '',
        progress: '',
        hasButton: false,
        buttonText: ''
      };
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
          String(st.userSuggestion || '')
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
  const strictRule =
    LOGIN_AUDIT_STRICT_TEXT_RULES[channelId] ||
    /请登录|未登录|登录后继续|登录即可|请先登录|扫码登录|手机号登录|sign in|log in/i;
  const loggedRule =
    LOGIN_AUDIT_LOGGED_HINT_RULES[channelId] ||
    /个人中心|退出登录|发文章|创作中心|发布入口|写文章|我的主页/i;

  const info = await page.evaluate(
    ({ strictRuleSource, loggedRuleSource }) => {
      const bodyText = String(document.body?.innerText || '').slice(0, 5000);
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') !== 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const hasPwd = Array.from(document.querySelectorAll('input[type="password"]')).some(
        isVisible
      );
      const hasLoginBtn = Array.from(document.querySelectorAll('button,a,div,span')).some((el) => {
        if (!isVisible(el)) return false;
        const t = String(el.textContent || '').trim();
        if (!t) return false;
        return /登录|登入|sign in|log in|继续登录|扫码登录|手机号登录/i.test(t);
      });
      const hasCaptchaHints =
        /验证码|安全验证|风控|请完成验证|访问异常|环境异常|行为验证|滑动验证|captcha|human verification/i.test(
          bodyText
        );
      const strictLoginText = new RegExp(strictRuleSource, 'i').test(bodyText);
      const hasLoggedInHints = new RegExp(loggedRuleSource, 'i').test(bodyText);
      return { bodyText, hasPwd, hasLoginBtn, hasCaptchaHints, hasLoggedInHints, strictLoginText };
    },
    { strictRuleSource: strictRule.source, loggedRuleSource: loggedRule.source }
  );

  const url = String(page.url() || '');
  const lowUrl = url.toLowerCase();
  const byUrl =
    (LOGIN_URL_RULES[channelId] || []).some((r) => r.test(lowUrl)) ||
    /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i.test(lowUrl);
  const byDom = (info.hasPwd && info.hasLoginBtn) || info.strictLoginText;

  if (info.hasLoggedInHints && !byDom)
    return { status: 'logged_in', reason: 'logged-in-dom-hints', url };
  if (byUrl || byDom)
    return { status: 'not_logged_in', reason: byUrl ? 'login-url' : 'login-dom', url };
  if (info.hasCaptchaHints) return { status: 'unknown', reason: 'captcha-or-risk-page', url };
  return { status: 'logged_in', reason: 'entry-page-accessible', url };
}

async function auditLoginStatus(context, audit, auditPath) {
  const loginPages = new Map();

  for (const channelId of ACTIVE_CHANNELS) {
    const entry = LOGIN_AUDIT_ENTRY_URLS[channelId] || CHANNEL_ENTRY_URLS[channelId];
    let page = findExistingChannelAuditPage(context, channelId);
    let createdForAudit = false;
    try {
      if (page) {
        await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
        await sleep(1200);
        console.log(`[login-audit] ${channelId}: reuse existing page ${page.url()}`);
      } else {
        page = await context.newPage();
        createdForAudit = true;
        await gotoWithRetry(page, entry);
        await sleep(2200);
      }

      const result = await inspectLoginStateOnPage(page, channelId);
      audit.channels[channelId] = {
        status: result.status,
        reason: result.reason,
        url: result.url,
        updatedAt: nowIso()
      };
      const needManual =
        result.status === 'not_logged_in' ||
        (result.status === 'unknown' &&
          String(result.reason || '').includes('captcha-or-risk-page'));
      if (needManual) loginPages.set(channelId, page);
      else if (createdForAudit) await page.close().catch(() => {});
      console.log(`[login-audit] ${channelId}: ${result.status} (${result.reason}) ${result.url}`);
    } catch (error) {
      audit.channels[channelId] = {
        status: 'unknown',
        reason: `audit-error: ${error instanceof Error ? error.message : String(error)}`,
        url: String(page?.url() || entry),
        updatedAt: nowIso()
      };
      if (createdForAudit && page) await page.close().catch(() => {});
      console.log(
        `[login-audit] ${channelId}: unknown (${error instanceof Error ? error.message : String(error)})`
      );
    }
    saveLoginAudit(auditPath, audit);
  }

  return loginPages;
}

async function reloadExistingChannelPagesForFreshContentScripts(context, channelIds) {
  for (const channelId of channelIds) {
    const page = findExistingChannelAuditPage(context, channelId);
    if (!page || page.isClosed()) continue;
    const beforeUrl = String(page.url() || '');
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
      await sleep(800);
      console.log(`[content-script] ${channelId}: refreshed ${beforeUrl}`);
    } catch (error) {
      throw new Error(
        `${channelId} 页面刷新失败，无法确认当前构建的 content script 已生效：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

async function waitForManualLogin(context, loginPages, blockedChannels, audit, auditPath) {
  const pending = Array.from(new Set(blockedChannels)).filter(Boolean);
  if (!pending.length) return;

  const deadline = Date.now() + LOGIN_WAIT_TIMEOUT_MS;
  let lastLogAt = 0;

  while (Date.now() < deadline) {
    const remain = [];
    for (const channelId of pending) {
      let page = loginPages.get(channelId) || null;
      if (!page || page.isClosed()) {
        page = await context.newPage();
        loginPages.set(channelId, page);
        const entry = LOGIN_AUDIT_ENTRY_URLS[channelId] || CHANNEL_ENTRY_URLS[channelId];
        await gotoWithRetry(page, entry);
        await sleep(1200);
      }

      try {
        await page.bringToFront().catch(() => {});
      } catch {
        // ignore
      }

      try {
        const result = await inspectLoginStateOnPage(page, channelId);
        audit.channels[channelId] = {
          status: result.status,
          reason: result.reason,
          url: result.url,
          updatedAt: nowIso()
        };
        saveLoginAudit(auditPath, audit);
        if (result.status !== 'logged_in') remain.push(channelId);
      } catch (error) {
        audit.channels[channelId] = {
          status: 'unknown',
          reason: `wait-login-inspect-error: ${error instanceof Error ? error.message : String(error)}`,
          url: String(page.url() || ''),
          updatedAt: nowIso()
        };
        saveLoginAudit(auditPath, audit);
        remain.push(channelId);
      }
    }

    if (!remain.length) {
      console.log(`[login-wait] 已检测到登录完成：${pending.join(', ')}`);
      return;
    }

    if (Date.now() - lastLogAt > 8000) {
      const urlHints = remain
        .map((id) => `${id}:${String(audit.channels[id]?.url || '').slice(0, 120)}`)
        .join(' | ');
      console.log(
        `[login-wait] 等待登录（剩余 ${Math.round((deadline - Date.now()) / 1000)}s）：${urlHints}`
      );
      lastLogAt = Date.now();
    }

    await sleep(2000);
  }

  throw new Error(
    `等待登录超时（${Math.round(LOGIN_WAIT_TIMEOUT_MS / 1000)}s）：${pending.join(', ')}`
  );
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
  console.log(`[${LIVE_ACTION_LABEL}:${channelId}] start job prepare`);
  await withTimeout(waitForPanel(page), 13 * 60_000, `waitForPanel:${channelId}`);
  await withTimeout(stopIfExecuting(page), 45_000, `stopIfExecuting:${channelId}`);
  await withTimeout(waitStartReady(page), 90_000, `waitStartReady:${channelId}`);
  await withTimeout(setActionMode(page, LIVE_PUBLISH_ACTION), 10_000, `setActionMode:${channelId}`);
  await withTimeout(setFocusChannel(page, channelId), 10_000, `setFocusChannel:${channelId}`);
  await withTimeout(
    setChannelSelection(page, new Set([channelId])),
    12_000,
    `setChannelSelection:${channelId}`
  );
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
  console.log(`[${LIVE_ACTION_LABEL}:${channelId}] start clicked`);
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
      updateChannelProgress(
        progress,
        channelId,
        'running',
        `读取面板超时重试（${readRowsFailCount}/8） | ${reason}`
      );
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
      const diag = await withTimeout(
        readDiagnosis(page, channelId),
        10_000,
        `readDiagnosis:${channelId}`
      ).catch(() => '');
      if (containsImageFail(`${notes}\n${diag}`)) {
        const failNotes = `成功态拦截：检测到图片失败痕迹\n${diag || notes}`;
        updateChannelProgress(progress, channelId, 'failed', failNotes);
        saveProgress(progressPath, progress);
        return { status: 'failed', notes: failNotes };
      } else {
        const normalizedSuccess = LIVE_PUBLISH_ACTION === 'draft' ? 'success' : 'pending_review';
        updateChannelProgress(
          progress,
          channelId,
          normalizedSuccess,
          LIVE_PUBLISH_ACTION === 'draft'
            ? `${LIVE_ACTION_SUCCESS_TEXT} | ${row.progress || ''}`
            : `已提交，等待匿名公开验收 | ${row.progress || ''}`
        );
        saveProgress(progressPath, progress);
        return { status: normalizedSuccess, row, notes: diag };
      }
    }

    if (status === 'pending_review' || status === 'rejected') return { status, row, notes };

    if (status === 'not_logged_in') return { status: 'not_logged_in', notes };
    if (status === 'waiting_user') return { status: 'waiting_user', row, notes };
    if (status === 'failed') return { status: 'failed', row, notes };

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
      sourceUrl: String(location.href || '')
    };
  });
}

function countArticleImages(contentHtml) {
  return (String(contentHtml || '').match(/<img\b/gi) || []).length;
}

function extractArticleImageUrls(contentHtml) {
  return Array.from(
    String(contentHtml || '').matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)
  )
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean);
}

function decodeBasicHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code) || 0))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16) || 0)
    );
}

function htmlFragmentToPlainText(value) {
  return decodeBasicHtmlEntities(
    String(value || '')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p\s*>|<\/h[1-6]\s*>|<\/li\s*>|<\/blockquote\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function expectedFeishuTextAnchors(contentHtml) {
  const matches = Array.from(
    String(contentHtml || '').matchAll(
      /<(?:p|h[1-6]|li|blockquote)\b[^>]*>([\s\S]*?)<\/(?:p|h[1-6]|li|blockquote)>/gi
    )
  )
    .map((match) => htmlFragmentToPlainText(match[1]))
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter((text) => text.length >= 8);
  return Array.from(new Set(matches));
}

async function embedArticleImagesAsDataUrls(contentHtml) {
  let html = String(contentHtml || '');
  const sources = Array.from(new Set(extractArticleImageUrls(html)));
  for (const source of sources) {
    const response = await fetch(source, { redirect: 'follow' });
    if (!response.ok) throw new Error(`飞书可信粘贴读取图片失败：${response.status} ${source}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const mimeType = String(response.headers.get('content-type') || 'image/png')
      .split(';')[0]
      .trim();
    const dataUrl = `data:${mimeType || 'image/png'};base64,${bytes.toString('base64')}`;
    html = html.split(source).join(dataUrl);
  }
  return html;
}

async function collectFeishuVirtualEvidence(page) {
  return await page.evaluate(async () => {
    const scrollRoot = document.querySelector('.bear-web-x-container');
    const originalScrollTop = scrollRoot instanceof HTMLElement ? scrollRoot.scrollTop : 0;
    const blocks = new Map();
    const collect = () => {
      for (const block of Array.from(
        document.querySelectorAll('.page-block-children .block[data-block-id]')
      )) {
        const key =
          String(block.getAttribute('data-record-id') || '').trim() ||
          String(block.getAttribute('data-block-id') || '').trim();
        if (!key) continue;
        const type = String(block.getAttribute('data-block-type') || '').trim();
        const text = String(block.innerText || block.textContent || '')
          .replace(/\u200b/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const images = Array.from(block.querySelectorAll('img.docx-image, img'))
          .map((image) => String(image.currentSrc || image.src || '').trim())
          .filter((url) => /^https:\/\//i.test(url) && !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(url));
        const imageTokens = Array.from(block.querySelectorAll('[image-token]'))
          .map((node) => String(node.getAttribute('image-token') || '').trim())
          .filter(Boolean);
        blocks.set(key, { key, type, text, images, imageTokens });
      }
    };

    if (scrollRoot instanceof HTMLElement) {
      const max = Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight);
      const step = Math.max(260, Math.floor(scrollRoot.clientHeight * 0.6));
      for (let top = 0; top <= max; top += step) {
        scrollRoot.scrollTop = top;
        scrollRoot.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 160));
        collect();
      }
      scrollRoot.scrollTop = max;
      scrollRoot.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 160));
      collect();
      scrollRoot.scrollTop = originalScrollTop;
      scrollRoot.dispatchEvent(new Event('scroll', { bubbles: true }));
    } else {
      collect();
    }

    const title = String(document.querySelector('h1.page-block-content')?.innerText || '')
      .replace(/\u200b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const values = Array.from(blocks.values());
    const imageUrls = Array.from(new Set(values.flatMap((value) => value.images)));
    const imageTokens = Array.from(new Set(values.flatMap((value) => value.imageTokens)));
    const saveText = Array.from(document.querySelectorAll('.note-title__time'))
      .map((node) => String(node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return {
      title,
      text: values.map((value) => value.text).filter(Boolean).join('\n'),
      blocks: values,
      blockCount: values.length,
      imageUrls,
      imageTokens,
      imageCount: Math.max(imageUrls.length, imageTokens.length),
      saveText,
      scrollHeight: scrollRoot instanceof HTMLElement ? scrollRoot.scrollHeight : 0
    };
  });
}

function feishuEvidenceMatchesArticle(evidence, article) {
  const expectedTitle = String(article?.title || '').trim();
  const expectedImages = countArticleImages(article?.contentHtml || '');
  const anchors = expectedFeishuTextAnchors(article?.contentHtml || '');
  const missingAnchors = anchors.filter((anchor) => !String(evidence?.text || '').includes(anchor));
  return {
    ok:
      String(evidence?.title || '').trim() === expectedTitle &&
      Number(evidence?.imageCount || 0) >= expectedImages &&
      missingAnchors.length === 0,
    expectedImages,
    anchors,
    missingAnchors
  };
}

async function findFeishuRecoveryPage(context, article) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const candidates = context
      .pages()
      .slice()
      .reverse()
      .filter((page) => /^https:\/\/wuxinxuexi\.feishu\.cn\/docx\//i.test(page.url()));
    for (const page of candidates) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (!article?.title || bodyText.includes(article.title) || candidates.length === 1) return page;
    }
    await sleep(500);
  }
  throw new Error('飞书可信粘贴恢复未找到本次 docx 页面');
}

async function restoreFeishuTitleTrusted(page, title) {
  const editor = page
    .locator('h1.page-block-content .zone-container.text-editor[contenteditable="true"]')
    .first();
  await editor.waitFor({ state: 'visible', timeout: 30_000 });
  const current = String(await editor.innerText().catch(() => ''))
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (current === String(title || '').trim()) return;
  await editor.click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.insertText(String(title || '').trim());
}

async function pasteFeishuArticleTrusted(context, page, article) {
  const richHtml = await embedArticleImagesAsDataUrls(article.contentHtml);
  const plainText = htmlFragmentToPlainText(article.contentHtml);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'https://wuxinxuexi.feishu.cn'
  });
  await page.evaluate(
    async ({ html, text }) => {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
    },
    { html: richHtml, text: plainText }
  );

  let bodyEditor = page
    .locator(
      '.page-block-children .block.docx-text-block .zone-container.text-editor[contenteditable="true"]'
    )
    .first();
  await bodyEditor.waitFor({ state: 'visible', timeout: 30_000 });
  await bodyEditor.click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(600);

  bodyEditor = page
    .locator(
      '.page-block-children .block.docx-text-block .zone-container.text-editor[contenteditable="true"]'
    )
    .first();
  if (!(await bodyEditor.count())) {
    await restoreFeishuTitleTrusted(page, article.title);
    const titleEditor = page
      .locator('h1.page-block-content .zone-container.text-editor[contenteditable="true"]')
      .first();
    await titleEditor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    bodyEditor = page
      .locator(
        '.page-block-children .block.docx-text-block .zone-container.text-editor[contenteditable="true"]'
      )
      .first();
  }
  await bodyEditor.waitFor({ state: 'visible', timeout: 30_000 });
  await bodyEditor.click();
  await page.keyboard.press('Meta+V');
}

async function ensureFeishuAnonymousSharingTrusted(page) {
  const shareButton = page.locator('button.suite-share').filter({ hasText: '分享' }).last();
  await shareButton.waitFor({ state: 'visible', timeout: 30_000 });
  if (!(await page.locator('.share-popover-v2').isVisible().catch(() => false))) {
    await shareButton.click();
  }
  const sharePopover = page.locator('.share-popover-v2').last();
  await sharePopover.waitFor({ state: 'visible', timeout: 30_000 });
  let shareText = String(await sharePopover.innerText().catch(() => ''));
  if (/互联网获得链接的人可阅读|互联网上获得链接的任何人可阅读/.test(shareText)) return;

  const scopeDropdown = sharePopover.locator('button.link-share-detail-v2__dropdown').first();
  await scopeDropdown.click();
  const internetOption = page
    .getByRole('menuitem')
    .filter({ hasText: /互联网获得链接的人|互联网上获得链接的任何人/ })
    .last();
  await internetOption.waitFor({ state: 'visible', timeout: 30_000 });
  await internetOption.click();
  const confirmDialog = page.getByRole('dialog').filter({ hasText: /互联网上获得链接的人/ });
  if (await confirmDialog.isVisible().catch(() => false)) {
    await confirmDialog.getByRole('button', { name: '确认', exact: true }).click();
  }
  await page.waitForFunction(
    () =>
      /互联网获得链接的人可阅读|互联网上获得链接的任何人可阅读/.test(
        String(document.querySelector('.share-popover-v2')?.textContent || '')
      ),
    null,
    { timeout: 30_000 }
  );
  shareText = String(await sharePopover.innerText().catch(() => ''));
  if (!/互联网获得链接的人可阅读|互联网上获得链接的任何人可阅读/.test(shareText)) {
    throw new Error('飞书匿名分享权限未生效');
  }
}

async function verifyFeishuAnonymouslyTrusted(url, article) {
  const anonymousBrowser = await chromium.launch({ headless: true });
  try {
    const context = await anonymousBrowser.newContext();
    const initialCookieCount = (await context.cookies()).length;
    const page = await context.newPage();
    await gotoWithRetry(page, url);
    await page.waitForTimeout(5000);
    const evidence = await collectFeishuVirtualEvidence(page);
    const match = feishuEvidenceMatchesArticle(evidence, article);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (!match.ok) {
      throw new Error(
        `飞书匿名验收失败：title=${evidence.title === article.title} images=${evidence.imageCount}/${match.expectedImages} missing=${match.missingAnchors.length}`
      );
    }
    return {
      ok: true,
      url: page.url(),
      initialCookieCount,
      loginPromptVisible: /登录|注册/.test(bodyText),
      title: evidence.title,
      observedBlockCount: evidence.blockCount,
      observedImageCount: evidence.imageCount,
      imageUrls: evidence.imageUrls,
      missingAnchors: match.missingAnchors
    };
  } finally {
    await anonymousBrowser.close().catch(() => {});
  }
}

async function recoverFeishuWithTrustedClipboard({ context, bridge, jobId, channelRun }) {
  const page = await findFeishuRecoveryPage(context, channelRun.article);
  await page.bringToFront().catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(2500);

  let evidence = await collectFeishuVirtualEvidence(page);
  let match = feishuEvidenceMatchesArticle(evidence, channelRun.article);
  if (!match.ok) {
    const uploadSignals = { prepare: 0, finish: 0 };
    const onResponse = (response) => {
      const url = String(response.url() || '');
      if (/\/upload\/prepare\//i.test(url)) uploadSignals.prepare += 1;
      if (/\/upload\/finish\//i.test(url)) uploadSignals.finish += 1;
    };
    page.on('response', onResponse);
    try {
      await pasteFeishuArticleTrusted(context, page, channelRun.article);
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1800);
        evidence = await collectFeishuVirtualEvidence(page);
        match = feishuEvidenceMatchesArticle(evidence, channelRun.article);
        if (match.ok) break;
      }
      if (!match.ok) {
        throw new Error(
          `飞书可信粘贴未完整落库：images=${evidence.imageCount}/${match.expectedImages} missing=${match.missingAnchors.length} upload=${uploadSignals.prepare}/${uploadSignals.finish}`
        );
      }
    } finally {
      page.off('response', onResponse);
    }
  }

  await restoreFeishuTitleTrusted(page, channelRun.article.title);
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('.note-title__time')).some((node) => {
        const text = String(node.textContent || '').trim();
        return !!text && !text.includes('保存中');
      }),
    null,
    { timeout: 90_000 }
  );

  evidence = await collectFeishuVirtualEvidence(page);
  match = feishuEvidenceMatchesArticle(evidence, channelRun.article);
  if (!match.ok) throw new Error('飞书登录态最终验收未通过');
  const documentUrl = page.url();
  const isPublishing = LIVE_PUBLISH_ACTION === 'publish';
  let anonymousEvidence;
  if (isPublishing) {
    await ensureFeishuAnonymousSharingTrusted(page);
    anonymousEvidence = await verifyFeishuAnonymouslyTrusted(
      documentUrl,
      channelRun.article
    );
  }
  const devDetails = {
    documentUrl,
    publishedUrl: isPublishing ? documentUrl : undefined,
    candidatePublicUrl: isPublishing ? documentUrl : undefined,
    managementUrl: getChannelConfig('feishu-docs').managementUrl,
    reviewStatus: isPublishing ? 'anonymous_link_enabled' : 'draft_saved',
    savedToCloud: true,
    anonymousReadable: isPublishing ? true : undefined,
    expectedImageCount: match.expectedImages,
    observedImageCount: evidence.imageCount,
    observedBlockCount: evidence.blockCount,
    ...(anonymousEvidence ? { anonymousEvidence } : {})
  };
  await sendBackgroundMessage(bridge, {
    type: 'V2_CHANNEL_UPDATE',
    jobId,
    channelId: 'feishu-docs',
    patch: {
      status: LIVE_PUBLISH_ACTION === 'draft' ? 'success' : 'pending_review',
      stage: 'done',
      userMessage: isPublishing
        ? '飞书可信粘贴恢复完成，标题、全文、图片与匿名权限验收通过'
        : '飞书可信粘贴恢复完成，标题、全文、图片与云端保存验收通过',
      userSuggestion: undefined,
      devDetails
    }
  }).catch(() => {});
  return {
    status: LIVE_PUBLISH_ACTION === 'draft' ? 'success' : 'pending_review',
    row: { devDetails },
    notes: isPublishing
      ? '飞书可信粘贴与无 Cookie 匿名验收通过'
      : '飞书可信粘贴与云端保存验收通过'
  };
}

function buildFallbackContentHash(channelId, article) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        channelId,
        title: String(article?.title || '').trim(),
        contentHtml: String(article?.contentHtml || '').trim(),
        sourceUrl: String(article?.sourceUrl || '').trim()
      })
    )
    .digest('hex');
}

function articleRunForChannel(channelId, baseArticle, suppliedChannelArticles) {
  const supplied = suppliedChannelArticles?.[channelId] || null;
  const article = supplied?.article || baseArticle;
  return {
    article: {
      title: String(article?.title || ''),
      contentHtml: String(article?.contentHtml || ''),
      sourceUrl: String(article?.sourceUrl || ''),
      contentTokens: Array.isArray(article?.contentTokens) ? article.contentTokens : undefined
    },
    contentHash: String(supplied?.contentHash || buildFallbackContentHash(channelId, article)),
    expectedImageCount: Number.isFinite(Number(supplied?.expectedImageCount))
      ? Number(supplied.expectedImageCount)
      : countArticleImages(article?.contentHtml),
    sourceImageUrls: extractArticleImageUrls(article?.contentHtml),
    markdown: String(supplied?.markdown || '')
  };
}

function candidatePublicUrlFromResult(result) {
  const details = result?.row?.devDetails || {};
  const candidates = [details.candidatePublicUrl, details.publishedUrl, result?.candidatePublicUrl];
  const config = result?.channelId ? getChannelConfig(result.channelId) : null;
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    if (!config || config.publicUrlPatterns.some((pattern) => new RegExp(pattern, 'i').test(value)))
      return value;
  }
  return '';
}

async function verifyAndRecordCandidate({
  browser,
  ledger,
  ledgerPath,
  channelId,
  channelRun,
  candidatePublicUrl,
  progress,
  progressPath
}) {
  const evidenceDir = abs(
    path.join('artifacts/live-publish/evidence', channelRun.contentHash, channelId)
  );
  const evidence = await verifyPublicationAnonymously({
    browser,
    channelId,
    candidatePublicUrl,
    title: channelRun.article.title,
    contentHtml: channelRun.article.contentHtml,
    expectedImageCount: channelRun.expectedImageCount,
    sourceImageUrls: channelRun.sourceImageUrls,
    outputDir: evidenceDir
  });
  const common = {
    channelId,
    contentHash: channelRun.contentHash,
    title: channelRun.article.title,
    candidatePublicUrl,
    managementUrl: getChannelConfig(channelId).managementUrl,
    expectedImageCount: channelRun.expectedImageCount,
    observedImageCount: evidence.loadedImageCount,
    evidencePath: evidence.evidencePath,
    evidenceSha256: evidence.evidenceSha256,
    anonymousEvidence: {
      ok: evidence.ok,
      finalUrl: evidence.finalUrl,
      anchorsMatched: evidence.anchorsMatched,
      loadedImageCount: evidence.loadedImageCount,
      errors: evidence.errors
    }
  };
  if (evidence.ok) {
    upsertPublicationOutcome(ledger, { ...common, status: 'success', reviewStatus: 'public' });
    savePublicationLedger(ledger, ledgerPath);
    updateChannelProgress(
      progress,
      channelId,
      'success',
      `匿名公开验收通过 | ${candidatePublicUrl}`
    );
    saveProgress(progressPath, progress);
    return { status: 'success', evidence };
  }
  upsertPublicationOutcome(ledger, {
    ...common,
    status: 'pending_review',
    reviewStatus: 'anonymous_not_ready'
  });
  savePublicationLedger(ledger, ledgerPath);
  updateChannelProgress(
    progress,
    channelId,
    'pending_review',
    `已提交，匿名验收尚未通过 | ${evidence.errors.join(', ')}`
  );
  saveProgress(progressPath, progress);
  return { status: 'pending_review', evidence };
}

function parseCli() {
  const first = String(process.argv[2] || '').trim();
  if (first === 'open') return { mode: 'open', articleUrl: DEFAULT_ARTICLE_URL };
  if (first === 'publish') {
    const articleUrl = String(process.argv[3] || DEFAULT_ARTICLE_URL).trim();
    return { mode: 'publish', articleUrl };
  }
  if (first === 'markdown') {
    const markdownPath = String(process.argv[3] || '').trim();
    if (!markdownPath)
      throw new Error(
        '缺少 Markdown 文件路径；用法：npm run publish:markdown -- /绝对或相对路径/article.md'
      );
    return { mode: 'markdown', markdownPath };
  }
  const articleUrl = String(process.argv[2] || DEFAULT_ARTICLE_URL).trim();
  return { mode: 'legacy', articleUrl };
}

function runBuildOrThrow() {
  console.log('[build] npm run build');
  execSync('npm run build', { stdio: 'inherit' });
  const manifestPath = path.join(abs('dist'), 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`build 完成但未找到扩展产物：${manifestPath}`);
  }
}

async function openChannelEditorTabs(context) {
  console.log(`[open] open ${ACTIVE_CHANNELS.length} channel editor tabs...`);
  for (const channelId of ACTIVE_CHANNELS) {
    const url = CHANNEL_ENTRY_URLS[channelId];
    console.log(`[open] ${channelId}: ${url}`);
    const page = await context.newPage();
    await gotoWithRetry(page, url);
    await sleep(1000);
  }
  console.log(`[open] 已打开渠道：${ACTIVE_CHANNELS.join(', ')}`);
}

async function runOpenChannelEditors() {
  forceBypassProxyForLocalCdp();

  runBuildOrThrow();

  const distDir = abs('dist');
  const userDataDir = abs(process.env.CHROME_PROFILE_DIR || 'artifacts/chrome-cdp-live-profile-v8');

  const cdp = await ensureChromeAndGetWs({
    port: CHROME_CDP_PORT,
    userDataDir,
    distDir,
    forceRestart: true,
    requireExisting: false
  });
  console.log('[cdp] connected ws:', cdp.ws, `reused=${cdp.reused}`);

  let browser = null;
  try {
    browser = await chromium.connectOverCDP(cdp.ws, { timeout: 120_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('CDP context 不存在');
    installContextDialogAutoDismiss(context, 'open');
    await openChannelEditorTabs(context);
    console.log(
      '[open] 完成：请在浏览器里完成登录/验证码，然后执行：npm run live:publish -- <微信文章URL>'
    );
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore
    }
  }
}

async function runPublishOnce(articleUrl, options) {
  forceBypassProxyForLocalCdp();

  const suppliedArticle = options?.articlePayload || null;
  const suppliedChannelArticles = options?.channelArticles || null;
  const suppliedVariants = options?.variants || {};
  const distDir = abs('dist');
  const progressPath = abs('artifacts/live-publish/mcp-publish-progress.json');
  const auditPath = abs('artifacts/live-publish/mcp-login-audit.json');
  const ledgerPath = abs('artifacts/live-publish/publication-ledger.json');
  const userDataDir = abs(process.env.CHROME_PROFILE_DIR || 'artifacts/chrome-cdp-live-profile-v8');

  if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`未找到扩展产物：${path.join(distDir, 'manifest.json')}（请先 npm run build）`);
  }

  ensureArtifactsDirExists('artifacts/live-publish/mcp-publish-progress.json');
  ensureArtifactsDirExists('artifacts/live-publish/mcp-login-audit.json');
  const progress = loadProgress(progressPath, articleUrl);
  const audit = createLoginAudit(articleUrl);
  const ledger = loadPublicationLedger(ledgerPath);
  saveProgress(progressPath, progress);
  saveLoginAudit(auditPath, audit);

  const cdp = await ensureChromeAndGetWs({
    port: CHROME_CDP_PORT,
    userDataDir,
    distDir,
    forceRestart: !options?.requireExistingChrome,
    requireExisting: Boolean(options?.requireExistingChrome)
  });
  console.log('[cdp] connected ws:', cdp.ws, `reused=${cdp.reused}`);

  let browser = null;
  try {
    const initialConnectTimeout = options?.requireExistingChrome ? 120_000 : 30_000;
    try {
      browser = await chromium.connectOverCDP(cdp.ws, { timeout: initialConnectTimeout });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (options?.requireExistingChrome) {
        throw new Error(`复用现有浏览器失败（不会自动重启当前会话）：${reason}`);
      }
      console.log(`[cdp] connectOverCDP 失败，尝试重启后重连：${reason}`);
      const restarted = await ensureChromeAndGetWs({
        port: CHROME_CDP_PORT,
        userDataDir,
        distDir,
        forceRestart: true,
        requireExisting: false
      });
      console.log('[cdp] restarted ws:', restarted.ws, `reused=${restarted.reused}`);
      browser = await chromium.connectOverCDP(restarted.ws, { timeout: 120_000 });
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error('CDP context 不存在');
    let extensionRefreshedInExistingChrome = false;
    if (options?.requireExistingChrome) {
      await refreshBaweiExtensionInExistingChrome(context, distDir);
      extensionRefreshedInExistingChrome = true;
    }
    installContextDialogAutoDismiss(context, 'publish');
    if (ACTIVE_CHANNELS.includes('sspai')) installNetworkLogger(context, 'sspai');
    if (ACTIVE_CHANNELS.includes('mowen')) installNetworkLogger(context, 'mowen');
    if (ACTIVE_CHANNELS.includes('tencent-cloud-dev'))
      installNetworkLogger(context, 'tencent-cloud-dev');

    if (!options?.preserveExistingPages) {
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          try {
            if (!p.isClosed()) await p.close();
          } catch {
            // ignore
          }
        }
      }
    }

    const existingWechatPage =
      options?.preserveExistingPages && !suppliedArticle
        ? context.pages().find((p) => canonicalUrlKey(p.url()) === canonicalUrlKey(articleUrl)) ||
          context.pages().find((p) => /mp\.weixin\.qq\.com\/s\//i.test(String(p.url() || '')))
        : null;
    const wechatPage = existingWechatPage || (await context.newPage());
    wechatPage.on('console', (msg) => {
      try {
        const type = msg.type();
        const text = msg.text();
        if (
          type === 'error' ||
          /bawei|WeChat content script|publish panel|Failed to initialize/i.test(text)
        ) {
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

    await wechatPage.bringToFront().catch(() => {});
    if (existingWechatPage) {
      console.log('[main] reuse article page', wechatPage.url());
    } else if (suppliedArticle) {
      console.log('[main] 使用本地 Markdown payload，跳过文章网页加载');
    } else {
      console.log('[main] open article', articleUrl);
      await gotoWithRetry(wechatPage, articleUrl).catch(() => {});
    }

    let directMode = USE_BACKGROUND_DIRECT;
    if (suppliedArticle && !directMode) {
      throw new Error(
        '本地 Markdown 发布必须使用 background 直连模式；请移除 USE_BACKGROUND_DIRECT=0'
      );
    }
    if (!directMode) {
      console.log('[main] wait panel...');
      await ensureWechatPanelReady(wechatPage, articleUrl, 'main');
      console.log('[main] panel ready');
    } else {
      console.log('[main] 使用 background 直连模式（跳过面板依赖）');
    }

    console.log('[main] attach background bridge...');
    let backgroundBridge = await withTimeout(
      createBackgroundBridge(),
      120_000,
      'createBackgroundBridge'
    );
    console.log('[main] background bridge ready');

    let articlePayloadForRun = suppliedArticle
      ? {
          title: String(suppliedArticle.title || ''),
          contentHtml: String(suppliedArticle.contentHtml || ''),
          sourceUrl: String(suppliedArticle.sourceUrl || ''),
          contentTokens: Array.isArray(suppliedArticle.contentTokens)
            ? suppliedArticle.contentTokens
            : undefined
        }
      : null;
    if (directMode) {
      if (!articlePayloadForRun) {
        articlePayloadForRun = await withTimeout(
          loadArticlePayloadFromBackground(backgroundBridge, articleUrl).catch(() => null),
          45_000,
          'loadArticlePayloadFromBackground'
        ).catch(() => null);

        try {
          const expectedKey = canonicalUrlKey(articleUrl);
          const gotKey = canonicalUrlKey(articlePayloadForRun?.sourceUrl || '');
          if (expectedKey && gotKey && expectedKey !== gotKey) {
            console.log(
              `[main] warning: background payload mismatch; fallback to page extract (expected=${articleUrl} got=${articlePayloadForRun?.sourceUrl})`
            );
            articlePayloadForRun = null;
          }
        } catch {
          // ignore
        }
      }

      if (!articlePayloadForRun?.title || !articlePayloadForRun?.contentHtml) {
        const fallback = await withTimeout(
          extractArticlePayloadFromPage(wechatPage),
          20_000,
          'extractArticlePayloadFromPage'
        ).catch(() => null);
        if (fallback?.title && fallback?.contentHtml) {
          articlePayloadForRun = {
            title: fallback.title,
            contentHtml: fallback.contentHtml,
            sourceUrl: fallback.sourceUrl || articleUrl
          };
        }
      }
      if (!articlePayloadForRun?.title || !articlePayloadForRun?.contentHtml) {
        throw new Error(
          'background 直连模式未能获取文章 payload（请先在微信页启动过一次任务，或确保文章正文可见）'
        );
      }
      console.log(
        `[main] article payload ready: title=${String(articlePayloadForRun.title).slice(0, 32)} htmlLen=${String(articlePayloadForRun.contentHtml).length}`
      );
      dumpArticlePayloadToArtifacts(articlePayloadForRun, articleUrl);
    }

    const channelRuns = Object.fromEntries(
      ACTIVE_CHANNELS.map((channelId) => [
        channelId,
        articleRunForChannel(channelId, articlePayloadForRun, suppliedChannelArticles)
      ])
    );

    if (LIVE_PUBLISH_ACTION === 'publish') {
      for (const channelId of ACTIVE_CHANNELS) {
        const channelRun = channelRuns[channelId];
        const decision = getLedgerDecision({
          ledger,
          channelId,
          contentHash: channelRun.contentHash
        });
        if (decision.action === 'skip_success') {
          updateChannelProgress(
            progress,
            channelId,
            'success',
            `防重跳过：同内容哈希已匿名公开 | ${decision.entry?.candidatePublicUrl || ''}`
          );
          continue;
        }
        if (decision.action === 'skip_rejected') {
          updateChannelProgress(
            progress,
            channelId,
            'rejected',
            `防重跳过：同内容哈希已退回 | ${decision.entry?.rejectionReason || 'rejected'}`
          );
          continue;
        }
        if (decision.action === 'wait_user') {
          updateChannelProgress(
            progress,
            channelId,
            'waiting_user',
            `等待人工安全验证，禁止自动重投 | ${decision.entry?.technicalFailureReason || 'human-verification-required'}`
          );
          continue;
        }
        if (decision.action === 'verify_pending') {
          const candidatePublicUrl = String(decision.entry?.candidatePublicUrl || '').trim();
          if (candidatePublicUrl) {
            await verifyAndRecordCandidate({
              browser,
              ledger,
              ledgerPath,
              channelId,
              channelRun,
              candidatePublicUrl,
              progress,
              progressPath
            }).catch((error) => {
              updateChannelProgress(
                progress,
                channelId,
                'pending_review',
                `待审复核执行失败，禁止重投 | ${error instanceof Error ? error.message : String(error)}`
              );
            });
          } else {
            updateChannelProgress(
              progress,
              channelId,
              'pending_review',
              '同内容已提交待审，尚无候选公开地址，禁止重投'
            );
          }
          continue;
        }
        if (channelId === 'woshipm' && suppliedArticle) {
          const woshipmVariant = String(suppliedVariants?.woshipm || '').trim();
          if (!woshipmVariant) {
            throw new Error('人人都是产品经理正式发布必须提供 bawei:variant woshipm 渠道变体');
          }
          validateWoshipmVariant(woshipmVariant);
        }
        updateChannelProgress(progress, channelId, 'pending', decision.reason);
      }
      saveProgress(progressPath, progress);
    }

    await maybeImportStorageState(context);

    if (extensionRefreshedInExistingChrome) {
      const channelsNeedingFreshScripts = ACTIVE_CHANNELS.filter(
        (channelId) => progress.channels[channelId]?.status === 'pending'
      );
      await reloadExistingChannelPagesForFreshContentScripts(context, channelsNeedingFreshScripts);
    }

    console.log('[main] start login audit...');
    const loginPages = await auditLoginStatus(context, audit, auditPath);
    console.log('[main] login audit done');

    const blockedByLogin = [];
    for (const channelId of ACTIVE_CHANNELS) {
      const isStableLedgerOutcome = ['success', 'pending_review', 'rejected', 'waiting_user'].includes(
        progress.channels[channelId].status
      );
      if (LIVE_PUBLISH_ACTION === 'publish' && isStableLedgerOutcome) continue;
      const auditStatus = audit.channels[channelId]?.status || 'unknown';
      const auditReason = String(audit.channels[channelId]?.reason || '');
      if (
        auditStatus === 'not_logged_in' ||
        (auditStatus === 'unknown' && auditReason.includes('captcha-or-risk-page'))
      ) {
        blockedByLogin.push(channelId);
        if (WAIT_FOR_LOGIN) {
          updateChannelProgress(
            progress,
            channelId,
            'pending',
            `登录审计提示未登录：${auditReason || 'not_logged_in'}（等待登录）`
          );
        } else {
          updateChannelProgress(
            progress,
            channelId,
            'not_logged_in',
            `登录审计阻塞：${auditReason || 'not_logged_in'}`
          );
        }
      } else if (progress.channels[channelId].status !== 'success') {
        updateChannelProgress(progress, channelId, 'pending', '登录审计通过，等待发布');
      }
    }
    saveProgress(progressPath, progress);

    if (blockedByLogin.length && WAIT_FOR_LOGIN) {
      console.log(`[main] 登录审计发现未登录渠道，开始等待登录：${blockedByLogin.join(', ')}`);
      await waitForManualLogin(context, loginPages, blockedByLogin, audit, auditPath);

      for (const channelId of blockedByLogin) {
        const isStableLedgerOutcome = ['success', 'pending_review', 'rejected', 'waiting_user'].includes(
          progress.channels[channelId].status
        );
        if (LIVE_PUBLISH_ACTION === 'publish' && isStableLedgerOutcome) continue;
        const auditStatus = audit.channels[channelId]?.status || 'unknown';
        const auditReason = String(audit.channels[channelId]?.reason || '');
        if (auditStatus === 'logged_in') {
          if (progress.channels[channelId].status !== 'success') {
            updateChannelProgress(progress, channelId, 'pending', '等待登录完成，进入发布队列');
          }
        } else {
          updateChannelProgress(
            progress,
            channelId,
            'not_logged_in',
            `等待登录后仍未通过：${auditReason || auditStatus}`
          );
        }
      }
      saveProgress(progressPath, progress);
    } else if (blockedByLogin.length) {
      console.log(`[main] 登录审计阻塞渠道（本轮直接失败）: ${blockedByLogin.join(', ')}`);
    }

    console.log(`[main] start single-pass ${LIVE_ACTION_TEXT}（仅执行 pending 渠道）`);
    const pending = ACTIVE_CHANNELS.filter((id) => progress.channels[id].status === 'pending').sort(
      (a, b) => {
        const score = (id) => {
          if (id === 'sspai') return 3;
          if (id === 'csdn') return 2;
          if (id === 'tencent-cloud-dev') return 1;
          return 0;
        };
        return score(a) - score(b);
      }
    );

    if (!pending.length) {
      saveProgress(progressPath, progress);
      const summary = printRunSummary(progress);
      if (summary.publicSuccessCount !== ACTIVE_CHANNELS.length) process.exitCode = 2;
      return summary;
    }

    console.log(`\n===== ${LIVE_ACTION_LABEL}-single-pass =====`);
    console.log(`pending(${pending.length}): ${pending.join(', ')}`);

    for (const channelId of pending) {
      const current = progress.channels[channelId]?.status;
      if (current === 'success') continue;
      const channelRun = channelRuns[channelId];

      incAttempt(progress, channelId);
      updateChannelProgress(
        progress,
        channelId,
        'running',
        `开始第 ${progress.channels[channelId].attempts} 次${LIVE_ACTION_TEXT}尝试`
      );
      saveProgress(progressPath, progress);
      console.log(
        `[${LIVE_ACTION_LABEL}] ${channelId}: attempt=${progress.channels[channelId].attempts}`
      );

      let jobIdForChannel = '';
      try {
        if (directMode) {
          try {
            jobIdForChannel = await startSingleChannelJobDirect(
              backgroundBridge,
              channelId,
              channelRun.article
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (reason.includes('target') || reason.includes('session')) {
              backgroundBridge = await createBackgroundBridge();
              jobIdForChannel = await startSingleChannelJobDirect(
                backgroundBridge,
                channelId,
                channelRun.article
              );
            } else {
              throw error;
            }
          }
        } else {
          await startSingleChannelJob(wechatPage, channelId);
        }
      } catch (error) {
        updateChannelProgress(
          progress,
          channelId,
          'failed',
          `启动${LIVE_ACTION_TEXT}失败：${error instanceof Error ? error.message : String(error)}`
        );
        saveProgress(progressPath, progress);
        continue;
      }

      let result = directMode
        ? await waitSingleChannelResultDirect({
            bridge: backgroundBridge,
            jobId: jobIdForChannel,
            channelId,
            progress,
            progressPath
          })
        : await waitSingleChannelResult({
            page: wechatPage,
            channelId,
            progress,
            progressPath
          });

      if (
        directMode &&
        channelId === 'feishu-docs' &&
        ['waiting_user', 'failed'].includes(result.status)
      ) {
        try {
          updateChannelProgress(
            progress,
            channelId,
            'running',
            '飞书扩展侧写入未完整落库，启动可信剪贴板恢复'
          );
          saveProgress(progressPath, progress);
          result = await recoverFeishuWithTrustedClipboard({
            context,
            bridge: backgroundBridge,
            jobId: jobIdForChannel,
            channelRun
          });
        } catch (error) {
          result = {
            ...result,
            notes: `${result.notes || ''}\n飞书可信剪贴板恢复失败：${error instanceof Error ? error.message : String(error)}`.trim()
          };
        }
      }

      if (result.status === 'success') {
        console.log(`[${LIVE_ACTION_LABEL}] ${channelId}: success`);
        continue;
      }

      if (
        LIVE_PUBLISH_ACTION === 'publish' &&
        (result.status === 'pending_review' || result.status === 'rejected')
      ) {
        result.channelId = channelId;
        const details = result?.row?.devDetails || {};
        const candidatePublicUrl = candidatePublicUrlFromResult(result);
        const common = {
          channelId,
          contentHash: channelRun.contentHash,
          sourceMarkdownHash: String(options?.sourceMarkdownHash || ''),
          title: channelRun.article.title,
          managementUrl: String(
            details.managementUrl || details.listUrl || getChannelConfig(channelId).managementUrl
          ),
          candidatePublicUrl,
          submittedAt: new Date().toISOString(),
          expectedImageCount: channelRun.expectedImageCount,
          observedImageCount: Number(details.observedImageCount || 0)
        };

        if (result.status === 'rejected') {
          const rejectionReason = String(
            details.rejectionReason || details.message || result.notes || '平台明确退回'
          ).trim();
          upsertPublicationOutcome(ledger, {
            ...common,
            status: 'rejected',
            reviewStatus: String(details.reviewStatus || 'rejected'),
            rejectionReason
          });
          savePublicationLedger(ledger, ledgerPath);
          updateChannelProgress(progress, channelId, 'rejected', rejectionReason);
          saveProgress(progressPath, progress);
          console.log(`[publish] ${channelId}: rejected`);
          continue;
        }

        upsertPublicationOutcome(ledger, {
          ...common,
          status: 'pending_review',
          reviewStatus: String(
            details.reviewStatus || (candidatePublicUrl ? 'candidate_public_url' : 'submitted')
          )
        });
        savePublicationLedger(ledger, ledgerPath);

        if (candidatePublicUrl) {
          const verified = await verifyAndRecordCandidate({
            browser,
            ledger,
            ledgerPath,
            channelId,
            channelRun,
            candidatePublicUrl,
            progress,
            progressPath
          }).catch((error) => {
            updateChannelProgress(
              progress,
              channelId,
              'pending_review',
              `匿名验收执行失败，保留待审且禁止重投 | ${error instanceof Error ? error.message : String(error)}`
            );
            saveProgress(progressPath, progress);
            return { status: 'pending_review' };
          });
          console.log(`[publish] ${channelId}: ${verified.status}`);
        } else {
          updateChannelProgress(
            progress,
            channelId,
            'pending_review',
            '平台已接收，尚无候选公开地址'
          );
          saveProgress(progressPath, progress);
          console.log(`[publish] ${channelId}: pending_review (no public url yet)`);
        }
        continue;
      }

      if (result.status === 'timeout') {
        const diag = directMode
          ? JSON.stringify(
              ((await getJobStateDirect(backgroundBridge, jobIdForChannel).catch(() => null)) ||
                {})[channelId] || {}
            )
          : await withTimeout(
              readDiagnosis(wechatPage, channelId),
              10_000,
              `readDiagnosis:${channelId}`
            ).catch(() => '');
        result = { status: 'timeout', notes: `单渠道超时\n${diag}` };
      }

      if (result.status === 'stalled') {
        const diag = directMode
          ? JSON.stringify(
              ((await getJobStateDirect(backgroundBridge, jobIdForChannel).catch(() => null)) ||
                {})[channelId] || {}
            )
          : await withTimeout(
              readDiagnosis(wechatPage, channelId),
              10_000,
              `readDiagnosis:${channelId}`
            ).catch(() => '');
        result = {
          status: 'stalled',
          notes: `无进度超时（${Math.round(NO_PROGRESS_TIMEOUT_MS / 1000)}s）\n${result.notes || ''}\n${diag}`
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
          updatedAt: nowIso()
        };
        saveLoginAudit(auditPath, audit);
      }

      if (isBlockingRuntimeResult(result.status)) {
        const reasonMap = {
          not_logged_in: `${LIVE_ACTION_TEXT}中检测到未登录（阻塞）`,
          waiting_user: `${LIVE_ACTION_TEXT}中进入 waiting_user（阻塞）`,
          failed: '渠道返回 failed（阻塞）',
          timeout: `${LIVE_ACTION_TEXT}超时（阻塞）`,
          stalled: `${LIVE_ACTION_TEXT}无进度超时（阻塞）`
        };
        const head = reasonMap[result.status] || `阻塞状态：${result.status}`;
        const terminalStatus =
          result.status === 'not_logged_in'
            ? 'not_logged_in'
            : result.status === 'waiting_user'
              ? 'waiting_user'
              : 'failed';
        updateChannelProgress(
          progress,
          channelId,
          terminalStatus,
          `${head}\n${result.notes || ''}`
        );
        if (LIVE_PUBLISH_ACTION === 'publish') {
          upsertPublicationOutcome(ledger, {
            channelId,
            contentHash: channelRun.contentHash,
            sourceMarkdownHash: String(options?.sourceMarkdownHash || ''),
            title: channelRun.article.title,
            status: terminalStatus,
            managementUrl: getChannelConfig(channelId).managementUrl,
            expectedImageCount: channelRun.expectedImageCount,
            technicalFailureReason: String(result.notes || '')
          });
          savePublicationLedger(ledger, ledgerPath);
        }
        saveProgress(progressPath, progress);
        console.log(`[${LIVE_ACTION_LABEL}] ${channelId}: blocking -> failed`);
        continue;
      }
    }

    saveProgress(progressPath, progress);
    const summary = printRunSummary(progress);
    if (summary.publicSuccessCount !== ACTIVE_CHANNELS.length) process.exitCode = 2;
    return summary;
  } finally {
    if (KEEP_BROWSER_OPEN && !options?.preserveExistingPages) {
      await cleanupChromePagesKeepBlank(CHROME_CDP_PORT).catch(() => {});
    }
    try {
      await browser?.close();
    } catch {
      // ignore
    }
    if (!KEEP_BROWSER_OPEN) {
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

async function main() {
  const cli = parseCli();
  if (cli.mode === 'open') {
    await runOpenChannelEditors();
    return;
  }
  if (cli.mode === 'publish') {
    await runPublishOnce(cli.articleUrl, {
      requireExistingChrome: LIVE_PUBLISH_REQUIRE_EXISTING_CHROME,
      preserveExistingPages: LIVE_PUBLISH_PRESERVE_EXISTING_PAGES
    });
    return;
  }
  if (cli.mode === 'markdown') {
    runBuildOrThrow();
    const prepared = await prepareLocalMarkdown(cli.markdownPath);
    console.log(
      `[markdown] ready: title=${prepared.article.title} images=${prepared.assetCount} source=${prepared.article.sourceUrl || '<none>'}`
    );
    if (!prepared.hasDurableSourceUrl) {
      console.log(
        '[markdown] 未声明 source_url：正文不会写入临时本机链接，本地服务仅用于图片传输。'
      );
    }
    try {
      await runPublishOnce(prepared.identity, {
        requireExistingChrome: LIVE_PUBLISH_REQUIRE_EXISTING_CHROME,
        preserveExistingPages: LIVE_PUBLISH_PRESERVE_EXISTING_PAGES,
        articlePayload: prepared.article,
        channelArticles: prepared.channelArticles,
        variants: prepared.variants,
        sourceMarkdownHash: prepared.sourceMarkdownHash
      });
    } finally {
      await prepared.close();
    }
    return;
  }
  await runPublishOnce(cli.articleUrl, {
    requireExistingChrome: LIVE_PUBLISH_REQUIRE_EXISTING_CHROME,
    preserveExistingPages: LIVE_PUBLISH_PRESERVE_EXISTING_PAGES
  });
}

main().catch((e) => {
  console.error('\n❌ live publish via chrome cdp failed:', e);
  process.exit(1);
});
