/**
 * WoShiPM Publisher Content Script (V2)
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */
/* INLINE:rich-content */
/* INLINE:image-bridge */

const CHANNEL_ID: ChannelId = 'woshipm';

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
  return location.hostname === 'www.woshipm.com';
}

function isWritingPage(): boolean {
  return location.hostname === 'www.woshipm.com' && location.pathname.startsWith('/writing');
}

function isMyPostsPage(): boolean {
  return location.hostname === 'www.woshipm.com' && location.pathname.startsWith('/me/posts');
}

function getListUrl(): string {
  return 'https://www.woshipm.com/me/posts';
}

function getProbeKey(jobId: string): string {
  return `bawei_v2_woshipm_probe_idx_${jobId}`;
}

function getHomeRetryKey(jobId: string): string {
  return `bawei_v2_woshipm_home_retry_${jobId}`;
}

function buildBackHash(jobId: string, backUrl: string): string {
  return `#bawei_v2=1&job=${encodeURIComponent(jobId)}&back=${encodeURIComponent(backUrl)}`;
}

function parseBackUrlFromHash(): string | null {
  const h = (location.hash || '').replace(/^#/, '');
  if (!h) return null;
  const parts = h.split('&');
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 'back' && v) return decodeURIComponent(v);
  }
  return null;
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

  const url = String(location.href || '').toLowerCase();
  const hasLoginUrl = /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i.test(url);
  const hasPassword = !!document.querySelector('input[type="password"],input[name*="password" i]');
  const text = String(document.body?.innerText || '');
  const hardLoginText = /请先登录后继续|请登录后操作|登录后继续/i.test(text);
  if (hasLoginUrl || hasPassword || hardLoginText) {
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
  const input = (await waitForElement('input[placeholder*="文章标题"]', 15000)) as HTMLInputElement;
  simulateFocus(input);
  simulateType(input, title);
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugWoshipmNoSourceFieldAppend'),
  });

  const iframe = (await waitForElement<HTMLIFrameElement>('iframe', 15000)) as HTMLIFrameElement;

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

function hasRealNameBlocker(): boolean {
  const text = document.body?.innerText || '';
  return text.includes('账号实名制认证') || text.includes('立即认证');
}

async function verifyMaybeDetail(job: AnyJob): Promise<boolean> {
  // 详情页/当前页若已包含原文链接，则直接通过
  if (pageContainsSourceUrl(job.article.sourceUrl)) {
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgVerifyPassedDetailHasSourceLink'),
      devDetails: summarizeVerifyDetails({ publishedUrl: location.href, sourceUrlPresent: true }),
    });
    return true;
  }
  return false;
}

function normalizeText(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPostTitle(post: unknown): string {
  const p = post && typeof post === 'object' ? (post as Record<string, unknown>) : {};
  const nested = p.post && typeof p.post === 'object' ? (p.post as Record<string, unknown>) : {};
  return normalizeText(p.post_title) || normalizeText(p.title) || normalizeText(p.name) || normalizeText(nested.title) || '';
}

function extractPostUrl(post: unknown): string | null {
  const p = post && typeof post === 'object' ? (post as Record<string, unknown>) : {};
  const cands = [
    p.url,
    p.link,
    p.href,
    p.permalink,
    p.guid,
    p.post_url,
    p.post_link,
    p.detail_url,
  ]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x);

  for (const u of cands) {
    try {
      const full = new URL(u, location.origin).toString();
      if (full.includes('woshipm.com')) return full;
    } catch {
      // ignore
    }
  }
  return null;
}

async function fetchMyPosts(postStatus: string, paged = 1): Promise<unknown[] | null> {
  try {
    const url = `/__api/v3/me/posts?post_status=${encodeURIComponent(postStatus)}&paged=${encodeURIComponent(String(paged))}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as unknown;
    if (!data || typeof data !== 'object') return null;
    const payload = (data as Record<string, unknown>)?.payload;
    if (!payload || typeof payload !== 'object') return null;
    const posts = (payload as Record<string, unknown>)?.posts;
    return Array.isArray(posts) ? posts : null;
  } catch {
    return null;
  }
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
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgSubmittingReview') });

  // 勾选协议/承诺项（必须勾选，否则提交无效且列表始终为空）
  try {
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"][name="copyright"], input[type="checkbox"][name="copyright_other"], input[type="checkbox"][name="copyright_pm"]'
      )
    );
    for (const input of inputs) {
      if (input.checked) continue;
      // 优先点 input 自身；若 UI 需要点 label，再点最近的 label/父容器
      try {
        simulateClick(input as unknown as HTMLElement);
      } catch {
        try {
          input.click();
        } catch {
          // ignore
        }
      }
      if (!input.checked) {
        const wrap = (input.closest('label') as HTMLElement | null) || (input.parentElement as HTMLElement | null);
        if (wrap) {
          try {
            simulateClick(wrap);
          } catch {
            wrap.click();
          }
        }
      }
      // 触发表单监听
      try {
        input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  const link = Array.from(document.querySelectorAll('a,button')).find((n) => (n.textContent || '').includes('提交审核'));
  if (!link) throw new Error('未找到提交审核按钮');
  (link as HTMLElement).click();

  if (hasRealNameBlocker()) {
    await report({
      status: 'waiting_user',
      stage: 'waitingUser',
      userMessage: getMessage('v2MsgIdentityVerificationRequiredCompleteThenContinue'),
      userSuggestion: getMessage('v2SugDoneThenClickContinue'),
    });
    return;
  }
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  const okTexts =
    action === 'draft'
      ? ['草稿', '已保存', '保存成功']
      : ['提交成功', '审核', '已提交', '发布成功'];

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (hasRealNameBlocker()) {
      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v2MsgIdentityVerificationRequiredCompleteThenContinue'),
        userSuggestion: getMessage('v2SugDoneThenClickContinue'),
      });
      return;
    }

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
    userMessage: action === 'draft' ? getMessage('v2MsgPleaseConfirmDraftSaved') : getMessage('v2MsgPleaseConfirmReviewSubmitted'),
    userSuggestion: getMessage('v2SugHandleModalRiskRequiredThenContinueOrRetry'),
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

    // 先尝试在当前页面直接验收（若页面已跳到详情/预览）
    if (await verifyMaybeDetail(job)) return;

    const listUrl = getListUrl();
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgWoshipmReviewSubmittedGoMyArticlesVerify'),
      devDetails: summarizeVerifyDetails({ listUrl }),
    });
    location.href = listUrl;
  }
}

async function bootstrap(): Promise<void> {
  if (!shouldRunOnThisPage()) return;
  try {
    const ctx = await getContextFromBackground();
    if (ctx.channelId !== CHANNEL_ID) return;
    currentJob = ctx.job;
    if (currentJob.stoppedAt) return;

    // 非 writing 页：尽量把它当作列表/详情做验收
    if (!isWritingPage()) {
      // 详情页优先：包含原文链接即通过
      if (await verifyMaybeDetail(currentJob)) {
        sessionStorage.removeItem(getProbeKey(currentJob.jobId));
        return;
      }

      // 探测详情回退：未命中原文链接时回到列表继续探测
      const backUrl = parseBackUrlFromHash();
      if (backUrl) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyNoSourceOnPageBackToListProbe'),
          devDetails: summarizeVerifyDetails({ listUrl: backUrl, listVisible: true, publishedUrl: location.href, sourceUrlPresent: false }),
        });
        location.href = backUrl;
        return;
      }

      // 非列表页统一先跳到“我的文章”，避免在首页/活动页无限刷新
      if (!isMyPostsPage()) {
        const listUrl = getListUrl();
        const retryKey = getHomeRetryKey(currentJob.jobId);
        const n = Number(sessionStorage.getItem(retryKey) || '0') + 1;
        sessionStorage.setItem(retryKey, String(n));
        if (n >= 3) {
          await report({
            status: 'not_logged_in',
            stage: 'detectLogin',
            userMessage: getMessage('v3MsgNotLoggedIn'),
            userSuggestion: getMessage('v3SugLoginThenRetry'),
            devDetails: { reason: 'woshipm-home-loop', attempts: n, currentUrl: location.href },
          });
          throw new Error('__BAWEI_V2_STOPPED__');
        }
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgWoshipmReviewSubmittedGoMyArticlesVerify'),
          devDetails: summarizeVerifyDetails({ listUrl }),
        });
        location.href = listUrl;
        return;
      }

      sessionStorage.removeItem(getHomeRetryKey(currentJob.jobId));

      // 我的文章列表页：优先用接口数据定位（页面可能异步渲染，直接查 DOM 容易误判）
      if (isMyPostsPage()) {
        currentStage = 'confirmSuccess';
        await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyLocateNewArticleInMyArticles') });

        const token = titleToken(currentJob.article.title);
        const statuses = ['pending', 'publish', 'draft', 'future', 'all'];
        const probeCandidates: string[] = [];
        for (const s of statuses) {
          const posts = await fetchMyPosts(s, 1);
          if (!posts?.length) continue;

          for (const post of posts) {
            const href = extractPostUrl(post);
            if (href) probeCandidates.push(href);
          }

          const hit = posts.find((p) => extractPostTitle(p).includes(token)) || null;
          if (!hit) continue;

          const href = extractPostUrl(hit);
          if (href) {
            sessionStorage.removeItem(getProbeKey(currentJob.jobId));
            await report({
              status: 'running',
              stage: 'confirmSuccess',
              userMessage: getMessage('v2MsgVerifyMatchedTokenInListApiOpeningDetail', [String(s)]),
              devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true, publishedUrl: href }),
            });
            location.href = `${href}${buildBackHash(currentJob.jobId, location.href)}`;
            return;
          }
        }

        const uniqProbe = Array.from(new Set(probeCandidates)).slice(0, 8);
        if (uniqProbe.length) {
          const key = getProbeKey(currentJob.jobId);
          const idx = Number(sessionStorage.getItem(key) || '0');
          if (idx < uniqProbe.length) {
            sessionStorage.setItem(key, String(idx + 1));
            const backWithProbe = `${location.origin}${location.pathname}${location.search}#bawei_v2=1&job=${encodeURIComponent(currentJob.jobId)}`;
            await report({
              status: 'running',
              stage: 'confirmSuccess',
              userMessage: getMessage('v2MsgVerifyNotFoundNewArticleProbingDetails', [String(idx + 1), String(uniqProbe.length)]),
              devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true, publishedUrl: uniqProbe[idx] }),
            });
            location.href = `${uniqProbe[idx]}${buildBackHash(currentJob.jobId, backWithProbe)}`;
            return;
          }
          sessionStorage.removeItem(key);
        }
      }

      // 列表页：出现标题则尝试打开
      if (pageContainsTitle(currentJob.article.title)) {
        const node = findAnyElementContainingText(titleToken(currentJob.article.title));
        const link = (node?.closest('a') as HTMLAnchorElement | null) || findAnchorContainingText(titleToken(currentJob.article.title));
        if (link?.href) {
          sessionStorage.removeItem(getProbeKey(currentJob.jobId));
          await report({
            status: 'running',
            stage: 'confirmSuccess',
            userMessage: getMessage('v2MsgVerifyFoundTitleOpeningDetail'),
            devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
          });
          location.href = `${link.href}${buildBackHash(currentJob.jobId, location.href)}`;
          return;
        }
      }

      // 自动刷新几次，避免列表异步加载
      const key = 'bawei_v2_woshipm_list_retry';
      const n = Number(sessionStorage.getItem(key) || '0') + 1;
      sessionStorage.setItem(key, String(n));
      if (n <= 6) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyListOrDetailNotRecognizedRefresh5s6', [String(n)]),
        });
        setTimeout(() => location.reload(), 5000);
        return;
      }

      sessionStorage.removeItem(key);
      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v2MsgVerifyBlockedListNoNewArticle'),
        userSuggestion: getMessage('v2SugWoshipmSwitchTabsThenContinue'),
      });
      return;
    }

    await runFlow(currentJob);
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
