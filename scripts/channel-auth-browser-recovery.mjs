import { readRecoveryCredentials } from './channel-auth-consumer.mjs';

const RISK_TEXT =
  /验证码|安全验证|风控|请完成验证|访问异常|环境异常|行为验证|滑动验证|captcha|human verification|one[- ]time|two[- ]factor|2fa|otp/i;
const QR_TEXT = /扫码|二维码|scan\s+(?:the\s+)?qr|qr\s*code/i;

export function classifyRecoveryPage(snapshot) {
  if (snapshot?.riskDetected) {
    return { allowed: false, checkpoint: 'manual_strong_verification_required' };
  }
  if (!snapshot?.hasPassword || !snapshot?.hasUsername) {
    return {
      allowed: false,
      checkpoint: snapshot?.qrDetected
        ? 'manual_strong_verification_required'
        : 'password_form_unavailable'
    };
  }
  return { allowed: true, checkpoint: 'bounded_password_login' };
}

export async function attemptBoundedPasswordRecovery(
  page,
  channel,
  { credentialReader = readRecoveryCredentials } = {}
) {
  const snapshot = await page.evaluate(
    ({ riskSource, qrSource }) => {
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
      const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
      const bodyText = String(document.body?.innerText || '').slice(0, 8000);
      const risk = new RegExp(riskSource, 'i');
      const qr = new RegExp(qrSource, 'i');
      const hasRiskInput = inputs.some((input) =>
        risk.test(
          `${input.type || ''} ${input.name || ''} ${input.id || ''} ${input.placeholder || ''} ${input.autocomplete || ''}`
        )
      );
      const hasPassword = inputs.some((input) => input.type === 'password');
      const hasUsername = inputs.some((input) => {
        if (input.type === 'password' || input.type === 'hidden') return false;
        const hint = `${input.type || ''} ${input.name || ''} ${input.id || ''} ${input.placeholder || ''} ${input.autocomplete || ''}`;
        return /username|email|tel|phone|mobile|account|login|user|账号|帐号|手机|邮箱/i.test(hint);
      });
      return {
        riskDetected: risk.test(bodyText) || hasRiskInput,
        qrDetected: qr.test(bodyText),
        hasPassword,
        hasUsername
      };
    },
    { riskSource: RISK_TEXT.source, qrSource: QR_TEXT.source }
  );
  const decision = classifyRecoveryPage(snapshot);
  if (!decision.allowed) {
    return { status: 'blocked_external', attempted: false, checkpoint: decision.checkpoint };
  }

  let credentials = credentialReader(channel);
  if (!credentials) {
    return {
      status: 'blocked_external',
      attempted: false,
      checkpoint: 'keychain_unlock_required'
    };
  }
  const username = String(credentials.username || '');
  const password = String(credentials.password || '');
  credentials = null;
  if (!username || !password) {
    return {
      status: 'blocked_external',
      attempted: false,
      checkpoint: 'keychain_unlock_required'
    };
  }

  const usernameSelector = [
    'input[autocomplete="username"]:visible',
    'input[type="email"]:visible',
    'input[type="tel"]:visible',
    'input[name*="user" i]:visible',
    'input[name*="account" i]:visible',
    'input[name*="login" i]:visible',
    'input[placeholder*="账号"]:visible',
    'input[placeholder*="帐号"]:visible',
    'input[placeholder*="手机"]:visible',
    'input[placeholder*="邮箱"]:visible'
  ].join(',');
  const passwordSelector = 'input[type="password"]:visible';
  try {
    await page.locator(usernameSelector).first().fill(username);
    await page.locator(passwordSelector).first().fill(password);
    const submit = page
      .locator('button:visible, input[type="submit"]:visible, [role="button"]:visible')
      .filter({ hasText: /登录|登入|sign in|log in|继续/i })
      .first();
    if ((await submit.count()) > 0) await submit.click();
    else await page.locator(passwordSelector).first().press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1800);
    return { status: 'attempted', attempted: true, checkpoint: 'login_result_audit_required' };
  } catch {
    return {
      status: 'blocked_external',
      attempted: true,
      checkpoint: 'bounded_password_login_failed'
    };
  }
}
