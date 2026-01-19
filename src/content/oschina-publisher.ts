/**
 * OSCHINA Publisher Content Script (V2)
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */

const CHANNEL_ID: ChannelId = 'oschina';

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
  if (location.hostname === 'www.oschina.net' && location.pathname.startsWith('/blog/write')) return true;
  if (location.hostname === 'my.oschina.net') return true; // list/detail/write 都在此域
  return false;
}

function isWritePage(): boolean {
  return location.hostname === 'my.oschina.net' && /\/blog\/write/.test(location.pathname);
}

function isLandingWritePage(): boolean {
  return location.hostname === 'www.oschina.net' && location.pathname.startsWith('/blog/write');
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

async function ensureEditorPage(): Promise<void> {
  if (location.hostname !== 'www.oschina.net') return;
  if (!location.pathname.startsWith('/blog/write')) return;

  // /blog/write 是入口页：需要跳转到 my.oschina.net 的个人空间写作页
  const target = await retryUntil(
    async () => {
      const direct = document.querySelector<HTMLAnchorElement>('a[href*="my.oschina.net"][href*="/blog/write"]');
      if (direct?.href) return direct;

      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
      const byText = anchors.find((a) => ((a.textContent || '').trim() || '').includes('写博客'));
      if (byText?.href) return byText;

      // 有些情况下入口是按钮/卡片，先点一下触发跳转
      const maybe = Array.from(document.querySelectorAll<HTMLElement>('button,a,div')).find((n) =>
        ((n.textContent || '').trim() || '').includes('写博客')
      );
      if (maybe) return maybe;

      throw new Error('write entry not ready');
    },
    { timeoutMs: 20000, intervalMs: 400 }
  );

  if (target instanceof HTMLAnchorElement && target.href) {
    location.href = target.href;
    return;
  }

  try {
    simulateClick(target as unknown as HTMLElement);
  } catch {
    (target as unknown as HTMLElement).click();
  }
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle' });
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

  const html = withSourceUrlAppended(contentHtml, sourceUrl);

  // 优先通过 CKEDITOR API 写入（仅改 iframe body 可能不会更新编辑器状态）
  try {
    type CkEditorInstance = {
      setData: (data: string, opts?: { callback?: () => void }) => void;
      fire?: (eventName: string) => void;
      updateElement?: () => void;
    };
    type CkEditorGlobal = { instances?: Record<string, unknown> };

    const ck = (window as Window & { CKEDITOR?: CkEditorGlobal }).CKEDITOR;
    const instances = ck?.instances ? Object.values(ck.instances) : [];
    const inst =
      instances.find((x): x is CkEditorInstance => {
        const candidate = x as Partial<CkEditorInstance> | null;
        return !!candidate && typeof candidate.setData === 'function';
      }) || null;
    if (inst) {
      await new Promise<void>((resolve) => {
        try {
          inst.setData(html, { callback: resolve });
        } catch {
          resolve();
        }
      });
      try {
        if (typeof inst.fire === 'function') inst.fire('change');
        if (typeof inst.updateElement === 'function') inst.updateElement();
      } catch {
        // ignore
      }
      await report({ userMessage: getMessage('v2MsgContentWrittenByCkeditorSourceAppended') });
      // 同步隐藏 textarea，避免发布时仍提交旧值（content script 可能无法直接访问 page world 的 CKEDITOR）
      try {
        const ta = document.querySelector<HTMLTextAreaElement>('textarea[name="body"], textarea#body');
        if (ta) {
          ta.value = html;
          ta.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }
      } catch {
        // ignore
      }
      return;
    }
  } catch {
    // ignore
  }

  // 回退：直接写入 iframe body
  const iframe = (await waitForElement<HTMLIFrameElement>('iframe.cke_wysiwyg_frame, iframe', 15000)) as HTMLIFrameElement;

  // 等待 iframe body 可写（避免 document_end 时机过早）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (iframe?.contentDocument?.body) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!iframe?.contentDocument?.body) throw new Error('未找到正文编辑器（iframe 未就绪）');

  iframe.contentDocument.body.innerHTML = html;
  iframe.contentDocument.body.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));

  // CKEditor 4 的原始字段通常是 textarea[name=body]，仅改 iframe 可能导致提交内容仍为空/旧值
  try {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea[name="body"], textarea#body');
    if (ta) {
      ta.value = html;
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }
  } catch {
    // ignore
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
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('button,a,div'));
      const byText = (text: string) => nodes.find((n) => (n.textContent || '').trim() === text) || null;
      const btn = byText('确认并发布') || byText('确认发布') || null;
      if (!btn) throw new Error('confirm not ready');
      return btn;
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
      : ['发布成功', '已发布', '提交成功'];

  const deadline = Date.now() + 20000;
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
    userMessage: action === 'draft' ? getMessage('v2MsgPleaseConfirmDraftSaved') : getMessage('v2MsgPleaseConfirmPublishCompleted'),
    userSuggestion: getMessage('v2SugHandleModalRiskRequiredThenContinueOrRetry'),
  });
}

async function runFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredEditorPage') });
  await ensureEditorPage();

  if (location.hostname === 'www.oschina.net') {
    await report({
      status: 'running',
      stage: 'openEntry',
      userMessage: getMessage('v2MsgOschinaGoProfileWriteBlogPage'),
    });

    // 给入口页充分时间渲染/跳转；若仍卡住再提示手动处理
    setTimeout(() => {
      try {
        if (location.hostname !== 'www.oschina.net') return;
        void report({
          status: 'waiting_user',
          stage: 'waitingUser',
          userMessage: getMessage('v2MsgOschinaStillOnEntryNeedWriteBlogOrRelogin'),
          userSuggestion: getMessage('v2SugOschinaLoginThenClickWriteBlogThenContinue'),
        });
      } catch {
        // ignore
      }
    }, 60_000);
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
    if (isLandingWritePage()) {
      await runFlow(currentJob);
      return;
    }
    if (isWritePage()) {
      await runFlow(currentJob);
      return;
    }

    if (isMyOschinaPage()) {
      // 空间迁移：如果当前在旧空间（/u/账号ID），优先切到实际空间（/u/spaceId）
      const canonicalSpacePath = detectCanonicalSpacePath();
      const curSpacePath = location.pathname.match(/^\/u\/[^/]+/)?.[0] || null;
      if (canonicalSpacePath && curSpacePath && canonicalSpacePath !== curSpacePath) {
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

      // detail page: 直接包含原文链接即可通过
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

      const m = location.pathname.match(/^\/u\/[^/]+/);
      const userBasePath = m?.[0] || null;
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
