/**
 * Feishu Docs Publisher Content Script (V2)
 *
 * Strategy:
 * - Entry page is a fixed Drive folder.
 * - Create a new blank Docx inside the folder.
 * - Fill title + content (append source URL at the end for originality).
 * - Return to folder list and verify the doc is visible, then open the doc and verify source URL exists.
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */

const CHANNEL_ID: ChannelId = 'feishu-docs';

const FEISHU_FOLDER_URL = 'https://wuxinxuexi.feishu.cn/drive/folder/PyWAfSFwrlMgiydvlHectMn2nSd';

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

function getDocUrlKey(jobId: string): string {
  return `bawei_v2_feishu_doc_url_${jobId}`;
}

function setDocUrlForJob(jobId: string, url: string): void {
  try {
    sessionStorage.setItem(getDocUrlKey(jobId), url);
  } catch {
    // ignore
  }
}

function getDocUrlForJob(jobId: string): string | null {
  try {
    return sessionStorage.getItem(getDocUrlKey(jobId));
  } catch {
    return null;
  }
}

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

function buildPlainContent(contentHtml: string, sourceUrl: string): string {
  const plain = htmlToPlainTextSafe(contentHtml);
  const base = plain || '（以下为自动同步内容）';
  const suffix = sourceUrl ? `\n\n原文链接：${sourceUrl}\n` : '';
  return `${base}${suffix}`.trim();
}

function shouldRunOnThisPage(): boolean {
  return location.hostname === 'wuxinxuexi.feishu.cn';
}

function isFolderPage(): boolean {
  return location.hostname === 'wuxinxuexi.feishu.cn' && location.pathname.startsWith('/drive/folder/');
}

function isDocxPage(): boolean {
  return location.hostname === 'wuxinxuexi.feishu.cn' && location.pathname.startsWith('/docx/');
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

function findClickableByText(text: string): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('button,[role="menuitem"],a,div,span,li'));
  return nodes.find((n) => (n.textContent || '').replace(/\s+/g, ' ').trim() === text) || null;
}

function pickClickTarget(el: HTMLElement): HTMLElement {
  // Feishu Drive buttons are often plain divs with internal click handlers.
  if (el.classList.contains('workspace-next-layout-btn-wrapper')) {
    const inner =
      (el.querySelector('[data-selector="workspace-next-create_new_file"]') as HTMLElement | null) ||
      (el.querySelector('[data-selector]') as HTMLElement | null) ||
      null;
    if (inner) return inner;
  }
  return (
    (el.closest('button') as HTMLElement | null) ||
    (el.querySelector('button') as HTMLElement | null) ||
    (el.closest('[role="button"]') as HTMLElement | null) ||
    el
  );
}

function getFolderTokenFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/drive\/folder\/([^/?#]+)/);
    if (m?.[1]) return m[1];
  } catch {
    // ignore
  }
  return '';
}

function getCookieValue(name: string): string {
  try {
    const parts = String(document.cookie || '')
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      if (k !== name) continue;
      return decodeURIComponent(part.slice(idx + 1));
    }
  } catch {
    // ignore
  }
  return '';
}

async function createBlankDocxByApi(folderToken: string, name: string): Promise<string> {
  const body = new URLSearchParams({
    parent_token: folderToken,
    type: '22',
    // Use title as file name so that folder list verification is stable even if doc title sync is delayed.
    name: String(name || '').slice(0, 80),
    time_zone: 'Asia/Shanghai',
    source: '0',
    ua_type: 'Web',
    scene: 'space_create',
    ext_info: JSON.stringify({ platform: 'web' }),
  }).toString();

  const csrfToken = getCookieValue('_csrf_token') || getCookieValue('lgw_csrf_token');

  const res = await fetch('/space/api/explorer/v2/create/object/', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}),
    },
    body,
  });

  type FeishuCreateDocResponse = {
    code?: number;
    msg?: string;
    message?: string;
    data?: {
      entities?: { nodes?: Record<string, { url?: string }> };
      obj_token?: string;
      objToken?: string;
    };
  };

  let data: FeishuCreateDocResponse | null = null;
  try {
    data = (await res.json()) as FeishuCreateDocResponse;
  } catch {
    // ignore
  }
  if (!res.ok) throw new Error(`create doc http ${res.status}`);
  if (data?.code !== 0) throw new Error(`create doc failed: ${data?.msg || data?.message || data?.code || 'unknown'}`);

  const nodes = data?.data?.entities?.nodes;
  if (nodes && typeof nodes === 'object') {
    for (const k of Object.keys(nodes)) {
      const u = nodes?.[k]?.url;
      if (typeof u === 'string' && u.includes('/docx/')) return u;
    }
  }

  const token = data?.data?.obj_token || data?.data?.objToken;
  if (typeof token === 'string' && token) return `https://${location.hostname}/docx/${token}`;

  throw new Error('create doc response missing doc url');
}

async function ensureNewBlankDocxCreated(job: AnyJob): Promise<void> {
  currentStage = 'openEntry';
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgFeishuCreatingBlankDoc') });

  // Prefer API creation to avoid menu click instability and to keep the doc opened in the same tab.
  const folderToken = getFolderTokenFromUrl(location.href) || getFolderTokenFromUrl(FEISHU_FOLDER_URL);
  if (folderToken) {
    try {
      const docUrl = await createBlankDocxByApi(folderToken, job.article.title);
      setDocUrlForJob(job.jobId, docUrl);
      location.href = docUrl;
      return;
    } catch (e) {
      await report({
        status: 'running',
        stage: 'openEntry',
        userMessage: getMessage('v2MsgFeishuApiCreateFailedFallbackUi'),
        devDetails: { message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  // Click header "新建" button (it is not always a real <button>, so use wrapper class + text)
  const newBtn = await retryUntil(
    async () => {
      const el =
        Array.from(document.querySelectorAll<HTMLElement>('.workspace-next-layout-btn-wrapper')).find((n) =>
          (n.textContent || '').replace(/\s+/g, ' ').trim().startsWith('新建')
        ) || findClickableByText('新建');
      if (!el) throw new Error('new button not ready');
      return el;
    },
    { timeoutMs: 60_000, intervalMs: 800 }
  );
  simulateClick(pickClickTarget(newBtn));
  await new Promise((r) => setTimeout(r, 800));

  // Click "文档" entry in the dropdown menu
  const docMenu = await retryUntil(
    async () => {
      const el =
        Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((n) => (n.textContent || '').trim() === '文档') ||
        findClickableByText('文档');
      if (!el) throw new Error('doc menu not ready');
      return el;
    },
    { timeoutMs: 20_000, intervalMs: 600 }
  );
  simulateClick(pickClickTarget(docMenu));
  await new Promise((r) => setTimeout(r, 1200));

  // In template modal, click "新建空白文档"
  const blank = await retryUntil(
    async () => {
      const el = findClickableByText('新建空白文档') || findAnyElementContainingText('新建空白文档');
      if (!el) throw new Error('blank doc entry not ready');
      return el;
    },
    { timeoutMs: 30_000, intervalMs: 800 }
  );
  simulateClick(pickClickTarget(blank));

  // Wait for navigation to /docx/
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (isDocxPage()) {
      setDocUrlForJob(job.jobId, location.href);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('新建文档后未进入 docx 页面（可能被弹窗/拦截）');
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle', userMessage: getMessage('v2MsgFillingTitle') });

  // Best-effort: some Feishu doc layouts do not expose the title as a stable h1. We already set the file name
  // during creation, so title editing is optional and must not block the whole flow.
  const h1 = document.querySelector<HTMLElement>('h1.page-block-title-empty') || document.querySelector<HTMLElement>('h1');
  if (!h1) {
    await report({ status: 'running', stage: 'fillTitle', userMessage: getMessage('v2MsgFeishuTitleAreaNotFoundSkipUseFilename') });
    return;
  }

  simulateClick(h1);
  await new Promise((r) => setTimeout(r, 100));

  // Feishu doc title editing uses selection in the document; keep selection scoped to title node.
  selectContents(h1);
  try {
    document.execCommand('delete', false);
  } catch {
    // ignore
  }
  try {
    document.execCommand('insertText', false, title);
  } catch {
    // ignore
  }
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugFeishuNoSourceFieldAppend'),
  });

  const editor = await retryUntil(
    async () => {
      const el =
        (document.querySelector<HTMLElement>('.zone-container.text-editor') as HTMLElement | null) ||
        (document.querySelector<HTMLElement>('.zone-container.text-editor[contenteditable="true"]') as HTMLElement | null) ||
        (document.querySelector<HTMLElement>('[contenteditable="true"].zone-container.text-editor') as HTMLElement | null) ||
        (findContentEditor(document) as HTMLElement | null);
      if (!el) throw new Error('editor not ready');
      return el;
    },
    { timeoutMs: 60_000, intervalMs: 800 }
  );

  const plain = buildPlainContent(contentHtml, sourceUrl);

  // Feishu Docx blocks execCommand insertText/insertHTML. The stable way is to set innerText and dispatch input events.
  // This also preserves "原创" requirement by appending source URL to the end of the document.
  simulateClick(editor);
  simulateFocus(editor);
  await new Promise((r) => setTimeout(r, 200));
  try {
    editor.innerText = plain;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: plain, inputType: 'insertText' }));
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: plain }));
  } catch {
    // ignore
  }

  // Verify we can observe the source URL in the DOM. (Some accounts may render link cards, so also accept the label.)
  await new Promise((r) => setTimeout(r, 800));
  const ok = pageContainsSourceUrl(sourceUrl) || pageContainsText('原文链接');
  if (!ok) throw new Error('正文填充失败：未检测到“原文链接/原文URL”写入');

  await report({ userMessage: getMessage('v2MsgAppendedSourceLinkKeepOriginal') });
}

async function waitForAutoSave(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const el = document.querySelector<HTMLElement>('.note-title__time');
    const t = (el?.textContent || '').trim();
    // Common states:
    // - "保存中..." -> still saving
    // - "已经保存到云端" -> saved
    // - "最近修改: 刚刚/xx 分钟前" -> saved
    if (t && !t.includes('保存中') && (t.includes('已经保存到云端') || t.includes('已保存到云端') || t.includes('已保存至云端') || t.includes('最近修改'))) {
      return;
    }

    const text = document.body?.innerText || '';
    if (text.includes('已经保存到云端') || text.includes('已保存到云端') || text.includes('已保存至云端') || text.includes('保存成功')) return;
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function runDocxFlow(job: AnyJob): Promise<void> {
  await stageFillTitle(job.article.title);
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl);

  // Feishu docs auto-saves; treat both actions as "created + saved".
  currentStage = job.action === 'draft' ? 'saveDraft' : 'submitPublish';
  await report({
    status: 'running',
    stage: currentStage,
    userMessage: job.action === 'draft' ? getMessage('v2MsgFeishuWaitingAutosaveDraft') : getMessage('v2MsgFeishuWaitingAutosavePublish'),
  });

  await waitForAutoSave();

  await report({
    status: 'running',
    stage: 'confirmSuccess',
    userMessage: getMessage('v2MsgFeishuContentWrittenBackToFolderVerify'),
    devDetails: summarizeVerifyDetails({ listUrl: FEISHU_FOLDER_URL }),
  });
  location.href = FEISHU_FOLDER_URL;
}

async function verifyFromFolder(job: AnyJob): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyFindNewDocInFolderList') });

  // Folder list renders async; wait a bit before deciding "not found", otherwise we may refresh too early and never see the item.
  const waitDeadline = Date.now() + 18_000;
  let found = false;
  while (Date.now() < waitDeadline) {
    if (document.querySelector('a[href*="/docx/"]')) {
      found = pageContainsTitle(job.article.title);
      if (found) break;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }

  if (!found) {
    const key = `bawei_v2_feishu_list_retry_${job.jobId}`;
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
      userMessage: getMessage('v2MsgVerifyFailedFolderListNoTitle'),
      userSuggestion: getMessage('v2SugRefreshListThenContinue'),
      devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
    });
    return;
  }

  sessionStorage.removeItem(`bawei_v2_feishu_list_retry_${job.jobId}`);

  const docUrl = getDocUrlForJob(job.jobId);
  if (docUrl) {
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgVerifyFoundTitleOpeningDocDetail'),
      devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
    });
    location.href = docUrl;
    return;
  }

  await report({
    status: 'waiting_user',
    stage: 'waitingUser',
    userMessage: getMessage('v2MsgVerifyBlockedNoDocLink'),
    userSuggestion: getMessage('v2SugFeishuOpenDocDetailManuallyThenWaitVerify'),
    devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
  });
}

async function verifyFromDocx(job: AnyJob): Promise<void> {
  // Auto-save indicator is the strongest signal that edits are persisted to the cloud.
  const savedText = (document.querySelector<HTMLElement>('.note-title__time')?.textContent || '').trim();
  const isSaved =
    !!savedText &&
    !savedText.includes('保存中') &&
    (savedText.includes('已经保存到云端') ||
      savedText.includes('已保存到云端') ||
      savedText.includes('已保存至云端') ||
      savedText.includes('最近修改'));
  const ok = (pageContainsSourceUrl(job.article.sourceUrl) || pageContainsText('原文链接')) && isSaved;
  await report({
    status: ok ? 'success' : 'waiting_user',
    stage: ok ? 'done' : 'waitingUser',
    userMessage: ok ? getMessage('v2MsgVerifyPassedSavedToCloudAndHasSource') : getMessage('v2MsgVerifyFailedNoSavedToCloudOrSource'),
    userSuggestion: ok ? undefined : getMessage('v2SugFeishuConfirmSavedToCloudAndSourceThenContinue'),
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

    if (isFolderPage()) {
      // If we are back from docx editing, we should verify list; otherwise create a docx first.
      if (getDocUrlForJob(currentJob.jobId)) {
        await verifyFromFolder(currentJob);
      } else {
        await ensureNewBlankDocxCreated(currentJob);
      }
      return;
    }

    if (isDocxPage()) {
      // If not filled yet for this job, fill; otherwise verify.
      const filledKey = `bawei_v2_feishu_filled_${currentJob.jobId}`;
      const hasFilled = sessionStorage.getItem(filledKey) === '1';
      if (!hasFilled) {
        sessionStorage.setItem(filledKey, '1');
        await runDocxFlow(currentJob);
      } else {
        await verifyFromDocx(currentJob);
      }
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
