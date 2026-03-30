import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
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

const LIVE_PUBLISH_CHANNELS_RAW = String(process.env.LIVE_PUBLISH_CHANNELS || '').trim();

function parseActiveChannels(raw) {
  const text = String(raw || '').trim();
  if (!text) return [...ALL_CHANNELS];
  const uniq = Array.from(new Set(text.split(',').map((s) => s.trim()).filter(Boolean)));
  const filtered = uniq.filter((id) => ALL_CHANNELS.includes(id));
  if (!filtered.length) {
    throw new Error(`LIVE_PUBLISH_CHANNELS 解析为空（raw=${text || 'empty'}），可用渠道：${ALL_CHANNELS.join(', ')}`);
  }
  return filtered;
}

const ACTIVE_CHANNELS = parseActiveChannels(LIVE_PUBLISH_CHANNELS_RAW);
const OSCHINA_DIRECT_WRITE_ENTRY_URL = 'https://my.oschina.net/u/1/blog/write';

const CHANNEL_ENTRY_URLS = {
  csdn: 'https://mp.csdn.net/mp_blog/creation/editor',
  'tencent-cloud-dev': 'https://cloud.tencent.com/developer/article/write',
  cnblogs: 'https://i.cnblogs.com/posts/edit',
  oschina: OSCHINA_DIRECT_WRITE_ENTRY_URL,
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

const LOGIN_AUDIT_STRICT_TEXT_RULES = {
  oschina: /请登录|未登录|登录后继续|登录即可|请先登录|扫码登录|手机号登录|登录|注册|sign in|log in/i,
  woshipm: /请登录|未登录|登录后继续|登录即可|请先登录|扫码登录|手机号登录|注册\s*\|\s*登录|立即登录|点我注册|登录人人都是产品经理即可获得以下权益|sign in|log in/i,
};

const LOGIN_AUDIT_LOGGED_HINT_RULES = {
  oschina: /写博客|我的博客|博客广场|动弹|消息|设置|个人空间|退出登录|我的主页/i,
  woshipm: /发布文章|我的文章|草稿箱|账号设置|退出登录|个人中心|创作中心/i,
};

const PER_CHANNEL_TIMEOUT_MS = 9 * 60_000;
const ACTION_INTERVAL_MS = 15_000;
const LOOP_INTERVAL_MS = 3000;
const KEEP_BROWSER_OPEN = String(process.env.KEEP_BROWSER_OPEN || '1') !== '0';
const PW_EXECUTABLE_PATH = String(process.env.PW_EXECUTABLE_PATH || '').trim();
const WAIT_FOR_LOGIN = String(process.env.WAIT_FOR_LOGIN || '1') !== '0';

function abs(p) {
  return path.resolve(process.cwd(), p);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBadge(badge) {
  const text = String(badge || '').trim();
  if (text.includes('成功')) return 'success';
  if (text.includes('进行中')) return 'running';
  if (text.includes('等待处理')) return 'waiting_user';
  if (text.includes('未登录')) return 'not_logged_in';
  if (text.includes('失败')) return 'failed';
  if (text.includes('未开始')) return 'not_started';
  return text ? 'unknown' : 'not_started';
}

function createProgress(articleUrl) {
  const channels = {};
  for (const id of ALL_CHANNELS) channels[id] = { status: 'pending', notes: '', updatedAt: nowIso(), attempts: 0 };
  return {
    updatedAt: nowIso(),
    articleUrl,
    channels,
  };
}

function loadProgress(filePath, articleUrl) {
  try {
    if (!fs.existsSync(filePath)) return createProgress(articleUrl);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
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
  for (const id of ALL_CHANNELS) {
    channels[id] = { status: 'unknown', reason: '', url: '', updatedAt: nowIso() };
  }
  return {
    updatedAt: nowIso(),
    articleUrl,
    channels,
  };
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
  return (
    t.includes('图片自动上传失败') ||
    t.includes('请手动上传') ||
    t.includes('image insert failed') ||
    t.includes('fetch image failed')
  );
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
      await sleep(2500);
    }
  }
  throw lastErr || new Error(`goto failed: ${url}`);
}

async function applyStorageState(context, state) {
  if (state?.cookies?.length) {
    await context.addCookies(state.cookies);
  }

  const origins = Array.isArray(state?.origins)
    ? state.origins.filter((o) => o?.origin && Array.isArray(o.localStorage) && o.localStorage.length > 0)
    : [];

  if (origins.length) {
    await context.addInitScript((allOrigins) => {
      try {
        const hit = allOrigins.find((o) => o.origin === location.origin);
        if (!hit) return;
        for (const it of hit.localStorage || []) {
          try {
            localStorage.setItem(it.name, it.value);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }, origins);
  }
}

async function waitForPanel(page) {
  await page.waitForLoadState('domcontentloaded');
  const deadline = Date.now() + 12 * 60_000;
  let lastHint = 0;
  let lastProbeLog = 0;

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

    const hasPanel = (await page.locator('#bawei-v2-panel').count()) > 0;
    const hasLauncher = (await page.locator('#bawei-v2-launcher').count()) > 0;
    if (Date.now() - lastProbeLog > 15_000) {
      console.log(`[wechat-panel] probe url=${url} hasPanel=${hasPanel} hasLauncher=${hasLauncher}`);
      lastProbeLog = Date.now();
    }
    if (!hasPanel) {
      if (hasLauncher) {
        await page.click('#bawei-v2-launcher').catch(() => {});
      }
      await sleep(1000);
      continue;
    }

    const panelVisible = await page.isVisible('#bawei-v2-panel').catch(() => false);
    if (!panelVisible) {
      if ((await page.locator('#bawei-v2-launcher').count()) > 0) {
        await page.click('#bawei-v2-launcher').catch(() => {});
      }
      await sleep(700);
      continue;
    }

    return;
  }

  throw new Error('等待扩展面板注入超时（可能卡在微信验证/登录页）');
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
    for (const id of channelIds) {
      const cb = document.querySelector(`#bawei-v2-run-${id}`);
      if (!cb) {
        out[id] = { exists: false, checked: false, badge: '', progress: '', hasButton: false, buttonText: '' };
        continue;
      }
      const row = cb.closest('div');
      const right = row?.querySelector(':scope > div');
      const spans = Array.from(right?.querySelectorAll('span') || []);
      const badge = (spans[0]?.textContent || '').trim();
      const progress = (spans[1]?.textContent || '').trim();
      const btn = right?.querySelector('button');
      out[id] = {
        exists: true,
        checked: !!cb.checked,
        badge,
        progress,
        hasButton: !!btn,
        buttonText: (btn?.textContent || '').trim(),
      };
    }
    return out;
  }, ALL_CHANNELS);
}

async function clickBadgeAndControl(page, channelId) {
  await page.evaluate((id) => {
    const cb = document.querySelector(`#bawei-v2-run-${id}`);
    const row = cb?.closest('div');
    if (!row) return;
    const right = row.querySelector(':scope > div');
    const spans = Array.from(right?.querySelectorAll('span') || []);
    const badge = spans[0];
    if (badge) badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const btn = right?.querySelector('button');
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, channelId);
}

async function clickBadge(page, channelId) {
  await page.evaluate((id) => {
    const cb = document.querySelector(`#bawei-v2-run-${id}`);
    const row = cb?.closest('div');
    if (!row) return;
    const right = row.querySelector(':scope > div');
    const spans = Array.from(right?.querySelectorAll('span') || []);
    const badge = spans[0];
    if (badge) badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, channelId);
}

async function readDiagnosis(page, channelId) {
  await setFocusChannel(page, channelId);
  await sleep(200);
  const text = await page.textContent('#bawei-v2-diagnosis').catch(() => '');
  return (text || '').trim();
}

async function inspectLoginStateOnPage(page, channelId) {
  const strictRule = LOGIN_AUDIT_STRICT_TEXT_RULES[channelId] || /请登录|未登录|登录后继续|登录即可|sign in|log in/i;
  const loggedRule = LOGIN_AUDIT_LOGGED_HINT_RULES[channelId] || /个人中心|退出登录|发文章|创作中心|发布入口|写文章|我的主页/i;

  const info = await page.evaluate(({ strictRuleSource, loggedRuleSource }) => {
    const bodyText = String(document.body?.innerText || '').slice(0, 5000);
    const hasPwd = !!document.querySelector('input[type="password"]');
    const hasLoginBtn = Array.from(document.querySelectorAll('button,a,div,span')).some((el) => {
      const t = String(el.textContent || '').trim();
      if (!t) return false;
      return /登录|登入|sign in|log in|继续登录|扫码登录|手机号登录/i.test(t);
    });
    const hasCaptchaHints = /验证码|安全验证|风控|请完成验证|environment|异常/i.test(bodyText);
    const strictLoginText = new RegExp(strictRuleSource, 'i').test(bodyText);
    const hasLoggedInHints = new RegExp(loggedRuleSource, 'i').test(bodyText);
    return { bodyText, hasPwd, hasLoginBtn, hasCaptchaHints, strictLoginText, hasLoggedInHints };
  }, { strictRuleSource: strictRule.source, loggedRuleSource: loggedRule.source });

  const url = String(page.url() || '');
  const lowUrl = url.toLowerCase();
  const urlRules = LOGIN_URL_RULES[channelId] || [];
  const byUrl = urlRules.some((r) => r.test(lowUrl)) || /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i.test(lowUrl);
  const byDom = (info.hasPwd && info.hasLoginBtn) || info.strictLoginText;

  if (info.hasLoggedInHints && !byDom) {
    return { status: 'logged_in', reason: 'logged-in-dom-hints', url };
  }
  if (byUrl || byDom) {
    return { status: 'not_logged_in', reason: byUrl ? 'login-url' : 'login-dom', url };
  }
  if (info.hasCaptchaHints) {
    return { status: 'unknown', reason: 'captcha-or-risk-page', url };
  }
  return { status: 'logged_in', reason: 'entry-page-accessible', url };
}

async function auditLoginStatus(context, audit, auditPath) {
  const loginPages = new Map();

  for (const channelId of ACTIVE_CHANNELS) {
    const entry = CHANNEL_ENTRY_URLS[channelId];
    const page = await context.newPage();
    try {
      await gotoWithRetry(page, entry);
      await sleep(2500);
      const result = await inspectLoginStateOnPage(page, channelId);

      audit.channels[channelId] = {
        status: result.status,
        reason: result.reason,
        url: result.url,
        updatedAt: nowIso(),
      };

      if (result.status === 'not_logged_in') {
        loginPages.set(channelId, page);
      } else {
        await page.close().catch(() => {});
      }

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

async function waitUserLoginUntilReady(context, page, loginPages, audit, auditPath, progress, progressPath) {
  if (!loginPages.size) return;

  console.log('\n[login-wait] 检测到未登录渠道，浏览器保持打开，开始轮询登录状态...');

  while (loginPages.size) {
    for (const channelId of Array.from(loginPages.keys())) {
      const lp = await ensureLoginPageOpen(context, loginPages, channelId);
      let result = null;
      try {
        result = await inspectLoginStateOnPage(lp, channelId);
      } catch (error) {
        result = {
          status: 'unknown',
          reason: `inspect-error: ${error instanceof Error ? error.message : String(error)}`,
          url: String(lp.url() || CHANNEL_ENTRY_URLS[channelId]),
        };
      }

      audit.channels[channelId] = {
        status: result.status,
        reason: result.reason,
        url: result.url,
        updatedAt: nowIso(),
      };
      saveLoginAudit(auditPath, audit);

      if (result.status === 'logged_in') {
        console.log(`[login-wait] ${channelId}: 已登录`);
        updateChannelProgress(progress, channelId, 'pending', '登录已恢复，准备重新发布');
        saveProgress(progressPath, progress);
        await lp.close().catch(() => {});
        loginPages.delete(channelId);
        continue;
      }

      console.log(`[login-wait] ${channelId}: ${result.status} (${result.reason})`);
      updateChannelProgress(progress, channelId, 'not_logged_in', `待登录：${result.reason}`);
      saveProgress(progressPath, progress);

      await clickBadge(page, channelId).catch(() => {});
    }

    if (!loginPages.size) break;
    await sleep(10_000);
  }

  console.log('[login-wait] 未登录渠道已全部恢复登录');
}

async function startSingleChannelJob(page, channelId) {
  await waitForPanel(page);
  await stopIfExecuting(page);
  await waitStartReady(page);
  await setActionPublish(page);
  await setFocusChannel(page, channelId);
  await setChannelSelection(page, new Set([channelId]));
  await page.click('#bawei-v2-start');
  await sleep(1200);
}

async function waitSingleChannelResult(params) {
  const { page, channelId, progress, progressPath } = params;
  const deadline = Date.now() + PER_CHANNEL_TIMEOUT_MS;
  let lastActionAt = 0;

  while (Date.now() < deadline) {
    const rows = await readRows(page);
    const row = rows[channelId] || { badge: '', progress: '', hasButton: false, buttonText: '' };
    const status = normalizeBadge(row.badge);
    const notes = `${row.badge || status} | ${row.progress || ''}`.trim();

    if (status !== 'not_started') {
      updateChannelProgress(progress, channelId, status, notes);
      saveProgress(progressPath, progress);
    }

    if (status === 'success') {
      const diag = await readDiagnosis(page, channelId).catch(() => '');
      if (containsImageFail(`${notes}\n${diag}`)) {
        updateChannelProgress(progress, channelId, 'waiting_user', `成功态拦截：检测到图片失败痕迹\n${diag}`);
        saveProgress(progressPath, progress);
        if (row.hasButton && Date.now() - lastActionAt > ACTION_INTERVAL_MS) {
          await clickBadgeAndControl(page, channelId).catch(() => {});
          lastActionAt = Date.now();
          console.log(`[publish:${channelId}] 检测到图片失败痕迹，已触发继续`);
        }
      } else {
        updateChannelProgress(progress, channelId, 'success', `发布成功 | ${row.progress || ''}`);
        saveProgress(progressPath, progress);
        return { status: 'success' };
      }
    }

    if (status === 'not_logged_in') {
      return { status: 'not_logged_in' };
    }

    if ((status === 'waiting_user' || status === 'failed') && row.hasButton) {
      if (Date.now() - lastActionAt > ACTION_INTERVAL_MS) {
        await clickBadgeAndControl(page, channelId).catch(() => {});
        lastActionAt = Date.now();
        console.log(`[publish:${channelId}] 自动触发 ${row.buttonText || '继续/重试'}`);
      }
    }

    await sleep(LOOP_INTERVAL_MS);
  }

  return { status: 'timeout' };
}

async function keepAliveForever(context, progress, progressPath) {
  console.log('\n[keep-open] 已完成目标，按要求保持 Playwright 浏览器常驻（不退出）');
  while (true) {
    saveProgress(progressPath, progress);
    await sleep(30_000);
    if (context.isClosed()) break;
  }
}

async function main() {
  const distDir = abs('dist');
  const articleUrl = String(process.argv[2] || 'https://mp.weixin.qq.com/s/3sSae4T0IeSsfM3dm5fByg').trim();
  const statePath = abs('tmp/mcp-storageState.json');
  const progressPath = abs('tmp/mcp-publish-progress.json');
  const auditPath = abs('tmp/mcp-login-audit.json');
  const profileDir = abs(process.env.PW_PROFILE_DIR || 'tmp/pw-profile-mcp-live-publish');

  if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`未找到扩展产物：${path.join(distDir, 'manifest.json')}（请先 npm run build）`);
  }

  const progress = loadProgress(progressPath, articleUrl);
  const audit = createLoginAudit(articleUrl);
  saveProgress(progressPath, progress);
  saveLoginAudit(auditPath, audit);

  const context = await chromium.launchPersistentContext(profileDir, {
    ...(PW_EXECUTABLE_PATH ? { executablePath: PW_EXECUTABLE_PATH } : {}),
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    } catch {
      // ignore
    }
  });

  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      await applyStorageState(context, state);
      console.log('[state] 已注入登录态');
    } catch (error) {
      console.log('[state] 登录态注入失败（继续执行）', error instanceof Error ? error.message : String(error));
    }
  } else {
    console.log('[state] 未找到 tmp/mcp-storageState.json，将直接执行');
  }

  const wechatPage = await context.newPage();
  console.log('[main] open article', articleUrl);
  await gotoWithRetry(wechatPage, articleUrl);
  console.log('[main] wait panel...');
  await waitForPanel(wechatPage);
  console.log('[main] panel ready');

  console.log('[main] start login audit...');
  const loginPages = await auditLoginStatus(context, audit, auditPath);
  console.log('[main] login audit done');

  for (const channelId of ACTIVE_CHANNELS) {
    const auditStatus = audit.channels[channelId]?.status || 'unknown';
    if (auditStatus === 'not_logged_in') {
      updateChannelProgress(progress, channelId, 'not_logged_in', '登录审计判定未登录');
    } else if (progress.channels[channelId].status !== 'success') {
      updateChannelProgress(progress, channelId, 'pending', '登录审计通过，等待发布');
    }
  }
  saveProgress(progressPath, progress);

  if (WAIT_FOR_LOGIN) {
    console.log('[main] wait user login if needed...');
    await waitUserLoginUntilReady(context, wechatPage, loginPages, audit, auditPath, progress, progressPath);
    console.log('[main] login wait done, start publish loop');
  } else {
    console.log('[main] WAIT_FOR_LOGIN=0，跳过人工登录等待');
  }

  while (true) {
    const pending = ACTIVE_CHANNELS.filter((id) => {
      const status = progress.channels[id].status;
      if (status === 'success') return false;
      if (!WAIT_FOR_LOGIN && status === 'not_logged_in') return false;
      return true;
    });
    const blockedByLogin = ACTIVE_CHANNELS.filter((id) => progress.channels[id].status === 'not_logged_in');
    if (!pending.length) {
      if (!WAIT_FOR_LOGIN && blockedByLogin.length) {
        console.log(`\n⏸️ 已完成非登录阻塞渠道；以下渠道仍需人工登录：${blockedByLogin.join(', ')}`);
      } else {
        console.log(`\n✅ 全部目标渠道发布成功（${ACTIVE_CHANNELS.length}/${ACTIVE_CHANNELS.length}）`);
      }
      saveProgress(progressPath, progress);
      if (KEEP_BROWSER_OPEN) {
        await keepAliveForever(context, progress, progressPath);
        return;
      }
      await context.close();
      return;
    }

    console.log(`\n===== publish-loop =====`);
    console.log(`pending(${pending.length}): ${pending.join(', ')}`);

    for (const channelId of pending) {
      const current = progress.channels[channelId]?.status;
      if (current === 'success') continue;

      if (current === 'not_logged_in') {
        const p = await ensureLoginPageOpen(context, loginPages, channelId);
        audit.channels[channelId] = {
          status: 'not_logged_in',
          reason: 'publish-loop-detected',
          url: String(p.url() || CHANNEL_ENTRY_URLS[channelId]),
          updatedAt: nowIso(),
        };
        saveLoginAudit(auditPath, audit);
        continue;
      }

      incAttempt(progress, channelId);
      updateChannelProgress(progress, channelId, 'running', `开始第 ${progress.channels[channelId].attempts} 次发布尝试`);
      saveProgress(progressPath, progress);
      console.log(`[publish] ${channelId}: attempt=${progress.channels[channelId].attempts}`);

      try {
        await startSingleChannelJob(wechatPage, channelId);
      } catch (error) {
        updateChannelProgress(progress, channelId, 'failed', `启动发布失败：${error instanceof Error ? error.message : String(error)}`);
        saveProgress(progressPath, progress);
        continue;
      }

      const result = await waitSingleChannelResult({
        page: wechatPage,
        channelId,
        progress,
        progressPath,
      });

      if (result.status === 'success') {
        console.log(`[publish] ${channelId}: success`);
        continue;
      }

      if (result.status === 'not_logged_in') {
        updateChannelProgress(progress, channelId, 'not_logged_in', '发布中检测到未登录，等待人工登录');
        saveProgress(progressPath, progress);

        const lp = await ensureLoginPageOpen(context, loginPages, channelId);
        audit.channels[channelId] = {
          status: 'not_logged_in',
          reason: 'publish-runtime-detected',
          url: String(lp.url() || CHANNEL_ENTRY_URLS[channelId]),
          updatedAt: nowIso(),
        };
        saveLoginAudit(auditPath, audit);
        continue;
      }

      if (result.status === 'timeout') {
        const diag = await readDiagnosis(wechatPage, channelId).catch(() => '');
        updateChannelProgress(progress, channelId, 'failed', `单渠道超时\n${diag}`);
        saveProgress(progressPath, progress);
        console.log(`[publish] ${channelId}: timeout`);
      }
    }

    if (WAIT_FOR_LOGIN && loginPages.size > 0) {
      await waitUserLoginUntilReady(context, wechatPage, loginPages, audit, auditPath, progress, progressPath);
    }

    await sleep(1500);
  }
}

main().catch((e) => {
  console.error('\n❌ mcp live publish failed:', e);
  process.exit(1);
});
