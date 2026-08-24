import process from 'node:process';
import { chromium } from 'playwright';
import { getChannelConfig, getChannelIds, matchesConfiguredUrl } from './channel-config.mjs';
import { resolveAndApplyBrowserAuth, summarizeChannelAuth } from './channel-auth-consumer.mjs';
import { attemptBoundedPasswordRecovery } from './channel-auth-browser-recovery.mjs';
import { directChromiumArgs } from './channel-network-policy.mjs';

const READY_RULES = {
  csdn: {
    url: /^https:\/\/mp\.csdn\.net\/mp_blog\/creation\/editor/i,
    selectors: ['textarea', 'input[placeholder*="标题"]', '[contenteditable="true"]']
  },
  'tencent-cloud-dev': {
    url: /^https:\/\/cloud\.tencent\.com\/developer\/article\/write/i,
    selectors: ['textarea', 'input[placeholder*="标题"]', '[contenteditable="true"]']
  },
  cnblogs: {
    url: /^https:\/\/i\.cnblogs\.com\/posts\/edit/i,
    selectors: ['textarea', 'input[placeholder*="标题"]', '[contenteditable="true"]']
  },
  sspai: {
    url: /^https:\/\/sspai\.com\/write(?:[/?#]|$)/i,
    selectors: [
      'textarea',
      'input[placeholder*="标题"]',
      '[contenteditable="true"]',
      '.ProseMirror'
    ]
  },
  baijiahao: {
    url: /^https:\/\/baijiahao\.baidu\.com\/builder\/rc\/edit/i,
    selectors: ['textarea', 'input[placeholder*="标题"]', '[contenteditable="true"]']
  },
  toutiao: {
    url: /^https:\/\/mp\.toutiao\.com\/profile_v4\/graphic\/publish/i,
    selectors: ['textarea', 'input[placeholder*="标题"]', '[contenteditable="true"]']
  }
};

function selectedChannels() {
  const requested = String(process.env.AUTH_PROBE_CHANNELS || process.argv[2] || '').trim();
  if (!requested) return getChannelIds();
  const channels = [
    ...new Set(
      requested
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
  const unknown = channels.filter((channel) => !getChannelIds().includes(channel));
  if (unknown.length) throw new Error(`未知渠道：${unknown.join(', ')}`);
  return channels;
}

function safeUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

async function probePage(context, channel, resolution) {
  const config = getChannelConfig(channel);
  const readyRule = READY_RULES[channel];
  const page = await context.newPage();
  try {
    const response = await page.goto(config.entryUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000
    });
    await page.waitForTimeout(1800);
    let recovery = null;
    if (
      String(process.env.AUTH_PROBE_ALLOW_RECOVERY || '0') === '1' &&
      resolution?.status === 'recovery_present' &&
      resolution.selected === 'keychain_password'
    ) {
      recovery = await attemptBoundedPasswordRecovery(page, channel);
      if (recovery.attempted) {
        await page.goto(config.entryUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 90_000
        });
        await page.waitForTimeout(1800);
      }
    }
    const finalUrl = String(page.url() || '');
    const dom = await page.evaluate(() => {
      const visible = (element) => {
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
      const body = String(document.body?.innerText || '').slice(0, 6000);
      const password = Array.from(document.querySelectorAll('input[type="password"]')).some(
        visible
      );
      const strongVerification =
        /验证码|安全验证|风控|请完成验证|访问异常|滑动验证|扫码|二维码|captcha|human verification|2fa|otp/i.test(
          body
        );
      const loginControl = Array.from(
        document.querySelectorAll('button,a,[role="button"],input[type="submit"]')
      ).some((element) => {
        if (!visible(element)) return false;
        return /登录|登入|sign in|log in|手机号登录/i.test(
          String(element.textContent || element.value || '').trim()
        );
      });
      return { password, strongVerification, loginControl };
    });
    const loginUrl = matchesConfiguredUrl(finalUrl, config.loginUrlPatterns);
    const httpStatus = response?.status() || 0;
    if (dom.strongVerification) {
      return {
        status: 'blocked_external',
        checkpoint: recovery?.checkpoint || 'manual_strong_verification_required',
        finalUrl: safeUrl(finalUrl),
        httpStatus
      };
    }
    if (loginUrl || (dom.password && dom.loginControl)) {
      return {
        status: 'not_logged_in',
        checkpoint: recovery?.checkpoint || (loginUrl ? 'login_url' : 'login_form'),
        finalUrl: safeUrl(finalUrl),
        httpStatus
      };
    }
    if (httpStatus >= 400 || !httpStatus) {
      return {
        status: 'unknown',
        checkpoint: 'http_probe_failed',
        finalUrl: safeUrl(finalUrl),
        httpStatus
      };
    }
    const readyUrl = Boolean(readyRule?.url?.test(finalUrl));
    let readySelector = false;
    for (const selector of readyRule?.selectors || []) {
      if ((await page.locator(selector).count()) > 0) {
        readySelector = true;
        break;
      }
    }
    if (!readyUrl || !readySelector) {
      return {
        status: 'unknown',
        checkpoint: 'editor_permission_probe_failed',
        finalUrl: safeUrl(finalUrl),
        httpStatus
      };
    }
    return {
      status: 'ready',
      checkpoint: 'editor_permission_probe_passed',
      finalUrl: safeUrl(finalUrl),
      httpStatus
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const channels = selectedChannels();
  const browser = await chromium.launch({
    headless: String(process.env.AUTH_PROBE_HEADLESS || '1') !== '0',
    args: directChromiumArgs(channels)
  });
  try {
    const context = await browser.newContext();
    const resolutions = await resolveAndApplyBrowserAuth(context, channels);
    const results = [];
    for (const channel of channels) {
      const resolution = resolutions.get(channel);
      const summary = summarizeChannelAuth(resolution);
      const mayProbeRecovery =
        String(process.env.AUTH_PROBE_ALLOW_RECOVERY || '0') === '1' &&
        resolution.status === 'recovery_present';
      if (
        !mayProbeRecovery &&
        (resolution.status !== 'ready' || resolution.selected !== 'browser_state')
      ) {
        results.push({ channel, auth: summary, probe: { status: resolution.status } });
        continue;
      }
      const probe = await probePage(context, channel, resolution).catch(() => ({
        status: 'unknown',
        checkpoint: 'probe_error',
        finalUrl: '',
        httpStatus: 0
      }));
      results.push({ channel, auth: summary, probe });
    }
    const ok = results.every((item) => item.probe.status === 'ready');
    console.log(
      JSON.stringify({ ok, checkedAt: new Date().toISOString(), channels: results }, null, 2)
    );
    if (!ok) process.exitCode = 2;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );
  process.exitCode = 1;
});
