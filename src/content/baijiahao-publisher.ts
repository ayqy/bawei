/**
 * Baijiahao (Baidu) Publisher Content Script (V2)
 *
 * Editor:
 * - Title: a small contenteditable div on the page (not inside iframe).
 * - Content: UEditor iframe (#ueditor_0).
 * - Required fields may include category / AI declaration / cover type.
 *
 * Verification:
 * - Go to list page and search for title token.
 * - Open detail/preview when possible and verify source URL exists in content.
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:channel-config */
/* INLINE:publish-verify */
/* INLINE:rich-content */
/* INLINE:image-bridge */

const CHANNEL_ID: ChannelId = 'baijiahao';

type AnyJob = Pick<PublishJob, 'jobId' | 'action' | 'article' | 'stoppedAt'>;

let currentJob: AnyJob | null = null;
let currentStage: ChannelRuntimeState['stage'] = 'init';
let stopRequested = false;

(
  globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }
).__BAWEI_V2_IS_STOP_REQUESTED = () => stopRequested;

// The legacy /builder/rc/list page often renders empty; use the real content management list.
const LIST_URL =
  'https://baijiahao.baidu.com/builder/rc/content?currentPage=1&pageSize=10&search=&type=&collection=&startDate=&endDate=';

function getMessage(key: string, substitutions?: string[]): string {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

function buildListSearchToken(title: string): string {
  const normalized = normalizeForSearch(title);
  // Baijiahao search seems sensitive to punctuation; keep only Chinese/letters/numbers for keyword.
  const cleaned = normalized.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const candidate = cleaned.length >= 4 ? cleaned : normalized;
  return titleToken(candidate);
}

function normalizeLoose(value: string): string {
  return normalizeForSearch(value).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
}

function normalizeTitleValue(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeBaijiahaoRichHtml(rawHtml: string): string {
  const container = document.createElement('div');
  container.innerHTML = String(rawHtml || '');

  const removableSelectors = ['script', 'style', 'iframe', 'mp-style-type'];
  for (const node of Array.from(container.querySelectorAll(removableSelectors.join(', ')))) {
    node.remove();
  }

  const removableAttrRules = [
    /^data-pm-slice$/i,
    /^data-diagnose-id$/i,
    /^data-report-img-idx$/i,
    /^data-fail$/i,
    /^leaf$/i,
    /^nodeleaf$/i,
    /^textstyle$/i,
    /^_width$/i
  ];

  for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (removableAttrRules.some((rule) => rule.test(attr.name))) {
        el.removeAttribute(attr.name);
      }
    }
  }

  const blocks = Array.from(container.querySelectorAll<HTMLElement>('p,section,div'));
  for (const block of blocks) {
    const text = String(block.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, '')
      .trim();
    const hasMedia = !!block.querySelector('img,video,table,blockquote,pre,hr');
    const styleText = String(block.getAttribute('style') || '');
    if (!text && !hasMedia) {
      block.remove();
      continue;
    }
    if (!hasMedia && /font-size:\s*0px/i.test(styleText) && text.length <= 1) {
      block.remove();
    }
  }

  return String(container.innerHTML || '').trim();
}

function buildBaijiahaoTitle(title: string): string {
  return normalizeTitleValue(title).slice(0, 64);
}

function selectContents(el: HTMLElement): void {
  try {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    // ignore
  }
}

function setEditableTitleValue(target: HTMLElement, value: string): void {
  simulateFocus(target);
  selectContents(target);
  try {
    document.execCommand('delete', false);
  } catch {
    // ignore
  }
  try {
    target.innerHTML = '';
  } catch {
    // ignore
  }
  try {
    target.textContent = value;
  } catch {
    // ignore
  }
  try {
    target.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: 'insertText'
      })
    );
  } catch {
    // ignore
  }
  try {
    target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } catch {
    // ignore
  }
  try {
    target.dispatchEvent(
      new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'End' })
    );
  } catch {
    // ignore
  }
}

async function setBaijiahaoTitleByMainWorld(value: string): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: V3_EXECUTE_MAIN_WORLD,
      action: 'baijiahao-set-title',
      payload: { value }
    });
    if (!res?.success) return false;
    const detail = (res.result || {}) as { ok?: boolean; value?: string };
    return !!detail.ok && normalizeTitleValue(detail.value || '') === value;
  } catch {
    return false;
  }
}

function findPreviewLinkByTitleOrToken(title: string, token: string): HTMLAnchorElement | null {
  const wantTitle = normalizeLoose(title);
  const wantToken = normalizeLoose(token);
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((a) =>
    a.href.includes('/builder/preview/')
  );
  for (const a of links) {
    const txt = normalizeLoose(a.textContent || '');
    if (wantToken && txt.includes(wantToken)) return a;
    if (wantTitle && txt.includes(wantTitle.slice(0, Math.min(12, wantTitle.length)))) return a;
  }
  return null;
}

function clickStatusTabBestEffort(label: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const root = document.querySelector('.cheetah-custom-tabs-sub');
  const scope = (root as HTMLElement | null) || document;
  const tabs = Array.from(scope.querySelectorAll<HTMLElement>('.cheetah-tabs-tab-btn[role="tab"]'));
  const btn = tabs.find((t) => normalize(t.textContent || '') === label) || null;
  if (!btn) return false;
  try {
    simulateClick(btn);
  } catch {
    // ignore
  }
  try {
    btn.click();
  } catch {
    // ignore
  }
  return true;
}

function buildPlainText(contentHtml: string, sourceUrl: string): string {
  const base = htmlToPlainTextSafe(contentHtml) || '（以下为自动发布内容）';
  const suffix = sourceUrl ? `\n\n原文链接：${sourceUrl}` : '';
  return `${base}${suffix}`.trim();
}

function buildBaijiahaoFinalHtml(contentHtml: string, needPad: boolean): string {
  const container = document.createElement('div');
  container.innerHTML = String(contentHtml || '').trim();

  if (needPad) {
    container.insertAdjacentHTML(
      'beforeend',
      '<p>（提示：本文内容较短，更多细节请点击下方原文链接查看完整内容。）</p>'
    );
  }

  return String(container.innerHTML || '').trim();
}

function appendBaijiahaoSourceHtml(html: string, sourceUrl: string): string {
  const base = String(html || '').trim();
  const source = String(sourceUrl || '').trim();
  if (!source || base.includes(source)) return base;
  return `${base}<p><br></p><p>原文链接：<a href="${source}" target="_blank" rel="noreferrer noopener">${source}</a></p>`;
}

function baijiahaoExpectedTextBlocks(html: string): string[] {
  const container = document.createElement('div');
  container.innerHTML = String(html || '');
  return Array.from(container.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6,li,blockquote'))
    .map((node) => normalizeTitleValue(node.textContent || ''))
    .filter((text) => text.length >= 8);
}

function normalizeBaijiahaoComparableImageUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, location.href);
    // 百家号正文 DOM 仍可能保存 http://，而 Chromium 的 currentSrc 会按站点
    // upgrade-insecure-requests 自动显示成 https://。只统一协议，其余 host/path/query/hash
    // 继续逐字比较，图片数量和顺序也仍保持严格验收。
    if (url.protocol === 'http:' || url.protocol === 'https:') url.protocol = 'https:';
    return url.toString();
  } catch {
    return raw.replace(/^http:\/\//i, 'https://');
  }
}

function countNormalizedOccurrences(haystack: string, needle: string): number {
  const full = normalizeTitleValue(haystack);
  const part = normalizeTitleValue(needle);
  if (!full || !part) return 0;
  let count = 0;
  let offset = 0;
  while (offset < full.length) {
    const found = full.indexOf(part, offset);
    if (found < 0) break;
    count += 1;
    offset = found + part.length;
  }
  return count;
}

function setBaijiahaoEditorContentByIframeFallback(
  body: HTMLBodyElement,
  contentHtml: string,
  sourceUrl: string
): void {
  const nextHtml = appendBaijiahaoSourceHtml(contentHtml, sourceUrl);
  body.innerHTML = nextHtml;
  try {
    body.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    body.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    body.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'End' }));
    body.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  } catch {
    // ignore
  }
}

async function setBaijiahaoEditorContent(contentHtml: string, sourceUrl: string): Promise<void> {
  const html = String(contentHtml || '').trim();
  if (!html) throw new Error('baijiahao content html empty');
  const res = await chrome.runtime.sendMessage({
    type: V3_EXECUTE_MAIN_WORLD,
    action: 'baijiahao-set-content',
    payload: { html, sourceUrl: String(sourceUrl || '') }
  });
  if (!res?.success)
    throw new Error(
      String(res?.error || `baijiahao main-world setContent failed: ${JSON.stringify(res || null)}`)
    );
  const detail = (res.result || {}) as { ok?: boolean; error?: string };
  if (!detail?.ok)
    throw new Error(
      String(detail?.error || `baijiahao main-world setContent failed: ${JSON.stringify(detail)}`)
    );
}

function shouldRunOnThisPage(): boolean {
  return location.hostname === 'baijiahao.baidu.com';
}

function isEditorPage(): boolean {
  return (
    location.hostname === 'baijiahao.baidu.com' && location.pathname.startsWith('/builder/rc/edit')
  );
}

function isListPage(): boolean {
  return (
    location.hostname === 'baijiahao.baidu.com' &&
    location.pathname.startsWith('/builder/rc/content')
  );
}

function isHomePage(): boolean {
  return location.hostname === 'baijiahao.baidu.com' && location.pathname === '/';
}

async function report(patch: Partial<ChannelRuntimeState>): Promise<void> {
  if (!currentJob) return;
  await chrome.runtime.sendMessage({
    type: V2_CHANNEL_UPDATE,
    jobId: currentJob.jobId,
    channelId: CHANNEL_ID,
    patch
  });
}

async function getContextFromBackground(): Promise<{ job: AnyJob; channelId: string }> {
  const res = await chrome.runtime.sendMessage({ type: V2_GET_CONTEXT });
  if (!res?.success) throw new Error(res?.error || 'get context failed');
  return { job: res.job, channelId: res.channelId };
}

function getCurrentLoginState() {
  return detectPageLoginState({
    loginUrlPattern: /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i,
    loggedInPattern: /百家号|发布|我的作品|账号设置|收益|创作中心|退出登录/i
  });
}

async function stageDetectLogin(): Promise<void> {
  currentStage = 'detectLogin';
  await report({
    status: 'running',
    stage: 'detectLogin',
    userMessage: getMessage('v3MsgDetectingLogin')
  });

  const loginState = getCurrentLoginState();
  if (loginState.status === 'not_logged_in') {
    await report({
      status: 'not_logged_in',
      stage: 'detectLogin',
      userMessage: getMessage('v3MsgNotLoggedIn'),
      userSuggestion: getMessage('v3SugLoginThenRetry')
    });
    throw new Error('__BAWEI_V2_STOPPED__');
  }
}

function findByExactText(text: string): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('button,a,div,span'));
  return nodes.find((n) => (n.textContent || '').replace(/\s+/g, ' ').trim() === text) || null;
}

function findClickableByText(text: string): HTMLElement | null {
  const el = findByExactText(text) || findAnyElementContainingText(text);
  if (!el) return null;
  return (
    (el.closest('button') as HTMLElement | null) ||
    (el.closest('[role="button"]') as HTMLElement | null) ||
    el
  );
}

function isVisibleTextEntry(el: HTMLElement | null | undefined): el is HTMLElement {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 18) return false;
  if (rect.top < -20 || rect.top > window.innerHeight + 260) return false;
  try {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
      return false;
  } catch {
    // ignore
  }
  return true;
}

function findCoverSelectButton(): HTMLElement | null {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

  const coverItem = document.querySelector('.form-item-cover');
  const scope = (coverItem?.closest('.cheetah-form-item') as HTMLElement | null) || document;
  const nodes = Array.from(scope.querySelectorAll<HTMLElement>('button,a,div,span'));
  const cands = nodes
    .map((n) => {
      const t = normalize(n.textContent || '');
      if (t !== '选择封面') return null;
      const rect = n.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const cursor = (() => {
        try {
          return getComputedStyle(n).cursor || '';
        } catch {
          return '';
        }
      })();
      const area = rect.width * rect.height;
      return { n, area, cursor, w: rect.width, h: rect.height };
    })
    .filter(Boolean) as Array<{
    n: HTMLElement;
    area: number;
    cursor: string;
    w: number;
    h: number;
  }>;

  if (!cands.length) return null;

  // Prefer elements that look clickable; then prefer smaller clickable targets.
  cands.sort((a, b) => {
    const ap = a.cursor === 'pointer' ? 0 : 1;
    const bp = b.cursor === 'pointer' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.area - b.area;
  });

  const picked = cands[0]?.n;
  if (!picked) return null;
  return (
    (picked.closest('button') as HTMLElement | null) ||
    (picked.closest('[role="button"]') as HTMLElement | null) ||
    picked
  );
}

async function dismissOnboardingBestEffort(): Promise<void> {
  // The editor sometimes shows a guided-tour overlay which intercepts pointer events.
  // Best-effort click-through: "下一步" a few times, then "完成"/"跳过"/"我知道了".
  try {
    const max = 6;
    for (let i = 0; i < max; i++) {
      const next = findClickableByText('下一步');
      if (!next) break;
      try {
        simulateClick(next);
      } catch {
        // ignore
      }
      try {
        next.click();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    const done =
      findClickableByText('完成') || findClickableByText('我知道了') || findClickableByText('跳过');
    if (done) {
      try {
        simulateClick(done);
      } catch {
        // ignore
      }
      try {
        done.click();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch {
    // ignore
  }
}

function clickBaijiahaoPointerTarget(target: HTMLElement): void {
  try {
    target.scrollIntoView({
      block: 'center',
      inline: 'center',
      behavior: 'instant' as ScrollBehavior
    });
  } catch {
    // ignore
  }

  const rect = target.getBoundingClientRect();
  const clientX = rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2));
  const clientY = rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2));
  const view = target.ownerDocument?.defaultView || window;

  const fireMouse = (type: string) => {
    try {
      target.dispatchEvent(
        new view.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view,
          button: 0,
          buttons: 1,
          clientX,
          clientY
        })
      );
    } catch {
      // ignore
    }
  };

  const firePointer = (type: string) => {
    try {
      const PointerCtor = (
        view as Window & typeof globalThis & { PointerEvent?: typeof PointerEvent }
      ).PointerEvent;
      if (typeof PointerCtor !== 'function') return;
      target.dispatchEvent(
        new PointerCtor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX,
          clientY
        })
      );
    } catch {
      // ignore
    }
  };

  firePointer('pointerover');
  firePointer('pointerenter');
  fireMouse('mouseover');
  fireMouse('mouseenter');
  firePointer('pointerdown');
  fireMouse('mousedown');
  firePointer('pointerup');
  fireMouse('mouseup');
  fireMouse('click');

  try {
    simulateClick(target);
  } catch {
    // ignore
  }
  try {
    target.click();
  } catch {
    // ignore
  }
}

function findTitleEditable(): HTMLElement | null {
  const titleRoot = document.querySelector<HTMLElement>('[data-testid="news-title-input"]');
  const lexicalTitle = titleRoot?.querySelector<HTMLElement>('[contenteditable="true"]') || null;
  if (lexicalTitle && isVisibleTextEntry(lexicalTitle)) return lexicalTitle;

  const explicit = Array.from(
    document.querySelectorAll<HTMLElement>(
      [
        '[contenteditable="true"][placeholder*="标题"]',
        '[contenteditable="true"][aria-label*="标题"]',
        '[contenteditable="true"][data-placeholder*="标题"]',
        '[role="textbox"][contenteditable="true"]',
        '[role="textbox"][aria-label*="标题"]',
        '[role="textbox"][data-placeholder*="标题"]',
        '[class*="title"][contenteditable="true"]',
        '[id*="title"][contenteditable="true"]'
      ].join(', ')
    )
  )
    .filter((el) => isVisibleTextEntry(el))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top || ar.height - br.height;
    });
  if (explicit[0]) return explicit[0];

  const cands = Array.from(document.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    // Title editor may expand to multiple lines (height > 160) when long; keep an upper bound to avoid huge editors.
    .filter((x) => x.rect.width >= 240 && x.rect.height >= 18 && x.rect.height <= 420)
    .filter((x) => x.rect.top >= 0 && x.rect.top <= window.innerHeight + 200)
    // Prefer the top-most small editable area which is usually the title.
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.height - b.rect.height);
  return cands[0]?.el || null;
}

function findTitleTextFieldFallback(): HTMLInputElement | HTMLTextAreaElement | null {
  const explicit = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      [
        'textarea[placeholder*="标题"]',
        'textarea[aria-label*="标题"]',
        'textarea[data-placeholder*="标题"]',
        'textarea[name*="title" i]',
        'textarea[id*="title" i]',
        'input[placeholder*="标题"]',
        'input[aria-label*="标题"]',
        'input[data-placeholder*="标题"]',
        'input[name*="title" i]',
        'input[id*="title" i]',
        'input[type="text"][class*="title"]',
        'textarea[class*="title"]'
      ].join(', ')
    )
  )
    .filter((el) => isVisibleTextEntry(el as unknown as HTMLElement))
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.top - br.top || ar.height - br.height;
    });
  if (explicit[0]) return explicit[0];

  const exclude = new Set(['abstract', 'inputTextArea']);
  const cands = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'))
    .filter((el) => !exclude.has(el.id || ''))
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    // Title textarea is usually small and near the top; avoid large editors / hidden textareas.
    .filter((x) => x.rect.width >= 280 && x.rect.height >= 18 && x.rect.height <= 140)
    .filter((x) => x.rect.top >= 0 && x.rect.top <= window.innerHeight + 200)
    .filter((x) => {
      const style = getComputedStyle(x.el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
        return false;
      return true;
    })
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.height - b.rect.height);
  if (cands[0]?.el) return cands[0].el;

  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])')
  )
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    .filter((x) => x.rect.width >= 240 && x.rect.height >= 18 && x.rect.height <= 120)
    .filter((x) => x.rect.top >= 0 && x.rect.top <= window.innerHeight + 200)
    .filter((x) => isVisibleTextEntry(x.el))
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.height - b.rect.height);
  return inputs[0]?.el || null;
}

function setNativeTextEntryValue(
  target: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void {
  const proto =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (typeof desc?.set === 'function') desc.set.call(target, value);
  else target.value = value;

  target.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: 'insertText'
    })
  );
  target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

async function stageOpenEditor(): Promise<void> {
  currentStage = 'openEntry';
  await report({
    status: 'running',
    stage: 'openEntry',
    userMessage: getMessage('v2MsgBaijiahaoOpeningEditor')
  });

  // Some accounts do not have #home-publish-btn; fallback to clicking "发布图文" in the publish entry list.
  const btn =
    (document.querySelector('#home-publish-btn') as HTMLElement | null) ||
    findByExactText('发布作品');
  if (btn) {
    try {
      simulateClick(btn);
    } catch {
      btn.click();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const publishNews = findByExactText('发布图文');
  if (!publishNews) throw new Error('未找到“发布图文”入口');
  simulateClick(publishNews);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (isEditorPage()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('打开编辑器超时（可能被弹窗/风控拦截）');
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({
    status: 'running',
    stage: 'fillTitle',
    userMessage: getMessage('v2MsgFillingTitle')
  });
  const finalTitle = buildBaijiahaoTitle(title);

  // Persistent contexts may restore the last scroll position; ensure title area is visible.
  try {
    window.scrollTo(0, 0);
  } catch {
    // ignore
  }

  const deadline = Date.now() + 8 * 60_000;
  let lastHeartbeat = 0;
  let lastSecurityHint = '';

  while (Date.now() < deadline) {
    const pageText = document.body?.innerText || '';
    const securityHint =
      pageText.includes('百度安全验证') ||
      pageText.includes('拖动左侧滑块') ||
      pageText.includes('扫码验证');
    if (securityHint) {
      const key = `bawei_v2_baijiahao_security_hint_${currentJob?.jobId || ''}`;
      if (!sessionStorage.getItem(key) || lastSecurityHint !== 'security') {
        sessionStorage.setItem(key, '1');
        lastSecurityHint = 'security';
        await report({
          status: 'running',
          stage: 'fillTitle',
          userMessage: getMessage('v2MsgBaijiahaoSecurityVerifyTriggered')
        });
      }
      await new Promise((r) => setTimeout(r, 900));
      continue;
    }

    if (await setBaijiahaoTitleByMainWorld(finalTitle)) return;

    const textField = findTitleTextFieldFallback();
    if (textField) {
      simulateFocus(textField);
      try {
        setNativeTextEntryValue(textField, finalTitle);
      } catch {
        try {
          textField.value = finalTitle;
        } catch {
          // ignore
        }
      }
      if (normalizeTitleValue(String(textField.value || '')) === finalTitle) {
        return;
      }
    }

    const target = findTitleEditable();
    if (target) {
      const editable = target as HTMLElement;
      setEditableTitleValue(editable, finalTitle);

      if (normalizeTitleValue(editable.textContent || '') !== finalTitle) {
        try {
          editable.textContent = finalTitle;
          editable.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
          editable.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        } catch {
          // ignore
        }
      }

      if (normalizeTitleValue(editable.textContent || '') === finalTitle) return;
    }

    if (Date.now() - lastHeartbeat > 10_000) {
      lastHeartbeat = Date.now();
      await report({
        status: 'running',
        stage: 'fillTitle',
        userMessage: getMessage('v2MsgFillingTitle')
      });
    }
    await new Promise((r) => setTimeout(r, 900));
  }

  throw new Error('title editable not ready');
}

function findBaijiahaoUploadInput(): HTMLInputElement | null {
  const modals = Array.from(document.querySelectorAll<HTMLElement>('.cheetah-ui-pro-image-modal'));
  const visibleModal = modals.find((modal) => isElementVisible(modal));
  if (visibleModal) {
    const modalInputs = Array.from(
      visibleModal.querySelectorAll<HTMLInputElement>('input[type="file"]')
    );
    return (
      modalInputs.find(
        (input) =>
          input.accept.toLowerCase().includes('image') ||
          /image/i.test(`${input.className} ${input.id} ${input.name}`)
      ) || null
    );
  }
  if (modals.length) return null;

  const documents: Document[] = [document];
  for (const frame of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))) {
    try {
      if (frame.contentDocument) documents.push(frame.contentDocument);
    } catch {
      // Cross-origin frames are irrelevant to the UEditor dialog.
    }
  }
  for (const doc of documents) {
    const inputs = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="file"]'));
    const preferred = inputs.find(
      (input) =>
        input.accept.toLowerCase().includes('image') ||
        /image/i.test(`${input.className} ${input.id} ${input.name}`)
    );
    if (preferred) return preferred;
  }
  return null;
}

function resolveBaijiahaoEditorBody(fallback?: HTMLBodyElement | null): HTMLBodyElement | null {
  try {
    const current =
      document.querySelector<HTMLIFrameElement>('iframe#ueditor_0')?.contentDocument?.body;
    if (current) return current as HTMLBodyElement;
  } catch {
    // Keep the last same-origin body while UEditor is replacing its document.
  }
  return fallback || null;
}

async function openBaijiahaoImageDialog(): Promise<boolean> {
  try {
    const res = await chrome.runtime.sendMessage({
      type: V3_EXECUTE_MAIN_WORLD,
      action: 'baijiahao-open-image-dialog',
      payload: {}
    });
    const detail = (res?.result || {}) as { ok?: boolean };
    return !!res?.success && !!detail.ok;
  } catch {
    return false;
  }
}

async function uploadBaijiahaoImages(
  sourceUrls: string[],
  body: HTMLBodyElement
): Promise<string[]> {
  const sources = sourceUrls.map((value) => String(value || '').trim()).filter(Boolean);
  if (!sources.length) return [];

  const insertButton =
    document.querySelector<HTMLElement>('.edui-for-insertimage .edui-button-body') ||
    document.querySelector<HTMLElement>('.edui-for-insertimage');
  if (!insertButton) throw new Error('百家号未找到插图按钮 .edui-for-insertimage');
  const openedInMainWorld = await openBaijiahaoImageDialog();
  if (!openedInMainWorld) simulateClick(insertButton);
  await report({
    devDetails: {
      imagePhase: 'dialog-requested',
      openedInMainWorld,
      sourceCount: sources.length
    }
  });

  const input = await retryUntil(
    async () => {
      const candidate = findBaijiahaoUploadInput();
      if (!candidate) throw new Error('等待百家号图片上传控件');
      return candidate;
    },
    { timeoutMs: 20_000, intervalMs: 400 }
  );
  const beforeBody = resolveBaijiahaoEditorBody(body);
  if (!beforeBody) throw new Error('百家号正文编辑器在图片上传前不可用');
  const beforeUrls = Array.from(beforeBody.querySelectorAll<HTMLImageElement>('img')).map((img) =>
    String(img.currentSrc || img.src || '').trim()
  );
  const beforeCount = beforeUrls.length;
  const transfer = new DataTransfer();
  for (let index = 0; index < sources.length; index += 1) {
    const sourceFile = await fetchImageAsFile(currentJob?.jobId || '', sources[index]);
    const uploadFile = new File([sourceFile], `bawei-${index + 1}-${sourceFile.name}`, {
      type: sourceFile.type || 'application/octet-stream'
    });
    transfer.items.add(uploadFile);
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  const uploadDispatchedAt = Date.now();
  await report({
    devDetails: {
      imagePhase: 'files-dispatched',
      beforeCount,
      fileCount: transfer.files.length
    }
  });

  let confirmed = false;
  return await retryUntil(
    async () => {
      const imageModal = Array.from(
        document.querySelectorAll<HTMLElement>('.cheetah-ui-pro-image-modal')
      ).find((modal) => isElementVisible(modal));
      const liveBody = resolveBaijiahaoEditorBody(body);
      if (!liveBody) throw new Error('等待百家号正文编辑器恢复');
      const candidates = Array.from(liveBody.querySelectorAll<HTMLImageElement>('img'))
        .map((img) => String(img.currentSrc || img.src || img.getAttribute('src') || '').trim())
        .filter((value) => isPlatformHostedImageUrl(value));
      if (
        candidates.length >= beforeCount + sources.length ||
        ((confirmed || (!imageModal && Date.now() - uploadDispatchedAt >= 1_500)) &&
          candidates.length >= sources.length)
      ) {
        await report({
          devDetails: {
            imagePhase: 'hosted-detected',
            beforeCount,
            hostedCount: candidates.length,
            confirmed
          }
        });
        return candidates.slice(-sources.length);
      }

      const modalText = String(imageModal?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (imageModal && !confirmed && /上传成功/.test(modalText)) {
        const confirmButton = Array.from(
          imageModal.querySelectorAll<HTMLButtonElement>('button')
        ).find(
          (button) =>
            (button.textContent || '').replace(/\s+/g, ' ').trim() === '确认' &&
            !button.disabled &&
            isElementVisible(button)
        );
        if (confirmButton) {
          simulateClick(confirmButton);
          confirmed = true;
          await report({
            devDetails: {
              imagePhase: 'confirm-clicked',
              beforeCount,
              hostedCount: candidates.length
            }
          });
        }
      }

      throw new Error(confirmed ? '等待百家号平台托管图片' : '等待百家号批量图片上传完成并确认');
    },
    { timeoutMs: 120_000, intervalMs: 800 }
  );
}

async function rehostBaijiahaoImages(contentHtml: string, body: HTMLBodyElement): Promise<string> {
  const container = document.createElement('div');
  container.innerHTML = String(contentHtml || '');
  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
  if (!images.length) return container.innerHTML;

  const resetEditor = async () => {
    try {
      await setBaijiahaoEditorContent('<p><br></p>', '');
    } catch {
      const liveBody = resolveBaijiahaoEditorBody(body);
      if (!liveBody) throw new Error('百家号正文编辑器不可用');
      setBaijiahaoEditorContentByIframeFallback(liveBody, '<p><br></p>', '');
    }
  };
  await resetEditor();
  // The page can restore an autosaved UEditor snapshot shortly after reload. Clear once more after
  // that initialization window so prior failed attempts cannot reappear when the toolbar is focused.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await resetEditor();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await retryUntil(
    async () => {
      const liveBody = resolveBaijiahaoEditorBody(body);
      if (!liveBody) throw new Error('等待百家号正文编辑器恢复');
      if (liveBody.querySelectorAll('img').length) throw new Error('等待百家号编辑器清空历史图片');
      return true;
    },
    { timeoutMs: 8_000, intervalMs: 200 }
  );
  const sourceUrls = images.map((image, index) => {
    const sourceUrl = String(
      image.getAttribute('src') || image.getAttribute('data-src') || ''
    ).trim();
    if (!sourceUrl) throw new Error(`百家号第 ${index + 1} 张图片缺少来源地址`);
    return sourceUrl;
  });
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v3MsgUploadingImageProgress', ['1', String(images.length)])
  });
  const hostedUrls = await uploadBaijiahaoImages(sourceUrls, body);
  if (hostedUrls.length !== images.length) {
    throw new Error(`百家号平台托管图片数量不精确：${hostedUrls.length}/${images.length}`);
  }
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    image.setAttribute('src', hostedUrls[index]);
    image.removeAttribute('data-src');
    image.removeAttribute('data-original');
  }
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v3MsgUploadingImageProgress', [
      String(images.length),
      String(images.length)
    ])
  });
  return container.innerHTML;
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugBaijiahaoNoSourceFieldAppend')
  });

  const iframe = (await waitForElement<HTMLIFrameElement>(
    'iframe#ueditor_0',
    60000
  )) as HTMLIFrameElement;

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (iframe?.contentDocument?.body) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!iframe?.contentDocument?.body) throw new Error('未找到正文编辑器（iframe 未就绪）');

  const body = iframe.contentDocument.body as HTMLBodyElement | null;
  if (!body) throw new Error('未找到正文编辑器（body 未就绪）');
  const sanitizedContentHtml = sanitizeBaijiahaoRichHtml(contentHtml);
  const needPad = htmlToPlainTextSafe(sanitizedContentHtml).replace(/\s+/g, '').length < 50;
  const rawFinalContentHtml = buildBaijiahaoFinalHtml(sanitizedContentHtml, needPad);
  const finalContentHtml = await rehostBaijiahaoImages(rawFinalContentHtml, body);
  const expectedImages = (() => {
    const container = document.createElement('div');
    container.innerHTML = finalContentHtml;
    return container.querySelectorAll('img').length;
  })();

  const expectedTextBlocks = baijiahaoExpectedTextBlocks(
    appendBaijiahaoSourceHtml(finalContentHtml, sourceUrl)
  );
  const expectedImageUrls = (() => {
    const container = document.createElement('div');
    container.innerHTML = finalContentHtml;
    return Array.from(container.querySelectorAll<HTMLImageElement>('img')).map((image) =>
      String(image.getAttribute('src') || '').trim()
    );
  })();

  try {
    try {
      await setBaijiahaoEditorContent(finalContentHtml, sourceUrl);
    } catch {
      const liveBody = resolveBaijiahaoEditorBody(body);
      if (!liveBody) throw new Error('百家号正文编辑器不可用');
      setBaijiahaoEditorContentByIframeFallback(liveBody, finalContentHtml, sourceUrl);
    }
    await retryUntil(
      async () => {
        const liveBody = resolveBaijiahaoEditorBody(body);
        if (!liveBody) throw new Error('等待百家号正文编辑器恢复');
        const currentHtml = String(liveBody.innerHTML || '');
        const currentText = String(liveBody.innerText || liveBody.textContent || '');
        const normalizedCurrentText = normalizeTitleValue(currentText);
        const hasSource =
          !sourceUrl || currentHtml.includes(sourceUrl) || currentText.includes(sourceUrl);
        const hasLeadingBrace = /^\s*\}/.test(currentHtml);
        const currentImages = Array.from(liveBody.querySelectorAll<HTMLImageElement>('img')).map(
          (image) =>
            String(
              image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || ''
            ).trim()
        );

        if (!currentHtml.trim()) throw new Error('百家号正文仍为空');
        if (hasLeadingBrace) throw new Error('百家号正文出现前导 }');
        if (!hasSource) throw new Error('百家号原文链接未写入');
        if (currentImages.length !== expectedImages) {
          throw new Error(`百家号正文图片数量不精确：${currentImages.length}/${expectedImages}`);
        }
        for (let index = 0; index < expectedImageUrls.length; index += 1) {
          if (
            normalizeBaijiahaoComparableImageUrl(currentImages[index]) !==
            normalizeBaijiahaoComparableImageUrl(expectedImageUrls[index])
          ) {
            throw new Error(`百家号正文第 ${index + 1} 张图片顺序或地址不一致`);
          }
        }

        let cursor = 0;
        for (const block of expectedTextBlocks) {
          const anchor = block.slice(0, Math.min(80, block.length));
          const next = normalizedCurrentText.indexOf(anchor, cursor);
          if (next < 0) throw new Error(`百家号正文段落缺失或顺序错误：${anchor}`);
          if (countNormalizedOccurrences(normalizedCurrentText, anchor) !== 1) {
            throw new Error(`百家号正文段落重复：${anchor}`);
          }
          cursor = next + anchor.length;
        }
        return true;
      },
      { timeoutMs: 12_000, intervalMs: 300 }
    );
  } catch (e) {
    await report({
      status: 'failed',
      stage: 'fillContent',
      userMessage: getMessage('v2MsgFillingContent'),
      devDetails: { message: e instanceof Error ? e.message : String(e) }
    });
    throw e instanceof Error ? e : new Error(String(e));
  }

  await report({ userMessage: getMessage('v2MsgAppendedSourceLinkKeepOriginal') });
}

async function stageEnsureNoCover(): Promise<void> {
  // New Baijiahao editor requires cover selection (单图/三图 + "选择封面"), "无封面" option may not exist.
  // We do NOT upload images in this phase; this function keeps best-effort and will leave hints via verification stage.
  const noCover = findByExactText('无封面') || findAnyElementContainingText('无封面');
  if (noCover) {
    try {
      simulateClick(noCover);
      await new Promise((r) => setTimeout(r, 400));
    } catch {
      // ignore
    }
    return;
  }
}

async function stageEnsureAiDeclaration(): Promise<void> {
  const marker =
    document.querySelector<HTMLElement>('.aigc_bjh_status') ||
    findAnyElementContainingText('采用AI生成内容') ||
    findAnyElementContainingText('AI创作声明');
  if (!marker) return;

  const label = marker.closest('label');
  const input =
    (label?.querySelector('input[type="checkbox"]') as HTMLInputElement | null) ||
    (marker.parentElement?.querySelector('input[type="checkbox"]') as HTMLInputElement | null) ||
    null;
  if (!input) return;
  const isChecked = () =>
    input.checked ||
    !!label?.classList.contains('cheetah-checkbox-wrapper-checked') ||
    !!label?.querySelector('.cheetah-checkbox-checked');
  if (isChecked()) return;

  try {
    simulateClick(input as unknown as HTMLElement);
  } catch {
    try {
      input.click();
    } catch {
      // ignore
    }
  }
  try {
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } catch {
    // ignore
  }

  await retryUntil(
    async () => {
      if (isChecked()) return true;
      throw new Error('AI declaration not selected');
    },
    { timeoutMs: 8000, intervalMs: 300 }
  );
}

async function stageEnsureCategorySelected(): Promise<void> {
  // If "请选择内容分类" exists, pick the first available option.
  const text = document.body?.innerText || '';
  if (!text.includes('请选择内容分类')) return;

  const input = (document.querySelector('#rc_select_0') as HTMLInputElement | null) || null;
  if (!input) return;

  const select = input.closest('.cheetah-select') as HTMLElement | null;
  if (!select) return;

  const already = (select.textContent || '').replace(/\s+/g, ' ').trim();
  if (already && !already.includes('请选择内容分类')) return;

  // Open cascader dropdown (it listens on mousedown in many implementations).
  const selector =
    (select.querySelector('.cheetah-select-selector') as HTMLElement | null) || select;
  try {
    simulateClick(selector);
  } catch {
    // ignore
  }
  try {
    selector.click();
  } catch {
    // ignore
  }

  // Wait for the first-level menu to appear.
  const firstMenu = await retryUntil(
    async () => {
      const menus = Array.from(
        document.querySelectorAll<HTMLElement>('.cheetah-cascader-menus .cheetah-cascader-menu')
      );
      const visible = menus.filter((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!visible.length) throw new Error('category menu not visible');
      return visible[0];
    },
    { timeoutMs: 10_000, intervalMs: 300 }
  );

  const pickItem = (menu: HTMLElement, prefer: string[]): HTMLElement | null => {
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'));
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const p of prefer) {
      const hit = items.find((it) => normalize(it.textContent || '') === p);
      if (hit) return hit;
    }
    return items[0] || null;
  };

  // Prefer a safe category that usually doesn't require extra permissions.
  const first = pickItem(firstMenu, ['科技', '生活', '教育', '社会', '财经', '数码', '其他']);
  if (!first) return;
  try {
    simulateClick(first);
  } catch {
    // ignore
  }
  try {
    first.click();
  } catch {
    // ignore
  }

  // Some categories are multi-level: wait for the second-level menu and pick its first item.
  const secondMenu = await retryUntil(
    async () => {
      const menus = Array.from(
        document.querySelectorAll<HTMLElement>('.cheetah-cascader-menus .cheetah-cascader-menu')
      );
      const visible = menus.filter((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visible.length >= 2) return visible[1];
      // If dropdown closes and selection is applied, we are done.
      const cur = (select.textContent || '').replace(/\s+/g, ' ').trim();
      if (cur && !cur.includes('请选择内容分类')) return null;
      throw new Error('second menu not ready');
    },
    { timeoutMs: 10_000, intervalMs: 300 }
  ).catch(() => null);

  if (secondMenu) {
    const second = pickItem(secondMenu, ['互联网', '科技综合']);
    if (second) {
      try {
        simulateClick(second);
      } catch {
        // ignore
      }
      try {
        second.click();
      } catch {
        // ignore
      }
    }
  }

  // Wait for selection text to update.
  await retryUntil(
    async () => {
      const cur = (select.textContent || '').replace(/\s+/g, ' ').trim();
      if (cur && !cur.includes('请选择内容分类')) return true;
      throw new Error('category not selected');
    },
    { timeoutMs: 10_000, intervalMs: 500 }
  );
}

async function stageEnsureSummaryFilled(job: AnyJob): Promise<void> {
  const summary = document.querySelector<HTMLTextAreaElement>('#abstract');
  if (!summary) return;
  const value = (summary.value || '').trim();
  if (value.length >= 10) return;

  const plain = buildPlainText(job.article.contentHtml, job.article.sourceUrl || '');
  const snippet = plain.replace(/\s+/g, ' ').trim().slice(0, 120);
  try {
    summary.focus();
    summary.value = snippet;
    summary.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: snippet,
        inputType: 'insertText'
      })
    );
    summary.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } catch {
    // ignore
  }
}

async function stageEnsureEventSourceSelected(): Promise<void> {
  const text = document.body?.innerText || '';
  if (!text.includes('事件来源说明')) return;

  // 1) Date picker: "请选择时间"
  const dateInput =
    (document.querySelector<HTMLInputElement>(
      'input[placeholder*="请选择时间"]'
    ) as HTMLInputElement | null) || null;
  if (dateInput && !(dateInput.value || '').trim()) {
    try {
      dateInput.scrollIntoView({ block: 'center' });
    } catch {
      // ignore
    }
    try {
      simulateClick(dateInput as unknown as HTMLElement);
    } catch {
      // ignore
    }
    try {
      dateInput.click();
    } catch {
      // ignore
    }

    const day = String(new Date().getDate());
    const pickCell = async (): Promise<HTMLElement> => {
      const cells = Array.from(document.querySelectorAll<HTMLElement>('td[role="gridcell"], td'));
      const hit =
        cells.find((c) => (c.textContent || '').replace(/\s+/g, ' ').trim() === day) || null;
      if (!hit) throw new Error('date cell not found');
      const r = hit.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) throw new Error('date cell not visible');
      return hit;
    };

    const cell = await retryUntil(pickCell, { timeoutMs: 10_000, intervalMs: 300 }).catch(
      () => null
    );
    if (cell) {
      try {
        simulateClick(cell);
      } catch {
        // ignore
      }
      try {
        cell.click();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  // 2) Location cascader: "请选择地点" (rc_select_1)
  const locInput = (document.querySelector('#rc_select_1') as HTMLInputElement | null) || null;
  const locSelect = (locInput?.closest('.cheetah-select') as HTMLElement | null) || null;
  if (locInput && locSelect && (locSelect.textContent || '').includes('请选择地点')) {
    const selector =
      (locSelect.querySelector('.cheetah-select-selector') as HTMLElement | null) || locSelect;
    try {
      simulateClick(selector);
    } catch {
      // ignore
    }
    try {
      selector.click();
    } catch {
      // ignore
    }

    const firstMenu = await retryUntil(
      async () => {
        const menus = Array.from(
          document.querySelectorAll<HTMLElement>('.cheetah-cascader-menus .cheetah-cascader-menu')
        );
        const visible = menus.filter((m) => {
          const r = m.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!visible.length) throw new Error('location menu not visible');
        return visible[0];
      },
      { timeoutMs: 10_000, intervalMs: 300 }
    );

    const pickMenuItem = (menu: HTMLElement, prefer: string[]): HTMLElement | null => {
      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'));
      const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
      for (const p of prefer) {
        const hit = items.find((it) => normalize(it.textContent || '') === p);
        if (hit) return hit;
      }
      return items[0] || null;
    };

    const first = pickMenuItem(firstMenu, ['北京市', '上海市']);
    if (first) {
      try {
        simulateClick(first);
      } catch {
        // ignore
      }
      try {
        first.click();
      } catch {
        // ignore
      }
    }

    const secondMenu = await retryUntil(
      async () => {
        const menus = Array.from(
          document.querySelectorAll<HTMLElement>('.cheetah-cascader-menus .cheetah-cascader-menu')
        );
        const visible = menus.filter((m) => {
          const r = m.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (visible.length >= 2) return visible[1];
        // If applied already, stop.
        const cur = (locSelect.textContent || '').replace(/\s+/g, ' ').trim();
        if (cur && !cur.includes('请选择地点')) return null;
        throw new Error('second location menu not ready');
      },
      { timeoutMs: 10_000, intervalMs: 300 }
    ).catch(() => null);

    if (secondMenu) {
      const second = pickMenuItem(secondMenu, []);
      if (second) {
        try {
          simulateClick(second);
        } catch {
          // ignore
        }
        try {
          second.click();
        } catch {
          // ignore
        }
      }
    }

    await retryUntil(
      async () => {
        const cur = (locSelect.textContent || '').replace(/\s+/g, ' ').trim();
        if (cur && !cur.includes('请选择地点')) return true;
        throw new Error('location not selected');
      },
      { timeoutMs: 10_000, intervalMs: 500 }
    ).catch(() => {
      // ignore: location might be optional
    });
  }
}

async function stageEnsureCoverSelected(): Promise<void> {
  const text = document.body?.innerText || '';
  const hasCoverUi = text.includes('封面') && (text.includes('单图') || text.includes('三图'));
  if (!hasCoverUi) return;
  const coverApplied = () =>
    !findCoverSelectButton() ||
    !!findAnyElementContainingText('更换封面') ||
    !!findAnyElementContainingText('编辑');
  if (coverApplied()) return;

  const findVisibleCoverModal = (): HTMLElement | null =>
    Array.from(
      document.querySelectorAll<HTMLElement>('.cheetah-modal[role="dialog"], .cheetah-modal')
    ).find(
      (candidate) =>
        isElementVisible(candidate) && (candidate.textContent || '').includes('封面预览')
    ) || null;

  await dismissOnboardingBestEffort();
  let modal = findVisibleCoverModal();

  if (!modal) {
    const selectBtn = findCoverSelectButton();
    if (!selectBtn) return;
    clickBaijiahaoPointerTarget(selectBtn);

    modal = await retryUntil(
      async () => {
        await dismissOnboardingBestEffort();
        const dlg = findVisibleCoverModal();
        if (!dlg) throw new Error('cover modal not ready');
        return dlg;
      },
      { timeoutMs: 30_000, intervalMs: 600 }
    );
  }

  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const hasReadyLocalCover = /确定\s*\(\s*[1-9]\d*\s*\)/.test(normalize(modal.textContent || ''));
  if (!hasReadyLocalCover) {
    const aiTab = Array.from(modal.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) =>
      (t.textContent || '').includes('AI封图')
    );
    if (aiTab) {
      clickBaijiahaoPointerTarget(aiTab);
      await new Promise((r) => setTimeout(r, 800));
    }

    const genCandidates = Array.from(modal.querySelectorAll<HTMLElement>('button,a,div,span'))
      .map((n) => {
        const t = normalize(n.textContent || '');
        if (t !== '根据全文智能生成封面') return null;
        const rect = n.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const cursor = (() => {
          try {
            return getComputedStyle(n).cursor || '';
          } catch {
            return '';
          }
        })();
        return { n, cursor, area: rect.width * rect.height };
      })
      .filter(Boolean) as Array<{ n: HTMLElement; cursor: string; area: number }>;

    genCandidates.sort((a, b) => {
      const ap = a.cursor === 'pointer' ? 0 : 1;
      const bp = b.cursor === 'pointer' ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.area - b.area;
    });

    const gen = genCandidates[0]?.n || null;
    if (gen) {
      clickBaijiahaoPointerTarget(gen);

      await retryUntil(
        async () => {
          const dlg = findVisibleCoverModal();
          const t = (dlg?.textContent || '').replace(/\s+/g, ' ');
          if (!t.includes('图片生成完成') && !t.includes('确定 (1)') && !t.includes('确定(1)'))
            throw new Error('ai cover not ready');
          const confirm =
            (Array.from(dlg?.querySelectorAll<HTMLButtonElement>('button') || []).find((b) =>
              (b.textContent || '').includes('确定')
            ) as HTMLButtonElement | undefined) || null;
          if (!confirm || confirm.hasAttribute('disabled')) throw new Error('confirm disabled');
          return true;
        },
        // Some accounts may have slow AIGC generation; allow longer.
        { timeoutMs: 180_000, intervalMs: 1200 }
      );
    }
  }

  const dlg = findVisibleCoverModal() || modal;
  const confirmBtn =
    (Array.from(dlg.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      (b.textContent || '').includes('确定')
    ) as HTMLButtonElement | undefined) || null;
  if (!confirmBtn) throw new Error('未找到封面弹窗的“确定”按钮');
  clickBaijiahaoPointerTarget(confirmBtn);

  await retryUntil(
    async () => {
      await dismissOnboardingBestEffort();
      const applied = coverApplied();
      if (applied) {
        const dlg = document.querySelector<HTMLElement>(
          '.cheetah-modal[role="dialog"], .cheetah-modal'
        );
        if (dlg) {
          const rect = dlg.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;
          if (visible) {
            const close =
              (dlg.querySelector<HTMLElement>('.cheetah-modal-close') as HTMLElement | null) ||
              (dlg.querySelector<HTMLElement>(
                'button[aria-label="Close"]'
              ) as HTMLElement | null) ||
              null;
            if (close) {
              clickBaijiahaoPointerTarget(close);
            }
            const mask =
              (document.querySelector<HTMLElement>('.cheetah-modal-mask') as HTMLElement | null) ||
              (dlg.parentElement?.querySelector<HTMLElement>(
                '.cheetah-modal-mask'
              ) as HTMLElement | null) ||
              null;
            if (mask) {
              clickBaijiahaoPointerTarget(mask);
            }
            try {
              document.dispatchEvent(
                new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  key: 'Escape',
                  code: 'Escape'
                })
              );
              document.dispatchEvent(
                new KeyboardEvent('keyup', {
                  bubbles: true,
                  cancelable: true,
                  key: 'Escape',
                  code: 'Escape'
                })
              );
            } catch {
              // ignore
            }
          }
        }
        return true;
      }

      const dlg = document.querySelector<HTMLElement>(
        '.cheetah-modal[role="dialog"], .cheetah-modal'
      );
      const stillOpen = (() => {
        if (!dlg) return false;
        const rect = dlg.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        try {
          const s = getComputedStyle(dlg);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        } catch {
          // ignore
        }
        return true;
      })();
      if (stillOpen) {
        const close =
          (dlg?.querySelector<HTMLElement>('.cheetah-modal-close') as HTMLElement | null) ||
          (dlg?.querySelector<HTMLElement>('button[aria-label="Close"]') as HTMLElement | null) ||
          null;
        if (close) {
          clickBaijiahaoPointerTarget(close);
        }
        try {
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              bubbles: true,
              cancelable: true,
              key: 'Escape',
              code: 'Escape'
            })
          );
          document.dispatchEvent(
            new KeyboardEvent('keyup', {
              bubbles: true,
              cancelable: true,
              key: 'Escape',
              code: 'Escape'
            })
          );
        } catch {
          // ignore
        }
        if (coverApplied()) return true;
      }
      if (stillOpen) throw new Error('cover modal still open');
      throw new Error('cover not applied yet');
    },
    { timeoutMs: 30_000, intervalMs: 800 }
  );
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({
    status: 'running',
    stage: 'saveDraft',
    userMessage: getMessage('v2MsgSavingDraft')
  });
  const btn = findByExactText('存草稿') || findAnyElementContainingText('存草稿');
  if (!btn) throw new Error('未找到存草稿按钮');
  btn.click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({
    status: 'running',
    stage: 'submitPublish',
    userMessage: getMessage('v2MsgPublishing')
  });
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const publishBtn =
    Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .map((b) => ({ b, t: normalize(b.textContent || ''), rect: b.getBoundingClientRect() }))
      .filter((x) => x.t === '发布' && x.rect.width > 0 && x.rect.height > 0)
      // Prefer the bottom-most publish button (action bar).
      .sort((a, b) => b.rect.top - a.rect.top)[0]?.b || null;
  if (!publishBtn) throw new Error('未找到发布按钮');
  // `simulateClick` already dispatches mousedown/mouseup/click. Calling `.click()` afterwards
  // submits twice and can open duplicate verification widgets or trigger SMS rate limits.
  simulateClick(publishBtn);

  // Some accounts show a blocking prompt when content is short: choose "保持图文发布".
  await retryUntil(
    async () => {
      const keep = findByExactText('保持图文发布') || findAnyElementContainingText('保持图文发布');
      if (!keep) throw new Error('short-content dialog not present');
      try {
        simulateClick(keep as HTMLElement);
      } catch {
        // ignore
      }
      try {
        (keep as HTMLElement).click();
      } catch {
        // ignore
      }
      return true;
    },
    { timeoutMs: 4000, intervalMs: 400 }
  ).catch(() => {
    // ignore if dialog not shown
  });

  const handleSecurityVerificationBestEffort = async (): Promise<void> => {
    const isSecurityDialogPresent = (): boolean => {
      const t = (document.body?.innerText || document.body?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!t) return false;
      return (
        t.includes('百度安全验证') ||
        t.includes('安全验证') ||
        t.includes('完成下方验证') ||
        t.includes('拖动左侧滑块') ||
        t.includes('扫码验证') ||
        t.includes('百度APP扫描') ||
        t.includes('二维码') ||
        t.includes('手机验证') ||
        t.includes('验证码已发送至你的手机') ||
        t.includes('验证方式选择') ||
        t.includes('去验证') ||
        t.includes('已完成验证')
      );
    };

    const firstSeen = await retryUntil(
      async () => {
        if (!isSecurityDialogPresent()) throw new Error('no security dialog');
        return true;
      },
      { timeoutMs: 10_000, intervalMs: 400 }
    ).catch(() => false);
    if (!firstSeen) return;

    await report({
      status: 'running',
      stage: 'submitPublish',
      userMessage: getMessage('v2MsgPublishBlockedBySecurityVerify')
    });

    const securityText = (document.body?.innerText || document.body?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const isPhoneVerification =
      /手机号?(?:验证|是否可用于验证)|验证码已发送至你的手机|请输入.{0,8}验证码/.test(
        securityText
      ) || !!document.querySelector('.mod-dialog-authwidget [class*="mobile"], .authwidget-dialog');
    currentStage = 'waitingUser';
    await report({
      status: 'waiting_user',
      stage: 'waitingUser',
      userMessage: getMessage('v2MsgPublishBlockedBySecurityVerify'),
      userSuggestion: isPhoneVerification
        ? '请在百家号完成手机号验证后点击继续；正文、三张图片和封面均已保留'
        : '请在百家号完成平台安全验证后点击继续；当前稿件已保留',
      devDetails: {
        message: isPhoneVerification
          ? '百家号要求手机号验证，正文、三张图片和封面已保留，未重复提交'
          : '百家号要求交互式安全验证，稿件已保留，自动化未尝试绕过',
        verificationType: isPhoneVerification ? 'phone' : 'interactive-security'
      }
    });
    throw new Error(
      isPhoneVerification
        ? 'waiting_user:baijiahao-phone-verification'
        : 'waiting_user:baijiahao-security-verification'
    );
  };

  await handleSecurityVerificationBestEffort();

  // Some confirmation dialogs use "确认"
  await new Promise((r) => setTimeout(r, 1200));
  const confirm = findByExactText('确认') || findAnyElementContainingText('确认');
  if (confirm) {
    try {
      confirm.click();
    } catch {
      // ignore
    }
  }

  // Some editors show a blocking modal on missing required fields.
  // The modal uses plain "确认" but may not be visible in our generic query; click it if present.
  await new Promise((r) => setTimeout(r, 800));
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"], .modal, .cheetah-modal, .ant-modal')
  );
  for (const modal of modals) {
    const t = (modal.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (!t.includes('确认')) continue;
    const okBtn =
      (modal.querySelector('button.bjh-btn-primary') as HTMLButtonElement | null) ||
      (Array.from(modal.querySelectorAll('button')).find((b) =>
        (b.textContent || '').includes('确认')
      ) as HTMLButtonElement | undefined) ||
      null;
    if (okBtn) {
      try {
        okBtn.click();
      } catch {
        // ignore
      }
    }
  }
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({
    status: 'running',
    stage: 'confirmSuccess',
    userMessage: getMessage('v2MsgConfirmingResult')
  });

  const okTexts = action === 'draft' ? ['已保存', '保存成功'] : ['发布成功', '已发布', '审核中'];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = document.body?.innerText || '';
    if (okTexts.some((t) => text.includes(t))) return;
    await new Promise((r) => setTimeout(r, 400));
  }

  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const clues = [
    '请选择内容分类',
    '请选择封面',
    '请先上传封面',
    '请输入摘要',
    '请完善摘要',
    '发布失败',
    '内容过短',
    '请先完成安全验证',
    '百度安全验证',
    '拖动左侧滑块',
    '扫码验证',
    '手机验证',
    '验证码已发送至你的手机',
    '确认',
    '去验证',
    '已完成验证',
    '审核未通过'
  ].filter((t) => bodyText.includes(t));
  const compactText = bodyText.slice(0, 300);
  throw new Error(
    `未检测到${action === 'draft' ? '存草稿' : '发布'}成功信号` +
      (clues.length ? `（线索：${clues.join(' / ')}）` : '') +
      (compactText ? `：${compactText}` : '')
  );
}

async function runEditorFlow(job: AnyJob): Promise<void> {
  await report({
    status: 'running',
    stage: 'openEntry',
    userMessage: getMessage('v2MsgEnteredBaijiahaoEditor')
  });

  await stageDetectLogin();
  await stageFillTitle(job.article.title);
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl || '');

  // Best-effort required fields (keep original without re-hosting)
  await stageEnsureNoCover();
  await stageEnsureAiDeclaration();
  await stageEnsureCategorySelected();
  await stageEnsureSummaryFilled(job);
  await stageEnsureEventSourceSelected();
  if (job.action === 'publish') {
    await stageEnsureCoverSelected();
  }
  if (currentStage === 'waitingUser') return;

  if (job.action === 'draft') {
    await stageSaveDraft();
    await stageConfirmSuccess('draft');
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgDraftSavedVerifyDone'),
      devDetails: summarizeVerifyDetails({ listUrl: LIST_URL, listVisible: true })
    });
    return;
  }

  await stageSubmitPublish();
  await stageConfirmSuccess('publish');

  await report({
    status: 'running',
    stage: 'confirmSuccess',
    userMessage: getMessage('v2MsgPublishTriggeredGoWorksListVerify'),
    devDetails: summarizeVerifyDetails({ listUrl: LIST_URL })
  });
  location.href = LIST_URL;
}

async function verifyFromList(job: AnyJob): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({
    status: 'running',
    stage: 'confirmSuccess',
    userMessage: getMessage('v2MsgVerifyFindNewArticleInWorksList')
  });

  const token = buildListSearchToken(job.article.title);
  // Prefer URL param search (more reliable than synthetic key events which may be ignored by frameworks).
  try {
    const u = new URL(location.href);
    const cur = u.searchParams.get('search') || '';
    if (token && cur !== token) {
      u.searchParams.set('search', token);
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgVerifySetListSearchKeyword', [token]),
        devDetails: summarizeVerifyDetails({ listUrl: u.toString() })
      });
      location.href = u.toString();
      return;
    }
  } catch {
    // ignore
  }

  // The list is rendered asynchronously and may jump routes; wait for anchors first.
  const listReady = await retryUntil(
    async () => {
      const hasPreview = document.querySelectorAll('a[href*="/builder/preview/"]').length > 0;
      const t = document.body?.innerText || '';
      const hasEmpty = t.includes('暂无数据') || t.includes('共0篇');
      if (!hasPreview && !hasEmpty) throw new Error('list not ready');
      return true;
    },
    { timeoutMs: 90_000, intervalMs: 1500 }
  ).catch(() => false);

  const tryFind = (): HTMLAnchorElement | null =>
    findPreviewLinkByTitleOrToken(job.article.title, token);

  if (listReady) {
    const direct = tryFind();
    if (direct?.href) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgVerifyFoundTitleOpeningDetail'),
        devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true })
      });
      location.href = direct.href;
      return;
    }

    // The article may be in other status tabs (e.g. 审核中 -> 待发布/已发布/草稿).
    const statuses = ['全部', '待发布', '草稿', '已发布', '未通过', '已撤回'];
    for (const st of statuses) {
      clickStatusTabBestEffort(st);
      await new Promise((r) => setTimeout(r, 1200));
      const found = tryFind();
      if (found?.href) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyFoundTitleInListOpeningDetail', [st]),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true })
        });
        location.href = found.href;
        return;
      }
    }
  }

  if (!listReady || !tryFind()) {
    const key = `bawei_v2_baijiahao_list_retry_${job.jobId}`;
    const n = Number(sessionStorage.getItem(key) || '0') + 1;
    sessionStorage.setItem(key, String(n));
    if (n <= 20) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgVerifyListNoTitleRefresh6s20', [String(n)]),
        devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false })
      });
      setTimeout(() => location.reload(), 6000);
      return;
    }

    sessionStorage.removeItem(key);
    await report({
      status: 'pending_review',
      stage: 'done',
      userMessage: getMessage('v2MsgVerifyFailedListStillNoTitleMaybeReviewOrFailed'),
      devDetails: summarizeVerifyDetails({
        listUrl: location.href,
        managementUrl: location.href,
        listVisible: false,
        reviewStatus: 'submitted_not_indexed'
      })
    });
    return;
  }

  sessionStorage.removeItem(`bawei_v2_baijiahao_list_retry_${job.jobId}`);

  const found = tryFind();
  if (found?.href) {
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgVerifyFoundTitleOpeningDetail'),
      devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true })
    });
    location.href = found.href;
    return;
  }

  throw new Error('验收失败：列表页匹配成功但未能提取详情链接');
}

async function verifyFromDetail(job: AnyJob): Promise<void> {
  const bodyText = normalizeLoose(document.body?.innerText || '');
  const rejectionReason = getChannelConfig(CHANNEL_ID).rejectedPatterns.find((pattern) =>
    new RegExp(pattern, 'i').test(bodyText)
  );
  if (rejectionReason) {
    await report({
      status: 'rejected',
      stage: 'done',
      userMessage: rejectionReason,
      devDetails: summarizeVerifyDetails({
        managementUrl: location.href,
        reviewStatus: 'rejected',
        rejectionReason
      })
    });
    return;
  }
  const sourceUrl = job.article.sourceUrl || '';
  const sourcePresent = sourceUrl ? pageContainsSourceUrl(sourceUrl) : false;
  const publicLink = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find(
    (link) => matchesChannelUrl(link.href, getChannelConfig(CHANNEL_ID).publicUrlPatterns)
  );
  const candidatePublicUrl = matchesChannelUrl(
    location.href,
    getChannelConfig(CHANNEL_ID).publicUrlPatterns
  )
    ? location.href
    : publicLink?.href || '';
  await report({
    status: job.action === 'draft' ? 'success' : 'pending_review',
    stage: 'done',
    userMessage: getMessage('v2MsgSuccessDetectedStartVerify'),
    devDetails: summarizeVerifyDetails({
      publishedUrl: candidatePublicUrl || location.href,
      ...(candidatePublicUrl ? { candidatePublicUrl } : {}),
      managementUrl: location.href,
      reviewStatus: candidatePublicUrl ? 'candidate_public_url' : 'submitted_or_preview',
      sourceUrlPresent: sourcePresent
    })
  });
}

async function bootstrap(): Promise<void> {
  if (!shouldRunOnThisPage()) return;
  try {
    const ctx = await getContextFromBackground();
    if (ctx.channelId !== CHANNEL_ID) return;
    currentJob = ctx.job;
    if (currentJob.stoppedAt) return;

    if (isHomePage() && !isEditorPage() && !isListPage()) {
      await stageOpenEditor();
      return;
    }

    if (isEditorPage()) {
      await runEditorFlow(currentJob);
      return;
    }

    if (isListPage()) {
      await verifyFromList(currentJob);
      return;
    }

    // Any other page on baijiahao.baidu.com may be a preview/detail page.
    await verifyFromDetail(currentJob);
  } catch (error) {
    if (error instanceof Error && error.message === '__BAWEI_V2_STOPPED__') return;
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith('waiting_user:')) return;
    await report({
      status: 'failed',
      stage: currentStage,
      userMessage: getMessage('v2MsgFailed'),
      userSuggestion: getMessage('v2SugCheckLoginOrDomThenRetry'),
      devDetails: { message: error instanceof Error ? error.message : String(error) }
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === V2_PROBE_LOGIN_STATE && message.channelId === CHANNEL_ID) {
    sendResponse({ success: true, result: { ...getCurrentLoginState(), url: location.href } });
    return;
  }
  if (!currentJob) return;
  if (message?.type === V2_REQUEST_STOP && message.jobId === currentJob.jobId) {
    stopRequested = true;
    return;
  }
  if (
    message?.type === V2_REQUEST_RETRY &&
    message.jobId === currentJob.jobId &&
    message.channelId === CHANNEL_ID
  ) {
    bootstrap();
  }
  if (
    message?.type === V2_REQUEST_CONTINUE &&
    message.jobId === currentJob.jobId &&
    message.channelId === CHANNEL_ID
  ) {
    bootstrap();
  }
});

bootstrap();
