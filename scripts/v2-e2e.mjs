import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function abs(p) {
  return path.resolve(process.cwd(), p);
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
      await page.waitForTimeout(2500);
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

  // 用 addInitScript 在首次进入各站点时写入 localStorage，避免启动时先打开一堆 origin 页面
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

async function getPanelStatus(page) {
  return await page.evaluate(() => {
    const list = document.querySelector('#bawei-v2-status-list');
    if (!list) return { ok: false, error: 'no status list' };
    const rows = Array.from(list.querySelectorAll(':scope > div'));
    const out = [];
    for (const row of rows) {
      const checkbox = row.querySelector('input[type=\"checkbox\"]');
      if (!checkbox || !checkbox.checked) continue;
      const name = row.querySelector('label span')?.textContent?.trim() || '';
      const right = row.querySelector('div');
      const spans = Array.from(right?.querySelectorAll('span') || []);
      const badge = spans[0]?.textContent?.trim() || '';
      const progress = spans[1]?.textContent?.trim() || '';
      out.push({ name, badge, progress });
    }
    return { ok: true, rows: out };
  });
}

async function getDiagnosis(page, channelId) {
  await page.selectOption('#bawei-v2-focus-channel', channelId);
  await page.waitForTimeout(200);
  const text = await page.textContent('#bawei-v2-diagnosis');
  return (text || '').trim();
}

async function waitForPanel(page) {
  await page.waitForLoadState('domcontentloaded');
  const deadline = Date.now() + 12 * 60_000;
  let lastHint = 0;

  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('mp/wappoc_appmsgcaptcha')) {
      if (Date.now() - lastHint > 8000) {
        console.log('[微信] 触发验证码页，等待手动通过后继续…');
        lastHint = Date.now();
      }
      // 验证码页不会注入面板；给用户充足时间手动通过
      await page.waitForTimeout(3000);
      continue;
    }

    if (await page.locator('#bawei-v2-panel').count()) {
      await page.waitForTimeout(1200);
      return;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error('等待扩展面板注入超时（可能卡在微信验证码/登录/风控页）');
}

async function startOneChannel(page, channelId) {
  // Set focus channel so background opens that channel tab in the foreground.
  await page.selectOption('#bawei-v2-focus-channel', channelId);
  await page.click('input[name="bawei_v2_action"][value="publish"]');
  const want = new Set([channelId]);
  for (const id of ALL_CHANNELS) {
    const sel = `#bawei-v2-run-${id}`;
    if (!(await page.locator(sel).count())) continue;
    const should = want.has(id);
    await page.setChecked(sel, should);
  }
  const states = {};
  for (const id of ALL_CHANNELS) {
    const sel = `#bawei-v2-run-${id}`;
    if (!(await page.locator(sel).count())) continue;
    states[id] = await page.isChecked(sel);
  }
  console.log('本次运行渠道勾选：', states, '当前轮次：', channelId);
  await page.click('#bawei-v2-start');
}

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

// 已验收通过：后续不要重复跑（通过一个就把它加到这里）
// 用户确认已通过：cnblogs / mowen / csdn / tencent-cloud-dev / oschina / woshipm
// 自动验收已通过：feishu-docs
const PASSED_CHANNELS = new Set([
  'cnblogs',
  'mowen',
  'csdn',
  'tencent-cloud-dev',
  'oschina',
  'woshipm',
  'feishu-docs',
  'toutiao',
  'baijiahao',
]);

// 暂缓验证（目前无）
// 少数派：新账号前 3 篇需要审核，无法立即在列表页“已发布”验证，暂缓
const DEFERRED_CHANNELS = new Set(['sspai']);

async function main() {
  const distDir = abs('dist');
  const statePath = abs('tmp/mcp-storageState.json');
  const profileDir = abs('tmp/pw-profile-v2-e2e');

  if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`未找到扩展产物：${path.join(distDir, 'manifest.json')}`);
  }
  if (!fs.existsSync(statePath)) {
    throw new Error(`未找到登录态文件：${statePath}`);
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

  const forceChannelArg = String(process.argv[2] || '').trim();
  const forceChannel = forceChannelArg && ALL_CHANNELS.includes(forceChannelArg) ? forceChannelArg : '';

  if (forceChannelArg && !forceChannel) {
    throw new Error(`未知渠道参数：${forceChannelArg}（可选：${ALL_CHANNELS.join(', ')}）`);
  }

  const channelsToRun = forceChannel
    ? [forceChannel]
    : ALL_CHANNELS.filter((id) => !PASSED_CHANNELS.has(id) && !DEFERRED_CHANNELS.has(id));
  // 优先跑更稳定的渠道，避免一个渠道卡住导致后续无法验证
  // 百家号可能触发百度安全验证（滑块/扫码），优先把其他渠道跑完，最后再处理百家号。
  const preferredOrder = ['toutiao', 'sspai', 'baijiahao'];
  channelsToRun.sort((a, b) => {
    const ai = preferredOrder.indexOf(a);
    const bi = preferredOrder.indexOf(b);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  if (!channelsToRun.length) {
    console.log(
      '无待测试渠道：除暂缓外均已验收通过。',
      'passed=',
      Array.from(PASSED_CHANNELS).sort(),
      'deferred=',
      Array.from(DEFERRED_CHANNELS).sort()
    );
    return;
  }
  if (forceChannel) {
    console.log('[强制单渠道运行] 将忽略 PASSED/DEFERRED，仅测试：', forceChannel);
  }

  // Reuse profile directory to keep site sessions (e.g. WeChat captcha cookies) across retries.
  // This dramatically reduces the chance of being stuck on WeChat captcha page on every run.

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  await applyStorageState(context, state);

  const wechatUrl = 'https://mp.weixin.qq.com/s/3F0lbpS9PJYMY7V0QjI0YA';

  function attachDebugListeners(p) {
    p.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[V2]') || text.includes('failed:') || text.includes('Failed')) {
        console.log('[console]', text);
      }
    });
    // 额外抓取关键发布/验收接口，方便定位“看起来点了发布但实际上没入库”的问题
    p.on('request', (req) => {
      const u = req.url();
      if (req.method() === 'POST') {
        if (u.includes('mp.toutiao.com/mp/agw/article/publish')) {
          console.log('[toutiao][publish][req]', req.method(), u);
          try {
            const body = req.postData() || '';
            const params = new URLSearchParams(body);
            const title =
              params.get('title') || params.get('article_title') || params.get('articleTitle') || params.get('pgc_title') || '';
            const content = params.get('content') || params.get('article_content') || params.get('articleContent') || '';
            const coverType = params.get('cover_type') || params.get('coverType') || '';
            const coverUri = params.get('cover_uri') || params.get('coverUri') || '';
            const pgcFeedCovers = params.get('pgc_feed_covers') || '';
            const draftFormData = params.get('draft_form_data') || '';
            const saveFlag = params.get('save') || '';
            const timerStatus = params.get('timer_status') || '';
            const timerTime = params.get('timer_time') || '';
            const claimExclusive = params.get('claim_exclusive') || '';
            const articleAdType = params.get('article_ad_type') || '';
            const governForward = params.get('govern_forward') || '';
            const mpEditorStat = params.get('mp_editor_stat') || '';
            const searchCreationInfo = params.get('search_creation_info') || '';
            let draftObj = null;
            try {
              draftObj = draftFormData ? JSON.parse(draftFormData) : null;
            } catch {
              draftObj = null;
            }
            const extraRaw = params.get('extra') || '';
            let extra = null;
            try {
              extra = extraRaw ? JSON.parse(extraRaw) : null;
            } catch {
              extra = null;
            }
            console.log(
              '[toutiao][publish][form]',
              JSON.stringify({
                bodyLen: body.length,
                title: title.slice(0, 60),
                titleLen: title.length,
                contentLen: content.length,
                save: saveFlag,
                timerStatus,
                timerTime,
                claimExclusive,
                articleAdType,
                governForward,
                mpEditorStatSnippet: mpEditorStat.slice(0, 160),
                searchCreationInfoSnippet: searchCreationInfo.slice(0, 160),
                coverType,
                coverUri: coverUri ? coverUri.slice(0, 60) : '',
                pgcFeedCoversLen: pgcFeedCovers.length,
                pgcFeedCoversSnippet: pgcFeedCovers.slice(0, 120),
                draftFormDataLen: draftFormData.length,
                draftFormKeys: draftObj && typeof draftObj === 'object' ? Object.keys(draftObj).slice(0, 30) : [],
                draftFormSnippet: draftFormData.slice(0, 160),
                extraKeys: extra && typeof extra === 'object' ? Object.keys(extra).slice(0, 30) : [],
                extraSnippet: extra && typeof extra === 'object' ? JSON.stringify(extra).slice(0, 180) : extraRaw.slice(0, 180),
                keys: Array.from(params.keys()).slice(0, 30),
              })
            );
          } catch {
            // ignore
          }
        }
        if (u.includes('mp.weixin.qq.com')) return;
        if (u.includes('publish') || u.includes('submit') || u.includes('commit') || u.includes('save') || u.includes('draft') || u.includes('article')) {
          console.log('[post][req]', req.method(), u);
        }
      }
      if (u.includes('baijiahao.baidu.com') && req.method() === 'POST') {
        console.log('[baijiahao][req]', req.method(), u);
      }
      if (
        u.includes('article?action=CreateArticle') ||
        u.includes('article?action=CreateArticleDraft') ||
        u.includes('article?action=SettingArticle') ||
        u.includes('/developer/api/creator/articleList')
      ) {
        console.log('[req]', req.method(), u);
      }
    });
    p.on('response', async (res) => {
      const u = res.url();
      if (res.request().method() === 'POST') {
        if (u.includes('mp.toutiao.com/mp/agw/article/publish')) {
          try {
            const coverState = await p
              .evaluate(() => {
                const checked = document.querySelector('.article-cover-radio-group input[type="radio"]:checked')?.getAttribute('value') || '';
                const checkedInner = document.querySelectorAll('.article-cover-radio-group .byte-radio-inner.checked').length;
                const checkedInputs = Array.from(document.querySelectorAll('.article-cover-radio-group input[type="radio"]'))
                  .filter((i) => (i instanceof HTMLInputElement ? i.checked : false))
                  .map((i) => i.getAttribute('value') || '');
                const checkedLabels = Array.from(document.querySelectorAll('label'))
                  .filter((l) => (l.querySelector('input') instanceof HTMLInputElement ? l.querySelector('input').checked : false))
                  .map((l) => String(l.textContent || '').replace(/\s+/g, ' ').trim())
                  .filter(Boolean)
                  .slice(0, 12);
                return { checked, checkedInner, checkedInputs, checkedLabels };
              })
              .catch(() => ({ checked: '', checkedInner: 0, checkedInputs: [], checkedLabels: [] }));
            const data = await res.json();
            console.log(
              '[toutiao][publish][resp]',
              res.request().method(),
              res.status(),
              u,
              `coverChecked=${coverState?.checked || ''}`,
              `coverInner=${coverState?.checkedInner || 0}`,
              `checkedLabels=${JSON.stringify(coverState?.checkedLabels || [])}`,
              'json:',
              JSON.stringify(data).slice(0, 500)
            );
          } catch {
            console.log('[toutiao][publish][resp]', res.request().method(), res.status(), u);
          }
        }
        if (u.includes('mp.weixin.qq.com')) return;
        if (u.includes('publish') || u.includes('submit') || u.includes('commit') || u.includes('save') || u.includes('draft') || u.includes('article')) {
          // Try to print response json for publish endpoints when possible.
          if (u.includes('mp.toutiao.com/mp/agw/article/publish')) {
            try {
              const data = await res.json();
              console.log('[post][resp]', res.request().method(), res.status(), u, 'json:', JSON.stringify(data).slice(0, 500));
            } catch {
              console.log('[post][resp]', res.request().method(), res.status(), u);
            }
          } else {
            console.log('[post][resp]', res.request().method(), res.status(), u);
          }
        }
      }
      // Baijiahao publish often fails silently (toast/verification). Log suspicious requests for debugging.
      if (u.includes('baijiahao.baidu.com')) {
        const status = res.status();
        const req = res.request();
        const method = req.method();
        const isPost = method === 'POST';
        if (isPost || status >= 400) {
          try {
            const ct = res.headers()['content-type'] || '';
            if (ct.includes('application/json')) {
              const data = await res.json();
              console.log('[baijiahao][resp]', method, status, u, 'json:', JSON.stringify(data).slice(0, 500));
            } else {
              console.log('[baijiahao][resp]', method, status, u);
            }
          } catch {
            console.log('[baijiahao][resp]', method, status, u);
          }
        }
      }

      if (u.includes('article?action=CreateArticle')) {
        try {
          const data = await res.json();
          console.log('[resp]', res.status(), u, 'json:', data?.code, data?.data?.articleId || data?.data?.id || '');
        } catch {
          console.log('[resp]', res.status(), u);
        }
      } else if (
        u.includes('article?action=CreateArticleDraft') ||
        u.includes('article?action=SettingArticle') ||
        u.includes('/developer/api/creator/articleList')
      ) {
        console.log('[resp]', res.status(), u);
      }
    });
  }

  context.on('page', (p) => attachDebugListeners(p));

  const page = await context.newPage();
  attachDebugListeners(page);

  await gotoWithRetry(page, wechatUrl);

  for (let i = 0; i < channelsToRun.length; i++) {
    const channelId = channelsToRun[i];
    console.log(`\n[轮次 ${i + 1}/${channelsToRun.length}] 开始：${channelId}`);

    if (i > 0) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    console.log('[1/4] 等待扩展面板注入…');
    await waitForPanel(page);
    console.log('[2/4] 选择 publish 并启动任务…');
    await startOneChannel(page, channelId);

    console.log('[3/4] 等待渠道状态收敛（最多 30 分钟；如出现“等待处理”，请按面板提示手动处理后点“继续”）…');
    const deadline = Date.now() + 30 * 60_000;
    let finalRow = null;
    let waitingHinted = false;
    while (Date.now() < deadline) {
      const status = await getPanelStatus(page);
      if (status.ok && Array.isArray(status.rows) && status.rows.length) {
        const row = status.rows[0];
        finalRow = row;
        console.log('面板状态：', `${row.name}:${row.badge}${row.stage ? `(${row.stage})` : ''}`);
        if (row.badge === '等待处理' && !waitingHinted) {
          waitingHinted = true;
          console.log('[等待处理] 请按面板建议在当前页面完成手动步骤（如实名认证/风控/补齐必填项），然后点击面板“继续”。');
        }
        // 等待处理不算终态：让用户完成操作后继续轮询，直到成功或失败
        if (['成功', '失败'].includes(row.badge)) break;
      } else {
        console.log('面板状态读取失败：', status.error);
      }
      await sleep(4000);
    }

    console.log('[4/4] 输出诊断信息与打开的页面 URL：');
    try {
      const diag = await getDiagnosis(page, channelId);
      console.log(`\n[诊断] ${channelId}\n${diag}`);
    } catch (e) {
      console.log(`\n[诊断] ${channelId}\n读取失败：${e instanceof Error ? e.message : String(e)}`);
    }

    const pages = context.pages();
    console.log('\n[页面] 当前打开的 tab：');
    for (const p of pages) console.log('-', p.url());

    if (!finalRow || finalRow.badge !== '成功') {
      throw new Error(`渠道未通过：${channelId}`);
    }
  }

  console.log('\n全部轮次通过：所有渠道（含 woshipm）');
  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
