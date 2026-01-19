/**
 * Mowen Publisher Content Script (V2)
 * Note: Mowen editor has no separate title input; title is the first line of content.
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */

const CHANNEL_ID: ChannelId = 'mowen';

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

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function withTitleAndSourceUrl(contentHtml: string, title: string, sourceUrl: string): string {
  const safe = escapeAttr(sourceUrl);
  const titleHtml = `<p>${title.replace(/</g, '&lt;')}</p>`;
  return `${titleHtml}\n${contentHtml}\n<p><br/></p><p>原文链接：<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a></p>`;
}

function shouldRunOnThisPage(): boolean {
  if (location.hostname !== 'note.mowen.cn') return false;
  if (location.pathname.startsWith('/editor')) return true;
  if (location.pathname.startsWith('/my/notes')) return true;
  if (location.pathname.startsWith('/detail/')) return true;
  return false;
}

function isEditorPage(): boolean {
  return location.hostname === 'note.mowen.cn' && location.pathname.startsWith('/editor');
}

function isListPage(): boolean {
  return location.hostname === 'note.mowen.cn' && location.pathname.startsWith('/my/notes');
}

function isDetailPage(): boolean {
  return location.hostname === 'note.mowen.cn' && location.pathname.startsWith('/detail/');
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

async function stageFillContent(title: string, contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgMowenFillingContentTitleFirstLine'),
    userSuggestion: getMessage('v2SugMowenTitleInFirstLine'),
  });

  // 墨问编辑器基于 ProseMirror（tiptap），需要等待渲染完成
  const editor =
    ((await (async () => {
      try {
        return await waitForVisibleElement<HTMLElement>('.ProseMirror[contenteditable="true"]', 15000);
      } catch {
        return null;
      }
    })()) as HTMLElement | null) || findContentEditor(document);

  if (!editor) throw new Error('未找到内容编辑器（可能是编辑器尚未渲染完成）');

  simulateFocus(editor);
  const html = withTitleAndSourceUrl(contentHtml, title, sourceUrl);

  // ProseMirror 下优先使用 execCommand，避免系统剪贴板权限导致的卡死
  let ok = false;
  try {
    document.execCommand('selectAll', false);
    ok = document.execCommand('insertHTML', false, html);
  } catch {
    ok = false;
  }

  if (!ok) {
    try {
      editor.innerHTML = html;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      ok = true;
    } catch {
      ok = false;
    }
  }

  if (!ok) throw new Error('填充正文失败（插入未生效）');
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSaving') });
  const el = Array.from(document.querySelectorAll<HTMLElement>('div, button, a')).find((n) => (n.textContent || '').trim() === '保存');
  if (!el) throw new Error('未找到保存按钮');
  el.click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishing') });
  const el = Array.from(document.querySelectorAll<HTMLElement>('div, button, a')).find((n) => (n.textContent || '').trim() === '发布');
  if (!el) throw new Error('未找到发布按钮');
  el.click();
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  const okTexts =
    action === 'draft'
      ? ['保存成功', '已保存']
      : ['发布成功', '已发布'];

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const text = document.body?.innerText || '';
    if (okTexts.some((t) => text.includes(t))) {
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgSuccessDetectedStartVerify') });
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  await report({
    status: 'waiting_user',
    stage: 'waitingUser',
    userMessage: action === 'draft' ? getMessage('v2MsgPleaseConfirmSaveCompleted') : getMessage('v2MsgPleaseConfirmPublishCompleted'),
    userSuggestion: getMessage('v2SugHandleModalRiskRequiredThenContinueOrRetry'),
  });
}

async function runFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredEditorPage') });
  await stageFillContent(job.article.title, job.article.contentHtml, job.article.sourceUrl);
  if (job.action === 'draft') {
    await stageSaveDraft();
    await stageConfirmSuccess('draft');
  } else {
    await stageSubmitPublish();
    await stageConfirmSuccess('publish');

    // 墨问可能通过 SPA 直接切到 detail（不触发 reload），这里立即做详情验收
    if (isDetailPage()) {
      const ok = pageContainsSourceUrl(job.article.sourceUrl);
      await report({
        status: ok ? 'success' : 'waiting_user',
        stage: ok ? 'done' : 'waitingUser',
        userMessage: ok ? getMessage('v2MsgVerifyPassedDetailHasSourceLink') : getMessage('v2MsgVerifyFailedDetailNoSourceLink'),
        userSuggestion: ok ? undefined : getMessage('v2SugCheckSourceLinkAtEndThenContinue'),
        devDetails: summarizeVerifyDetails({ publishedUrl: location.href, sourceUrlPresent: ok }),
      });
      return;
    }

    // 发布后跳转到列表页验收；若已进入 detail 则由 detail 分支验收
    if (!isDetailPage()) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgMowenPublishTriggeredGoNotesListVerify'),
        devDetails: summarizeVerifyDetails({ listUrl: 'https://note.mowen.cn/my/notes' }),
      });
      location.href = 'https://note.mowen.cn/my/notes';
      return;
    }
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
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyFindNewNoteInList') });

      if (!pageContainsTitle(currentJob.article.title)) {
        const key = 'bawei_v2_mowen_list_retry';
        const n = Number(sessionStorage.getItem(key) || '0') + 1;
        sessionStorage.setItem(key, String(n));
        if (n <= 6) {
          await report({
            status: 'running',
            stage: 'confirmSuccess',
            userMessage: getMessage('v2MsgVerifyListNoTitleRefresh5s6', [String(n)]),
            devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
          });
          setTimeout(() => location.reload(), 5000);
          return;
        }

        sessionStorage.removeItem(key);
        await report({
          status: 'waiting_user',
          stage: 'waitingUser',
          userMessage: getMessage('v2MsgVerifyFailedListNoTitleTitleIsFirstLine'),
          userSuggestion: getMessage('v2SugRefreshListThenContinue'),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
        });
        return;
      }

      sessionStorage.removeItem('bawei_v2_mowen_list_retry');

      const node = findAnyElementContainingText(titleToken(currentJob.article.title));
      const link = (node?.closest('a') as HTMLAnchorElement | null) || findAnchorContainingText(titleToken(currentJob.article.title));
      if (link?.href) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyFoundTitleOpeningDetail'),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
        });
        location.href = link.href;
        return;
      }

      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v2MsgVerifyBlockedNoDetailLink'),
        userSuggestion: getMessage('v2SugOpenDetailManuallyThenWaitVerify'),
        devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
      });
      return;
    }

    if (isDetailPage()) {
      const ok = pageContainsSourceUrl(currentJob.article.sourceUrl);
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
