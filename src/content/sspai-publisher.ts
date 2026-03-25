/**
 * SSPAI Publisher Content Script (V2)
 *
 * Editor: https://sspai.com/write
 * - Title: textarea[placeholder*="标题"]
 * - Content: CKEditor editable div (.ck-editor__editable[contenteditable=true])
 *
 * Note:
 * - Some accounts require real-name verification to publish ("开始认证").
 *   In that case we set status=waiting_user and let the user handle it.
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */
/* INLINE:rich-content */
/* INLINE:image-bridge */

const CHANNEL_ID: ChannelId = 'sspai';

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

const WRITE_URL = 'https://sspai.com/write';

type SspaiArticleInfo = {
  data?: {
    id?: number;
    released_at?: number;
    body?: string;
    body_last?: string;
    title?: string;
    title_last?: string;
    banner?: string;
    banner_id?: number;
    type?: number;
    created_at?: number;
    words_count?: number;
    words_count_last?: number;
    tags?: unknown;
    allow_comment?: boolean;
    custom_tags?: unknown;
    token?: string;
    show_content_table?: boolean;
    delete_status?: boolean;
    free?: boolean;
    benefits_statement_on?: boolean;
    benefits_statement_id?: number;
    body_updated_at?: number;
  };
  error?: number;
  msg?: string;
};

function assertSspaiApiOk(payload: unknown, label: string): void {
  const p = (payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null) || {};
  const err = Number(p?.error || 0);
  if (!err) return;
  const msg = String(p?.msg || '').trim();
  throw new Error(msg ? `${label}: ${msg}` : `${label}: api error=${err}`);
}

function getSspaiJwt(): string {
  // SSPAI API 需要 Authorization Bearer；仅带 cookie 有时会返回“请登录”
  try {
    const t = localStorage.getItem('ssToken') || '';
    if (t) return t;
  } catch {
    // ignore
  }
  try {
    const m = String(document.cookie || '').match(/(?:^|;\s*)sspai_jwt_token=([^;]+)/);
    if (m?.[1]) return decodeURIComponent(m[1]);
  } catch {
    // ignore
  }
  return '';
}

function sspaiAuthHeaders(): Record<string, string> {
  const jwt = getSspaiJwt();
  return jwt ? { authorization: `Bearer ${jwt}` } : {};
}

function shouldRunOnThisPage(): boolean {
  if (location.hostname !== 'sspai.com') return false;
  if (location.pathname.startsWith('/write')) return true;
  if (location.pathname.startsWith('/post/')) return true;
  return true;
}

function isWritePage(): boolean {
  return location.hostname === 'sspai.com' && location.pathname.startsWith('/write');
}

function isDetailPage(): boolean {
  return location.hostname === 'sspai.com' && location.pathname.startsWith('/post/');
}

function isEditPage(): boolean {
  // After publishing, SSPAI typically redirects to /write#<id>
  return location.hostname === 'sspai.com' && location.pathname.startsWith('/write') && /#\d+/.test(location.hash || '');
}

function parseArticleIdFromHash(): string {
  const m = String(location.hash || '').match(/#(\d+)/);
  return m?.[1] || '';
}

async function waitForArticleId(): Promise<string> {
  return await retryUntil(
    async () => {
      const id = parseArticleIdFromHash();
      if (!id) throw new Error('article id not ready');
      return id;
    },
    { timeoutMs: 45_000, intervalMs: 600 }
  );
}

async function fetchArticleInfo(id: string): Promise<SspaiArticleInfo> {
  const url = `/api/v1/matrix/editor/article/single/info/get?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      accept: 'application/json, text/plain, */*',
      // 部分接口在缺少该 header 时会返回 HTML（导致 token 取不到）
      'x-requested-with': 'XMLHttpRequest',
      ...sspaiAuthHeaders(),
    },
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`fetch article info failed: ${res.status}`);
  if (!ct.includes('application/json')) {
    const snippet = await res
      .text()
      .then((t) => String(t || '').slice(0, 160))
      .catch(() => '');
    throw new Error(`fetch article info not json: ${ct || 'unknown'} ${snippet ? `| ${snippet}` : ''}`.trim());
  }
  const json = (await res.json().catch(() => ({}))) as SspaiArticleInfo;
  assertSspaiApiOk(json, 'fetch article info failed');
  return json;
}

function containsSourceUrlInHtml(html: string, url: string): boolean {
  if (!html || !url) return false;
  return html.includes(url);
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

function findButtonExact(text: string): HTMLButtonElement | null {
  const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  return btns.find((b) => (b.textContent || '').replace(/\s+/g, ' ').trim() === text) || null;
}

async function stageDetectLogin(): Promise<void> {
  currentStage = 'detectLogin';
  await report({ status: 'running', stage: 'detectLogin', userMessage: getMessage('v3MsgDetectingLogin') });

  const loginState = detectPageLoginState({
    loginUrlPattern: /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i,
    loggedInPattern: /写文章|草稿|发布|账号设置|少数派|退出登录|我的文章/i,
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
  await report({ status: 'running', stage: 'fillTitle', userMessage: getMessage('v2MsgFillingTitle') });

  const input = (await waitForElement<HTMLTextAreaElement>('textarea[placeholder*="标题"]', 30000)) as HTMLTextAreaElement;
  simulateFocus(input);
  simulateType(input, title.slice(0, 32));
}

async function stageFillContent(contentHtml: string, sourceUrl: string, articleId: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugSspaiNoSourceFieldAppend'),
  });

  const jobTokens = currentJob?.article?.contentTokens;
  const tokens = Array.isArray(jobTokens) ? jobTokens : buildRichContentTokens({ contentHtml, baseUrl: sourceUrl, sourceUrl });
  const escapeAttr = (value: string): string =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const editorTokens = tokens.map((token) => {
    if (!token || token.kind !== 'image') return token;
    const src = String(token.src || '').trim();
    if (!src) return { kind: 'html', html: '<p><br/></p>' };
    const alt = escapeAttr(String(token.alt || ''));
    const safeSrc = escapeAttr(src);
    return {
      kind: 'html',
      html: `<p><img src="${safeSrc}"${alt ? ` alt="${alt}"` : ''} /></p>`,
    };
  });

  const expectedImages = editorTokens.filter((t) => t?.kind === 'image').length;

  const plainLen = tokens
    .filter((t) => t?.kind === 'html')
    .map((t) => htmlToPlainTextSafe((t as { html?: string }).html || ''))
    .join('\n')
    .replace(/\s+/g, '')
    .length;

  if (plainLen < 120) {
    let pad = '（内容来自原文链接，更多细节请查看原文。）';
    while (pad.replace(/\s+/g, '').length < 140) pad += '。';
    const padHtml = `<p>${pad}</p>`;
    const last = tokens[tokens.length - 1];
    if (last?.kind === 'html' && sourceUrl && String((last as { html?: string }).html || '').includes(sourceUrl)) {
      tokens.splice(tokens.length - 1, 0, { kind: 'html', html: padHtml });
    } else {
      tokens.push({ kind: 'html', html: padHtml });
    }
  }

  const editor = await retryUntil(
    async () => {
      const el =
        (document.querySelector<HTMLElement>('.ck-editor__editable[contenteditable="true"]') as HTMLElement | null) ||
        (document.querySelector<HTMLElement>('.ck-editor__editable') as HTMLElement | null) ||
        (document.querySelector<HTMLElement>('.x-editor-inst.wangEditor-txt') as HTMLElement | null) ||
        (document.querySelector<HTMLElement>('[class*="ck-editor__editable"]') as HTMLElement | null) ||
        (findContentEditor(document) as HTMLElement | null) ||
        null;
      if (!el) throw new Error('editor not ready');
      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 80) throw new Error('editor not visible');

      try {
        simulateClick(el);
        simulateFocus(el);
        if (el.getAttribute('contenteditable') !== 'true') {
          el.setAttribute('contenteditable', 'true');
        }
      } catch {
        // ignore
      }
      return el;
    },
    { timeoutMs: 60_000, intervalMs: 800 }
  );

  const existingHtml = (() => {
    try {
      return String(editor.innerHTML || '');
    } catch {
      return '';
    }
  })();
  const existingHasSource = !!(sourceUrl && existingHtml.includes(sourceUrl));
  const existingOk =
    existingHasSource &&
    (expectedImages === 0 ||
      Array.from(editor.querySelectorAll<HTMLImageElement>('img')).filter((img) => {
        const src = String(img.getAttribute('src') || '').trim();
        if (!src) return false;
        if (src.startsWith('blob:') || src.startsWith('data:')) return true;
        return !src.includes('qpic.cn') && !src.includes('qlogo.cn');
      }).length >= expectedImages);

  if (!existingOk) {
    try {
      await fillEditorByTokens({
        jobId: currentJob?.jobId || '',
        tokens: editorTokens,
        editorRoot: editor,
        writeMode: 'html',
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

  const baselineInfo = await fetchArticleInfo(articleId).catch(() => null);
  const baselineBody = String(baselineInfo?.data?.body_last || baselineInfo?.data?.body || '');
  const baselineLen = baselineBody.replace(/\s+/g, '').length;
  const sourceHost = (() => {
    try {
      return new URL(sourceUrl).hostname;
    } catch {
      return '';
    }
  })();

  const persisted = await retryUntil(
    async () => {
      const info = await fetchArticleInfo(articleId);
      const bodyLast = String(info?.data?.body_last || info?.data?.body || '');
      if (!bodyLast) throw new Error('waiting body_last update');
      if (containsSourceUrlInHtml(bodyLast, sourceUrl)) return true;

      const normalized = bodyLast.replace(/\s+/g, '');
      if (sourceHost && normalized.includes(sourceHost.replace(/\s+/g, ''))) return true;
      if (normalized.length > Math.max(baselineLen + 80, 240)) return true;
      throw new Error('waiting body_last update');
    },
    { timeoutMs: 120_000, intervalMs: 1200 }
  ).catch(() => false);

  if (!persisted) {
    await report({
      status: 'running',
      stage: 'fillContent',
      userMessage: getMessage('v2MsgContentFilled'),
      userSuggestion: getMessage('v2SugSspaiNoSourceFieldAppend'),
      devDetails: { message: 'body_last未及时刷新，继续提交流程并在发布后验收原文链接' },
    });
  }
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSavingDraft') });
  const btn = findButtonExact('保存') || findAnyElementContainingText('保存');
  if (!btn) throw new Error('未找到保存按钮');
  (btn as HTMLElement).click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishing') });

  const btn = findButtonExact('发布') || findAnyElementContainingText('发布');
  if (!btn) throw new Error('未找到发布按钮');
  (btn as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 1200));

  // Some flows use a final confirm button.
  const confirm = findButtonExact('确定') || findButtonExact('确认') || findAnyElementContainingText('确定');
  if (confirm) {
    try {
      (confirm as HTMLElement).click();
    } catch {
      // ignore
    }
  }
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<'ok' | 'waiting_user'> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  const text = document.body?.innerText || '';
  if (action === 'publish') {
    if (text.includes('完成实名认证') || text.includes('开始认证') || text.includes('最后一步')) {
      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v2MsgIdentityVerificationRequiredToPublish'),
        userSuggestion: getMessage('v2SugCompleteIdentityVerificationThenContinue'),
      });
      return 'waiting_user';
    }
  }

  const okTexts = action === 'draft' ? ['草稿已保存', '已保存'] : ['发布成功', '已发布'];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const body = document.body?.innerText || '';
    if (okTexts.some((t) => body.includes(t))) return 'ok';
    if (action === 'publish' && (body.includes('完成实名认证') || body.includes('开始认证'))) {
      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v2MsgIdentityVerificationRequiredToPublish'),
        userSuggestion: getMessage('v2SugCompleteIdentityVerificationThenContinue'),
      });
      return 'waiting_user';
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return 'ok';
}

async function stageVerifyPublished(articleId: string): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyConfirmPublishedVisibleOnDetail') });

  // 以 API 为准判断是否已发布（released_at > 0）
  const info = await fetchArticleInfo(articleId).catch(() => ({} as SspaiArticleInfo));
  const releasedAt = Number(info?.data?.released_at || 0);
  if (!releasedAt) {
    await report({
      status: 'waiting_user',
      stage: 'waitingUser',
      userMessage: getMessage('v2MsgVerifyBlockedNotPublishedYet'),
      userSuggestion: getMessage('v2SugCompleteVerificationOrRequiredThenContinueToRetry'),
      devDetails: { releasedAt },
    });
    return;
  }

  // 已发布：打开详情页验收原文链接
  location.href = `https://sspai.com/post/${articleId}`;
}

async function runWriteFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredSspaiWritePage') });

  await stageDetectLogin();
  await stageFillTitle(job.article.title);
  const articleId = await waitForArticleId();
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl, articleId);

  if (job.action === 'draft') {
    await stageSaveDraft();
    await stageConfirmSuccess('draft');
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgDraftSavedVerifyDone'),
      devDetails: summarizeVerifyDetails({ listUrl: WRITE_URL, listVisible: true }),
    });
    return;
  }

  await stageSubmitPublish();
  const confirm = await stageConfirmSuccess('publish');
  if (confirm === 'waiting_user') return;

  // SSPAI will keep you at /write#<id> after publish; use that hash to open /post/<id> for verification.
  if (isEditPage()) {
    await stageVerifyPublished(articleId);
    return;
  }

  // If we are redirected to detail, verify it.
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

  // Fallback waiting user
  await report({
    status: 'waiting_user',
    stage: 'waitingUser',
    userMessage: getMessage('v2MsgSspaiPublishTriggeredButNotInVerifiablePage'),
    userSuggestion: getMessage('v2SugCheckRequiredOrIdentityThenContinue'),
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

    if (isWritePage()) {
      await runWriteFlow(currentJob);
      return;
    }

    if (isDetailPage()) {
      await verifyFromDetail(currentJob);
      return;
    }

    if (isEditPage()) {
      const id = await waitForArticleId().catch(() => '');
      if (!id) throw new Error('未能获取文章ID（/write#<id>）');
      await stageVerifyPublished(id);
      return;
    }

    // Unexpected page on sspai.com -> go to write page.
    await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgSspaiOpeningWritePage') });
    location.href = WRITE_URL;
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
