/**
 * Toutiao Publisher Content Script (V2)
 *
 * Entry: https://mp.toutiao.com/profile_v4/graphic/publish
 * List:  https://mp.toutiao.com/profile_v4/manage/content/all
 * Detail: https://www.toutiao.com/item/<id>/
 *
 * Notes:
 * - Editor is ProseMirror. We write plain text and append source URL at the end.
 * - Publish flow may be blocked by assistant drawers/popovers; we try to close them.
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */

const CHANNEL_ID: ChannelId = 'toutiao';

type AnyJob = Pick<PublishJob, 'jobId' | 'action' | 'article' | 'stoppedAt'>;

let currentJob: AnyJob | null = null;
let currentStage: ChannelRuntimeState['stage'] = 'init';
let stopRequested = false;

(globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }).__BAWEI_V2_IS_STOP_REQUESTED = () => stopRequested;

function getMessage(key: string, substitutions?: string[]): string {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

const EDITOR_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish';
const LIST_URL = 'https://mp.toutiao.com/profile_v4/manage/content/all';

function escapePlainText(value: string): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replaceAll('\u0000', '')
    .trim();
}

function htmlToPlainTextSafe(html: string): string {
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return escapePlainText(tmp.textContent || tmp.innerText || '');
  } catch {
    return '';
  }
}

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plainTextToHtml(plain: string): string {
  const lines = String(plain || '').split('\n');
  const parts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) parts.push('<p><br/></p>');
    else parts.push(`<p>${escapeHtml(line)}</p>`);
  }
  return parts.join('');
}

function ensureMinLengthText(text: string, minLen: number, sourceUrl: string): string {
  let out = (text || '').trim();
  if (!out) out = '（以下为自动发布内容）';
  if (sourceUrl && !out.includes(sourceUrl)) out += `\n\n原文链接：${sourceUrl}`;
  if (out.length >= minLen) return out;
  let pad = '\n\n（内容来自原文链接，更多细节请查看原文。）';
  if (sourceUrl && !out.includes(sourceUrl) && !pad.includes(sourceUrl)) pad += `\n原文链接：${sourceUrl}`;
  while ((out + pad).length < minLen + 20) pad += '。';
  return `${out}${pad}`;
}

function shouldRunOnThisPage(): boolean {
  if (location.hostname === 'mp.toutiao.com') return true;
  if (location.hostname === 'www.toutiao.com' && location.pathname.startsWith('/item/')) return true;
  return false;
}

function isEditorPage(): boolean {
  return location.hostname === 'mp.toutiao.com' && location.pathname.startsWith('/profile_v4/graphic/publish');
}

function isListPage(): boolean {
  return location.hostname === 'mp.toutiao.com' && location.pathname.startsWith('/profile_v4/manage/content/all');
}

function isDetailPage(): boolean {
  return location.hostname === 'www.toutiao.com' && location.pathname.startsWith('/item/');
}

async function report(patch: Partial<ChannelRuntimeState>): Promise<void> {
  if (!currentJob) return;
  await chrome.runtime.sendMessage({
    type: V2_CHANNEL_UPDATE,
    jobId: currentJob.jobId,
    channelId: CHANNEL_ID,
    patch,
  });
}

async function getContextFromBackground(): Promise<{ job: AnyJob; channelId: string }> {
  const res = await chrome.runtime.sendMessage({ type: V2_GET_CONTEXT });
  if (!res?.success) throw new Error(res?.error || 'get context failed');
  return { job: res.job, channelId: res.channelId };
}

function findAnyButtonByText(text: string): HTMLButtonElement | null {
  const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  return btns.find((b) => (b.textContent || '').replace(/\s+/g, ' ').trim() === text) || null;
}

function findClickableByExactText(text: string): HTMLElement | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"],[role="menuitem"],a,div,span'));
  return nodes.find((n) => norm(n.textContent || '') === text) || null;
}

function buildLooseToken(title: string): string {
  const normalized = normalizeForSearch(title);
  const cleaned = normalized.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const candidate = cleaned.length >= 4 ? cleaned : normalized;
  return titleToken(candidate);
}

function closeOverlaysBestEffort(): void {
  // NOTE: 头条号编辑页会弹出各种 Drawer/Popover。这里仅关闭“阻挡点击”的遮罩，
  // 不要无脑按 Escape（会把“发布确认/广告提示”等关键弹窗关掉，导致只触发 save=0 而不提交 save=1）。
  try {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('button,div,span,a')).filter((n) => {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      return t === '我知道了' || t === '以后再说' || t === '关闭' || t === '×';
    });
    for (const n of candidates.slice(0, 3)) {
      try {
        (n as HTMLElement).click();
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // Toutiao editor often shows an AI assistant drawer that blocks pointer events.
  try {
    const mask =
      (document.querySelector<HTMLElement>('.byte-drawer-mask') as HTMLElement | null) ||
      (document.querySelector<HTMLElement>('.byte-modal-mask') as HTMLElement | null) ||
      null;
    if (mask) mask.click();

    const close =
      (document.querySelector<HTMLElement>('.byte-drawer-close') as HTMLElement | null) ||
      (document.querySelector<HTMLElement>('.byte-modal-close') as HTMLElement | null) ||
      null;
    if (close) close.click();
  } catch {
    // ignore
  }
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle', userMessage: getMessage('v2MsgFillingTitle') });

  closeOverlaysBestEffort();

  const input = (await waitForElement<HTMLTextAreaElement>('textarea[placeholder*="文章标题"]', 60000)) as HTMLTextAreaElement;
  simulateFocus(input);
  const t = title.slice(0, 30);
  simulateType(input, t);
  const v = (input.value || '').trim();
  if (!v || v.length < 2) throw new Error('标题填充失败：输入框未写入内容');
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugToutiaoNoSourceFieldAppend'),
  });

  const plain = ensureMinLengthText(htmlToPlainTextSafe(contentHtml), 180, sourceUrl);

  const editor = await retryUntil(
    async () => {
      const el =
        (document.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]') as HTMLElement | null) ||
        (document.querySelector<HTMLElement>('.ProseMirror') as HTMLElement | null) ||
        (findContentEditor(document) as HTMLElement | null) ||
        null;
      if (!el) throw new Error('editor not ready');
      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 80) throw new Error('editor not visible');
      return el;
    },
    { timeoutMs: 60_000, intervalMs: 800 }
  );

  closeOverlaysBestEffort();
  simulateClick(editor);
  simulateFocus(editor);

  try {
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
  } catch {
    // ignore
  }
  const html = plainTextToHtml(plain);
  // NOTE: avoid navigator.clipboard in this page (can hang waiting permission). Prefer execCommand + innerText.
  let wrote = false;
  try {
    wrote = document.execCommand('insertText', false, plain);
  } catch {
    // ignore
  }
  if (!wrote) {
    try {
      wrote = document.execCommand('insertHTML', false, html);
    } catch {
      // ignore
    }
  }
  if (!wrote) {
    try {
      editor.innerText = plain;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: plain, inputType: 'insertText' }));
      editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: plain }));
    } catch {
      // ignore
    }
  }

  await new Promise((r) => setTimeout(r, 900));
  const textLen = (editor.textContent || '').replace(/\s+/g, '').length;
  const ok = (editor.textContent || '').includes('原文链接') || pageContainsSourceUrl(sourceUrl) || pageContainsText('原文链接');
  if (!ok || textLen < 30) throw new Error('正文填充失败：未检测到内容写入（可能被编辑器拦截）');
}

async function stageEnsureNoCover(): Promise<void> {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const label = await retryUntil(
    async () => {
      const group =
        (document.querySelector<HTMLElement>('.article-cover-radio-group') as HTMLElement | null) ||
        (document.querySelector<HTMLElement>('.article-cover .byte-radio-group') as HTMLElement | null) ||
        null;
      const scope = group || document;
      const labels = Array.from(scope.querySelectorAll<HTMLElement>('label.byte-radio'));
      const hit =
        labels.find((l) => normalize(l.textContent || '') === '无封面') ||
        labels.find((l) => normalize(l.textContent || '').includes('无封面')) ||
        null;
      if (!hit) throw new Error('no-cover option not ready');
      return hit;
    },
    { timeoutMs: 30_000, intervalMs: 600 }
  );

  const input = label.querySelector<HTMLInputElement>('input[type="radio"]');
  if (input?.checked) return;

  closeOverlaysBestEffort();
  // ByteDesign 的 Radio 有时依赖更“真实”的交互事件；优先点 inner/input，避免仅改动 checked 而未触发状态更新。
  const inner = label.querySelector<HTMLElement>('.byte-radio-inner') || label;
  try {
    simulateClick(inner);
  } catch {
    // ignore
  }
  try {
    inner.click();
  } catch {
    // ignore
  }
  if (input) {
    try {
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    } catch {
      // ignore
    }
  }

  await retryUntil(
    async () => {
      const after = label.querySelector<HTMLInputElement>('input[type="radio"]');
      if (after?.checked) return true;
      throw new Error('no-cover not selected');
    },
    { timeoutMs: 10_000, intervalMs: 400 }
  );

  // Give React state a moment to propagate before triggering editor auto-save.
  await new Promise((r) => setTimeout(r, 800));
}

async function stageEnsureNoAds(): Promise<void> {
  // 保持默认广告选项，避免触发“不投放广告”的二次确认弹窗阻塞发布流程。
}

async function stageEnsureStatementSelected(): Promise<void> {
  // 头条号“作品声明”是一组 checkbox。之前用“任意 input.checked”判断会被“发布得更多收益”等
  // 无关选项误伤，导致声明未勾选，最终发布接口只返回 7050 保存失败。
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

  await retryUntil(
    async () => {
      const marker = findAnyElementContainingText('作品声明');
      if (!marker) throw new Error('statement marker not ready');
      return true;
    },
    { timeoutMs: 30_000, intervalMs: 600 }
  );

  const optionTexts = ['取材网络', '引用站内', '个人观点', '引用AI', '虚构演绎', '投资观点', '健康医疗'];
  const optionLabels = optionTexts
    .map((t) => {
      const labels = Array.from(document.querySelectorAll<HTMLElement>('label'));
      return (
        labels.find((l) => normalize(l.textContent || '') === t) ||
        labels.find((l) => normalize(l.textContent || '').includes(t)) ||
        null
      );
    })
    .filter(Boolean) as HTMLElement[];

  const optionInputs = optionLabels
    .map((l) => l.querySelector<HTMLInputElement>('input[type="checkbox"],input[type="radio"]'))
    .filter((i): i is HTMLInputElement => !!i);

  // 若已经有任意“作品声明”选项被勾选，直接返回
  if (optionInputs.some((i) => i.checked)) return;

  // 优先勾选“取材网络”（更通用）
  const preferred =
    optionLabels.find((l) => normalize(l.textContent || '').includes('取材网络')) || optionLabels[0] || null;
  if (!preferred) throw new Error('未找到作品声明选项（取材网络等）');

  const input = preferred.querySelector<HTMLInputElement>('input[type="checkbox"],input[type="radio"]');
  if (input?.checked) return;

  closeOverlaysBestEffort();
  try {
    preferred.scrollIntoView({ block: 'center' });
  } catch {
    // ignore
  }
  try {
    preferred.click();
  } catch {
    // ignore
  }
  await new Promise((r) => setTimeout(r, 300));
  const after = preferred.querySelector<HTMLInputElement>('input[type="checkbox"],input[type="radio"]') || input;
  if (after && !after.checked) {
    try {
      after.click();
    } catch {
      // ignore
    }
  }

  await retryUntil(
    async () => {
      const ok = optionInputs.some((i) => i.checked) || !!after?.checked;
      if (ok) return true;
      throw new Error('statement not selected');
    },
    { timeoutMs: 8000, intervalMs: 400 }
  );
}

async function stageDisableToutiaoFirstIfAny(): Promise<void> {
  // Some accounts might have "头条首发" checked by default and may block publishing if not eligible.
  const node = findAnyElementContainingText('头条首发');
  if (!node) return;
  const wrap = (node.closest('label') as HTMLElement | null) || (node.parentElement as HTMLElement | null);
  const input = (wrap?.querySelector('input[type="checkbox"]') as HTMLInputElement | null) || null;
  if (!input) return;
  if (!input.checked) return;
  try {
    simulateClick(input as unknown as HTMLElement);
  } catch {
    try {
      input.click();
    } catch {
      // ignore
    }
  }
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSavingDraft') });

  // There is usually an auto-sync, but try to trigger draft save by focusing out.
  closeOverlaysBestEffort();
  const input = document.querySelector<HTMLTextAreaElement>('textarea[placeholder*="文章标题"]');
  input?.blur();
  await new Promise((r) => setTimeout(r, 1500));
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  const coverChecked =
    (document.querySelector<HTMLInputElement>('.article-cover-radio-group input[type="radio"]:checked')?.getAttribute('value') ||
      '') as string;
  await report({
    status: 'running',
    stage: 'submitPublish',
    userMessage: getMessage('v2MsgPublishing'),
    devDetails: { coverChecked },
  });

  closeOverlaysBestEffort();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const pickVisible = (text: string): HTMLButtonElement | null => {
    const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
    for (const b of btns) {
      if (norm(b.textContent || '') !== text) continue;
      const rect = b.getBoundingClientRect();
      const style = window.getComputedStyle(b);
      if (rect.width < 2 || rect.height < 2) continue;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      return b;
    }
    return null;
  };
  const btn =
    pickVisible('预览并发布') ||
    findAnyButtonByText('预览并发布') ||
    (findClickableByExactText('预览并发布') as HTMLButtonElement | null) ||
    pickVisible('立即发布') ||
    findAnyButtonByText('立即发布') ||
    (findClickableByExactText('立即发布') as HTMLButtonElement | null) ||
    pickVisible('发布') ||
    findAnyButtonByText('发布') ||
    (findClickableByExactText('发布') as HTMLButtonElement | null);
  if (!btn) throw new Error('未找到发布按钮（预览并发布/立即发布/发布）');
  const isDisabled =
    (btn instanceof HTMLButtonElement && btn.disabled) ||
    (btn.getAttribute('aria-disabled') || '').toLowerCase() === 'true' ||
    btn.hasAttribute('disabled');
  if (isDisabled) throw new Error('发布按钮不可用：可能标题/正文未正确写入，或存在必填项未满足');
  // 尽量点“可见”的发布按钮，避免命中隐藏节点导致无效点击
  try {
    btn.scrollIntoView({ block: 'center' });
  } catch {
    // ignore
  }
  try {
    btn.click();
  } catch {
    try {
      simulateClick(btn as unknown as HTMLElement);
    } catch {
      // ignore
    }
  }

  // Some dialogs require one or more confirm clicks (e.g. "不投放广告" warning).
  const deadline = Date.now() + 28_000;
  console.log('[V2][toutiao] clicked publish, waiting for confirm dialogs…');
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 900));
    // 这里不要调用 closeOverlaysBestEffort()（会把确认弹窗关掉），只在必要时轻量点遮罩
    try {
      const mask =
        (document.querySelector<HTMLElement>('.byte-drawer-mask') as HTMLElement | null) ||
        (document.querySelector<HTMLElement>('.byte-modal-mask') as HTMLElement | null) ||
        null;
      // 注意：byte-modal-mask 可能就是确认弹窗的遮罩，点它会关闭弹窗；只点 drawer-mask
      if (mask && mask.classList.contains('byte-drawer-mask')) mask.click();
    } catch {
      // ignore
    }

    const confirm = pickVisible('确定') || pickVisible('确认发布') || pickVisible('确认') || pickVisible('发布');
    if (confirm) {
      const disabled =
        (confirm instanceof HTMLButtonElement && confirm.disabled) ||
        (confirm.getAttribute('aria-disabled') || '').toLowerCase() === 'true' ||
        confirm.hasAttribute('disabled');
      if (!disabled) {
        console.log('[V2][toutiao] click confirm:', norm(confirm.textContent || ''));
        try {
          confirm.click();
        } catch {
          try {
            simulateClick(confirm as unknown as HTMLElement);
          } catch {
            // ignore
          }
        }
      }
    }

    const text = document.body?.innerText || '';
    if (text.includes('发布成功') || text.includes('已发布') || text.includes('审核中')) break;
  }
}

async function stageConfirmSuccess(): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingPublishResult') });

  // If publish API returns "保存失败" / "发布失败", we should stop and let user handle required fields / risk controls.
  const failDeadline = Date.now() + 6000;
  while (Date.now() < failDeadline) {
    const text = document.body?.innerText || '';
    const html = document.documentElement?.outerHTML || '';
    if (text.includes('保存失败') || text.includes('发布失败') || html.includes('保存失败') || html.includes('发布失败')) {
      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v2MsgToutiaoSavePublishFailedSaveFailed'),
        userSuggestion: getMessage('v2SugToutiaoHandleRequiredFieldsThenContinueVerify'),
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Wait for any success hint or navigation; then fall back to list verification.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const text = document.body?.innerText || '';
    if (text.includes('发布成功') || text.includes('已发布') || text.includes('审核中')) return;
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function runEditorFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredToutiaoEditor') });

  // Best-effort required fields (avoid image upload)
  await stageEnsureNoCover();
  await stageEnsureNoAds();
  await stageEnsureStatementSelected();
  await stageDisableToutiaoFirstIfAny();

  // Fill title/content after required fields, so that editor auto-save isn't blocked by missing selections.
  await stageFillTitle(job.article.title);

  // Fill content after required fields to reduce the chance that auto-save is blocked by missing selections.
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl);

  if (job.action === 'draft') {
    await stageSaveDraft();
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgDraftSavedVerifyDone'),
      devDetails: summarizeVerifyDetails({ listUrl: LIST_URL, listVisible: true }),
    });
    return;
  }

  await stageSubmitPublish();
  await stageConfirmSuccess();

  await report({
    status: 'running',
    stage: 'confirmSuccess',
    userMessage: getMessage('v2MsgPublishTriggeredGoWorksListVerify'),
    devDetails: summarizeVerifyDetails({ listUrl: LIST_URL }),
  });
  location.href = LIST_URL;
}

async function verifyFromList(job: AnyJob): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyFindNewArticleInWorksList') });

  // Wait for list content to render (avoid refreshing too early and never seeing the row).
  await retryUntil(
    async () => {
      const hasSearch = !!document.querySelector('input[placeholder*="搜索关键词"], input[placeholder*="搜索"]');
      const hasItemLink = document.querySelectorAll('a[href*="toutiao.com/item"]').length > 0;
      const t = document.body?.innerText || '';
      const hasCount = t.includes('共') && t.includes('条内容');
      if (hasSearch || hasItemLink || hasCount) return true;
      throw new Error('list not ready');
    },
    { timeoutMs: 30_000, intervalMs: 800 }
  ).catch(() => {
    // ignore
  });

  const token = buildLooseToken(job.article.title);
  const hasTitle =
    pageContainsTitle(job.article.title) || (token.length >= 6 && pageContainsText(token)) || pageContainsText(token.slice(0, 8));

  // Try using built-in keyword search to reduce noise and make matching stable.
  const searchInput = document.querySelector<HTMLInputElement>(
    'input[placeholder*="搜索关键词"], input[placeholder*="搜索"]'
  );
  if (searchInput && token) {
    const cur = (searchInput.value || '').trim();
    if (cur !== token) {
      try {
        simulateFocus(searchInput);
        searchInput.value = token;
        searchInput.dispatchEvent(
          new InputEvent('input', { bubbles: true, cancelable: true, data: token, inputType: 'insertText' })
        );
        searchInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        searchInput.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' })
        );
        searchInput.dispatchEvent(
          new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' })
        );
      } catch {
        // ignore
      }
      // Give the list time to re-render with keyword filter applied.
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  if (!(hasTitle || pageContainsTitle(job.article.title) || (token.length >= 6 && pageContainsText(token)))) {
    const key = `bawei_v2_toutiao_list_retry_${job.jobId}`;
    const n = Number(sessionStorage.getItem(key) || '0') + 1;
    sessionStorage.setItem(key, String(n));
    if (n <= 12) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgVerifyListNoTitleRefresh8s12', [String(n)]),
        devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
      });
      setTimeout(() => location.reload(), 8000);
      return;
    }

    sessionStorage.removeItem(key);
    await report({
      status: 'waiting_user',
      stage: 'waitingUser',
      userMessage: getMessage('v2MsgVerifyFailedListStillNoTitleMaybeReviewOrFailed'),
      userSuggestion: getMessage('v2SugConfirmPublishedNoRequiredRefreshThenContinue'),
      devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
    });
    return;
  }

  sessionStorage.removeItem(`bawei_v2_toutiao_list_retry_${job.jobId}`);

  const findItemLinkByToken = (tok: string): HTMLAnchorElement | null => {
    const wantRaw = normalizeForSearch(tok);
    const want = wantRaw.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    if (!wantRaw) return null;
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    for (const a of links) {
      const href = a.href || a.getAttribute('href') || '';
      if (!href) continue;
      if (!href.includes('/item/')) continue;
      const txtRaw = normalizeForSearch(a.textContent || '');
      const txt = txtRaw.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
      if (want && txt.includes(want)) return a;
      if (wantRaw && txtRaw.includes(wantRaw)) return a;
    }
    return null;
  };

  const link =
    findLinkByText(job.article.title) ||
    findItemLinkByToken(job.article.title) ||
    findItemLinkByToken(token) ||
    findAnchorContainingText(job.article.title) ||
    findAnchorContainingText(token) ||
    (findAnyElementContainingText(job.article.title)?.closest('a') as HTMLAnchorElement | null) ||
    (findAnyElementContainingText(token)?.closest('a') as HTMLAnchorElement | null);
  const href = link?.href || '';
  if (href) {
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgVerifyPassedListNewArticlePublished'),
      devDetails: summarizeVerifyDetails({ publishedUrl: href, listUrl: location.href, listVisible: true }),
    });
    return;
  }

  await report({
    status: 'waiting_user',
    stage: 'waitingUser',
    userMessage: getMessage('v2MsgVerifyBlockedNoDetailLink'),
    userSuggestion: getMessage('v2SugOpenDetailManuallyThenWaitVerify'),
    devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
  });
}

async function verifyFromDetail(job: AnyJob): Promise<void> {
  const ok = pageContainsSourceUrl(job.article.sourceUrl);
  await report({
    status: ok ? 'success' : 'waiting_user',
    stage: ok ? 'done' : 'waitingUser',
    userMessage: ok ? getMessage('v2MsgVerifyPassedDetailHasSourceLink') : getMessage('v2MsgVerifyFailedDetailNoSourceLink'),
    userSuggestion: ok ? undefined : getMessage('v2SugCheckSourceLinkAtEndThenContinue'),
    devDetails: summarizeVerifyDetails({ publishedUrl: location.href, sourceUrlPresent: ok }),
  });
}

async function bootstrap(): Promise<void> {
  if (!shouldRunOnThisPage()) return;
  try {
    const ctx = await getContextFromBackground();
    if (ctx.channelId !== CHANNEL_ID) return;
    currentJob = ctx.job;
    if (currentJob.stoppedAt) return;

    if (isEditorPage()) {
      await runEditorFlow(currentJob);
      return;
    }

    if (isListPage()) {
      await verifyFromList(currentJob);
      return;
    }

    if (isDetailPage()) {
      await verifyFromDetail(currentJob);
      return;
    }

    // Unexpected page: jump back to editor
    await report({
      status: 'running',
      stage: 'openEntry',
      userMessage: getMessage('v2MsgOutOfScopeReturningToEditor'),
      devDetails: summarizeVerifyDetails({ listUrl: EDITOR_URL }),
    });
    location.href = EDITOR_URL;
  } catch (error) {
    if (error instanceof Error && error.message === '__BAWEI_V2_STOPPED__') return;
    await report({
      status: 'failed',
      stage: currentStage,
      userMessage: getMessage('v2MsgFailed'),
      userSuggestion: getMessage('v2SugCheckLoginOrDomThenRetry'),
      devDetails: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!currentJob) return;
  if (message?.type === V2_REQUEST_STOP && message.jobId === currentJob.jobId) {
    stopRequested = true;
    return;
  }
  if (message?.type === V2_REQUEST_RETRY && message.jobId === currentJob.jobId && message.channelId === CHANNEL_ID) {
    bootstrap();
  }
  if (message?.type === V2_REQUEST_CONTINUE && message.jobId === currentJob.jobId && message.channelId === CHANNEL_ID) {
    bootstrap();
  }
});

bootstrap();
