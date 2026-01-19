/**
 * CSDN Publisher Content Script (V2)
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */

const CHANNEL_ID: ChannelId = 'csdn';

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

function getEditorIdFromUrl(): string | null {
  const m = location.pathname.match(/\/mp_blog\/creation\/editor\/(\d+)/);
  return m?.[1] || null;
}

function setEditorIdForJob(jobId: string, editorId: string): void {
  try {
    sessionStorage.setItem(`bawei_v2_csdn_editor_id_${jobId}`, editorId);
  } catch {
    // ignore
  }
}

function getEditorIdForJob(jobId: string): string | null {
  try {
    return sessionStorage.getItem(`bawei_v2_csdn_editor_id_${jobId}`);
  } catch {
    return null;
  }
}

function setPublishedUrlForJob(jobId: string, url: string): void {
  try {
    sessionStorage.setItem(`bawei_v2_csdn_published_url_${jobId}`, url);
  } catch {
    // ignore
  }
}

function getPublishedUrlForJob(jobId: string): string | null {
  try {
    return sessionStorage.getItem(`bawei_v2_csdn_published_url_${jobId}`);
  } catch {
    return null;
  }
}

function pressEnter(target: HTMLElement): void {
  const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' });
  const press = new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' });
  const up = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' });
  target.dispatchEvent(down);
  target.dispatchEvent(press);
  target.dispatchEvent(up);
}

function pressEscape(): void {
  const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape' });
  const up = new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape' });
  document.dispatchEvent(down);
  document.dispatchEvent(up);
}

function compactKeyword(title: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim();
  const stripped = normalized
    .replace(
      /[\s\u00A0·`~!@#$%^&*()_+\-={}[\]|\\:;"'<>,.?/！￥…（）—【】‘’“”，。、《》？：；]/g,
      ''
    )
    .trim();
  return (stripped || normalized).slice(0, 16);
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

function getProbeIndexFromWindowName(jobId: string): number {
  const raw = String(window.name || '');
  const prefix = `bawei_v2_csdn_probe:${jobId}:`;
  if (!raw.startsWith(prefix)) return 0;
  const n = Number(raw.slice(prefix.length));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function setProbeIndexInWindowName(jobId: string, nextIndex: number): void {
  try {
    window.name = `bawei_v2_csdn_probe:${jobId}:${String(nextIndex)}`;
  } catch {
    // ignore
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function isElementDisplayed(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
}

function withSourceUrlAppended(contentHtml: string, sourceUrl: string): string {
  const safe = escapeAttr(sourceUrl);
  return `${contentHtml}\n<p><br/></p><p>原文链接：<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a></p>`;
}

function shouldRunOnThisPage(): boolean {
  return location.hostname === 'mp.csdn.net' || location.hostname.endsWith('.csdn.net');
}

function isEditorPage(): boolean {
  return location.hostname === 'mp.csdn.net' && location.pathname.startsWith('/mp_blog/creation/editor');
}

function isSuccessPage(): boolean {
  return location.hostname === 'mp.csdn.net' && location.pathname.startsWith('/mp_blog/creation/success');
}

function isManagePage(): boolean {
  return location.hostname === 'mp.csdn.net' && location.pathname.startsWith('/mp_blog/manage');
}

function isDetailPage(): boolean {
  return location.hostname === 'blog.csdn.net';
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

function getSuccessArticleIdFromUrl(): string | null {
  const m = location.pathname.match(/\/mp_blog\/creation\/success\/(\d+)/);
  return m?.[1] || null;
}

async function handleSuccessPage(job: AnyJob): Promise<void> {
  currentStage = 'confirmSuccess';
  const articleId = getSuccessArticleIdFromUrl();
  await report({
    status: 'running',
    stage: 'confirmSuccess',
    userMessage: getMessage('v2MsgDetectedSuccessPageGetDetailLinkVerify'),
    devDetails: summarizeVerifyDetails({ publishedUrl: getPublishedUrlForJob(job.jobId) || undefined }),
  });

  try {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a')).filter((a) => !!a.href);
    const byText = links.find((a) => (a.textContent || '').trim().includes('查看文章'));
    const byHref = links.find((a) => a.href.includes('blog.csdn.net') && a.href.includes('/article/details/'));
    const picked = byText?.href || byHref?.href || null;
    if (picked) {
      setPublishedUrlForJob(job.jobId, picked);
    } else if (articleId) {
      // 兜底：success 页未取到“查看文章”链接时，仍继续走列表探测流程（按标题 token / editorId / browse links）
      setPublishedUrlForJob(job.jobId, `https://blog.csdn.net/article/details/${articleId}`);
    }
  } catch {
    // ignore
  }

  await report({
    status: 'running',
    stage: 'confirmSuccess',
    userMessage: getMessage('v2MsgGoManageListVerify'),
    devDetails: summarizeVerifyDetails({ listUrl: 'https://mp.csdn.net/mp_blog/manage/article' }),
  });
  location.href = 'https://mp.csdn.net/mp_blog/manage/article';
}

async function verifyFromManagePage(job: AnyJob): Promise<void> {
  currentStage = 'confirmSuccess';
  const listUrl = `${location.origin}${location.pathname}${location.search}`;
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyFindNewArticleInList') });

  // 文章管理页 tab：必须精确点击 role=tab
  const tabOrder = ['已发布', '全部', '审核中/未通过', '草稿箱'];
  for (const name of tabOrder) {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
    const tab = tabs.find((t) => (t.textContent || '').trim().startsWith(name));
    if (tab) {
      try {
        simulateClick(tab);
        await new Promise((r) => setTimeout(r, 800));
      } catch {
        // ignore
      }
    }
    if (pageContainsTitle(job.article.title)) break;
  }

  // 使用关键词搜索（titleToken）
  const searchInput = document.querySelector<HTMLInputElement>('input[placeholder="请输入关键词"]');
  if (searchInput) {
    try {
      const keyword = compactKeyword(job.article.title);
      simulateFocus(searchInput);
      simulateType(searchInput, keyword);
      // CSDN 管理页搜索通常需要点放大镜图标触发，Enter 不一定生效
      pressEnter(searchInput);
      const icon =
        (searchInput.parentElement?.querySelector('img') as HTMLElement | null) ||
        (searchInput.closest('div')?.querySelector('img') as HTMLElement | null);
      if (icon) simulateClick((icon.parentElement as HTMLElement) || icon);
      await new Promise((r) => setTimeout(r, 1500));
    } catch {
      // ignore
    }
  }

  // 等待列表加载（异步渲染）
  try {
    await retryUntil(
      async () => {
        const hasEditorLinks = document.querySelectorAll('a[href^="/mp_blog/creation/editor/"]').length > 0;
        const hasBrowseLinks = document.querySelectorAll('a[href*="blog.csdn.net"][href*="/article/details/"]').length > 0;
        if (!hasEditorLinks && !hasBrowseLinks) throw new Error('list not ready');
        return true;
      },
      { timeoutMs: 12000, intervalMs: 600 }
    );
  } catch {
    // ignore（走后续刷新策略）
  }

  const editorId = getEditorIdForJob(job.jobId);
  const publishedUrl = getPublishedUrlForJob(job.jobId);
  const publishedId = publishedUrl ? publishedUrl.match(/\/article\/details\/(\d+)/)?.[1] || null : null;

  if (publishedUrl) {
    const direct = document.querySelector<HTMLAnchorElement>(`a[href="${publishedUrl}"]`);
    if (direct?.href) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgVerifyFoundPublishedDetailLinkOpeningDetail'),
        devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: direct.href }),
      });
      location.href = `${direct.href}${buildBackHash(job.jobId, listUrl)}`;
      return;
    }
  }

  const editorLink = editorId
    ? (document.querySelector<HTMLAnchorElement>(`a[href="/mp_blog/creation/editor/${editorId}"]`) as HTMLAnchorElement | null)
    : null;

  const token = compactKeyword(job.article.title);
  const byToken =
    Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/mp_blog/creation/editor/"]')).find((a) =>
      ((a.textContent || '') + ' ' + (a.getAttribute('title') || '')).includes(token)
    ) || null;

  const rowAnchor = editorLink || byToken;
  const row = (rowAnchor?.closest('div') as HTMLElement | null) || null;
  const browseLink = row
    ? Array.from(row.querySelectorAll<HTMLAnchorElement>('a')).find((a) => (a.href || '').includes('blog.csdn.net') && (a.href || '').includes('/article/details/')) ||
      null
    : null;

  if (browseLink?.href) {
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgVerifyFoundNewArticleOpeningDetail'),
      devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: browseLink.href }),
    });
    location.href = `${browseLink.href}${buildBackHash(job.jobId, listUrl)}`;
    return;
  }

  // 兜底探测：从列表页取前 5 个“浏览”链接，逐个打开详情检查 sourceUrl
  let browseLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="blog.csdn.net"][href*="/article/details/"]')).map((a) => a.href);
  if (publishedId) {
    // 优先把已知 articleId 放到队首
    const prefer = browseLinks.filter((u) => u.includes(`/article/details/${publishedId}`));
    const rest = browseLinks.filter((u) => !u.includes(`/article/details/${publishedId}`));
    browseLinks = [...prefer, ...rest];
  }
  const uniqBrowse = Array.from(new Set(browseLinks)).slice(0, 12);
  if (uniqBrowse.length) {
    const idx = getProbeIndexFromWindowName(job.jobId);
    if (idx < uniqBrowse.length) {
      setProbeIndexInWindowName(job.jobId, idx + 1);
      const backWithNextProbe = `${listUrl}#bawei_v2=1&job=${encodeURIComponent(job.jobId)}`;
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgVerifyNotFoundNewArticleProbingDetails', [String(idx + 1), String(uniqBrowse.length)]),
        devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: uniqBrowse[idx] }),
      });
      location.href = `${uniqBrowse[idx]}${buildBackHash(job.jobId, backWithNextProbe)}`;
      return;
    }
  }

  // 探测结束（probe idx 已超过范围），清理 probe hash 并走刷新/失败逻辑
  setProbeIndexInWindowName(job.jobId, 0);

  {
    const key = 'bawei_v2_csdn_list_retry';
    const n = Number(sessionStorage.getItem(key) || '0') + 1;
    sessionStorage.setItem(key, String(n));
    if (n <= 36) {
      const strategyLabel = editorId ? getMessage('v2CsdnVerifyByEditorIdLabel') : getMessage('v2CsdnVerifyByTitleTokenLabel');
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgCsdnVerifyListNoNewArticleRefresh5s36', [strategyLabel, String(n)]),
        devDetails: summarizeVerifyDetails({ listUrl, listVisible: false }),
      });
      setTimeout(() => location.reload(), 5000);
      return;
    }

    sessionStorage.removeItem(key);
    await report({
      status: 'waiting_user',
      stage: 'waitingUser',
      userMessage: getMessage('v2MsgVerifyFailedListStillNoNewArticle'),
      userSuggestion: getMessage('v2SugCsdnConfirmPublishThenRefreshOrWaitReview'),
      devDetails: summarizeVerifyDetails({ listUrl, listVisible: false }),
    });
    return;
  }

}

async function verifyFromDetailPage(job: AnyJob): Promise<void> {
  currentStage = 'confirmSuccess';
  const publishedUrl = location.href;
  const ok = pageContainsSourceUrl(job.article.sourceUrl);
  const backUrl = parseBackUrlFromHash();
  if (!ok && backUrl) {
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgVerifyNoSourceOnPageBackToListProbe'),
      devDetails: summarizeVerifyDetails({ listUrl: backUrl, listVisible: true, publishedUrl, sourceUrlPresent: false }),
    });
    location.href = backUrl;
    return;
  }
  await report({
    status: ok ? 'success' : 'waiting_user',
    stage: ok ? 'done' : 'waitingUser',
    userMessage: ok ? getMessage('v2MsgVerifyPassedDetailHasSourceLink') : getMessage('v2MsgVerifyFailedDetailNoSourceLink'),
    userSuggestion: ok ? undefined : getMessage('v2SugCheckSourceLinkAtEndThenContinue'),
    devDetails: summarizeVerifyDetails({ publishedUrl, sourceUrlPresent: ok }),
  });
}

async function stageDetectLogin(): Promise<void> {
  currentStage = 'detectLogin';
  await report({ status: 'running', stage: 'detectLogin' });
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle' });

  const selector =
    '#txtTitle, textarea[placeholder*="请输入文章标题"], textarea[placeholder*="请输入文章标题（5～100个字）"], input[placeholder*="标题"], textarea[placeholder*="标题"]';

  let input: HTMLInputElement | HTMLTextAreaElement | null = null;
  try {
    input = (await waitForElement(selector, 20000)) as HTMLInputElement | HTMLTextAreaElement;
  } catch {
    input = (document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null) || null;
  }

  if (!input) {
    await report({
      status: 'failed',
      stage: 'fillTitle',
      userMessage: getMessage('v2MsgFailedTitleInputNotFound'),
      userSuggestion: getMessage('v2SugWaitEditorLoadThenRetry'),
      devDetails: {
        url: location.href,
        readyState: document.readyState,
        titleNodes: {
          txtTitle: !!document.querySelector('#txtTitle'),
          textareaCount: document.querySelectorAll('textarea').length,
          inputCount: document.querySelectorAll('input').length,
        },
      },
    });
    throw new Error('未找到标题输入框');
  }
  simulateFocus(input);
  simulateType(input, title);
}

async function stageEnsureOriginal(): Promise<void> {
  await report({ status: 'running', stage: currentStage, userMessage: getMessage('v2MsgSettingOriginalType') });

  // 优先点击“原创”选项（避免误选转载）
  const exact = Array.from(document.querySelectorAll<HTMLElement>('label,span,div')).find((n) => (n.textContent || '').trim() === '原创');
  if (exact) {
    const clickable =
      (exact.closest('label') as HTMLElement | null) ||
      (exact.closest('div') as HTMLElement | null) ||
      (exact as HTMLElement);
    simulateClick(clickable);
    await new Promise((r) => setTimeout(r, 300));
    return;
  }

  // 兜底：radio 容器文本包含“原创”
  const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  for (const r of radios) {
    const container = r.closest('label') || r.closest('div') || r.parentElement;
    const text = (container?.textContent || '').trim();
    if (text.includes('原创') && !text.includes('转载')) {
      simulateClick((container as HTMLElement) || r);
      await new Promise((rr) => setTimeout(rr, 300));
      return;
    }
  }
}

async function stageEnsureOneTag(): Promise<void> {
  await report({ status: 'running', stage: currentStage, userMessage: getMessage('v2MsgSettingTags') });

  try {
    const hidden = document.querySelector<HTMLInputElement>('input[name="tags"][type="hidden"]');
    if (hidden?.value && hidden.value.trim() && hidden.value !== '[]') return;
  } catch {
    // ignore
  }

  // CSDN 标签选择：先点“添加文章标签”打开面板，再选择一个推荐标签
  const addBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((n) => (n.textContent || '').trim() === '添加文章标签');
  if (!addBtn) return;

  try {
    simulateClick(addBtn);
  } catch {
    // ignore
  }

  // 等待标签面板输入框出现
  try {
    await waitForElement('input[placeholder*="请输入文字搜索"], input[placeholder*="Enter键入可添加自定义标签"]', 8000);
  } catch {
    // ignore
  }

  // 优先点击推荐里的一个标签（避免自定义输入不生效）
  const pick = (label: string): boolean => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('div,span,li,a')).find((n) => (n.textContent || '').trim() === label);
    if (!el) return false;
    try {
      simulateClick(el);
      return true;
    } catch {
      return false;
    }
  };

  pick('html') || pick('前端') || pick('javascript') || pick('java') || pick('react') || pick('vue') || pick('面试');

  // 兜底：在搜索框里输入“前端”并回车
  try {
    const input = document.querySelector<HTMLInputElement>('input[placeholder*="请输入文字搜索"]');
    if (input) {
      simulateFocus(input);
      simulateType(input, '前端');
      pressEnter(input);
    }
  } catch {
    // ignore
  }

  await new Promise((r) => setTimeout(r, 500));
  pressEscape();
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugIfNoSourceFieldAppendToEnd'),
  });

  // 尝试同步填写“原文链接”字段（即使原创模式也可能展示在详情页）
  try {
    const sourceInput =
      (document.querySelector('input[placeholder="请填写原文链接"]') as HTMLInputElement | null) ||
      (document.querySelector('input[placeholder*="原文链接"]') as HTMLInputElement | null);
    if (sourceInput) {
      simulateFocus(sourceInput);
      simulateType(sourceInput, sourceUrl);
    }
  } catch {
    // ignore
  }

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
    const instRaw = (ck?.instances as Record<string, unknown> | undefined)?.editor;
    const inst = instRaw as CkEditorInstance | undefined;
    if (inst && typeof inst.setData === 'function') {
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
      await report({
        userMessage: getMessage('v2MsgContentWrittenByCkeditorSourceAppended'),
        userSuggestion: getMessage('v2SugFillSourceFieldManually'),
      });
      return;
    }
  } catch {
    // ignore
  }

  // CSDN 富文本编辑器（CKEditor）通常使用 iframe 承载可编辑 body
  const ckIframe = (await (async () => {
    try {
      return (await waitForElement<HTMLIFrameElement>('#cke_editor iframe.cke_wysiwyg_frame, iframe.cke_wysiwyg_frame', 15000)) as
        | HTMLIFrameElement
        | null;
    } catch {
      return null;
    }
  })()) as HTMLIFrameElement | null;

  // 等待 iframe body 就绪（避免 document_end 时机过早）
  if (ckIframe) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (ckIframe.contentDocument?.body) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (ckIframe?.contentDocument?.body) {
    ckIframe.contentDocument.body.innerHTML = html;
    ckIframe.contentDocument.body.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    await report({
      userMessage: getMessage('v2MsgAppendedSourceLinkNoSourceFieldInOriginalMode'),
      userSuggestion: getMessage('v2SugFillSourceFieldManually'),
    });
    return;
  }

  const editor = findContentEditor(document);
  if (!editor) throw new Error('未找到内容编辑器（可能是编辑器尚未加载）');

  simulateFocus(editor);

  try {
    document.execCommand('selectAll', false);
    document.execCommand('insertHTML', false, html);
  } catch {
    editor.innerHTML = html;
  }

  await report({
    userMessage: getMessage('v2MsgAppendedSourceLinkNoSourceFieldInOriginalMode'),
    userSuggestion: getMessage('v2SugFillSourceFieldManually'),
  });
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSavingDraftToGenerateId') });
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').includes('保存草稿')) as HTMLButtonElement | undefined;
  if (!btn) throw new Error('未找到保存草稿按钮');
  try {
    simulateClick(btn);
  } catch {
    btn.click();
  }
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgTryingToPublish') });
  // CSDN 真正提交发布通常是“发布博客”（底部按钮）
  const publishBlogCandidates = Array.from(document.querySelectorAll<HTMLElement>('button,a,div'))
    .filter((n) => isElementDisplayed(n))
    .filter((n) => ((n.textContent || '').trim() || '').includes('发布博客'));
  const publishBlog = publishBlogCandidates.length ? publishBlogCandidates[0] : undefined;

  // 顶部“发布文章”通常只是展开发布设置，不一定提交
  const publishArticleCandidates = Array.from(document.querySelectorAll<HTMLElement>('button,div[role="button"],a,div,span'))
    .filter((n) => isElementDisplayed(n))
    .filter((n) => ((n.textContent || '').trim() || '').includes('发布文章'));
  const publishArticle = publishArticleCandidates.length ? publishArticleCandidates[0] : undefined;

  const raw = publishBlog || publishArticle;
  if (!raw) throw new Error('未找到发布按钮（发布博客/发布文章）');
  const btn =
    (raw.closest('button') as HTMLElement | null) ||
    (raw.getAttribute('role') === 'button' ? raw : null) ||
    (raw as HTMLElement);
  try {
    simulateClick(btn);
  } catch {
    // ignore
  }
  try {
    (btn as HTMLElement).click();
  } catch {
    // ignore
  }

  // 若出现确认弹窗（例如“确认发布/确定发布”），尝试自动确认
  await new Promise((r) => setTimeout(r, 500));
  const isVisible = isElementDisplayed;

  const preferRoots = [
    ...Array.from(document.querySelectorAll('[role="dialog"]')),
    ...Array.from(document.querySelectorAll('.el-dialog, .el-message-box, .modal, .dialog')),
  ];

  const roots = preferRoots.length ? preferRoots : [document.body];
  const confirmTexts = ['确认发布', '确定发布', '确认', '确定', '发布', '提交', '继续发布'];

  for (const root of roots) {
    const btns = Array.from(root.querySelectorAll('button, a, div')).filter(isVisible);
    const hit = btns.find((n) => {
      const t = (n.textContent || '').trim();
      return confirmTexts.some((x) => t === x || t.includes(x));
    });
    if (hit) {
      simulateClick(hit);
      break;
    }
  }
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  const okTexts =
    action === 'draft'
      ? ['草稿', '保存成功', '已保存']
      : ['发布成功', '已发布', '提交成功'];

  const deadline = Date.now() + 15000;
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

async function stageEnsureDraftId(job: AnyJob): Promise<void> {
  if (job.action !== 'publish') return;
  // 避免短时间内反复触发保存草稿
  try {
    const key = `bawei_v2_csdn_draft_id_last_try_${job.jobId}`;
    const last = Number(sessionStorage.getItem(key) || '0');
    if (last && Date.now() - last < 20000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // ignore
  }

  const existing = getEditorIdFromUrl() || getEditorIdForJob(job.jobId);
  if (existing) {
    setEditorIdForJob(job.jobId, existing);
    return;
  }

  try {
    await stageSaveDraft();
  } catch {
    return;
  }

  try {
    await retryUntil(
      async () => {
        const editorId = getEditorIdFromUrl();
        if (editorId) {
          setEditorIdForJob(job.jobId, editorId);
          return true;
        }
        throw new Error('editor id not ready');
      },
      { timeoutMs: 20000, intervalMs: 800 }
    );
  } catch {
    // ignore
  }
}

async function runFlow(job: AnyJob): Promise<void> {
  await stageDetectLogin();
  await stageFillTitle(job.article.title);
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl);

  if (job.action === 'draft') {
    await stageSaveDraft();
    await stageConfirmSuccess('draft');
  } else {
    // 新建文章首次打开可能是 /editor（无ID），先保存草稿以生成 editorId，避免发布卡住
    await stageEnsureDraftId(job);
    await stageEnsureOriginal();
    await stageEnsureOneTag();
    await stageSubmitPublish();

    // 等待页面跳转（成功页/详情页）或后台处理一小段时间，然后进入列表验收闭环
    await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgPublishClickedWaitingRedirectOrIndex') });
    await new Promise((r) => setTimeout(r, 15000));

    // 自动跳转到列表页进行验收（需 manifest 覆盖 manage 页）
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgPublishTriggeredGoManageListVerify'),
      devDetails: summarizeVerifyDetails({ listUrl: 'https://mp.csdn.net/mp_blog/manage/article' }),
    });
    location.href = 'https://mp.csdn.net/mp_blog/manage/article';
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
    await report({ status: 'running', stage: 'init', userMessage: getMessage('v2MsgEnteredPage') });

    if (isEditorPage()) {
      const editorId = getEditorIdFromUrl();
      if (editorId) setEditorIdForJob(currentJob.jobId, editorId);
      await runFlow(currentJob);
      return;
    }

    if (isSuccessPage()) {
      await handleSuccessPage(currentJob);
      return;
    }

    if (isManagePage()) {
      await verifyFromManagePage(currentJob);
      return;
    }

    if (isDetailPage()) {
      await verifyFromDetailPage(currentJob);
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
