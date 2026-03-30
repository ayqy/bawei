/**
 * OSCHINA Publisher Content Script (V2)
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */
/* INLINE:rich-content */
/* INLINE:image-bridge */

const CHANNEL_ID: ChannelId = 'oschina';
const OSCHINA_DIRECT_WRITE_ENTRY_URL = 'https://my.oschina.net/u/1/blog/write';

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

function tokenForSearch(title: string): string {
  return titleToken(title);
}

function getProbeKey(jobId: string): string {
  return `bawei_v2_oschina_probe_index_${jobId}`;
}

function getProbeActiveKey(jobId: string): string {
  return `bawei_v2_oschina_probe_active_${jobId}`;
}

function getListUrlKey(jobId: string): string {
  return `bawei_v2_oschina_list_url_${jobId}`;
}

function getSearchAppliedKey(jobId: string): string {
  return `bawei_v2_oschina_search_applied_${jobId}`;
}

function getListRetryKey(jobId: string): string {
  return `bawei_v2_oschina_list_retry_${jobId}`;
}

function getWwwEntryRetryKey(jobId: string): string {
  return `bawei_v2_oschina_www_entry_retry_${jobId}`;
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

function pageContainsSourceUrlLoose(sourceUrl: string): boolean {
  if (pageContainsSourceUrl(sourceUrl)) return true;
  try {
    const u = new URL(sourceUrl);
    if (u.hostname && pageContainsText(u.hostname)) return true;
    const m = u.pathname.match(/\/s\/([^/?]+)/);
    if (m?.[1] && pageContainsText(m[1])) return true;
  } catch {
    // ignore
  }
  return false;
}

function shouldRunOnThisPage(): boolean {
  if (location.hostname === 'www.oschina.net') return true;
  if (location.hostname === 'my.oschina.net') return true; // list/detail/write 都在此域
  return false;
}

function isWritePage(): boolean {
  return location.hostname === 'my.oschina.net' && /\/blog\/write/.test(location.pathname);
}

function isMyOschinaPage(): boolean {
  return location.hostname === 'my.oschina.net' && !/\/blog\/write/.test(location.pathname);
}

function detectCanonicalWriteUrl(): string | null {
  try {
    const a = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find((x) => {
      const text = (x.textContent || '').trim();
      if (!text.includes('写博客')) return false;
      return /\/u\/[^/]+\/blog\/write/.test(x.href);
    });
    return a?.href || null;
  } catch {
    return null;
  }
}

function detectWriteEntryUrlOnWww(): string | null {
  try {
    const direct = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find((a) => {
      const href = String(a.href || '');
      if (!href) return false;
      return href.includes('/blog/write');
    });
    if (direct?.href) return direct.href;

    const byText = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find((a) => {
      const text = (a.textContent || '').trim();
      if (!text.includes('写博客')) return false;
      const href = String(a.href || '');
      return !!href;
    });
    if (byText?.href) return byText.href;
  } catch {
    // ignore
  }
  return null;
}

function detectCanonicalSpacePath(): string | null {
  try {
    // 优先从“写博客”链接推导（在空间迁移场景下它更准确）
    const write = detectCanonicalWriteUrl();
    if (write) {
      const m = new URL(write).pathname.match(/^\/u\/[^/]+/);
      if (m?.[0]) return m[0];
    }

    // 兜底：个人主页链接
    const home = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find((x) => {
      const text = (x.textContent || '').trim();
      if (!text.includes('个人主页')) return false;
      return /^\/u\/[^/]+/.test(new URL(x.href).pathname);
    });
    if (home?.href) {
      const m = new URL(home.href).pathname.match(/^\/u\/[^/]+/);
      if (m?.[0]) return m[0];
    }
  } catch {
    // ignore
  }
  return null;
}

function getDirectWriteEntryUrl(): string {
  return OSCHINA_DIRECT_WRITE_ENTRY_URL;
}

function dismissGuideDrawer(): void {
  try {
    const close = Array.from(document.querySelectorAll<HTMLElement>('button,div,span')).find(
      (node) => (node.textContent || '').trim() === '关闭引导'
    );
    if (!close) return;
    try {
      simulateClick(close);
    } catch {
      close.click();
    }
  } catch {
    // ignore
  }
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
    strictLoginPattern: /请先登录后继续|请登录后操作|登录后继续|账号登录|密码登录|扫码登录/i,
    loggedInPattern: /写博客|我的博客|博客广场|动弹|消息|设置|个人空间|退出登录|我的主页/i,
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

async function ensureEditorPage(): Promise<boolean> {
  if (location.hostname !== 'www.oschina.net') return false;

  if (!location.pathname.startsWith('/blog/write')) {
    const detected = detectWriteEntryUrlOnWww();
    const target = detected || getDirectWriteEntryUrl();
    const retryKey = currentJob ? getWwwEntryRetryKey(currentJob.jobId) : '';
    if (!detected && retryKey) {
      const n = Number(getSessionValue(retryKey) || '0') + 1;
      setSessionValue(retryKey, String(n));
      if (n >= 3) {
        await report({
          status: 'not_logged_in',
          stage: 'detectLogin',
          userMessage: getMessage('v3MsgNotLoggedIn'),
          userSuggestion: getMessage('v3SugLoginThenRetry'),
          devDetails: { reason: 'oschina-www-entry-loop', attempts: n, currentUrl: location.href },
        });
        throw new Error('__BAWEI_V2_STOPPED__');
      }
    } else if (retryKey) {
      removeSessionValue(retryKey);
    }

    if (target && target !== location.href) {
      await report({
        status: 'running',
        stage: 'openEntry',
        userMessage: getMessage('v2MsgOschinaGoProfileWriteBlogPage'),
        devDetails: { from: location.href, to: target },
      });
      location.href = target;
      return true;
    }
    return false;
  }

  // /blog/write 是入口页：需要跳转到 my.oschina.net 的个人空间写作页
  const target =
    (await retryUntil(
      async () => {
        const direct = document.querySelector<HTMLAnchorElement>('a[href*="my.oschina.net"][href*="/blog/write"]');
        if (direct?.href) return direct;

        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
        const byText = anchors.find((a) => ((a.textContent || '').trim() || '').includes('写博客'));
        if (byText?.href) return byText;

        const maybe = Array.from(document.querySelectorAll<HTMLElement>('button,a,div')).find((n) =>
          ((n.textContent || '').trim() || '').includes('写博客')
        );
        if (maybe) return maybe;

        throw new Error('write entry not ready');
      },
      { timeoutMs: 4000, intervalMs: 300 }
    ).catch(() => null)) || null;

  if (target instanceof HTMLAnchorElement && target.href) {
    if (currentJob) removeSessionValue(getWwwEntryRetryKey(currentJob.jobId));
    location.href = target.href;
    return true;
  }

  if (target instanceof HTMLElement) {
    try {
      simulateClick(target);
    } catch {
      target.click();
    }
    return true;
  }

  const fallback = getDirectWriteEntryUrl();
  if (currentJob) removeSessionValue(getWwwEntryRetryKey(currentJob.jobId));
  await report({
    status: 'running',
    stage: 'openEntry',
    userMessage: getMessage('v2MsgOschinaGoProfileWriteBlogPage'),
    devDetails: { from: location.href, to: fallback, reason: 'fallback-direct-write-entry' },
  });
  location.href = fallback;
  return true;
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle' });
  dismissGuideDrawer();
  const input = (await waitForElement('input[name="title"], input[placeholder*="文章标题"]', 15000)) as HTMLInputElement;
  simulateFocus(input);
  simulateType(input, title);
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugOschinaNoSourceFieldAppend'),
  });

  const jobTokens = currentJob?.article?.contentTokens;
  const tokens = Array.isArray(jobTokens) ? jobTokens : buildRichContentTokens({ contentHtml, baseUrl: sourceUrl, sourceUrl });

  dismissGuideDrawer();

  let editorRoot: HTMLElement | null = null;
  let isProseMirrorEditor = false;

  const iframe = document.querySelector<HTMLIFrameElement>('iframe.cke_wysiwyg_frame, iframe');
  if (iframe) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (iframe.contentDocument?.body) {
        editorRoot = iframe.contentDocument.body as HTMLElement;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!editorRoot) {
    editorRoot =
      (await waitForElement<HTMLElement>(
        '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"], .tiptap.ProseMirror, [role="textbox"].aie-content',
        15000
      ).catch(() => null)) || null;
    isProseMirrorEditor = !!editorRoot;
  }

  if (!editorRoot) throw new Error('未找到正文编辑器（iframe / ProseMirror 未就绪）');

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
        ensureCaretAtEnd: isProseMirrorEditor,
        directHtmlAppend: isProseMirrorEditor,
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

  // Best-effort: sync CKEditor element state if available
  try {
    type CkEditorInstance = { fire?: (eventName: string) => void; updateElement?: () => void };
    type CkEditorGlobal = { instances?: Record<string, unknown> };
    const ck = (window as Window & { CKEDITOR?: CkEditorGlobal }).CKEDITOR;
    const instances = ck?.instances ? Object.values(ck.instances) : [];
    const inst =
      instances.find((x): x is CkEditorInstance => {
        const candidate = x as Partial<CkEditorInstance> | null;
        return !!candidate && typeof candidate.updateElement === 'function';
      }) || null;
    if (inst) {
      try {
        if (typeof inst.fire === 'function') inst.fire('change');
        if (typeof inst.updateElement === 'function') inst.updateElement();
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  if (isProseMirrorEditor) {
    try {
      editorRoot.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      editorRoot.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      editorRoot.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    } catch {
      // ignore
    }
  }

  await report({ userMessage: getMessage('v2MsgAppendedSourceLinkKeepOriginal') });
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSavingDraft') });
  const el = Array.from(document.querySelectorAll<HTMLElement>('a, button, div')).find(
    (n) => (n.textContent || '').trim() === '保存草稿'
  );
  if (!el) throw new Error('未找到保存草稿按钮');
  (el as HTMLElement).click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishingArticle') });
  const el = Array.from(document.querySelectorAll<HTMLElement>('a, button, div')).find((n) => (n.textContent || '').trim() === '发布文章');
  if (!el) throw new Error('未找到发布文章按钮');

  try {
    simulateClick(el);
  } catch {
    el.click();
  }

  // 发布弹窗：优先选择“原创”，然后点击“确认并发布”
  try {
    const original = Array.from(document.querySelectorAll<HTMLElement>('label,span,div')).find((n) => (n.textContent || '').trim() === '原创');
    if (original) simulateClick((original.closest('label') as HTMLElement | null) || (original as HTMLElement));
  } catch {
    // ignore
  }

  const confirm = await retryUntil(
    async () => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('button,a,div,span,label'));
      const byText = (text: string) => nodes.find((n) => (n.textContent || '').trim() === text) || null;
      const btn =
        byText('确定并发布') ||
        byText('确认并发布') ||
        byText('确定发布') ||
        byText('确认发布') ||
        null;
      if (!btn) throw new Error('confirm not ready');
      return (btn.closest('button') as HTMLElement | null) || btn;
    },
    { timeoutMs: 15000, intervalMs: 400 }
  );

  try {
    simulateClick(confirm);
  } catch {
    (confirm as HTMLElement).click();
  }
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  const okTexts =
    action === 'draft'
      ? ['草稿', '保存成功', '已保存']
      : ['发布成功', '已发布', '提交成功', '待审核', '正在审核中', '重新编辑'];

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (action === 'publish') {
      if (location.hostname === 'my.oschina.net' && /\/blog\/\d+/.test(location.pathname)) {
        await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgSuccessDetectedStartVerify') });
        return;
      }

      const text = document.body?.innerText || '';
      const hit = okTexts.some((t) => text.includes(t));
      if (hit) {
        if (isWritePage()) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgSuccessDetectedStartVerify') });
        return;
      }

      await new Promise((r) => setTimeout(r, 300));
      continue;
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
    userMessage: action === 'draft' ? getMessage('v2MsgPleaseConfirmDraftSaved') : getMessage('v2MsgPleaseConfirmPublishCompleted'),
    userSuggestion: getMessage('v2SugHandleModalRiskRequiredThenContinueOrRetry'),
  });
}

async function runFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredEditorPage') });
  const redirected = await ensureEditorPage();
  if (redirected) return;
  await stageDetectLogin();

  if (location.hostname === 'www.oschina.net') {
    await report({
      status: 'waiting_user',
      stage: 'waitingUser',
      userMessage: getMessage('v2MsgOschinaStillOnEntryNeedWriteBlogOrRelogin'),
      userSuggestion: getMessage('v2SugOschinaLoginThenClickWriteBlogThenContinue'),
    });
    return;
  }

  // 空间迁移：/u/<账号ID>/blog/write 里“写博客”可能指向实际空间 /u/<spaceId>/blog/write
  if (isWritePage()) {
    const canonical = detectCanonicalWriteUrl();
    if (canonical && canonical !== location.href) {
      await report({
        status: 'running',
        stage: 'openEntry',
        userMessage: getMessage('v2MsgOschinaSpaceMigrationSwitchToWritePage'),
        devDetails: { from: location.href, to: canonical },
      });
      location.href = canonical;
      return;
    }
  }

  await stageFillTitle(job.article.title);
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl);
  if (job.action === 'draft') {
    await stageSaveDraft();
    await stageConfirmSuccess('draft');
  } else {
    await stageSubmitPublish();
    await stageConfirmSuccess('publish');
    // 若已跳到详情页（/blog/<id>），优先留在详情页直接验收原文链接
    if (location.hostname === 'my.oschina.net' && /\/blog\/\d+/.test(location.pathname)) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgAlreadyInDetailVerifySourceLink'),
        devDetails: summarizeVerifyDetails({ publishedUrl: location.href }),
      });
      return;
    }

    // 否则跳到个人空间页做列表/详情验收
    const m = location.pathname.match(/^\/u\/[^/]+/);
    const base = m ? `${location.origin}${m[0]}?tab=newest` : `${location.origin}/`;
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgOschinaPublishTriggeredGoProfileVerify'),
      devDetails: summarizeVerifyDetails({ listUrl: base }),
    });
    location.href = base;
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
    if (location.hostname === 'www.oschina.net' || isWritePage()) {
      await runFlow(currentJob);
      return;
    }

    if (isMyOschinaPage()) {
      const isDetailPage = /\/blog\/\d+/.test(location.pathname);

      // detail page: 先等正文加载，再验原文链接；避免 document_end 过早回退
      if (isDetailPage) {
        await retryUntil(
          async () => {
            if (pageContainsSourceUrlLoose(currentJob.article.sourceUrl)) return true;
            const text = document.body?.innerText || '';
            if (/待审核|正在审核中|重新编辑|原文链接/.test(text)) return true;
            throw new Error('detail not ready');
          },
          { timeoutMs: 12000, intervalMs: 500 }
        ).catch(() => null);
      }

      // detail page: 直接包含原文链接即可通过，避免先做空间迁移把详情页误跳走
      const containsSource = pageContainsSourceUrlLoose(currentJob.article.sourceUrl);
      if (containsSource) {
        removeSessionValue(getProbeActiveKey(currentJob.jobId));
        removeSessionValue(getProbeKey(currentJob.jobId));
        await report({
          status: 'success',
          stage: 'done',
          userMessage: getMessage('v2MsgVerifyPassedDetailHasSourceLink'),
          devDetails: summarizeVerifyDetails({ publishedUrl: location.href, sourceUrlPresent: true }),
        });
        return;
      }

      // 空间迁移：列表页优先切到实际空间（/u/spaceId），详情页验收失败后只把 canonical path 用于后续列表兜底
      const canonicalSpacePath = detectCanonicalSpacePath();
      const curSpacePath = location.pathname.match(/^\/u\/[^/]+/)?.[0] || null;
      if (!isDetailPage && canonicalSpacePath && curSpacePath && canonicalSpacePath !== curSpacePath) {
        const nextUrl = `${location.origin}${canonicalSpacePath}${location.search || ''}`;
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyOschinaSpaceMigrationSwitchToList'),
          devDetails: { from: location.href, to: nextUrl },
        });
        location.href = nextUrl;
        return;
      }

      const m = location.pathname.match(/^\/u\/[^/]+/);
      const userBasePath = canonicalSpacePath || m?.[0] || null;
      const base = userBasePath ? `${location.origin}${userBasePath}` : null;
      const listUrl = base ? `${base}?tab=newest` : location.href;
      setSessionValue(getListUrlKey(currentJob.jobId), listUrl);

      // 若当前是博客详情页但未命中 sourceUrl，且处于探测模式：返回列表继续探测
      const probeActive = getSessionValue(getProbeActiveKey(currentJob.jobId)) === '1';
      if (/\/blog\/\d+/.test(location.pathname) && probeActive) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyNoSourceOnPageBackToListProbe'),
          devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: location.href, sourceUrlPresent: false }),
        });
        location.href = listUrl;
        return;
      }

      // 确保在 tab=newest 列表页
      if (base && (!location.search.includes('tab=newest') || (userBasePath && location.pathname !== userBasePath))) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifySwitchToBlogList'),
          devDetails: summarizeVerifyDetails({ listUrl }),
        });
        location.href = listUrl;
        return;
      }

      // 应用 q=token 搜索（仅一次，避免循环）
      const token = tokenForSearch(currentJob.article.title);
      const applied = getSessionValue(getSearchAppliedKey(currentJob.jobId)) === '1';
      if (!applied && token && !location.search.includes(`q=${encodeURIComponent(token)}`)) {
        setSessionValue(getSearchAppliedKey(currentJob.jobId), '1');
        const searchUrl = `${listUrl}&q=${encodeURIComponent(token)}`;
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyFilteringBlogListByKeyword'),
          devDetails: summarizeVerifyDetails({ listUrl: searchUrl }),
        });
        location.href = searchUrl;
        return;
      }

      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/blog/"]')).filter((a) => {
        const href = a.href;
        if (!href.includes('/blog/')) return false;
        if (href.includes('/blog/write')) return false;
        const t = (a.textContent || '').trim();
        if (!t) return false;
        if (t.includes('编辑') || t.includes('删除')) return false;
        return true;
      });

      const tokenHit = anchors.find((a) => (a.textContent || '').includes(token));
      if (tokenHit?.href) {
        removeSessionValue(getProbeActiveKey(currentJob.jobId));
        removeSessionValue(getProbeKey(currentJob.jobId));
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyMatchedTokenByKeywordOpeningDetail'),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true, publishedUrl: tokenHit.href }),
        });
        location.href = tokenHit.href;
        return;
      }

      // 兜底探测：依次打开前 5 个详情链接，直到命中 sourceUrl
      setSessionValue(getProbeActiveKey(currentJob.jobId), '1');
      const uniq = Array.from(new Set(anchors.map((a) => a.href))).slice(0, 5);
      const idx = Number(getSessionValue(getProbeKey(currentJob.jobId)) || '0');
      if (idx < uniq.length) {
        setSessionValue(getProbeKey(currentJob.jobId), String(idx + 1));
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyTokenNotMatchedProbingDetails', [String(idx + 1), String(uniq.length)]),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true, publishedUrl: uniq[idx] }),
        });
        location.href = uniq[idx];
        return;
      }

      removeSessionValue(getProbeActiveKey(currentJob.jobId));
      removeSessionValue(getProbeKey(currentJob.jobId));
      {
        const retryKey = getListRetryKey(currentJob.jobId);
        const n = Number(getSessionValue(retryKey) || '0') + 1;
        setSessionValue(retryKey, String(n));
        if (n <= 36) {
          await report({
            status: 'running',
            stage: 'confirmSuccess',
            userMessage: getMessage('v2MsgVerifyListNoNewArticleRefresh3s36', [String(n)]),
            devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
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
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
        });
        return;
      }
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
