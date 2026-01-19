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
  const html = document.documentElement?.outerHTML || '';
  const bodyText = document.body?.innerText || '';
  return html.includes(sourceUrl) || bodyText.includes(sourceUrl);
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

export function summarizeVerifyDetails(details: {
  publishedUrl?: string;
  listUrl?: string;
  listVisible?: boolean;
  sourceUrlPresent?: boolean;
}): NonNullable<ChannelRuntimeState['devDetails']> {
  return {
    publishedUrl: details.publishedUrl,
    listUrl: details.listUrl,
    verified: {
      listVisible: !!details.listVisible,
      sourceUrlPresent: !!details.sourceUrlPresent,
    },
  };
}
