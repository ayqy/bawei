/**
 * Tencent Cloud Developer Community Publisher Content Script (V2)
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */

const CHANNEL_ID: ChannelId = 'tencent-cloud-dev';

type AnyJob = Pick<PublishJob, 'jobId' | 'action' | 'article' | 'stoppedAt'>;

let currentJob: AnyJob | null = null;
let currentStage: ChannelRuntimeState['stage'] = 'init';
let publishProbeResourceIndex: number | null = null;
let stopRequested = false;

(globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }).__BAWEI_V2_IS_STOP_REQUESTED = () => stopRequested;

function getMessage(key: string, substitutions?: string[]): string {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

function tokenForSearch(title: string): string {
  return titleToken(title);
}

function getProbeKey(jobId: string): string {
  return `bawei_v2_tencent_probe_index_${jobId}`;
}

function getProbeActiveKey(jobId: string): string {
  return `bawei_v2_tencent_probe_active_${jobId}`;
}

function getListUrlKey(jobId: string): string {
  return `bawei_v2_tencent_list_url_${jobId}`;
}

function getListRetryKey(jobId: string): string {
  return `bawei_v2_tencent_list_retry_${jobId}`;
}

function setSessionValue(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function getSessionValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeSessionValue(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function withSourceUrlAppended(contentHtml: string, sourceUrl: string): string {
  const safe = escapeAttr(sourceUrl);
  return `${contentHtml}\n<p><br/></p><p>原文链接：<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a></p>`;
}

function htmlToPlainTextSafe(html: string): string {
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
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

function getTencentEditable(): HTMLElement | null {
  return (
    (document.querySelector<HTMLElement>('div.public-DraftEditor-content[contenteditable="true"]') as HTMLElement | null) ||
    (document.querySelector<HTMLElement>('div[role="textbox"][contenteditable="true"]') as HTMLElement | null) ||
    null
  );
}

function getTextLen(node: HTMLElement): number {
  return ((node.innerText || node.textContent || '').trim() || '').length;
}

function hasArticleActionSince(before: number | null, action: string): boolean {
  if (before == null) return false;
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceEntry[];
    const recent = entries.slice(Math.max(0, before));
    return recent.some((e) => {
      const name = String(e?.name || '');
      if (!name.includes('article?action=')) return false;
      const m = name.match(/[?&]action=([^&]+)/);
      return m?.[1] === action;
    });
  } catch {
    return false;
  }
}

function shouldRunOnThisPage(): boolean {
  if (location.hostname !== 'cloud.tencent.com') return false;
  if (location.pathname.startsWith('/developer/article/write')) return true;
  if (location.pathname.startsWith('/developer/creator/article')) return true;
  if (location.pathname.startsWith('/developer/article/')) return true;
  return false;
}

function isEditorPage(): boolean {
  return location.hostname === 'cloud.tencent.com' && location.pathname.startsWith('/developer/article/write');
}

function isListPage(): boolean {
  return location.hostname === 'cloud.tencent.com' && location.pathname.startsWith('/developer/creator/article');
}

function isDetailPage(): boolean {
  return (
    location.hostname === 'cloud.tencent.com' &&
    location.pathname.startsWith('/developer/article/') &&
    !location.pathname.startsWith('/developer/article/write')
  );
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

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle' });
  const input = (await waitForElement('input[placeholder*="标题"], textarea[placeholder*="标题"]', 15000)) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  simulateFocus(input);
  simulateType(input, title);
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugTencentNoSourceUrlFieldAppend'),
  });

  const html = withSourceUrlAppended(contentHtml, sourceUrl);
  const plain = ensureMinLengthText(htmlToPlainTextSafe(html), 160, sourceUrl);
  const minLen = 140;

  // 兼容新版编辑器（contenteditable）与 Markdown 模式（textarea）
  const editable = getTencentEditable();
  const editor = editable || findContentEditor(document);
  let target: HTMLElement | null = null;
  if (editor) {
    if ((editor as HTMLElement).getAttribute('contenteditable') === 'true') {
      target = editor as HTMLElement;
    } else {
      target = ((editor as HTMLElement).querySelector('[contenteditable="true"]') as HTMLElement | null) || null;
    }
  }

  if (target) {
    simulateFocus(target);
    try {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    } catch {
      // ignore
    }

    // 腾讯云会严格校验字数（>=140），且 DraftJS 对 insertHTML 兼容性不稳定；
    // 这里强制用纯文本写入，确保发布接口会真正触发。
    try {
      document.execCommand('insertText', false, plain);
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 300));

    let len = getTextLen(target);

    await report({
      userMessage: getMessage('v2MsgTencentContentWrittenLenNeedMin', [String(len), String(minLen)]),
      userSuggestion: len < minLen ? getMessage('v2SugContentTooShortMin140AlreadyAutoPadded') : undefined,
    });
  } else {
    const textarea = (await waitForElement('textarea', 15000)) as HTMLTextAreaElement;
    simulateFocus(textarea);
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    // Markdown 模式：尽量写入纯文本（避免 HTML 被当作字面量）
    textarea.value = plain || html;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  await report({
    userMessage: getMessage('v2MsgAppendedSourceLinkKeepOriginal'),
    userSuggestion: getMessage('v2SugAdjustFormatAtEnd'),
  });
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSavingDraft') });
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('保存草稿'));
  if (!btn) throw new Error('未找到保存草稿按钮');
  (btn as HTMLButtonElement).click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgTryingToPublish') });
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '发布');
  if (!btn) throw new Error('未找到发布按钮');
  (btn as HTMLButtonElement).click();

  // 发布弹窗：选择“原创”、添加至少一个标签，然后“确认发布”
  const confirm = await retryUntil(
    async () => {
      const c = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent || '').trim() === '确认发布');
      if (!c) throw new Error('confirm not ready');
      return c;
    },
    { timeoutMs: 15000, intervalMs: 400 }
  );

  // 选择“原创”（不选转载）
  try {
    const original = Array.from(document.querySelectorAll<HTMLElement>('label,span,div')).find((n) => (n.textContent || '').trim() === '原创');
    if (original) {
      simulateClick((original.closest('label') as HTMLElement | null) || (original as HTMLElement));
    }
  } catch {
    // ignore
  }

  // 添加一个标签（必填）
  try {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input.com-2-tag-input'));
    const tagInput = inputs[0] || null;
    if (tagInput) {
      simulateFocus(tagInput);
      simulateType(tagInput, '前端');
      await new Promise((r) => setTimeout(r, 600));
      const pick = Array.from(document.querySelectorAll<HTMLElement>('li,div,span,a')).find((n) => (n.textContent || '').trim() === '前端');
      if (pick) {
        simulateClick(pick);
      } else {
        // 兜底：部分实现需要 Enter 才会将输入内容转为标签
        tagInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
        tagInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
      }
    }
  } catch {
    // ignore
  }

  // 封面（部分账号/站点策略为必填）：自动用扩展 icon 作为占位封面
  try {
    const coverInput = document.querySelector<HTMLInputElement>('input[type="file"][name="article-cover-image"]');
    if (coverInput && (!coverInput.files || coverInput.files.length === 0)) {
      const url = chrome.runtime.getURL('icons/icon-128.png');
      const res = await fetch(url);
      const blob = await res.blob();
      const file = new File([blob], 'cover.png', { type: blob.type || 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      coverInput.files = dt.files;
      coverInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 800));
    }
  } catch {
    // ignore
  }

  // 腾讯云校验：正文不少于 140 字；若不足则自动补足（避免确认发布后被拦截成草稿）
  try {
    const editable = getTencentEditable();
    const text = ((editable?.innerText || editable?.textContent || '').trim() || '') as string;
    const sourceUrl = currentJob?.article?.sourceUrl || '';
    if (editable && text.length < 140) {
      // 如果前一步富文本写入失败，直接重写为一段足够长的纯文本，保证前端校验与后端发布都能通过
      const html = withSourceUrlAppended(currentJob?.article?.contentHtml || '', sourceUrl);
      const plain = ensureMinLengthText(htmlToPlainTextSafe(html), 160, sourceUrl);
      simulateFocus(editable);
      try {
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      } catch {
        // ignore
      }
      try {
        document.execCommand('insertText', false, plain);
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
    // ignore
  }

  // 记录资源列表基线：后续在 confirmSuccess 阶段用来判断是否真正触发 CreateArticle
  try {
    publishProbeResourceIndex = performance.getEntriesByType('resource').length;
  } catch {
    publishProbeResourceIndex = null;
  }

  (confirm as HTMLButtonElement).click();
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  // 发布成功的 toast 文案在腾讯云站点上不稳定，而且页面本身也可能包含“已发布”等文案；
  // 为避免误判（导致提前跳转、只生成草稿不真正发布），publish 仅以 CreateArticle 请求为准。
  const okTexts = action === 'draft' ? ['草稿', '保存成功', '已保存'] : [];

  const deadline = Date.now() + (action === 'publish' ? 60000 : 20000);
  while (Date.now() < deadline) {
    const text = document.body?.innerText || '';
    // 真正发布：必须触发 CreateArticle（否则可能只是保存草稿/前端校验拦截）
    if (action === 'publish' && hasArticleActionSince(publishProbeResourceIndex, 'CreateArticle')) {
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgTencentCreateArticleDetectedStartVerify') });
      return;
    }

    if (okTexts.length && okTexts.some((t) => text.includes(t))) {
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgSuccessDetectedStartVerify') });
      return;
    }

    // 若确认发布后被拦截（常见：正文不足 140 字），自动补足并再次点击确认发布
    if (action === 'publish' && text.includes('文章内容') && text.includes('140') && (text.includes('不能少于') || text.includes('不少于'))) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgContentTooShortAutoPadAndRepublish'),
      });
      try {
        const editable = getTencentEditable();
        if (editable) {
          const cur = ((editable.innerText || editable.textContent || '').trim() || '') as string;
          if (cur.length < 140) {
            const sourceUrl = currentJob?.article?.sourceUrl || '';
            const html = withSourceUrlAppended(currentJob?.article?.contentHtml || '', sourceUrl);
            const plain = ensureMinLengthText(htmlToPlainTextSafe(html), 160, sourceUrl);
            simulateFocus(editable);
            try {
              document.execCommand('selectAll', false);
              document.execCommand('delete', false);
            } catch {
              // ignore
            }
            try {
              document.execCommand('insertText', false, plain);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }

      try {
        const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
          (b) => (b.textContent || '').trim() === '确认发布'
        );
        if (confirmBtn && !confirmBtn.disabled) confirmBtn.click();
      } catch {
        // ignore
      }

      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    if (action === 'draft' && location.pathname.startsWith('/developer/article/') && !location.pathname.startsWith('/developer/article/write')) {
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgRedirectedToDetailStartVerify') });
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  await report({
    status: 'waiting_user',
    stage: 'waitingUser',
    userMessage: action === 'draft' ? getMessage('v2MsgPleaseConfirmDraftSaved') : getMessage('v2MsgPleaseConfirmPublishCompleted'),
    userSuggestion: getMessage('v2SugHandleRequiredCaptchaModalThenContinueOrRetry'),
  });
}

async function runFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredEditorPage') });
  await stageFillTitle(job.article.title);
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl);
  if (job.action === 'draft') {
    await stageSaveDraft();
    await stageConfirmSuccess('draft');
  } else {
    await stageSubmitPublish();
    await stageConfirmSuccess('publish');
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgPublishTriggeredGoManageListVerify'),
      devDetails: summarizeVerifyDetails({ listUrl: 'https://cloud.tencent.com/developer/creator/article' }),
    });
    location.href = 'https://cloud.tencent.com/developer/creator/article';
    return;
  }
}

async function bootstrap(): Promise<void> {
  if (!shouldRunOnThisPage()) return;
  try {
    const ctx = await getContextFromBackground();
    if (ctx.channelId !== CHANNEL_ID) return;
    currentJob = ctx.job;
    if (currentJob.stoppedAt) return;

    if (isEditorPage()) {
      await runFlow(currentJob);
      return;
    }

    if (isListPage()) {
      currentStage = 'confirmSuccess';
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyFindNewArticleInList') });

      // 状态筛选：仅点击可点击元素，且文本 startsWith 匹配
      // 验收只应切到“已发布/审核中/全部”之一，避免误切到“草稿箱”导致无法找到新发布文章
      // 新发布文章大概率先进入“审核中”，因此优先尝试“全部/审核中”，避免遗漏
      const tabOrder = ['全部', '审核中', '已发布'];
      for (const name of tabOrder) {
        const clickable = Array.from(document.querySelectorAll<HTMLElement>('a,button')).find((n) =>
          ((n.textContent || '').trim() || '').startsWith(name)
        );
        if (clickable) {
          try {
            simulateClick(clickable);
            await new Promise((r) => setTimeout(r, 800));
          } catch {
            // ignore
          }
          break;
        }
      }

      // 使用内置搜索（搜文章名称）
      const token = tokenForSearch(currentJob.article.title);
      const searchInput = document.querySelector<HTMLInputElement>('div.cdc-search__bar input[placeholder="搜文章名称"]');
      const searchBtn = searchInput?.closest('div.cdc-search__bar')?.querySelector<HTMLButtonElement>('button.cdc-search__btn');
      if (searchInput && searchBtn) {
        try {
          simulateFocus(searchInput);
          simulateType(searchInput, token);
          simulateClick(searchBtn);
          await new Promise((r) => setTimeout(r, 1200));
        } catch {
          // ignore
        }
      }

      const listUrl = location.href;
      setSessionValue(getListUrlKey(currentJob.jobId), listUrl);

      let listRoot = (document.querySelector('.com-2-course-panel-list') as HTMLElement | null) || null;
      try {
        listRoot = (await waitForElement('.com-2-course-panel-list', 12000)) as HTMLElement;
      } catch {
        // ignore
      }
      const root = listRoot || document.body;

      const allLinks = Array.from(
        root.querySelectorAll<HTMLAnchorElement>('a[href*="/developer/article/"],a[href*="https://cloud.tencent.com/developer/article/"]')
      )
        .map((a) => a.href)
        .filter((href) => href.includes('/developer/article/') && !href.includes('/developer/article/write'));
      const uniq = Array.from(new Set(allLinks));

      // token 命中优先
      const panels = Array.from(root.querySelectorAll<HTMLElement>('.cdc-2-course-panel'));
      const hitPanel = panels.find((p) => (p.textContent || '').includes(token)) || null;
      const panelLink = hitPanel?.querySelector<HTMLAnchorElement>('a[href*="/developer/article/"]') || null;

      const tokenLink =
        panelLink ||
        Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/developer/article/"],a[href*="https://cloud.tencent.com/developer/article/"]')).find((a) =>
          ((a.textContent || '') + ' ' + (a.getAttribute('title') || '')).includes(token)
        ) ||
        null;
      if (tokenLink?.href) {
        removeSessionValue(getProbeActiveKey(currentJob.jobId));
        removeSessionValue(getProbeKey(currentJob.jobId));
        removeSessionValue(getListRetryKey(currentJob.jobId));
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyMatchedTokenBySearchOpeningDetail'),
          devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: tokenLink.href }),
        });
        location.href = tokenLink.href;
        return;
      }

      // 兜底探测：依次打开前 5 个详情链接，直到命中 sourceUrl
      setSessionValue(getProbeActiveKey(currentJob.jobId), '1');
      const idx = Number(getSessionValue(getProbeKey(currentJob.jobId)) || '0');
      const candidates = uniq.slice(0, 5);
      if (idx < candidates.length) {
        setSessionValue(getProbeKey(currentJob.jobId), String(idx + 1));
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyTokenNotMatchedProbingDetails', [String(idx + 1), String(candidates.length)]),
          devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: candidates[idx] }),
        });
        location.href = candidates[idx];
        return;
      }

      removeSessionValue(getProbeActiveKey(currentJob.jobId));
      removeSessionValue(getProbeKey(currentJob.jobId));
      {
        const retryKey = getListRetryKey(currentJob.jobId);
        const n = Number(getSessionValue(retryKey) || '0') + 1;
        setSessionValue(retryKey, String(n));
        if (n <= 24) {
          await report({
            status: 'running',
            stage: 'confirmSuccess',
            userMessage: getMessage('v2MsgVerifyListNoNewArticleRefresh3s24', [String(n)]),
            devDetails: summarizeVerifyDetails({ listUrl, listVisible: false }),
          });
          setTimeout(() => location.reload(), 3000);
          return;
        }

        removeSessionValue(retryKey);
        await report({
          status: 'waiting_user',
          stage: 'waitingUser',
          userMessage: getMessage('v2MsgVerifyFailedListNoArticleWithSourceLink'),
          userSuggestion: getMessage('v2SugConfirmPublishIndexedOrSearchTitleThenContinue'),
          devDetails: summarizeVerifyDetails({ listUrl, listVisible: false }),
        });
        return;
      }
    }

    if (isDetailPage()) {
      const ok = pageContainsSourceUrl(currentJob.article.sourceUrl);
      const probeActive = getSessionValue(getProbeActiveKey(currentJob.jobId)) === '1';
      const listUrl = getSessionValue(getListUrlKey(currentJob.jobId));
      if (!ok && probeActive && listUrl) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyNoSourceOnPageBackToListProbe'),
          devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: location.href, sourceUrlPresent: false }),
        });
        location.href = listUrl;
        return;
      }

      await report({
        status: ok ? 'success' : 'waiting_user',
        stage: ok ? 'done' : 'waitingUser',
        userMessage: ok ? getMessage('v2MsgVerifyPassedDetailHasSourceLink') : getMessage('v2MsgVerifyFailedDetailNoSourceLink'),
        userSuggestion: ok ? undefined : getMessage('v2SugCheckSourceLinkAtEndThenContinue'),
        devDetails: summarizeVerifyDetails({ publishedUrl: location.href, sourceUrlPresent: ok }),
      });
      return;
    }
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
