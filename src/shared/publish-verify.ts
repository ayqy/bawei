import type { ChannelRuntimeState } from './v2-types';

const BAWEI_V2_STOP_ERROR_MESSAGE_PUBLISH_VERIFY = '__BAWEI_V2_STOPPED__';

function baweiV2IsStopRequestedPublishVerify(): boolean {
  try {
    const fn = (globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }).__BAWEI_V2_IS_STOP_REQUESTED;
    return typeof fn === 'function' ? !!fn() : false;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  if (baweiV2IsStopRequestedPublishVerify()) throw new Error(BAWEI_V2_STOP_ERROR_MESSAGE_PUBLISH_VERIFY);

  const start = Date.now();
  while (Date.now() - start < ms) {
    const left = ms - (Date.now() - start);
    await new Promise((r) => setTimeout(r, Math.min(200, left)));
    if (baweiV2IsStopRequestedPublishVerify()) throw new Error(BAWEI_V2_STOP_ERROR_MESSAGE_PUBLISH_VERIFY);
  }
}

export async function retryUntil<T>(
  fn: () => Promise<T>,
  options?: { timeoutMs?: number; intervalMs?: number; onError?: (err: unknown) => void }
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 45000;
  const intervalMs = options?.intervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (baweiV2IsStopRequestedPublishVerify()) throw new Error(BAWEI_V2_STOP_ERROR_MESSAGE_PUBLISH_VERIFY);

    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && err.message === BAWEI_V2_STOP_ERROR_MESSAGE_PUBLISH_VERIFY) throw err;
      lastError = err;
      options?.onError?.(err);
      await sleep(intervalMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function pageContainsText(text: string): boolean {
  const bodyText = document.body?.innerText || '';
  return bodyText.includes(text);
}

export function titleToken(title: string): string {
  const t = normalizeForSearch(title);
  return t.slice(0, Math.min(12, t.length));
}

export function pageContainsTitle(title: string): boolean {
  const t = normalizeForSearch(title);
  if (!t) return false;
  if (pageContainsText(t)) return true;
  const token = titleToken(t);
  if (token && token.length >= 6 && pageContainsText(token)) return true;
  return false;
}

export function pageContainsSourceUrl(sourceUrl: string): boolean {
  const target = String(sourceUrl || '').trim();
  if (!target) return false;
  const html = document.documentElement?.outerHTML || '';
  const bodyText = document.body?.innerText || '';
  if (html.includes(target) || bodyText.includes(target)) return true;

  try {
    const decoded = decodeURIComponent(target);
    if (decoded && decoded !== target && (html.includes(decoded) || bodyText.includes(decoded))) return true;
  } catch {
    // ignore
  }

  try {
    const u = new URL(target);
    const host = String(u.hostname || '').trim();
    const path = String(u.pathname || '').replace(/\/+$/g, '').trim();
    const pathToken = path
      .split('/')
      .filter(Boolean)
      .pop();
    const hostHit = host ? html.includes(host) || bodyText.includes(host) : false;
    if (!hostHit) return false;
    if (!pathToken) return true;
    if (path && (html.includes(path) || bodyText.includes(path))) return true;
    if (html.includes(pathToken) || bodyText.includes(pathToken)) return true;
  } catch {
    // ignore
  }

  return false;
}

export function detectPageLoginState(options?: {
  loginUrlPattern?: RegExp;
  strictLoginPattern?: RegExp;
  loggedInPattern?: RegExp;
}): { status: 'logged_in' | 'not_logged_in' | 'unknown'; reason: string } {
  const url = String(location.href || '').toLowerCase();
  const text = String(document.body?.innerText || '').slice(0, 12000);
  const loginUrlPattern = options?.loginUrlPattern || /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i;
  const strictLoginPattern =
    options?.strictLoginPattern || /请登录|请先登录|登录后继续|未登录|扫码登录|账号登录|手机号登录|sign in|log in/i;
  const loggedInPattern =
    options?.loggedInPattern ||
    /退出登录|个人中心|创作中心|创作后台|写文章|发布文章|发布管理|内容管理|工作台|我的文章|文章管理|账号设置|消息中心/i;

  const hasLoginUrl = loginUrlPattern.test(url);
  const hasPassword = !!document.querySelector('input[type="password"],input[name*="password" i],input[id*="password" i]');
  const hasLoginBtn = Array.from(document.querySelectorAll<HTMLElement>('button,a,span,div')).some((el) => {
    try {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return false;
    } catch {
      // ignore
    }
    const t = String(el.textContent || '').trim();
    if (!t) return false;
    return /登录|登入|sign in|log in|扫码登录|手机号登录/i.test(t);
  });
  const hasStrictLoginText = strictLoginPattern.test(text);
  const hasLoggedInHints = loggedInPattern.test(text);
  const hasStrongLoginSignals =
    (hasPassword && hasLoginBtn) ||
    (hasStrictLoginText && (hasLoginBtn || hasPassword || hasLoginUrl)) ||
    (hasLoginUrl && hasPassword);

  if (hasLoggedInHints && !hasStrongLoginSignals) {
    return { status: 'logged_in', reason: 'logged-in-dom-hints' };
  }
  if (hasStrongLoginSignals) {
    return { status: 'not_logged_in', reason: hasLoginUrl ? 'login-url' : 'login-dom' };
  }
  if (hasLoginUrl) {
    return { status: 'unknown', reason: 'login-url-no-form' };
  }
  return { status: 'logged_in', reason: 'entry-page-accessible' };
}

export function findLinkByText(text: string): HTMLAnchorElement | null {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'));
  return links.find((a) => (a.textContent || '').trim() === text) || null;
}

export function findAnchorContainingText(text: string): HTMLAnchorElement | null {
  const t = normalizeForSearch(text);
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a'));
  return links.find((a) => normalizeForSearch(a.textContent || '').includes(t)) || null;
}

export function findAnyElementContainingText(text: string): HTMLElement | null {
  // Include <label> because many platforms implement radio/checkbox options with labels.
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('a,button,div,span,label'));
  return candidates.find((n) => (n.textContent || '').includes(text)) || null;
}

export function normalizeForSearch(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function summarizeVerifyDetails<T extends Record<string, unknown> = Record<string, never>>(details: {
  publishedUrl?: string;
  draftUrl?: string;
  editorUrl?: string;
  listUrl?: string;
  listVisible?: boolean;
  sourceUrlPresent?: boolean;
  savedToCloud?: boolean;
} & T): NonNullable<ChannelRuntimeState['devDetails']> {
  const {
    publishedUrl,
    draftUrl,
    editorUrl,
    listUrl,
    listVisible,
    sourceUrlPresent,
    savedToCloud,
    ...rest
  } = details;

  return {
    ...rest,
    publishedUrl,
    ...(draftUrl ? { draftUrl } : {}),
    ...(editorUrl ? { editorUrl } : {}),
    listUrl,
    verified: {
      listVisible: !!listVisible,
      sourceUrlPresent: !!sourceUrlPresent,
      ...(typeof savedToCloud === 'boolean' ? { savedToCloud } : {}),
    },
  };
}
