/**
 * WeChat Article Content Script
 * V2: Injects publish panel, extracts article data, and orchestrates multi-channel publishing
 */

import type { ChannelId, ChannelRuntimeState, PublishAction } from '../shared/v2-types';
import type { Settings } from '../shared/settings-manager';

/* INLINE:settings-manager */
/* INLINE:notify */
/* INLINE:v2-protocol */

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

/**
 * Extracts article content HTML from the page
 * @returns Article content HTML
 */
function extractArticleContent(): string {
  // Try multiple selectors for WeChat article content
  const contentSelectors = [
    '#js_content',
    '.rich_media_content',
    '.rich_media_area_primary',
    '.article-content',
    '[data-role="content"]',
  ];
  
  for (const selector of contentSelectors) {
    const contentElement = document.querySelector(selector);
    if (contentElement && contentElement.innerHTML?.trim()) {
      return contentElement.innerHTML.trim();
    }
  }
  
  // Fallback to body content if specific selectors fail
  const bodyContent = document.body.innerHTML;
  return bodyContent || '';
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
  const startBtn = document.createElement('button');
  startBtn.id = 'bawei-v2-start';
  startBtn.textContent = getMessage('panelStart') || '开始执行（并发全渠道）';
  startBtn.style.cssText = `
    width: 100%;
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
  startSection.appendChild(startBtn);

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
    } catch (error) {
      console.error('Failed to stop job:', error);
      showError(getMessage('publishErrorToast') || `失败：${error instanceof Error ? error.message : getMessage('unknownError') || '未知错误'}`);
    } finally {
      isStoppingJob = false;
      refreshPanelControls();
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

  try {
    // Extract article data
    const title = extractArticleTitle();
    const contentHtml = extractArticleContent();
    const sourceUrl = window.location.href;
    
    if (!title.trim()) {
      throw new Error(getMessage('extractTitleFailed') || '无法提取文章标题');
    }
    
    if (!contentHtml.trim()) {
      throw new Error(getMessage('extractContentFailed') || '无法提取文章内容');
    }

    // Diagnose image policy (external images)
    const hasImages = /<img\b/i.test(contentHtml);
    globalHint = hasImages
      ? getMessage('imagePolicyHint') ||
        '检测到图片：本期不上传图片，默认复用原文外链；如平台限制外链，请按诊断提示手动处理。'
      : null;

    const response = await chrome.runtime.sendMessage({
      type: V2_START_JOB,
      action: selectedAction,
      focusChannel,
      channels: Array.from(runChannels),
      article: {
        title,
        contentHtml,
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
    showInfo(getMessage('panelStarted') || '任务已启动：正在并发打开各渠道编辑页...');

    // Keep existing setting behavior (optional): close original page after starting job
    if (settings?.autoCloseOriginal) {
      setTimeout(() => {
        window.close();
      }, 2000);
    }
    
  } catch (error) {
    console.error('Failed to publish article:', error);
    showError(getMessage('publishErrorToast') || `失败：${error instanceof Error ? error.message : getMessage('unknownError') || '未知错误'}`);
  } finally {
    isStartingJob = false;
    refreshPanelControls();
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
    
    // Wait for page to be ready
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
    }
    
    // Additional wait for dynamic content
    setTimeout(() => {
      createLauncherIcon();
    }, 1000);
    
    isInitialized = true;
    console.log('WeChat content script initialized successfully');
    
  } catch (error) {
    console.error('Failed to initialize WeChat content script:', error);
  }
}

/**
 * Checks if we should run on this page
 */
function shouldRun(): boolean {
  // Check if we're on a WeChat article page
  const isWeChatDomain = window.location.hostname === 'mp.weixin.qq.com';
  
  if (!isWeChatDomain) {
    return false;
  }
  
  // Additional checks to ensure it's an article page
  const hasArticleIndicators = 
    document.querySelector('#activity-name') ||
    document.querySelector('#js_content') ||
    document.querySelector('.rich_media_title') ||
    document.title.includes('微信公众平台');
  
  return !!hasArticleIndicators;
}

function statusLabel(status: string): string {
  if (status === 'running') return getMessage('statusRunning') || '进行中';
  if (status === 'success') return getMessage('statusSuccess') || '成功';
  if (status === 'failed') return getMessage('statusFailed') || '失败';
  if (status === 'waiting_user') return getMessage('statusWaiting') || '等待处理';
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

  const diagWrapper = document.querySelector('#bawei-v2-diagnosis-wrapper') as HTMLElement | null;
  if (diagWrapper) {
    diagWrapper.style.display = currentJobId ? 'block' : 'none';
  }
}

function renderStatusList(): void {
  const list = document.querySelector('#bawei-v2-status-list') as HTMLElement | null;
  if (!list) return;

  list.innerHTML = '';
  const executing = isExecutingNow();
  const allowControl = !!currentJobId && !isJobStopped;

  for (const ch of ALL_CHANNELS) {
    const state = latestState?.[ch.id];
    const status = state?.status || 'not_started';
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
    name.style.cssText = `color:#111; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
    name.textContent = getMessage(ch.labelKey) || ch.id;
    left.appendChild(checkbox);
    left.appendChild(name);

    const right = document.createElement('div');
    right.style.cssText = `display:flex; align-items:center; gap:6px; min-width: 0;`;
    const badge = document.createElement('span');
    badge.style.cssText = `
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: ${status === 'success' ? 'rgba(0,180,90,0.12)' : status === 'failed' ? 'rgba(255,77,79,0.12)' : status === 'waiting_user' ? 'rgba(250,173,20,0.16)' : status === 'running' ? 'rgba(22,119,255,0.12)' : 'rgba(0,0,0,0.06)'};
      color: ${status === 'success' ? '#0a7a3a' : status === 'failed' ? '#cf1322' : status === 'waiting_user' ? '#ad6800' : status === 'running' ? '#0958d9' : '#555'};
    `;
    badge.textContent = statusLabel(status);

    right.appendChild(badge);

    const progressText = state?.userMessage || state?.stage || '';
    const progress = document.createElement('span');
    progress.style.cssText = `font-size:11px; color:#666; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
    progress.textContent = progressText;
    right.appendChild(progress);

    if (allowControl && status === 'waiting_user') {
      const btn = document.createElement('button');
      btn.textContent = getMessage('panelContinue') || '继续';
      btn.style.cssText = `font-size:11px; padding:4px 8px; border-radius:6px; border:1px solid rgba(0,0,0,0.12); background:#fff; cursor:pointer;`;
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ type: V2_REQUEST_CONTINUE, jobId: currentJobId, channelId: ch.id });
      });
      right.appendChild(btn);
    }

    if (allowControl && status === 'failed') {
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
}

function renderDiagnosis(): void {
  const box = document.querySelector('#bawei-v2-diagnosis') as HTMLElement | null;
  if (!box) return;

  const state = latestState?.[focusChannel];
  if (!currentJobId) {
    box.textContent = '';
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

  const isDevBuild = (process?.env?.BUILD_TARGET || 'production') !== 'production';
  if (isDevBuild && state?.devDetails) {
    lines.push(`\n[DEV]\n${JSON.stringify(state.devDetails, null, 2)}`);
  }

  box.textContent = lines.join('\n');
}

// Entry point
if (shouldRun()) {
  initialize();
} else {
  console.log('WeChat content script not running - not a WeChat article page');
}

chrome.runtime.onMessage.addListener((message) => {
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
  }
});
