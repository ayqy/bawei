/**
 * WeChat Article Content Script
 * V2: Injects publish panel, extracts article data, and orchestrates multi-channel publishing
 */

import type { ChannelId, ChannelRuntimeState, PublishAction } from '../shared/v2-types';
import type { Settings } from '../shared/settings-manager';

/* INLINE:settings-manager */
/* INLINE:notify */
/* INLINE:v2-protocol */
/* INLINE:rich-content */

let isInitialized = false;
let settings: Settings | null = null;
let currentJobId: string | null = null;
let latestState: Record<ChannelId, ChannelRuntimeState> | null = null;
let globalHint: string | null = null;
let focusChannel: ChannelId = 'csdn';
let selectedAction: PublishAction = 'draft';
let runChannels: Set<ChannelId> = new Set([
  'csdn',
  'tencent-cloud-dev',
  'cnblogs',
  'oschina',
  'woshipm',
  'mowen',
  'sspai',
  'baijiahao',
  'toutiao',
  'feishu-docs',
]);

const ALL_CHANNELS: Array<{ id: ChannelId; labelKey: string }> = [
  { id: 'csdn', labelKey: 'channelCsdn' },
  { id: 'tencent-cloud-dev', labelKey: 'channelTencentCloudDev' },
  { id: 'cnblogs', labelKey: 'channelCnblogs' },
  { id: 'oschina', labelKey: 'channelOschina' },
  { id: 'woshipm', labelKey: 'channelWoshipm' },
  { id: 'mowen', labelKey: 'channelMowen' },
  { id: 'sspai', labelKey: 'channelSspai' },
  { id: 'baijiahao', labelKey: 'channelBaijiahao' },
  { id: 'toutiao', labelKey: 'channelToutiao' },
  { id: 'feishu-docs', labelKey: 'channelFeishuDocs' },
];

let isStartingJob = false;
let isAwaitingFirstBroadcast = false;
let isStoppingJob = false;
let isJobStopped = false;
let imageRewriteObserver: MutationObserver | null = null;
let imageRewriteScheduled = false;
let panelKeepAliveTimer: number | null = null;
let panelBridgeBound = false;
let cachedArticlePayload: { title: string; sourceUrl: string; contentHtml: string; contentTokens: unknown[] } | null = null;
type LoginAuditStatus = 'idle' | 'checking' | 'logged_in' | 'not_logged_in' | 'unknown';
type LoginAuditState = { status: LoginAuditStatus; reason?: string; url?: string; checkedAt?: number; tabId?: number };
let channelLoginAuditState: Partial<Record<ChannelId, LoginAuditState>> = {};
let isCheckingChannelLogins = false;

/**
 * Gets localized message
 * @param key Message key
 * @returns Localized message or key as fallback
 */
function getMessage(key: string): string {
  try {
    return chrome.i18n.getMessage(key) || key;
  } catch {
    return key;
  }
}

/**
 * Extracts article title from the page
 * @returns Article title or empty string
 */
function extractArticleTitle(): string {
  // Try multiple selectors for WeChat article title
  const titleSelectors = [
    '#activity-name',
    '.rich_media_title',
    'h1',
    '.title',
    '[data-role="title"]',
  ];
  
  for (const selector of titleSelectors) {
    const titleElement = document.querySelector(selector);
    if (titleElement && titleElement.textContent?.trim()) {
      return titleElement.textContent.trim();
    }
  }
  
  // Fallback to page title
  return document.title || '';
}

function findArticleContentRoot(): HTMLElement | null {
  const contentSelectors = [
    '#js_content',
    '.rich_media_content',
    '.rich_media_area_primary',
    '.article-content',
    '[data-role="content"]',
  ];

  for (const selector of contentSelectors) {
    const contentElement = document.querySelector<HTMLElement>(selector);
    if (contentElement && contentElement.innerHTML?.trim()) {
      return contentElement;
    }
  }

  return null;
}

/**
 * Extracts article content HTML from the page
 * @returns Article content HTML
 */
function extractArticleContent(): string {
  const contentElement = findArticleContentRoot();
  if (contentElement) {
    return contentElement.innerHTML.trim();
  }

  // Fallback to body content if specific selectors fail
  const bodyContent = document.body.innerHTML;
  return bodyContent || '';
}

function rewriteOneArticleImage(img: HTMLImageElement): void {
  const attrs = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'src'];
  let raw = '';
  for (const key of attrs) {
    const val = String(img.getAttribute(key) || '').trim();
    if (val) {
      raw = val;
      break;
    }
  }
  if (!raw) return;

  const proxied = toProxyImageUrl(raw, window.location.href);
  if (!proxied) return;

  let hasTrackedAttr = false;
  for (const key of attrs) {
    if (!img.hasAttribute(key)) continue;
    hasTrackedAttr = true;
    if (img.getAttribute(key) !== proxied) {
      img.setAttribute(key, proxied);
    }
  }

  if (!hasTrackedAttr && img.getAttribute('src') !== proxied) {
    img.setAttribute('src', proxied);
  }

  if (img.hasAttribute('srcset') && img.getAttribute('srcset') !== proxied) {
    img.setAttribute('srcset', proxied);
  }
}

function rewriteArticleImageUrlsInDom(): void {
  const root = findArticleContentRoot();
  if (!root) return;

  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  for (const img of imgs) {
    rewriteOneArticleImage(img);
  }
}

function scheduleRewriteArticleImages(): void {
  if (imageRewriteScheduled) return;
  imageRewriteScheduled = true;
  requestAnimationFrame(() => {
    imageRewriteScheduled = false;
    rewriteArticleImageUrlsInDom();
  });
}

function buildArticlePayload(): { title: string; sourceUrl: string; contentHtml: string; contentTokens: unknown[] } {
  rewriteArticleImageUrlsInDom();
  ensureArticleImageProxyObserver();

  const title = extractArticleTitle();
  const sourceUrl = window.location.href;
  const rawContentHtml = extractArticleContent();
  const contentHtml = rewriteHtmlImageUrlsToProxy(rawContentHtml, sourceUrl);
  const contentTokens = buildRichContentTokens({
    contentHtml,
    baseUrl: sourceUrl,
    sourceUrl,
    htmlMode: 'raw',
    splitBlocks: true,
  });

  if (!title.trim()) {
    throw new Error(getMessage('extractTitleFailed') || '无法提取文章标题');
  }

  if (!contentHtml.trim()) {
    throw new Error(getMessage('extractContentFailed') || '无法提取文章内容');
  }

  return { title, sourceUrl, contentHtml, contentTokens };
}

function ensureArticleImageProxyObserver(): void {
  if (imageRewriteObserver) return;
  const root = findArticleContentRoot();
  if (!root) return;

  imageRewriteObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        const target = m.target;
        if (target instanceof HTMLImageElement) {
          rewriteOneArticleImage(target);
          continue;
        }
      }

      if (m.type === 'childList' && m.addedNodes.length) {
        let hasImageNode = false;
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof HTMLImageElement) {
            rewriteOneArticleImage(node);
            hasImageNode = true;
            continue;
          }
          if (node instanceof HTMLElement && node.querySelector('img')) {
            hasImageNode = true;
          }
        }
        if (hasImageNode) scheduleRewriteArticleImages();
      }
    }
  });

  imageRewriteObserver.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'data-actualsrc', 'data-lazy-src'],
  });
}

function getRuntimeStateMirrorNode(): HTMLScriptElement {
  let node = document.querySelector<HTMLScriptElement>('#bawei-v2-runtime-state');
  if (node) return node;

  node = document.createElement('script');
  node.id = 'bawei-v2-runtime-state';
  node.type = 'application/json';
  node.setAttribute('data-bawei-v2', 'runtime-state');
  node.style.display = 'none';
  const root = document.documentElement || document.body || document.head;
  if (root) root.appendChild(node);
  return node;
}

function writeRuntimeStateMirror(): void {
  try {
    const node = getRuntimeStateMirrorNode();
    const state: Partial<Record<ChannelId, Pick<ChannelRuntimeState, 'status' | 'stage' | 'userMessage' | 'userSuggestion'>>> = {};
    for (const ch of ALL_CHANNELS) {
      const s = latestState?.[ch.id];
      state[ch.id] = {
        status: s?.status || 'not_started',
        stage: s?.stage,
        userMessage: s?.userMessage || '',
        userSuggestion: s?.userSuggestion || '',
      };
    }

    node.textContent = JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      sourceUrl: window.location.href,
      currentJobId,
      focusChannel,
      selectedAction,
      runChannels: Array.from(runChannels),
      loginAuditState: channelLoginAuditState,
      isExecuting: isExecutingNow(),
      isStartingJob,
      isCheckingChannelLogins,
      isAwaitingFirstBroadcast,
      isStoppingJob,
      hasPanel: !!document.querySelector('#bawei-v2-panel'),
      hasLauncher: !!document.querySelector('#bawei-v2-launcher'),
      state,
    });
  } catch {
    // ignore
  }
}

function ensurePanelArtifacts(): void {
  if (!document.querySelector('#bawei-v2-launcher')) {
    createLauncherIcon();
  }
  if (!document.querySelector('#bawei-v2-panel')) {
    createPublishPanel();
    collapsePanel();
  }
  writeRuntimeStateMirror();
}

function startPanelKeepAlive(): void {
  if (panelKeepAliveTimer !== null) return;
  panelKeepAliveTimer = window.setInterval(() => {
    try {
      ensurePanelArtifacts();
      rewriteArticleImageUrlsInDom();
    } catch {
      // ignore
    }
  }, 3000);
}

function bindPanelBridgeEvents(): void {
  if (panelBridgeBound) return;
  panelBridgeBound = true;
  const handler = (event: Event) => {
    const custom = event as CustomEvent<{ action?: string }>;
    const action = String(custom.detail?.action || '');
    if (action === 'show') {
      ensurePanelArtifacts();
      showPanel();
      return;
    }
    if (action === 'collapse') {
      collapsePanel();
      return;
    }
    ensurePanelArtifacts();
  };
  window.addEventListener('bawei-v2-ensure-panel', handler);
}

function collapsePanel(): void {
  const panel = document.querySelector('#bawei-v2-panel') as HTMLElement | null;
  if (panel) {
    panel.style.display = 'none';
  }

  const launcher = document.querySelector('#bawei-v2-launcher') as HTMLButtonElement | null;
  if (launcher) {
    launcher.style.display = 'block';
  }
  writeRuntimeStateMirror();
}

function showPanel(): void {
  if (!document.querySelector('#bawei-v2-panel')) {
    createPublishPanel();
  }

  const panel = document.querySelector('#bawei-v2-panel') as HTMLElement | null;
  if (panel) {
    panel.style.display = 'block';
  }

  const launcher = document.querySelector('#bawei-v2-launcher') as HTMLButtonElement | null;
  if (launcher) {
    launcher.style.display = 'none';
  }

  // Ensure UI reflects current state when reopening.
  renderStatusList();
  renderDiagnosis();
  refreshPanelControls();
  writeRuntimeStateMirror();
}

function collectUiState(): Record<string, unknown> {
  const runtime = (() => {
    try {
      const raw = String(document.querySelector('#bawei-v2-runtime-state')?.textContent || '').trim();
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();

  const panel = document.querySelector('#bawei-v2-panel') as HTMLElement | null;
  const launcher = document.querySelector('#bawei-v2-launcher') as HTMLElement | null;
  const panelVisible = (() => {
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(panel);
    return !(style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0');
  })();

  const checkedChannels = Array.from(document.querySelectorAll('input[id^="bawei-v2-run-"]'))
    .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement && node.checked)
    .map((node) => String(node.id || '').replace(/^bawei-v2-run-/, ''))
    .filter(Boolean);

  const selectedActionValue =
    (document.querySelector('input[name="bawei_v2_action"]:checked') as HTMLInputElement | null)?.value || '';
  const startButton = document.querySelector('#bawei-v2-start') as HTMLButtonElement | null;

  return {
    url: window.location.href,
    title: document.title,
    hasLauncher: !!launcher,
    hasPanel: !!panel,
    hasMirror: !!document.querySelector('#bawei-v2-runtime-state'),
    panelVisible,
    selectedAction: selectedActionValue,
    checkedChannels,
    startButtonText: String(startButton?.textContent || '').trim(),
    startButtonDisabled: !!startButton?.disabled,
    isCheckingChannelLogins,
    loginAuditState: channelLoginAuditState,
    diagnosisText: String(document.querySelector('#bawei-v2-diagnosis')?.textContent || '').trim(),
    runtime,
  };
}

function dispatchCheckbox(input: HTMLInputElement, checked: boolean): void {
  if (input.checked === checked) return;
  input.checked = checked;
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

async function handleWeixinPanelRemoteAction(
  action: string,
  payload?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (action === 'weixin-probe-ui') {
    return { ok: true, ...collectUiState() };
  }

  if (action === 'weixin-open-panel') {
    ensurePanelArtifacts();
    showPanel();
    return { ok: true, ...collectUiState() };
  }

  if (action === 'weixin-set-action') {
    ensurePanelArtifacts();
    showPanel();
    const value = String(payload?.value || '').trim();
    const input = document.querySelector(`input[name="bawei_v2_action"][value="${value}"]`) as HTMLInputElement | null;
    if (!input) {
      return { ok: false, reason: 'action-input-not-found', value, ...collectUiState() };
    }
    input.click();
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: true, ...collectUiState() };
  }

  if (action === 'weixin-set-channels') {
    ensurePanelArtifacts();
    showPanel();
    const wanted = new Set(
      Array.isArray(payload?.channelIds) ? payload.channelIds.map((item) => String(item || '').trim()).filter(Boolean) : []
    );
    const inputs = Array.from(document.querySelectorAll('input[id^="bawei-v2-run-"]')).filter(
      (node): node is HTMLInputElement => node instanceof HTMLInputElement
    );
    for (const input of inputs) {
      const id = String(input.id || '').replace(/^bawei-v2-run-/, '');
      dispatchCheckbox(input, wanted.has(id));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: true, ...collectUiState() };
  }

  if (action === 'weixin-start') {
    ensurePanelArtifacts();
    showPanel();
    const startButton = document.querySelector('#bawei-v2-start') as HTMLButtonElement | null;
    if (!startButton) {
      return { ok: false, reason: 'start-button-not-found', ...collectUiState() };
    }
    if (startButton.disabled) {
      return { ok: false, reason: 'start-button-disabled', ...collectUiState() };
    }
    void handleStartClick();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { ok: true, ...collectUiState() };
  }

  if (action === 'weixin-start-job') {
    ensurePanelArtifacts();
    showPanel();

    const nextAction = String(payload?.action || '').trim();
    if (nextAction === 'draft' || nextAction === 'publish') {
      selectedAction = nextAction as PublishAction;
      const radio = document.querySelector(`input[name="bawei_v2_action"][value="${nextAction}"]`) as HTMLInputElement | null;
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }
    }

    if (Array.isArray(payload?.channelIds)) {
      runChannels = new Set(payload.channelIds.map((item) => String(item || '').trim()).filter(Boolean) as ChannelId[]);
      renderStatusList();
      refreshPanelControls();
      writeRuntimeStateMirror();
    }

    const startButton = document.querySelector('#bawei-v2-start') as HTMLButtonElement | null;
    if (!startButton) {
      return { ok: false, reason: 'start-button-not-found', ...collectUiState() };
    }
    if (startButton.disabled) {
      return { ok: false, reason: 'start-button-disabled', ...collectUiState() };
    }

    void handleStartClick();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (currentJobId || isStartingJob || isAwaitingFirstBroadcast || isExecutingNow()) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    return { ok: true, ...collectUiState() };
  }

  if (action === 'weixin-check-login') {
    ensurePanelArtifacts();
    showPanel();
    await handleCheckLoginClick();
    return { ok: true, ...collectUiState() };
  }

  if (action === 'weixin-read-runtime') {
    return { ok: true, ...collectUiState() };
  }

  return { ok: false, reason: `unsupported-weixin-action:${action}` };
}

function createLauncherIcon(): void {
  // Avoid duplicate launchers
  if (document.querySelector('#bawei-v2-launcher')) {
    return;
  }

  const launcher = document.createElement('button');
  launcher.id = 'bawei-v2-launcher';
  launcher.type = 'button';

  const openLabel = getMessage('panelOpen') || '打开发布面板';
  launcher.setAttribute('aria-label', openLabel);
  launcher.title = openLabel;

  launcher.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: pointer;
  `;

  const img = document.createElement('img');
  img.src = chrome.runtime.getURL('icons/icon-32.png');
  img.alt = openLabel;
  img.style.cssText = `width: 32px; height: 32px; display: block;`;
  launcher.appendChild(img);

  launcher.addEventListener('click', showPanel);

  document.body.appendChild(launcher);
  writeRuntimeStateMirror();
}

/**
 * Creates and injects the publish panel
 */
function createPublishPanel(): void {
  // Avoid duplicate panels
  if (document.querySelector('#bawei-v2-panel')) {
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'bawei-v2-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', getMessage('panelAriaLabel') || '发布面板');
  panel.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    width: 320px;
    max-height: 80vh;
    overflow: auto;
    background: rgba(255, 255, 255, 0.96);
    color: #111;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 10px;
    padding: 12px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.18);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  // Force native form control appearance to avoid host page (e.g. WeChat) global styles.
  const formStyle = document.createElement('style');
  formStyle.textContent = `
    #bawei-v2-panel input[type="checkbox"],
    #bawei-v2-panel input[type="radio"] {
      appearance: auto !important;
      -webkit-appearance: auto !important;
      background: initial !important;
      border: initial !important;
      box-shadow: none !important;
    }
    #bawei-v2-panel select {
      appearance: auto !important;
      -webkit-appearance: auto !important;
      color: #111 !important;
      background: #fff !important;
      border-color: rgba(0,0,0,0.12) !important;
    }
  `;
  panel.appendChild(formStyle);

  const header = document.createElement('div');
  header.style.cssText = `
    display:flex; align-items:center; justify-content:space-between;
    gap: 8px; margin-bottom: 10px;
  `;
  const title = document.createElement('div');
  title.textContent = getMessage('panelTitle') || '多平台发布';
  title.style.cssText = `font-size:14px; font-weight:700;`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = getMessage('panelClose') || '关闭';
  closeBtn.setAttribute('aria-label', getMessage('panelClose') || '关闭');
  closeBtn.style.cssText = `
    border: none; background: transparent; cursor: pointer;
    color: #666; font-size: 12px; padding: 4px 6px;
  `;
  closeBtn.addEventListener('click', collapsePanel);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const sectionStyle = `margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(0,0,0,0.06);`;

  const actionSection = document.createElement('div');
  actionSection.style.cssText = sectionStyle;
  actionSection.innerHTML = `<div style="font-size:12px; color:#444; margin-bottom:6px;">${getMessage('panelActionLabel') || '动作'}</div>`;
  const actionList = document.createElement('div');
  actionList.style.cssText = `display:flex; gap: 10px;`;
  for (const act of [
    { id: 'draft' as const, labelKey: 'actionDraft' },
    { id: 'publish' as const, labelKey: 'actionPublish' },
  ]) {
    const label = document.createElement('label');
    label.style.cssText = `display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;`;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'bawei_v2_action';
    input.value = act.id;
    input.checked = selectedAction === act.id;
    input.addEventListener('change', () => {
      selectedAction = act.id;
      renderDiagnosis();
    });
    const span = document.createElement('span');
    span.textContent = getMessage(act.labelKey) || act.id;
    label.appendChild(input);
    label.appendChild(span);
    actionList.appendChild(label);
  }
  actionSection.appendChild(actionList);

  const channelSection = document.createElement('div');
  channelSection.style.cssText = sectionStyle;

  const channelHeader = document.createElement('div');
  channelHeader.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:8px;`;
  const statusLabelEl = document.createElement('div');
  statusLabelEl.style.cssText = `font-size:12px; color:#444;`;
  statusLabelEl.textContent = getMessage('panelStatusLabel') || '渠道执行状态';
  channelHeader.appendChild(statusLabelEl);

  const toggleAllCheckbox = document.createElement('input');
  toggleAllCheckbox.id = 'bawei-v2-toggle-all';
  toggleAllCheckbox.type = 'checkbox';
  toggleAllCheckbox.setAttribute('aria-label', getMessage('panelSelectAll') || '全选');
  toggleAllCheckbox.addEventListener('change', () => {
    if (toggleAllCheckbox.checked) {
      runChannels = new Set(ALL_CHANNELS.map((c) => c.id));
    } else {
      runChannels = new Set();
    }
    renderStatusList();
    refreshPanelControls();
  });
  channelHeader.appendChild(toggleAllCheckbox);

  channelSection.appendChild(channelHeader);

  const statusList = document.createElement('div');
  statusList.id = 'bawei-v2-status-list';
  statusList.style.cssText = `display:flex; flex-direction:column; gap:6px; margin-top: 10px;`;
  channelSection.appendChild(statusList);

  const startSection = document.createElement('div');
  startSection.style.cssText = sectionStyle;
  const startRow = document.createElement('div');
  startRow.style.cssText = `display:flex; align-items:center; gap:8px;`;

  const checkLoginBtn = document.createElement('button');
  checkLoginBtn.id = 'bawei-v2-check-login';
  checkLoginBtn.textContent = getMessage('panelCheckLogin') || '检查登录';
  checkLoginBtn.style.cssText = `
    flex: 0 0 96px;
    background: #fff;
    color: #0958d9;
    border: 1px solid rgba(22,119,255,0.28);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  `;
  checkLoginBtn.addEventListener('click', () => {
    void handleCheckLoginClick();
  });

  const startBtn = document.createElement('button');
  startBtn.id = 'bawei-v2-start';
  startBtn.textContent = getMessage('panelStart') || '开始执行（并发全渠道）';
  startBtn.style.cssText = `
    flex: 1;
    background: #1677ff;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  `;
  startBtn.addEventListener('click', handleStartClick);
  startRow.appendChild(checkLoginBtn);
  startRow.appendChild(startBtn);
  startSection.appendChild(startRow);

  const diagWrapper = document.createElement('div');
  diagWrapper.id = 'bawei-v2-diagnosis-wrapper';
  diagWrapper.style.cssText = `${sectionStyle} display: none;`;

  const focusLabel = document.createElement('div');
  focusLabel.style.cssText = `font-size:12px; color:#444; margin-bottom:6px;`;
  focusLabel.textContent = getMessage('panelChannelLabel') || '渠道（单选，用于查看诊断）';
  diagWrapper.appendChild(focusLabel);

  const focusRow = document.createElement('div');
  focusRow.style.cssText = `display:flex; align-items:center; gap:8px;`;

  const focusSelect = document.createElement('select');
  focusSelect.id = 'bawei-v2-focus-channel';
  focusSelect.style.cssText = `flex: 1; padding: 6px 8px; font-size: 12px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.12); background: #fff;`;
  for (const ch of ALL_CHANNELS) {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = getMessage(ch.labelKey) || ch.id;
    focusSelect.appendChild(opt);
  }
  focusSelect.value = focusChannel;
  focusSelect.addEventListener('change', () => {
    focusChannel = focusSelect.value as ChannelId;
    renderDiagnosis();
  });
  focusRow.appendChild(focusSelect);

  diagWrapper.appendChild(focusRow);

  const diagBox = document.createElement('div');
  diagBox.id = 'bawei-v2-diagnosis';
  diagBox.style.cssText = `
    font-size: 12px;
    line-height: 1.4;
    color: #333;
    background: rgba(0,0,0,0.03);
    border-radius: 8px;
    padding: 10px;
    white-space: pre-wrap;
  `;
  diagBox.textContent = '';
  diagWrapper.appendChild(diagBox);

  panel.appendChild(header);
  panel.appendChild(actionSection);
  panel.appendChild(channelSection);
  panel.appendChild(startSection);
  panel.appendChild(diagWrapper);

  document.body.appendChild(panel);
  renderStatusList();
  renderDiagnosis();
  refreshPanelControls();
  writeRuntimeStateMirror();
}

/**
 * Handles panel start click
 */
async function handleStartClick(): Promise<void> {
  const startBtn = document.querySelector('#bawei-v2-start') as HTMLButtonElement | null;
  if (!startBtn) return;

  if (isExecutingNow()) {
    if (!currentJobId || isStoppingJob) return;
    isStoppingJob = true;
    refreshPanelControls();
    writeRuntimeStateMirror();

    try {
      const response = await chrome.runtime.sendMessage({
        type: V2_REQUEST_STOP,
        jobId: currentJobId,
      });
      if (!response?.success) {
        throw new Error(response?.error || 'stop failed');
      }

      isJobStopped = true;
      isAwaitingFirstBroadcast = false;
      renderStatusList();
      renderDiagnosis();
      writeRuntimeStateMirror();
    } catch (error) {
      console.error('Failed to stop job:', error);
      showError(getMessage('publishErrorToast') || `失败：${error instanceof Error ? error.message : getMessage('unknownError') || '未知错误'}`);
    } finally {
      isStoppingJob = false;
      refreshPanelControls();
      writeRuntimeStateMirror();
    }
    return;
  }

  // 全不选允许，但不允许开始
  if (runChannels.size === 0 || isStartingJob) return;

  isJobStopped = false;
  isStartingJob = true;
  isAwaitingFirstBroadcast = false;
  currentJobId = null;
  latestState = null;
  refreshPanelControls();
  renderStatusList();
  writeRuntimeStateMirror();

  try {
    const payload =
      cachedArticlePayload && cachedArticlePayload.sourceUrl === window.location.href
        ? cachedArticlePayload
        : buildArticlePayload();
    cachedArticlePayload = payload;

    const title = payload.title;
    const sourceUrl = payload.sourceUrl;
    const contentHtml = payload.contentHtml;

    // Diagnose image policy (external images)
    const hasImages = /<img\b/i.test(contentHtml);
    globalHint = hasImages
      ? getMessage('imagePolicyHint') ||
        '检测到图片：将自动下载并上传到各平台；如遇风控/上传失败，请按诊断提示手动处理。'
      : null;
    const contentTokens = payload.contentTokens;

    const response = await chrome.runtime.sendMessage({
      type: V2_START_JOB,
      action: selectedAction,
      focusChannel,
      channels: Array.from(runChannels),
      article: {
        title,
        contentHtml,
        contentTokens,
        sourceUrl,
      },
    });

    if (!response?.success || !response?.jobId) {
      throw new Error(response?.error || getMessage('sendToBackgroundFailed') || '发送到后台失败');
    }

    currentJobId = response.jobId;
    if (!latestState) {
      isAwaitingFirstBroadcast = true;
    }
    renderStatusList();
    renderDiagnosis();
    refreshPanelControls();
    writeRuntimeStateMirror();
    showInfo(getMessage('panelStarted') || '任务已启动：正在并发打开各渠道编辑页...');

    
  } catch (error) {
    console.error('Failed to publish article:', error);
    showError(getMessage('publishErrorToast') || `失败：${error instanceof Error ? error.message : getMessage('unknownError') || '未知错误'}`);
  } finally {
    isStartingJob = false;
    refreshPanelControls();
    writeRuntimeStateMirror();
  }
}

/**
 * Initializes the content script
 */
async function initialize(): Promise<void> {
  if (isInitialized) return;
  
  try {
    console.log('Initializing WeChat content script...');
    
    // Load settings
    settings = (await getSettings()) as Settings;
    console.log('Settings loaded:', settings);

    try {
      await chrome.runtime.sendMessage({ type: 'ping' });
    } catch {
      // ignore
    }

    try {
      rewriteArticleImageUrlsInDom();
      ensureArticleImageProxyObserver();
      setTimeout(() => {
        try {
          cachedArticlePayload = buildArticlePayload();
        } catch {
          // ignore
        }
      }, 600);
    } catch {
      // ignore
    }
    
    // Wait for page to be ready
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
    }

    ensurePanelArtifacts();
    setTimeout(() => {
      ensurePanelArtifacts();
    }, 1000);
    startPanelKeepAlive();
    bindPanelBridgeEvents();
    
    isInitialized = true;
    writeRuntimeStateMirror();
    console.log('WeChat content script initialized successfully');
    
  } catch (error) {
    console.error('Failed to initialize WeChat content script:', error);
  }
}

/**
 * Checks if we should run on this page
 */
function shouldRun(): boolean {
  if (window.location.hostname !== 'mp.weixin.qq.com') return false;
  const path = String(window.location.pathname || '');
  if (!(path === '/s' || path.startsWith('/s/'))) return false;
  const title = extractArticleTitle();
  const contentRoot = findArticleContentRoot();
  return !!title.trim() && !!contentRoot && !!contentRoot.innerHTML.trim();
}

function loginAuditStatusLabel(status: LoginAuditStatus): string {
  if (status === 'checking') return getMessage('statusCheckingLogin') || '检查中';
  if (status === 'logged_in') return getMessage('statusLoggedIn') || '已登录';
  if (status === 'not_logged_in') return getMessage('statusNotLoggedIn') || '未登录';
  if (status === 'unknown') return getMessage('statusUnknown') || '未知';
  return getMessage('statusUnchecked') || '未检查';
}

async function handleCheckLoginClick(): Promise<void> {
  if (runChannels.size === 0 || isCheckingChannelLogins || isStartingJob || isStoppingJob || isExecutingNow()) return;

  isCheckingChannelLogins = true;
  const checkedAt = Date.now();
  for (const channelId of runChannels) {
    channelLoginAuditState[channelId] = {
      ...(channelLoginAuditState[channelId] || {}),
      status: 'checking',
      checkedAt,
    };
  }
  renderStatusList();
  refreshPanelControls();
  writeRuntimeStateMirror();

  try {
    const response = (await chrome.runtime.sendMessage({
      type: V2_AUDIT_CHANNEL_LOGIN,
      channels: Array.from(runChannels),
    })) as
      | {
          success: true;
          results: Partial<Record<ChannelId, { status: LoginAuditStatus; reason: string; url: string; checkedAt?: number; tabId?: number }>>;
        }
      | { success: false; error?: string };

    if (!response?.success) {
      throw new Error(response?.error || 'login audit failed');
    }

    const now = Date.now();
    for (const channelId of runChannels) {
      const result = response.results?.[channelId];
      channelLoginAuditState[channelId] = {
        status: result?.status || 'unknown',
        reason: result?.reason || '',
        url: result?.url || '',
        tabId: result?.tabId,
        checkedAt: now,
      };
    }

    const notLoggedIn = Array.from(runChannels).filter((channelId) => channelLoginAuditState[channelId]?.status === 'not_logged_in');
    if (notLoggedIn.length > 0) {
      showInfo(getMessage('panelLoginCheckFinishedWithNotLoggedIn') || '登录检查完成：存在未登录渠道，已在后台静默打开对应页面。');
    } else {
      showInfo(getMessage('panelLoginCheckFinishedAllLoggedIn') || '登录检查完成：所选渠道均已登录。');
    }
  } catch (error) {
    console.error('Failed to audit channel login status:', error);
    showError(getMessage('panelLoginCheckFailed') || `失败：${error instanceof Error ? error.message : getMessage('unknownError') || '未知错误'}`);
  } finally {
    isCheckingChannelLogins = false;
    renderStatusList();
    refreshPanelControls();
    writeRuntimeStateMirror();
  }
}

function statusLabel(status: string): string {
  if (status === 'running') return getMessage('statusRunning') || '进行中';
  if (status === 'success') return getMessage('statusSuccess') || '成功';
  if (status === 'failed') return getMessage('statusFailed') || '失败';
  if (status === 'waiting_user') return getMessage('statusWaiting') || '等待处理';
  if (status === 'not_logged_in') return getMessage('statusNotLoggedIn') || '未登录';
  return getMessage('statusNotStarted') || '未开始';
}

function hasRunningChannels(): boolean {
  if (!latestState) return false;
  return Object.values(latestState).some((s) => s?.status === 'running');
}

function isExecutingNow(): boolean {
  if (isJobStopped) return false;
  return isStartingJob || isAwaitingFirstBroadcast || hasRunningChannels();
}

function refreshPanelControls(): void {
  const executing = isExecutingNow();

  const toggleAllCheckbox = document.querySelector('#bawei-v2-toggle-all') as HTMLInputElement | null;
  if (toggleAllCheckbox) {
    const isAll = runChannels.size === ALL_CHANNELS.length;
    toggleAllCheckbox.checked = isAll;
    toggleAllCheckbox.disabled = executing;
    toggleAllCheckbox.style.opacity = toggleAllCheckbox.disabled ? '0.65' : '1';
    toggleAllCheckbox.style.cursor = toggleAllCheckbox.disabled ? 'not-allowed' : 'pointer';
  }

  const startBtn = document.querySelector('#bawei-v2-start') as HTMLButtonElement | null;
  const checkLoginBtn = document.querySelector('#bawei-v2-check-login') as HTMLButtonElement | null;
  if (startBtn) {
    if (isStartingJob) {
      startBtn.disabled = true;
      startBtn.textContent = getMessage('panelStarting') || '正在启动...';
      startBtn.style.background = '#1677ff';
    } else if (isStoppingJob) {
      startBtn.disabled = true;
      startBtn.textContent = getMessage('panelStopping') || '正在停止...';
      startBtn.style.background = '#cf1322';
    } else if (executing) {
      startBtn.disabled = false;
      startBtn.textContent = getMessage('panelStop') || '停止';
      startBtn.style.background = '#cf1322';
    } else {
      const canStart = runChannels.size > 0;
      startBtn.disabled = !canStart;
      startBtn.textContent = getMessage('panelStart') || '开始执行（并发全渠道）';
      startBtn.style.background = canStart ? '#1677ff' : '#999';
    }

    startBtn.style.opacity = startBtn.disabled ? '0.65' : '1';
    startBtn.style.cursor = startBtn.disabled ? 'not-allowed' : 'pointer';
  }

  if (checkLoginBtn) {
    const canCheck = runChannels.size > 0 && !isCheckingChannelLogins && !isStartingJob && !isStoppingJob && !isExecutingNow();
    checkLoginBtn.disabled = !canCheck;
    checkLoginBtn.textContent = isCheckingChannelLogins
      ? getMessage('panelCheckingLogin') || '检查中...'
      : getMessage('panelCheckLogin') || '检查登录';
    checkLoginBtn.style.opacity = checkLoginBtn.disabled ? '0.65' : '1';
    checkLoginBtn.style.cursor = checkLoginBtn.disabled ? 'not-allowed' : 'pointer';
  }

  const diagWrapper = document.querySelector('#bawei-v2-diagnosis-wrapper') as HTMLElement | null;
  if (diagWrapper) {
    diagWrapper.style.display = currentJobId ? 'block' : 'none';
  }
  writeRuntimeStateMirror();
}

function renderStatusList(): void {
  const list = document.querySelector('#bawei-v2-status-list') as HTMLElement | null;
  if (!list) return;

  list.innerHTML = '';
  const executing = isExecutingNow();
  const allowControl = !!currentJobId && !isJobStopped;

  for (const ch of ALL_CHANNELS) {
    const state = latestState?.[ch.id];
    const audit = channelLoginAuditState[ch.id];
    const useLoginAudit = !executing && !!audit;
    const status = useLoginAudit ? audit?.status || 'idle' : state?.status || 'not_started';
    const row = document.createElement('div');
    row.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap: 8px;`;

    const left = document.createElement('label');
    left.style.cssText = `display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; min-width: 0;`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `bawei-v2-run-${ch.id}`;
    checkbox.checked = runChannels.has(ch.id);
    checkbox.disabled = executing;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) runChannels.add(ch.id);
      else runChannels.delete(ch.id);
      refreshPanelControls();
    });
    const name = document.createElement('span');
    name.style.cssText = `color:${useLoginAudit && audit?.status === 'not_logged_in' ? '#cf1322' : '#111'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
    name.textContent = getMessage(ch.labelKey) || ch.id;
    left.appendChild(checkbox);
    left.appendChild(name);

    const right = document.createElement('div');
    right.style.cssText = `display:flex; align-items:center; gap:6px; min-width: 0;`;
    const badge = document.createElement('span');
    const badgeBg = useLoginAudit
      ? status === 'logged_in'
        ? 'rgba(0,180,90,0.12)'
        : status === 'not_logged_in'
          ? 'rgba(255,77,79,0.12)'
          : status === 'checking'
            ? 'rgba(22,119,255,0.12)'
            : 'rgba(250,173,20,0.16)'
      : status === 'success'
        ? 'rgba(0,180,90,0.12)'
        : status === 'failed'
          ? 'rgba(255,77,79,0.12)'
          : status === 'waiting_user'
            ? 'rgba(250,173,20,0.16)'
            : status === 'not_logged_in'
              ? 'rgba(114,46,209,0.14)'
              : status === 'running'
                ? 'rgba(22,119,255,0.12)'
                : 'rgba(0,0,0,0.06)';
    const badgeColor = useLoginAudit
      ? status === 'logged_in'
        ? '#0a7a3a'
        : status === 'not_logged_in'
          ? '#cf1322'
          : status === 'checking'
            ? '#0958d9'
            : '#ad6800'
      : status === 'success'
        ? '#0a7a3a'
        : status === 'failed'
          ? '#cf1322'
          : status === 'waiting_user'
            ? '#ad6800'
            : status === 'not_logged_in'
              ? '#531dab'
              : status === 'running'
                ? '#0958d9'
                : '#555';
    badge.style.cssText = `
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: ${badgeBg};
      color: ${badgeColor};
    `;
    badge.textContent = useLoginAudit ? loginAuditStatusLabel(status as LoginAuditStatus) : statusLabel(status);
    if (!useLoginAudit && currentJobId) {
      badge.style.cursor = 'pointer';
      badge.title = getMessage('panelDiagnosisHint') || '点击跳转到该渠道页面';
      badge.addEventListener('click', async () => {
        try {
          await chrome.runtime.sendMessage({ type: V2_FOCUS_CHANNEL_TAB, jobId: currentJobId, channelId: ch.id });
        } catch {
          // ignore
        }
      });
    }

    right.appendChild(badge);

    const progressText = useLoginAudit ? audit?.reason || '' : state?.userMessage || state?.stage || '';
    const progress = document.createElement('span');
    progress.style.cssText = `font-size:11px; color:#666; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
    progress.textContent = progressText;
    right.appendChild(progress);

    if (!useLoginAudit && allowControl && status === 'waiting_user') {
      const btn = document.createElement('button');
      btn.textContent = getMessage('panelContinue') || '继续';
      btn.style.cssText = `font-size:11px; padding:4px 8px; border-radius:6px; border:1px solid rgba(0,0,0,0.12); background:#fff; cursor:pointer;`;
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: V2_REQUEST_CONTINUE, jobId: currentJobId, channelId: ch.id });
      });
      right.appendChild(btn);
    }

    if (!useLoginAudit && allowControl && status === 'failed') {
      const btn = document.createElement('button');
      btn.textContent = getMessage('panelRetry') || '重试';
      btn.style.cssText = `font-size:11px; padding:4px 8px; border-radius:6px; border:1px solid rgba(0,0,0,0.12); background:#fff; cursor:pointer;`;
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: V2_REQUEST_RETRY, jobId: currentJobId, channelId: ch.id });
      });
      right.appendChild(btn);
    }

    if (!useLoginAudit && allowControl && status === 'not_logged_in') {
      const btn = document.createElement('button');
      btn.textContent = getMessage('panelRetry') || '重试';
      btn.style.cssText = `font-size:11px; padding:4px 8px; border-radius:6px; border:1px solid rgba(0,0,0,0.12); background:#fff; cursor:pointer;`;
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: V2_REQUEST_RETRY, jobId: currentJobId, channelId: ch.id });
      });
      right.appendChild(btn);
    }

    row.appendChild(left);
    row.appendChild(right);
    list.appendChild(row);
  }

  refreshPanelControls();
  writeRuntimeStateMirror();
}

function renderDiagnosis(): void {
  const box = document.querySelector('#bawei-v2-diagnosis') as HTMLElement | null;
  if (!box) return;

  const state = latestState?.[focusChannel];
  if (!currentJobId) {
    box.textContent = '';
    writeRuntimeStateMirror();
    return;
  }

  const lines: string[] = [];
  const labelKey = ALL_CHANNELS.find((c) => c.id === focusChannel)?.labelKey || '';

  lines.push(`${getMessage('panelDiagnosisChannel') || '渠道'}：${(labelKey && getMessage(labelKey)) || focusChannel}`);
  lines.push(`${getMessage('panelDiagnosisStatus') || '状态'}：${statusLabel(state?.status || 'not_started')}`);
  if (state?.stage) lines.push(`${getMessage('panelDiagnosisStage') || '步骤'}：${state.stage}`);
  if (state?.userMessage) lines.push(`${getMessage('panelDiagnosisMessage') || '提示'}：${state.userMessage}`);
  if (state?.userSuggestion) lines.push(`${getMessage('panelDiagnosisSuggestion') || '建议'}：${state.userSuggestion}`);
  if (globalHint) lines.push(`\n${globalHint}`);

  // 注意：content script 运行在浏览器环境，`process` 可能不存在；直接引用会触发 ReferenceError
  const isDevBuild =
    (typeof process !== 'undefined' ? (process as { env?: { BUILD_TARGET?: string } }).env?.BUILD_TARGET : 'production') !== 'production';
  if (isDevBuild && state?.devDetails) {
    lines.push(`\n[DEV]\n${JSON.stringify(state.devDetails, null, 2)}`);
  }

  box.textContent = lines.join('\n');
  writeRuntimeStateMirror();
}

// Entry point
if (shouldRun()) {
  initialize();
} else {
  console.log('WeChat content script not running - not a WeChat article page');
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === V3_EXECUTE_MAIN_WORLD && typeof message?.action === 'string' && message.action.startsWith('weixin-')) {
    handleWeixinPanelRemoteAction(message.action, (message as { payload?: Record<string, unknown> }).payload)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  if (message?.type === V2_JOB_BROADCAST) {
    if (currentJobId && message.jobId !== currentJobId) return;
    currentJobId = message.jobId;
    isAwaitingFirstBroadcast = false;

    // 方案 B：不在面板展示 devDetails，仅在控制台输出失败原因，便于定位页面结构变化
    const prev = latestState;
    latestState = message.state as Record<ChannelId, ChannelRuntimeState>;
    const maybeChannels = (message as { channels?: unknown }).channels;
    if (Array.isArray(maybeChannels) && maybeChannels.length > 0) {
      const picked = maybeChannels.filter(
        (c): c is ChannelId => typeof c === 'string' && ALL_CHANNELS.some((x) => x.id === c)
      );
      if (picked.length > 0) runChannels = new Set(picked);
    }
    for (const [channelId, state] of Object.entries(latestState || {})) {
      if (state?.status !== 'failed' && state?.status !== 'waiting_user') continue;
      const prevStatus = prev?.[channelId as ChannelId]?.status;
      if (prevStatus === state.status) continue;
      if (state?.devDetails) {
        const detailsObj: unknown = state.devDetails;
        const details =
          typeof detailsObj === 'object' && detailsObj !== null && 'message' in detailsObj
            ? (detailsObj as Record<string, unknown>)['message']
            : JSON.stringify(detailsObj);
        console.error(`[V2][${channelId}] ${state.status}:`, details);
      }
    }

    renderStatusList();
    renderDiagnosis();
    writeRuntimeStateMirror();
  }
});
