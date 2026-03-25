/**
 * CNBlogs Publisher Content Script (V2)
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */
/* INLINE:rich-content */
/* INLINE:image-bridge */

const CHANNEL_ID: ChannelId = 'cnblogs';

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

function shouldRunOnThisPage(): boolean {
  if (location.hostname === 'i.cnblogs.com' && location.pathname.startsWith('/posts')) return true;
  if (location.hostname === 'www.cnblogs.com') return true;
  return false;
}

function isEditorPage(): boolean {
  return location.hostname === 'i.cnblogs.com' && location.pathname.startsWith('/posts/edit');
}

function isListPage(): boolean {
  return location.hostname === 'i.cnblogs.com' && location.pathname.startsWith('/posts');
}

function isDetailPage(): boolean {
  return location.hostname === 'www.cnblogs.com';
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

async function stageDetectLogin(): Promise<void> {
  currentStage = 'detectLogin';
  await report({ status: 'running', stage: 'detectLogin', userMessage: getMessage('v3MsgDetectingLogin') });

  const loginState = detectPageLoginState({
    loginUrlPattern: /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i,
    loggedInPattern: /新随笔|博客园|我的博客|文章管理|退出登录|个人中心|设置/i,
  });
  if (loginState.status === 'not_logged_in') {
    await report({
      status: 'not_logged_in',
      stage: 'detectLogin',
      userMessage: getMessage('v3MsgNotLoggedIn'),
      userSuggestion: getMessage('v3SugLoginThenRetry'),
    });
    throw new Error('__BAWEI_V2_STOPPED__');
  }
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle' });

  // 博客园后台新编辑器：标题通常为 #post-title（Angular 渲染，需等待）
  let input: HTMLInputElement | null = null;
  try {
    input = await waitForElement<HTMLInputElement>('#post-title', 15000);
  } catch {
    input =
      (document.querySelector('input[placeholder*="标题"]') as HTMLInputElement | null) ||
      (document.querySelector('input[id*="Title" i]') as HTMLInputElement | null) ||
      (document.querySelector('input[id*="title" i]') as HTMLInputElement | null) ||
      (document.querySelector('input[name*="Title" i]') as HTMLInputElement | null) ||
      (document.querySelector('input[name*="title" i]') as HTMLInputElement | null) ||
      (document.querySelector('input') as HTMLInputElement | null);
  }

  if (!input) throw new Error('未找到标题输入框（可能是页面未渲染完成）');
  simulateFocus(input);
  simulateType(input, title);
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugCnblogsNoSourceFieldAppend'),
  });

  const iframe = (await waitForElement<HTMLIFrameElement>('#Editor_Edit_EditorBody_ifr', 15000)) as HTMLIFrameElement;

  // 等待 iframe body 可写（避免 document_end 时机过早）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (iframe?.contentDocument?.body) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!iframe?.contentDocument?.body) throw new Error('未找到正文编辑器（iframe 未就绪）');

  const jobTokens = currentJob?.article?.contentTokens;
  const tokens = Array.isArray(jobTokens) ? jobTokens : buildRichContentTokens({ contentHtml, baseUrl: sourceUrl, sourceUrl });

  const editorRoot = iframe.contentDocument.body as HTMLElement;
  const expectedImages = tokens.filter((t) => t?.kind === 'image').length;
  const existingHtml = (() => {
    try {
      return String(editorRoot.innerHTML || '');
    } catch {
      return '';
    }
  })();
  const existingHasSource = !!(sourceUrl && existingHtml.includes(sourceUrl));
  const existingOk =
    existingHasSource &&
    (expectedImages === 0 ||
      Array.from(editorRoot.querySelectorAll<HTMLImageElement>('img')).filter((img) => {
        const src = String(img.getAttribute('src') || '').trim();
        if (!src) return false;
        if (src.startsWith('blob:') || src.startsWith('data:')) return true;
        return !src.includes('qpic.cn') && !src.includes('qlogo.cn');
      }).length >= expectedImages);

  if (!existingOk) {
    try {
      await fillEditorByTokens({
        jobId: currentJob?.jobId || '',
        tokens,
        editorRoot,
        writeMode: 'html',
        onImageProgress: async (current, total) => {
          await report({
            status: 'running',
            stage: 'fillContent',
            userMessage: getMessage('v3MsgUploadingImageProgress', [String(current), String(total)]),
          });
        },
      });
    } catch (e) {
      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v3MsgImageUploadFailed'),
        userSuggestion: getMessage('v3SugManualUploadImagesThenContinue'),
        devDetails: { message: e instanceof Error ? e.message : String(e) },
      });
      throw new Error('__BAWEI_V2_STOPPED__');
    }
  }

  await report({ userMessage: getMessage('v2MsgAppendedSourceLinkKeepOriginal') });
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSavingAsDraft') });
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('存为草稿'));
  if (!btn) throw new Error('未找到存为草稿按钮');
  (btn as HTMLButtonElement).click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishing') });
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '发布');
  if (!btn) throw new Error('未找到发布按钮');
  (btn as HTMLButtonElement).click();
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  const okTexts =
    action === 'draft'
      ? ['草稿', '已保存', '保存成功']
      : ['已发布', '发布成功', '提交成功', '审核'];

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
    userMessage:
      action === 'draft' ? getMessage('v2MsgPleaseConfirmDraftSaved') : getMessage('v2MsgPleaseConfirmPublishCompleted'),
    userSuggestion: getMessage('v2SugHandleModalRequiredThenContinueOrRetry'),
  });
}

async function runFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredEditorPage') });
  await stageDetectLogin();
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
      userMessage: getMessage('v2MsgPublishTriggeredGoPostsListVerify'),
      devDetails: summarizeVerifyDetails({ listUrl: 'https://i.cnblogs.com/posts' }),
    });
    location.href = 'https://i.cnblogs.com/posts';
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
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyFindNewPostInList') });

      if (!pageContainsTitle(currentJob.article.title)) {
        const key = 'bawei_v2_cnblogs_list_retry';
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
          userMessage: getMessage('v2MsgVerifyFailedListStillNoTitle'),
          userSuggestion: getMessage('v2SugConfirmPublishOrWaitIndexRefreshThenContinue'),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
        });
        return;
      }

      sessionStorage.removeItem('bawei_v2_cnblogs_list_retry');

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
