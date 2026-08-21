/**
 * OSCHINA Publisher Content Script (V2)
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:channel-config */
/* INLINE:publish-verify */
/* INLINE:rich-content */
/* INLINE:image-bridge */

const CHANNEL_ID: ChannelId = 'oschina';
const OSCHINA_DIRECT_WRITE_ENTRY_URL = 'https://my.oschina.net/blog/ai-write';

type AnyJob = Pick<PublishJob, 'jobId' | 'action' | 'article' | 'stoppedAt'>;
type OschinaContentToken =
  | { kind: 'html'; html: string }
  | { kind: 'image'; src: string; alt?: string };
type OschinaEditorCommand =
  | 'ensure-editor'
  | 'reset'
  | 'insert-html'
  | 'replace-html'
  | 'focus-end'
  | 'upload-image';
type OschinaImageFilePayload = {
  name: string;
  type: string;
  base64: string;
  marker?: string;
};

let currentJob: AnyJob | null = null;
let currentStage: ChannelRuntimeState['stage'] = 'init';
let stopRequested = false;

(
  globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }
).__BAWEI_V2_IS_STOP_REQUESTED = () => stopRequested;

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
  return location.hostname === 'my.oschina.net' && /\/blog\/(?:ai-)?write/.test(location.pathname);
}

function isMyOschinaPage(): boolean {
  return location.hostname === 'my.oschina.net' && !/\/blog\/(?:ai-)?write/.test(location.pathname);
}

function detectCanonicalWriteUrl(): string | null {
  try {
    const a = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find((x) => {
      const text = (x.textContent || '').trim();
      if (!text.includes('写博客')) return false;
      return /\/u\/[^/]+\/blog\/(?:ai-)?write/.test(x.href);
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
      return /\/blog\/(?:ai-)?write/.test(href);
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
    patch
  });
}

async function getContextFromBackground(): Promise<{ job: AnyJob; channelId: string }> {
  const res = await chrome.runtime.sendMessage({ type: V2_GET_CONTEXT });
  if (!res?.success) throw new Error(res?.error || 'get context failed');
  return { job: res.job, channelId: res.channelId };
}

function getCurrentLoginState() {
  return detectPageLoginState({
    loginUrlPattern: /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i,
    strictLoginPattern: /请先登录后继续|请登录后操作|登录后继续|账号登录|密码登录|扫码登录/i,
    loggedInPattern: /写博客|我的博客|博客广场|动弹|消息|设置|个人空间|退出登录|我的主页/i
  });
}

async function stageDetectLogin(): Promise<void> {
  currentStage = 'detectLogin';
  await report({
    status: 'running',
    stage: 'detectLogin',
    userMessage: getMessage('v3MsgDetectingLogin')
  });

  const loginState = getCurrentLoginState();

  if (loginState.status === 'not_logged_in') {
    await report({
      status: 'not_logged_in',
      stage: 'detectLogin',
      userMessage: getMessage('v3MsgNotLoggedIn'),
      userSuggestion: getMessage('v3SugLoginThenRetry')
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
          devDetails: { reason: 'oschina-www-entry-loop', attempts: n, currentUrl: location.href }
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
        devDetails: { from: location.href, to: target }
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
        const direct = document.querySelector<HTMLAnchorElement>(
          'a[href*="my.oschina.net"][href*="/blog/write"]'
        );
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
    devDetails: { from: location.href, to: fallback, reason: 'fallback-direct-write-entry' }
  });
  location.href = fallback;
  return true;
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle' });
  dismissGuideDrawer();
  const input = (await waitForElement(
    'input.title-input[placeholder="请输入文章标题"], input[name="title"], input[placeholder*="文章标题"]',
    15000
  )) as HTMLInputElement;
  simulateFocus(input);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (typeof setter === 'function') setter.call(input, title);
  else input.value = title;
  input.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: title,
      inputType: 'insertText'
    })
  );
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (String(input.value || '').trim() !== String(title || '').trim()) {
    throw new Error('OSCHINA 标题写入未生效');
  }
}

async function ensureOschinaEditorReady(): Promise<void> {
  currentStage = 'openEntry';
  await report({
    status: 'running',
    stage: 'openEntry',
    userMessage: getMessage('v2MsgEnteredEditorPage')
  });
  const result = await executeOschinaEditorCommand('ensure-editor');
  await retryUntil(
    async () => {
      const title = document.querySelector<HTMLInputElement>(
        'input.title-input[placeholder="请输入文章标题"], input[name="title"], input[placeholder*="文章标题"]'
      );
      const editor = document.querySelector<HTMLElement>(
        '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"].aie-content'
      );
      if (!title || !editor) throw new Error('OSCHINA 编辑器仍未就绪');
      return true;
    },
    { timeoutMs: 30_000, intervalMs: 300 }
  );
  if (result.recoveredLegacyRuntime === true) {
    await report({
      status: 'running',
      stage: 'openEntry',
      devDetails: { recoveredLegacyRuntime: true }
    });
  }
}

async function executeOschinaEditorCommand(
  command: OschinaEditorCommand,
  html = '',
  imageFile?: OschinaImageFilePayload
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown>;
  try {
    result = await executeOschinaEditorCommandViaPageBridge(command, html, imageFile);
  } catch (bridgeError) {
    const response = (await chrome.runtime.sendMessage({
      type: V3_EXECUTE_MAIN_WORLD,
      action: 'oschina-editor-command',
      payload: { command, html, imageFile }
    })) as { success?: boolean; result?: unknown; error?: string };
    if (!response?.success) {
      const bridgeReason = bridgeError instanceof Error ? bridgeError.message : String(bridgeError);
      throw new Error(
        `${response?.error || 'OSCHINA main-world command failed'} | page bridge: ${bridgeReason}`
      );
    }
    result = (response.result || {}) as Record<string, unknown>;
  }
  if (result.ok !== true) {
    throw new Error(String(result.error || `OSCHINA main-world command failed: ${command}`));
  }
  return result;
}

function encodeOschinaPageBridgePayload(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return encodeOschinaBytesBase64(bytes);
}

function encodeOschinaBytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const OSCHINA_PAGE_BRIDGE_ID = 'bawei-oschina-editor-bridge';
const OSCHINA_PAGE_BRIDGE_COMMAND_EVENT = 'bawei:oschina-editor-command';
const OSCHINA_PAGE_BRIDGE_RESULT_EVENT = 'bawei:oschina-editor-result';

async function ensureOschinaPageBridge(): Promise<HTMLElement> {
  let bridge = document.getElementById(OSCHINA_PAGE_BRIDGE_ID) as HTMLElement | null;
  if (!bridge) {
    bridge = document.createElement('div');
    bridge.id = OSCHINA_PAGE_BRIDGE_ID;
    bridge.hidden = true;
    bridge.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(bridge);
  }
  if (bridge.dataset.baweiReady === '1') return bridge;

  const script = document.createElement('script');
  script.dataset.baweiOschinaBridgeInstaller = '1';
  script.src = `${chrome.runtime.getURL('src/assets/oschina-page-bridge.js')}?v=${Date.now()}`;
  document.documentElement.appendChild(script);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && bridge.dataset.baweiReady !== '1') {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  script.remove();
  if (bridge.dataset.baweiReady !== '1') {
    bridge.remove();
    throw new Error('OSCHINA page bridge installation timed out');
  }
  return bridge;
}

async function executeOschinaEditorCommandViaPageBridge(
  command: OschinaEditorCommand,
  html = '',
  imageFile?: OschinaImageFilePayload
): Promise<Record<string, unknown>> {
  const bridge = await ensureOschinaPageBridge();
  const requestId = (() => {
    try {
      return crypto.randomUUID();
    } catch {
      return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
  })();
  const encodedPayload = encodeOschinaPageBridgePayload({
    requestId,
    command,
    html,
    imageFile
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let poll = 0;
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      bridge.removeAttribute('data-bawei-request-id');
      bridge.removeAttribute('data-bawei-request');
      bridge.removeAttribute('data-bawei-result-id');
      bridge.removeAttribute('data-bawei-result');
    };
    const finish = () => {
      if (settled || bridge.getAttribute('data-bawei-result-id') !== requestId) return;
      const rawResult = bridge.getAttribute('data-bawei-result') || '';
      if (!rawResult) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(rawResult) as Record<string, unknown>);
      } catch {
        reject(new Error('OSCHINA page bridge returned an invalid result'));
      }
    };
    const timeout = window.setTimeout(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        bridge.remove();
        reject(new Error('OSCHINA page bridge command timed out'));
      },
      command === 'ensure-editor' ? 45_000 : 8000
    );

    bridge.addEventListener(OSCHINA_PAGE_BRIDGE_RESULT_EVENT, finish, { once: true });
    poll = window.setInterval(finish, 25);
    bridge.setAttribute('data-bawei-request-id', requestId);
    bridge.setAttribute('data-bawei-request', encodedPayload);
    bridge.dispatchEvent(new Event(OSCHINA_PAGE_BRIDGE_COMMAND_EVENT));
  });
}

async function fillOschinaProseMirrorByTokens(
  tokens: OschinaContentToken[],
  editorRoot: HTMLElement
): Promise<void> {
  const normalizeText = (value: string): string => String(value || '').replace(/\s+/g, '');
  const escapeAttribute = (value: string): string =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const imageTokens = tokens.filter(
    (token): token is Extract<OschinaContentToken, { kind: 'image' }> => token?.kind === 'image'
  );
  const hostedImageUrls: string[] = [];

  // OSCHINA 的 uploadImage 是异步命令，真实页面会在上传完成时读取“当前选区”。
  // 若先写全文再逐个移动选区，图片回填可能切开或复制相邻段落。先在空文档中完成
  // 官方上传、收集平台 URL，再一次性写入最终 HTML，可避免异步选区污染正文结构。
  await executeOschinaEditorCommand('reset');
  const imageTotal = imageTokens.length;
  for (let index = 0; index < imageTokens.length; index += 1) {
    const imageIndex = index + 1;
    const token = imageTokens[index];
    await report({
      status: 'running',
      stage: 'fillContent',
      userMessage: getMessage('v3MsgUploadingImageProgress', [
        String(imageIndex),
        String(imageTotal)
      ])
    });
    const currentRoot =
      document.querySelector<HTMLElement>(
        '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"].aie-content'
      ) || editorRoot;
    const beforeSources = new Set(
      Array.from(currentRoot.querySelectorAll<HTMLImageElement>('img'))
        .map((image) => String(image.getAttribute('src') || '').trim())
        .filter(Boolean)
    );
    const imageFile = await fetchImageAsFile(currentJob?.jobId || '', token.src);
    const imageBytes = new Uint8Array(await imageFile.arrayBuffer());
    await executeOschinaEditorCommand('upload-image', '', {
      name: imageFile.name || `oschina-image-${imageIndex}`,
      type: imageFile.type || 'application/octet-stream',
      base64: encodeOschinaBytesBase64(imageBytes)
    });
    const hostedImageUrl = await waitForPlatformHostedImageUrl(
      () => {
        const latestRoot =
          document.querySelector<HTMLElement>(
            '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"].aie-content'
          ) || currentRoot;
        const sources = Array.from(latestRoot.querySelectorAll<HTMLImageElement>('img'))
          .map((image) => String(image.getAttribute('src') || '').trim())
          .filter(Boolean);
        return sources.find((source) => !beforeSources.has(source)) || '';
      },
      token.src,
      120_000
    );
    hostedImageUrls.push(hostedImageUrl);
  }

  let hostedImageIndex = 0;
  const finalHtml = tokens
    .map((token) => {
      if (!token) return '';
      if (token.kind === 'html') return token.html;
      const hostedImageUrl = hostedImageUrls[hostedImageIndex++] || '';
      if (!hostedImageUrl) throw new Error('OSCHINA 平台图片地址缺失');
      return `<p><img src="${escapeAttribute(hostedImageUrl)}" alt="${escapeAttribute(token.alt || '')}"></p>`;
    })
    .join('');
  if (!finalHtml.trim()) throw new Error('OSCHINA 最终正文为空');
  await executeOschinaEditorCommand('replace-html', finalHtml);
  await executeOschinaEditorCommand('focus-end');

  const latestRoot =
    document.querySelector<HTMLElement>(
      '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"].aie-content'
    ) || editorRoot;
  const expectedText = normalizeText(
    tokens
      .filter((token) => token?.kind === 'html')
      .map((token) =>
        htmlToPlainTextSafe((token as Extract<OschinaContentToken, { kind: 'html' }>).html)
      )
      .join('')
  );
  const observedText = normalizeText(String(latestRoot.innerText || latestRoot.textContent || ''));
  if (observedText !== expectedText) {
    throw new Error(
      `OSCHINA 正文结构校验失败：expected=${expectedText.length}, observed=${observedText.length}`
    );
  }
  const finalImageSources = Array.from(latestRoot.querySelectorAll<HTMLImageElement>('img')).map(
    (image) => String(image.getAttribute('src') || '').trim()
  );
  if (
    finalImageSources.length !== hostedImageUrls.length ||
    hostedImageUrls.some((url, index) => finalImageSources[index] !== url)
  ) {
    throw new Error(
      `OSCHINA 图片顺序校验失败：${finalImageSources.length}/${hostedImageUrls.length}`
    );
  }
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugOschinaNoSourceFieldAppend')
  });

  const jobTokens = currentJob?.article?.contentTokens;
  const tokens = Array.isArray(jobTokens)
    ? jobTokens
    : buildRichContentTokens({
        contentHtml,
        baseUrl: sourceUrl,
        sourceUrl,
        htmlMode: 'raw',
        splitBlocks: true
      });

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
  const expectedExistingText = htmlToPlainTextSafe(contentHtml).replace(/\s+/g, '');
  const observedExistingText = String(editorRoot.innerText || editorRoot.textContent || '').replace(
    /\s+/g,
    ''
  );
  const existingHasSource = !sourceUrl || existingHtml.includes(sourceUrl);
  const existingOk =
    existingHasSource &&
    (!expectedExistingText || observedExistingText.includes(expectedExistingText)) &&
    (expectedImages === 0 ||
      Array.from(editorRoot.querySelectorAll<HTMLImageElement>('img')).filter((img) => {
        const src = String(img.getAttribute('src') || '').trim();
        if (!src) return false;
        if (src.startsWith('blob:') || src.startsWith('data:')) return true;
        return !src.includes('qpic.cn') && !src.includes('qlogo.cn');
      }).length >= expectedImages);

  if (!existingOk) {
    try {
      if (isProseMirrorEditor) {
        await fillOschinaProseMirrorByTokens(tokens, editorRoot);
      } else {
        await fillEditorByTokens({
          jobId: currentJob?.jobId || '',
          tokens,
          editorRoot,
          writeMode: 'html',
          onImageProgress: async (current, total) => {
            await report({
              status: 'running',
              stage: 'fillContent',
              userMessage: getMessage('v3MsgUploadingImageProgress', [
                String(current),
                String(total)
              ])
            });
          }
        });
      }
    } catch (e) {
      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v3MsgImageUploadFailed'),
        userSuggestion: getMessage('v3SugManualUploadImagesThenContinue'),
        devDetails: { message: e instanceof Error ? e.message : String(e) }
      });
      throw new Error('__BAWEI_V2_STOPPED__');
    }
  }

  if (isProseMirrorEditor) {
    editorRoot =
      document.querySelector<HTMLElement>(
        '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"].aie-content'
      ) || editorRoot;
  }

  const expectedTextLength = htmlToPlainTextSafe(contentHtml).replace(/\s+/g, '').length;
  const observedTextLength = String(editorRoot.innerText || editorRoot.textContent || '').replace(
    /\s+/g,
    ''
  ).length;
  const expectedNormalizedText = htmlToPlainTextSafe(contentHtml).replace(/\s+/g, '');
  const observedNormalizedText = String(
    editorRoot.innerText || editorRoot.textContent || ''
  ).replace(/\s+/g, '');
  const durableImageCount = Array.from(editorRoot.querySelectorAll<HTMLImageElement>('img')).filter(
    (image) => !isTransientImageUrl(String(image.getAttribute('src') || ''))
  ).length;
  if (expectedTextLength >= 80 && observedTextLength < Math.floor(expectedTextLength * 0.8)) {
    throw new Error(`OSCHINA 正文写入不完整：${observedTextLength}/${expectedTextLength}`);
  }
  if (expectedNormalizedText && !observedNormalizedText.includes(expectedNormalizedText)) {
    throw new Error(
      `OSCHINA 正文语义校验失败：expected=${expectedNormalizedText.length}, observed=${observedNormalizedText.length}`
    );
  }
  if (durableImageCount < expectedImages) {
    throw new Error(`OSCHINA 平台图片未完成：${durableImageCount}/${expectedImages}`);
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
  await report({
    status: 'running',
    stage: 'saveDraft',
    userMessage: getMessage('v2MsgSavingDraft')
  });
  const draftButtonTexts = new Set([
    '保存草稿',
    '保存为草稿',
    '保存到草稿箱',
    '存为草稿',
    '存入草稿',
    '存入草稿箱',
    '存草稿'
  ]);
  const el = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, a, [role="button"], input[type="button"], input[type="submit"]'
    )
  )
    .filter((n) => {
      const style = window.getComputedStyle(n);
      const rect = n.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    })
    .find((n) => {
      const text = (n instanceof HTMLInputElement ? n.value : n.textContent || '').replace(
        /\s+/g,
        ''
      );
      return draftButtonTexts.has(text);
    });
  if (!el) {
    await retryUntil(
      async () => {
        const text = document.body?.innerText || '';
        if (/已保存|自动保存成功|草稿已保存/.test(text)) return true;
        throw new Error('等待 OSCHINA 自动保存');
      },
      { timeoutMs: 20000, intervalMs: 600 }
    );
    return;
  }
  try {
    simulateClick(el);
  } catch {
    el.click();
  }
}

async function stageSubmitPublish(): Promise<void> {
  const expectedTitle = String(currentJob?.article?.title || '').trim();
  const titleInput = document.querySelector<HTMLInputElement>(
    'input.title-input[placeholder="请输入文章标题"], input[name="title"], input[placeholder*="文章标题"]'
  );
  if (expectedTitle && String(titleInput?.value || '').trim() !== expectedTitle) {
    await stageFillTitle(expectedTitle);
  }

  currentStage = 'submitPublish';
  await report({
    status: 'running',
    stage: 'submitPublish',
    userMessage: getMessage('v2MsgPublishingArticle')
  });
  const el = Array.from(document.querySelectorAll<HTMLElement>('a, button, div')).find(
    (n) => (n.textContent || '').trim() === '发布文章'
  );
  if (!el) throw new Error('未找到发布文章按钮');

  try {
    simulateClick(el);
  } catch {
    el.click();
  }

  // 发布弹窗：优先选择“原创”，然后点击“确认并发布”
  try {
    const original = Array.from(document.querySelectorAll<HTMLElement>('label,span,div')).find(
      (n) => (n.textContent || '').trim() === '原创'
    );
    if (original)
      simulateClick((original.closest('label') as HTMLElement | null) || (original as HTMLElement));
  } catch {
    // ignore
  }

  const confirm = await retryUntil(
    async () => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('button,a,div,span,label'));
      const byText = (text: string) =>
        nodes.find((n) => (n.textContent || '').trim() === text) || null;
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

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<boolean> {
  currentStage = 'confirmSuccess';
  await report({
    status: 'running',
    stage: 'confirmSuccess',
    userMessage: getMessage('v2MsgConfirmingResult')
  });

  const okTexts =
    action === 'draft'
      ? ['草稿已保存', '自动保存成功', '保存成功', '已保存']
      : ['发布成功', '已发布', '提交成功', '待审核', '正在审核中', '重新编辑'];

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (action === 'publish') {
      if (location.hostname === 'my.oschina.net' && /\/blog\/\d+/.test(location.pathname)) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgSuccessDetectedStartVerify')
        });
        return true;
      }

      const text = document.body?.innerText || '';
      const hit = okTexts.some((t) => text.includes(t));
      if (hit) {
        if (isWritePage()) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgSuccessDetectedStartVerify')
        });
        return true;
      }

      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    const text = document.body?.innerText || '';
    if (okTexts.some((t) => text.includes(t))) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgSuccessDetectedStartVerify')
      });
      return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  await report({
    status: 'waiting_user',
    stage: 'waitingUser',
    userMessage:
      action === 'draft'
        ? getMessage('v2MsgPleaseConfirmDraftSaved')
        : getMessage('v2MsgPleaseConfirmPublishCompleted'),
    userSuggestion: getMessage('v2SugHandleModalRiskRequiredThenContinueOrRetry')
  });
  return false;
}

async function runFlow(job: AnyJob): Promise<void> {
  await report({
    status: 'running',
    stage: 'openEntry',
    userMessage: getMessage('v2MsgEnteredEditorPage')
  });
  const redirected = await ensureEditorPage();
  if (redirected) return;
  await stageDetectLogin();

  if (location.hostname === 'www.oschina.net') {
    await report({
      status: 'waiting_user',
      stage: 'waitingUser',
      userMessage: getMessage('v2MsgOschinaStillOnEntryNeedWriteBlogOrRelogin'),
      userSuggestion: getMessage('v2SugOschinaLoginThenClickWriteBlogThenContinue')
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
        devDetails: { from: location.href, to: canonical }
      });
      location.href = canonical;
      return;
    }
  }

  await ensureOschinaEditorReady();
  await stageFillTitle(job.article.title);
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl || '');
  if (job.action === 'draft') {
    await stageSaveDraft();
    const confirmed = await stageConfirmSuccess('draft');
    if (!confirmed) return;
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgDraftSavedVerifyDone'),
      devDetails: summarizeVerifyDetails({ draftUrl: location.href })
    });
    return;
  } else {
    await stageSubmitPublish();
    const confirmed = await stageConfirmSuccess('publish');
    if (!confirmed) return;
    // 若已跳到详情页（/blog/<id>），优先留在详情页直接验收原文链接
    if (location.hostname === 'my.oschina.net' && /\/blog\/\d+/.test(location.pathname)) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgAlreadyInDetailVerifySourceLink'),
        devDetails: summarizeVerifyDetails({ publishedUrl: location.href })
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
      devDetails: summarizeVerifyDetails({ listUrl: base })
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
      if (
        /^\/u\/[^/]+\/?$/.test(location.pathname) &&
        !new URLSearchParams(location.search).has('tab')
      ) {
        const profilePath = location.pathname.replace(/\/$/, '');
        const writeUrl = `${location.origin}${profilePath}/blog/ai-write`;
        await report({
          status: 'running',
          stage: 'openEntry',
          userMessage: getMessage('v2MsgOschinaGoProfileWriteBlogPage'),
          devDetails: { from: location.href, to: writeUrl, reason: 'profile-entry-redirect' }
        });
        location.href = writeUrl;
        return;
      }

      const isDetailPage = /\/blog\/\d+/.test(location.pathname);

      // detail page: 先等正文加载，再验原文链接；避免 document_end 过早回退
      if (isDetailPage) {
        await retryUntil(
          async () => {
            if (
              currentJob &&
              (!currentJob.article.sourceUrl ||
                pageContainsSourceUrlLoose(currentJob.article.sourceUrl))
            )
              return true;
            const text = document.body?.innerText || '';
            if (/待审核|正在审核中|重新编辑|原文链接/.test(text)) return true;
            throw new Error('detail not ready');
          },
          { timeoutMs: 12000, intervalMs: 500 }
        ).catch(() => null);
      }

      // detail page: 直接包含原文链接即可通过，避免先做空间迁移把详情页误跳走
      const sourceUrl = currentJob.article.sourceUrl || '';
      const containsSource = !sourceUrl || pageContainsSourceUrlLoose(sourceUrl);
      if (containsSource) {
        removeSessionValue(getProbeActiveKey(currentJob.jobId));
        removeSessionValue(getProbeKey(currentJob.jobId));
        await report({
          status: currentJob.action === 'draft' ? 'success' : 'pending_review',
          stage: 'done',
          userMessage: getMessage('v2MsgVerifyPassedDetailHasSourceLink'),
          devDetails: summarizeVerifyDetails({
            publishedUrl: location.href,
            candidatePublicUrl: location.href,
            managementUrl: getChannelConfig(CHANNEL_ID).managementUrl,
            reviewStatus: 'candidate_public_url',
            sourceUrlPresent: sourceUrl ? true : false
          })
        });
        return;
      }

      // 空间迁移：列表页优先切到实际空间（/u/spaceId），详情页验收失败后只把 canonical path 用于后续列表兜底
      const canonicalSpacePath = detectCanonicalSpacePath();
      const curSpacePath = location.pathname.match(/^\/u\/[^/]+/)?.[0] || null;
      if (
        !isDetailPage &&
        canonicalSpacePath &&
        curSpacePath &&
        canonicalSpacePath !== curSpacePath
      ) {
        const nextUrl = `${location.origin}${canonicalSpacePath}${location.search || ''}`;
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyOschinaSpaceMigrationSwitchToList'),
          devDetails: { from: location.href, to: nextUrl }
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
          devDetails: summarizeVerifyDetails({
            listUrl,
            listVisible: true,
            publishedUrl: location.href,
            sourceUrlPresent: false
          })
        });
        location.href = listUrl;
        return;
      }

      // 确保在 tab=newest 列表页
      if (
        base &&
        (!location.search.includes('tab=newest') ||
          (userBasePath && location.pathname !== userBasePath))
      ) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifySwitchToBlogList'),
          devDetails: summarizeVerifyDetails({ listUrl })
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
          devDetails: summarizeVerifyDetails({ listUrl: searchUrl })
        });
        location.href = searchUrl;
        return;
      }

      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href*="/blog/"]')
      ).filter((a) => {
        const href = a.href;
        if (!href.includes('/blog/')) return false;
        if (/\/blog\/(?:ai-)?write/.test(href)) return false;
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
          devDetails: summarizeVerifyDetails({
            listUrl: location.href,
            listVisible: true,
            publishedUrl: tokenHit.href
          })
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
          userMessage: getMessage('v2MsgVerifyTokenNotMatchedProbingDetails', [
            String(idx + 1),
            String(uniq.length)
          ]),
          devDetails: summarizeVerifyDetails({
            listUrl: location.href,
            listVisible: true,
            publishedUrl: uniq[idx]
          })
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
            devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false })
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
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false })
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
      devDetails: { message: error instanceof Error ? error.message : String(error) }
    });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === V2_PROBE_LOGIN_STATE && message.channelId === CHANNEL_ID) {
    sendResponse({ success: true, result: { ...getCurrentLoginState(), url: location.href } });
    return;
  }
  if (!currentJob) return;
  if (message?.type === V2_REQUEST_STOP && message.jobId === currentJob.jobId) {
    stopRequested = true;
    return;
  }
  if (
    message?.type === V2_REQUEST_RETRY &&
    message.jobId === currentJob.jobId &&
    message.channelId === CHANNEL_ID
  ) {
    bootstrap();
  }
  if (
    message?.type === V2_REQUEST_CONTINUE &&
    message.jobId === currentJob.jobId &&
    message.channelId === CHANNEL_ID
  ) {
    bootstrap();
  }
});

bootstrap();
