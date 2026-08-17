import { getSettings } from './shared/settings-manager';
import {
  cleanExpiredData,
  getJobData,
  getJobState,
  markJobStopped,
  storeJobData,
  storeJobState
} from './shared/article-data-manager';
import type { ChannelId, ChannelRuntimeState, PublishAction, PublishJob } from './shared/v2-types';
import { CHANNEL_IDS, getChannelConfig, matchesChannelUrl } from './shared/channel-config';
import {
  getNextSerialChannel,
  getRunningSerialChannel,
  isSerialTerminalStatus
} from './shared/serial-channel-queue';
import {
  V2_AUDIT_CHANNEL_LOGIN,
  V2_CHANNEL_UPDATE,
  V2_FOCUS_CHANNEL_TAB,
  V2_GET_CONTEXT,
  V2_JOB_BROADCAST,
  V2_PROBE_LOGIN_STATE,
  V2_REQUEST_CONTINUE,
  V2_REQUEST_RETRY,
  V2_REQUEST_STOP,
  V2_START_JOB,
  V3_EXECUTE_MAIN_WORLD,
  V3_FETCH_IMAGE
} from './shared/v2-protocol';
import type {
  AuditChannelLoginRequest,
  AuditChannelLoginResponse,
  ChannelUpdate,
  ContinueRequest,
  ExecuteMainWorldRequest,
  ExecuteMainWorldResponse,
  FetchImageRequest,
  FetchImageResponse,
  FocusChannelTabRequest,
  FocusChannelTabResponse,
  GetContextResponse,
  ProbeLoginStateResult,
  ProbeLoginStateResponse,
  RetryRequest,
  StartJobRequest,
  StartJobResponse,
  StopJobRequest,
  StopJobResponse
} from './shared/v2-protocol';

// Extension lifecycle events
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('bawei V2 extension installed/updated:', details.reason);

  // Initialize settings on first install
  if (details.reason === 'install') {
    console.log('First install - initializing settings...');
    await getSettings(); // This will create default settings
    console.log('Settings initialized successfully');
  }

  // Handle updates
  if (details.reason === 'update') {
    const previousVersion = details.previousVersion;
    console.log(`Updated from version ${previousVersion}`);

    // Ensure settings are compatible with new version
    await getSettings(); // This will merge with defaults if needed
    console.log('Settings migrated successfully');
  }

  // Clean expired article data on install/update
  try {
    const cleanedCount = await cleanExpiredData();
    console.log('Cleaned expired article data on install/update:', cleanedCount);
  } catch (error) {
    console.warn('Failed to clean expired data on install/update:', error);
  }
});

// Handle extension startup
chrome.runtime.onStartup.addListener(async () => {
  console.log('bawei V2 extension started');

  // Clean expired article data on startup
  try {
    const cleanedCount = await cleanExpiredData();
    console.log('Cleaned expired article data on startup:', cleanedCount);
  } catch (error) {
    console.warn('Failed to clean expired data on startup:', error);
  }
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  console.debug('Background received message:', message, 'from', sender);

  const msg = message as { type?: unknown };
  const type = typeof msg.type === 'string' ? msg.type : '';

  // Handle different message types
  switch (type) {
    case V2_START_JOB:
      handleV2StartJob(
        message as StartJobRequest,
        sender,
        sendResponse as (response: StartJobResponse) => void
      );
      return true; // Indicate async response

    case V2_GET_CONTEXT:
      handleV2GetContext(sender, sendResponse as (response: GetContextResponse) => void);
      return true;

    case V2_CHANNEL_UPDATE:
      handleV2ChannelUpdate(
        message as ChannelUpdate,
        sender,
        sendResponse as (response: { success: boolean; error?: string }) => void
      );
      return true;

    case V2_REQUEST_CONTINUE:
      handleV2Control(
        message as ContinueRequest,
        sendResponse as (response: { success: boolean; error?: string }) => void
      );
      return true;

    case V2_REQUEST_RETRY:
      handleV2Control(
        message as RetryRequest,
        sendResponse as (response: { success: boolean; error?: string }) => void
      );
      return true;

    case V2_REQUEST_STOP:
      handleV2StopJob(
        message as StopJobRequest,
        sendResponse as (response: StopJobResponse) => void
      );
      return true;

    case V2_FOCUS_CHANNEL_TAB:
      handleV2FocusChannelTab(
        message as FocusChannelTabRequest,
        sendResponse as (response: FocusChannelTabResponse) => void
      );
      return true;

    case V2_AUDIT_CHANNEL_LOGIN:
      handleV2AuditChannelLogin(
        message as AuditChannelLoginRequest,
        sender,
        sendResponse as (response: AuditChannelLoginResponse) => void
      );
      return true;

    case V3_FETCH_IMAGE:
      handleV3FetchImage(
        message as FetchImageRequest,
        sendResponse as (response: FetchImageResponse) => void
      );
      return true;

    case V3_EXECUTE_MAIN_WORLD:
      handleV3ExecuteMainWorld(
        message as ExecuteMainWorldRequest,
        sender,
        sendResponse as (response: ExecuteMainWorldResponse) => void
      );
      return true;

    case 'ping':
      sendResponse({ success: true, message: 'pong' });
      break;

    case 'error-report': {
      const err = (message as Record<string, unknown>)?.['error'];
      console.error('Error reported from content script:', err);
      sendResponse({ success: true });
      break;
    }

    default:
      console.warn('Unknown message type:', type);
      sendResponse({ success: false, error: 'Unknown message type' });
  }

  return true;
});

/**
 * V2 runtime mappings (in-memory)
 */
const tabIdToContext = new Map<number, { jobId: string; channelId: ChannelId }>();
const jobIdToSourceTabId = new Map<string, number>();
const jobStateCache = new Map<string, Record<ChannelId, ChannelRuntimeState>>();
const serialAdvanceLocks = new Map<string, Promise<void>>();

const CHANNEL_ENTRY_URLS = Object.fromEntries(
  CHANNEL_IDS.map((channelId) => [channelId, getChannelConfig(channelId).entryUrl])
) as Record<ChannelId, string>;

const ALL_CHANNELS: ChannelId[] = [...CHANNEL_IDS];

function urlPrefix(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function isReusableChannelEntryUrl(
  channelId: ChannelId,
  tabUrl: string,
  configuredPrefix: string
): boolean {
  if (channelId === 'oschina') {
    return /^https:\/\/my\.oschina\.net\/u\/[^/]+\/blog\/(?:ai-)?write(?:[/?#]|$)/i.test(tabUrl);
  }
  if (channelId === 'sspai') {
    return /^https:\/\/sspai\.com\/(?:write(?:[/?#]|$)|my(?:[/?#]|$)|whoops(?:[/?#]|$))/i.test(
      tabUrl
    );
  }
  return tabUrl.startsWith(configuredPrefix);
}

function targetChannelEntryUrl(
  channelId: ChannelId,
  configuredUrl: string,
  existingUrl?: string
): string {
  if (
    channelId === 'oschina' &&
    existingUrl &&
    /^https:\/\/my\.oschina\.net\/u\/[^/]+\/blog\/(?:ai-)?write(?:[/?#]|$)/i.test(existingUrl)
  ) {
    return existingUrl;
  }
  if (
    channelId === 'sspai' &&
    existingUrl &&
    /^https:\/\/sspai\.com\/(?:my(?:[/?#]|$)|whoops(?:[/?#]|$))/i.test(existingUrl)
  ) {
    return existingUrl;
  }
  if (
    channelId === 'toutiao' &&
    existingUrl &&
    /^https:\/\/mp\.toutiao\.com\/profile_v4\/graphic\/publish\?(?=[^#]*\bpgc_id=\d+)/i.test(
      existingUrl
    )
  ) {
    return existingUrl;
  }
  return configuredUrl;
}

async function openOrReuseChannelTab(
  channelId: ChannelId,
  options: { active: boolean; beforeNavigate?: (tabId: number) => void }
): Promise<chrome.tabs.Tab> {
  const url = CHANNEL_ENTRY_URLS[channelId];
  const prefix = urlPrefix(url);
  try {
    const tabs = await chrome.tabs.query({});
    const matches = tabs.filter(
      (t) =>
        t.id && typeof t.url === 'string' && isReusableChannelEntryUrl(channelId, t.url, prefix)
    );
    const sorted = matches
      .slice()
      .sort(
        (a, b) =>
          Number((b as { lastAccessed?: unknown }).lastAccessed || 0) -
          Number((a as { lastAccessed?: unknown }).lastAccessed || 0)
      );

    const keep = sorted[0] || null;
    const toClose = sorted
      .slice(1)
      .map((t) => t.id)
      .filter((id): id is number => typeof id === 'number');
    if (toClose.length) {
      await chrome.tabs.remove(toClose).catch(() => {});
    }
    if (keep?.id) {
      options.beforeNavigate?.(keep.id);
      if (options.active && keep.windowId != null) {
        await chrome.windows.update(keep.windowId, { focused: true }).catch(() => {});
      }
      return await chrome.tabs.update(keep.id, {
        url: targetChannelEntryUrl(channelId, url, keep.url),
        active: options.active
      });
    }
  } catch {
    // ignore and fallback create
  }

  const created = await chrome.tabs.create({ url: 'about:blank', active: options.active });
  if (!created.id) throw new Error(`Failed to create channel tab: ${channelId}`);
  options.beforeNavigate?.(created.id);
  if (options.active && created.windowId != null) {
    await chrome.windows.update(created.windowId, { focused: true }).catch(() => {});
  }
  return await chrome.tabs.update(created.id, { url, active: options.active });
}

function newJobId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function nowState(channelId: ChannelId, patch?: Partial<ChannelRuntimeState>): ChannelRuntimeState {
  return {
    channelId,
    status: 'not_started',
    updatedAt: Date.now(),
    ...patch
  };
}

function buildInitialState(): Record<ChannelId, ChannelRuntimeState> {
  return {
    csdn: nowState('csdn'),
    'tencent-cloud-dev': nowState('tencent-cloud-dev'),
    cnblogs: nowState('cnblogs'),
    oschina: nowState('oschina'),
    woshipm: nowState('woshipm'),
    mowen: nowState('mowen'),
    sspai: nowState('sspai'),
    baijiahao: nowState('baijiahao'),
    toutiao: nowState('toutiao'),
    'feishu-docs': nowState('feishu-docs')
  };
}

async function patchJobChannelState(
  jobId: string,
  channelId: ChannelId,
  patch: Partial<ChannelRuntimeState>
): Promise<void> {
  const job = await getJobData(jobId);
  if (job?.stoppedAt) return;

  const current = jobStateCache.get(jobId) || (await getJobState(jobId)) || buildInitialState();
  const prev = current[channelId] || nowState(channelId);
  const next: ChannelRuntimeState = {
    ...prev,
    ...patch,
    channelId,
    updatedAt: Date.now(),
    tabId: patch.tabId ?? prev.tabId
  };
  current[channelId] = next;
  jobStateCache.set(jobId, current);
  await storeJobState(jobId, current);
  await broadcastJobState(jobId);

  if (isSerialTerminalStatus(next.status)) {
    await enqueueSerialAdvance(jobId);
  }
}

async function broadcastJobState(jobId: string): Promise<void> {
  const sourceTabId = jobIdToSourceTabId.get(jobId);
  const state = jobStateCache.get(jobId);
  if (!sourceTabId || !state) return;
  try {
    const job = await getJobData(jobId);
    await chrome.tabs.sendMessage(sourceTabId, {
      type: V2_JOB_BROADCAST,
      jobId,
      channels: job?.channels,
      state
    });
  } catch (error) {
    console.warn('[V2] Failed to broadcast state to source tab:', error);
  }
}

async function focusOpenedChannelTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) return;
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
}

async function advanceSerialJob(jobId: string): Promise<void> {
  const job = await getJobData(jobId);
  if (!job || job.stoppedAt) return;

  const channels = (job.channels || ALL_CHANNELS).filter((channelId): channelId is ChannelId =>
    ALL_CHANNELS.includes(channelId)
  );
  const state = jobStateCache.get(jobId) || (await getJobState(jobId)) || buildInitialState();
  jobStateCache.set(jobId, state);

  while (!getRunningSerialChannel(channels, state)) {
    const channelId = getNextSerialChannel(channels, state);
    if (!channelId) {
      cleanupImagesForJob(jobId);
      return;
    }

    state[channelId] = {
      ...state[channelId],
      channelId,
      status: 'running',
      stage: 'openEntry',
      userMessage: chrome.i18n.getMessage('redirectingToTarget'),
      userSuggestion: undefined,
      devDetails: undefined,
      updatedAt: Date.now()
    };
    await storeJobState(jobId, state);
    await broadcastJobState(jobId);

    try {
      const tab = await openOrReuseChannelTab(channelId, {
        active: true,
        beforeNavigate: (tabId) => {
          tabIdToContext.set(tabId, { jobId, channelId });
        }
      });
      if (!tab.id) throw new Error(`Channel tab has no id: ${channelId}`);

      tabIdToContext.set(tab.id, { jobId, channelId });
      state[channelId] = {
        ...state[channelId],
        tabId: tab.id,
        updatedAt: Date.now()
      };
      await storeJobState(jobId, state);
      await focusOpenedChannelTab(tab);
      await broadcastJobState(jobId);
      return;
    } catch (error) {
      state[channelId] = {
        ...state[channelId],
        status: 'failed',
        userMessage: chrome.i18n.getMessage('v2MsgFailed'),
        userSuggestion: chrome.i18n.getMessage('v3SugClickStatusToReopen'),
        devDetails: { message: error instanceof Error ? error.message : String(error) },
        updatedAt: Date.now()
      };
      await storeJobState(jobId, state);
      await broadcastJobState(jobId);
    }
  }
}

function enqueueSerialAdvance(jobId: string): Promise<void> {
  const previous = serialAdvanceLocks.get(jobId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await advanceSerialJob(jobId);
    });
  serialAdvanceLocks.set(jobId, next);

  const cleanup = () => {
    if (serialAdvanceLocks.get(jobId) === next) serialAdvanceLocks.delete(jobId);
  };
  void next.then(cleanup, cleanup);
  return next;
}

/**
 * Handles V2 job start: store job, then focus and run one channel at a time.
 */
async function handleV2StartJob(
  message: StartJobRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: StartJobResponse) => void
) {
  try {
    const action: PublishAction = message.action;
    const article = message.article;
    if (!article?.title || !article?.contentHtml) {
      throw new Error('Missing required fields: title/contentHtml');
    }

    const jobId = newJobId();
    const createdAt = Date.now();
    const sourceTabId = sender.tab?.id;

    const channelsToRun = (
      Array.isArray(message.channels) && message.channels.length > 0
        ? message.channels
        : ALL_CHANNELS
    ).filter((c): c is ChannelId => ALL_CHANNELS.includes(c));

    const job: PublishJob = {
      jobId,
      createdAt,
      action,
      article,
      channels: channelsToRun,
      sourceTabId
    };

    await storeJobData(job);

    const initialState = buildInitialState();
    jobStateCache.set(jobId, initialState);
    await storeJobState(jobId, initialState);

    if (sourceTabId) {
      jobIdToSourceTabId.set(jobId, sourceTabId);
    }

    await enqueueSerialAdvance(jobId);

    sendResponse({ success: true, jobId });
  } catch (error) {
    console.error('[V2] Failed to start job:', error);
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function handleV2GetContext(
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: GetContextResponse) => void
) {
  try {
    const tabId = sender.tab?.id;
    if (!tabId) throw new Error('No sender tab id');
    const ctx = tabIdToContext.get(tabId);
    if (!ctx) throw new Error('No context for this tab');
    const job = await getJobData(ctx.jobId);
    if (!job) throw new Error('Job not found');
    sendResponse({ success: true, job, channelId: ctx.channelId });
  } catch (error) {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function handleV2ChannelUpdate(
  message: ChannelUpdate,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: { success: boolean; error?: string }) => void
) {
  try {
    const jobId: string = message.jobId;
    const channelId: ChannelId = message.channelId;
    const patch: Partial<ChannelRuntimeState> = message.patch || {};

    if (!jobId || !channelId) throw new Error('Missing jobId/channelId');

    const job = await getJobData(jobId);
    if (job?.stoppedAt) {
      sendResponse({ success: true });
      return;
    }

    const current = jobStateCache.get(jobId) || (await getJobState(jobId)) || buildInitialState();
    const prev = current[channelId] || nowState(channelId);
    const next: ChannelRuntimeState = {
      ...prev,
      ...patch,
      channelId,
      updatedAt: Date.now(),
      tabId: sender.tab?.id || prev.tabId
    };
    current[channelId] = next;

    jobStateCache.set(jobId, current);
    await storeJobState(jobId, current);
    await broadcastJobState(jobId);

    if (isSerialTerminalStatus(next.status)) {
      await enqueueSerialAdvance(jobId);
    }

    sendResponse({ success: true });
  } catch (error) {
    console.warn('[V2] Failed to handle channel update:', error);
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function handleV2StopJob(
  message: StopJobRequest,
  sendResponse: (response: StopJobResponse) => void
) {
  try {
    const jobId = message.jobId;
    if (!jobId) throw new Error('Missing jobId');

    const job = await getJobData(jobId);
    if (!job) throw new Error('Job not found');

    if (job.stoppedAt) {
      sendResponse({ success: true });
      return;
    }

    await markJobStopped(jobId, Date.now());

    const state = jobStateCache.get(jobId) || (await getJobState(jobId));
    await Promise.all(
      ALL_CHANNELS.map(async (channelId) => {
        const tabId = state?.[channelId]?.tabId;
        if (!tabId) return;
        try {
          await chrome.tabs.sendMessage(tabId, { type: V2_REQUEST_STOP, jobId });
        } catch (error) {
          console.warn('[V2] Failed to send stop to channel tab:', channelId, error);
        }
      })
    );

    cleanupImagesForJob(jobId);

    sendResponse({ success: true });
  } catch (error) {
    console.warn('[V2] Failed to stop job:', error);
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function handleV2FocusChannelTab(
  message: FocusChannelTabRequest,
  sendResponse: (response: FocusChannelTabResponse) => void
) {
  try {
    const { jobId, channelId } = message;
    if (!jobId || !channelId) throw new Error('Missing jobId/channelId');

    const state = jobStateCache.get(jobId) || (await getJobState(jobId));
    if ((state?.[channelId]?.status || 'not_started') === 'not_started') {
      throw new Error(`Channel is waiting in serial queue: ${channelId}`);
    }
    const tabId = state?.[channelId]?.tabId;
    if (tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.windowId != null) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        await chrome.tabs.update(tabId, { active: true });
        sendResponse({ success: true, tabId });
        return;
      } catch {
        // ignore (tab might be closed)
      }
    }

    const url = CHANNEL_ENTRY_URLS[channelId];
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab.id) throw new Error('Failed to create tab');

    tabIdToContext.set(tab.id, { jobId, channelId });
    await patchJobChannelState(jobId, channelId, {
      tabId: tab.id
    });

    sendResponse({ success: true, tabId: tab.id });
  } catch (error) {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function waitForTabReady(tabId: number, timeoutMs = 30000): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  let lastTab: chrome.tabs.Tab | null = null;

  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(`tab not found: ${tabId}`);
    lastTab = tab;
    if (tab.status === 'complete') {
      await sleep(800);
      return (await chrome.tabs.get(tabId).catch(() => tab)) || tab;
    }
    await sleep(300);
  }

  if (lastTab) return lastTab;
  throw new Error(`tab not ready: ${tabId}`);
}

async function probeLoginStateFromChannelTab(
  tabId: number,
  channelId: ChannelId,
  fallbackUrl: string
): Promise<ProbeLoginStateResult> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: V2_PROBE_LOGIN_STATE,
      channelId
    })) as ProbeLoginStateResponse | undefined;
    if (response?.success && response.result) {
      return response.result;
    }
  } catch {
    // ignore and fallback to URL-only probe
  }

  return {
    status: looksLikeLoginUrl(fallbackUrl, channelId) ? 'not_logged_in' : 'unknown',
    reason: looksLikeLoginUrl(fallbackUrl, channelId) ? 'login-url' : 'probe-unavailable',
    url: fallbackUrl
  };
}

async function handleV2AuditChannelLogin(
  message: AuditChannelLoginRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: AuditChannelLoginResponse) => void
) {
  const channels = (Array.isArray(message.channels) ? message.channels : []).filter(
    (item): item is ChannelId => ALL_CHANNELS.includes(item)
  );
  if (!channels.length) {
    sendResponse({ success: false, error: 'No channels selected' });
    return;
  }

  const sourceTabId = sender.tab?.id;

  try {
    const results: Partial<Record<ChannelId, ProbeLoginStateResult & { tabId?: number }>> = {};

    for (const channelId of channels) {
      const tab = await openOrReuseChannelTab(channelId, { active: false });
      if (!tab.id) {
        results[channelId] = {
          status: 'unknown',
          reason: 'tab-open-failed',
          url: CHANNEL_ENTRY_URLS[channelId]
        };
        continue;
      }

      const readyTab = await waitForTabReady(tab.id, 45000).catch(() => tab);
      const currentUrl = String(readyTab.url || CHANNEL_ENTRY_URLS[channelId]);
      const result = await probeLoginStateFromChannelTab(tab.id, channelId, currentUrl);
      results[channelId] = {
        ...result,
        tabId: tab.id
      };
    }

    if (typeof sourceTabId === 'number') {
      await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
    }

    sendResponse({ success: true, results });
  } catch (error) {
    if (typeof sourceTabId === 'number') {
      await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
    }
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const IMAGE_MIN_BYTES = 32;
const imageCache = new Map<
  string,
  { mimeType: string; buffer: ArrayBuffer; size: number; fetchedAt: number }
>();
const imageInFlight = new Map<
  string,
  Promise<{ mimeType: string; buffer: ArrayBuffer; size: number; fetchedAt: number }>
>();
const jobIdToImageUrls = new Map<string, Set<string>>();
const IMAGE_PROXY_ENDPOINT = 'https://read.useai.online/api/image-proxy?url=';

function normalizeProxyImageUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';

  try {
    const outer = new URL(value);
    const host = outer.hostname.toLowerCase();
    const isProxy = host === 'read.useai.online' && outer.pathname.startsWith('/api/image-proxy');
    if (!isProxy) {
      if (outer.protocol === 'http:' && (host.endsWith('.qpic.cn') || host.endsWith('.qlogo.cn'))) {
        outer.protocol = 'https:';
      }
      return outer.toString();
    }

    const innerRaw = String(outer.searchParams.get('url') || '').trim();
    if (!innerRaw) return outer.toString();

    try {
      const inner = new URL(innerRaw);
      if (inner.protocol !== 'https:' && inner.protocol !== 'http:') return outer.toString();
      if (
        inner.protocol === 'http:' &&
        (inner.hostname.toLowerCase().endsWith('.qpic.cn') ||
          inner.hostname.toLowerCase().endsWith('.qlogo.cn'))
      ) {
        inner.protocol = 'https:';
      }
      if (inner.hash) inner.hash = '';
      outer.searchParams.set('url', inner.toString());
      return outer.toString();
    } catch {
      return outer.toString();
    }
  } catch {
    return value;
  }
}

function isAllowedImageUrl(raw: string): boolean {
  try {
    const normalized = normalizeProxyImageUrl(raw);
    const u = new URL(normalized);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'read.useai.online' && u.pathname.startsWith('/api/image-proxy')) {
      const target = String(u.searchParams.get('url') || '').trim();
      if (!target) return false;
      try {
        const inner = new URL(target);
        return inner.protocol === 'https:' || inner.protocol === 'http:';
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function decodeProxyTargetUrl(raw: string): string {
  try {
    const outer = new URL(String(raw || '').trim());
    const host = outer.hostname.toLowerCase();
    if (!(host === 'read.useai.online' && outer.pathname.startsWith('/api/image-proxy'))) return '';
    const innerRaw = String(outer.searchParams.get('url') || '').trim();
    if (!innerRaw) return '';
    const inner = new URL(innerRaw);
    if (inner.protocol !== 'https:' && inner.protocol !== 'http:') return '';
    if (
      inner.protocol === 'http:' &&
      (inner.hostname.toLowerCase().endsWith('.qpic.cn') ||
        inner.hostname.toLowerCase().endsWith('.qlogo.cn'))
    ) {
      inner.protocol = 'https:';
    }
    if (inner.hash) inner.hash = '';
    return inner.toString();
  } catch {
    return '';
  }
}

function looksLikeImageBinary(mimeType: string, buffer: ArrayBuffer, size: number): boolean {
  const mt = String(mimeType || '').toLowerCase();
  const byteLen = Number(size || buffer?.byteLength || 0);
  if (!byteLen || byteLen < IMAGE_MIN_BYTES) return false;

  const head = new Uint8Array(buffer.slice(0, Math.min(16, byteLen)));
  const ascii = (from: number, len: number) => {
    try {
      return String.fromCharCode(...Array.from(head.slice(from, from + len)));
    } catch {
      return '';
    }
  };

  if (mt.includes('png')) {
    if (byteLen < 64) return false;
    return (
      head.length >= 8 &&
      head[0] === 0x89 &&
      head[1] === 0x50 &&
      head[2] === 0x4e &&
      head[3] === 0x47
    );
  }
  if (mt.includes('jpeg') || mt.includes('jpg')) {
    if (byteLen < 64) return false;
    return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  }
  if (mt.includes('gif')) {
    const sig = ascii(0, 6);
    return sig === 'GIF87a' || sig === 'GIF89a';
  }
  if (mt.includes('webp')) {
    return ascii(0, 4) === 'RIFF' && head.length >= 12 && ascii(8, 4) === 'WEBP';
  }
  if (mt.includes('svg')) {
    return false;
  }

  return byteLen >= 128;
}

function isProxyImageUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw || '').trim());
    return (
      u.hostname.toLowerCase() === 'read.useai.online' && u.pathname.startsWith('/api/image-proxy')
    );
  } catch {
    return false;
  }
}

function cleanupImagesForJob(jobId: string): void {
  const urls = jobIdToImageUrls.get(jobId);
  if (!urls) return;
  for (const url of urls) {
    imageCache.delete(url);
    imageInFlight.delete(url);
  }
  jobIdToImageUrls.delete(jobId);
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const parts: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    parts.push(String.fromCharCode(...Array.from(chunk)));
  }

  return btoa(parts.join(''));
}

async function fetchImageBinary(
  url: string,
  source: 'direct' | 'proxy'
): Promise<{ mimeType: string; buffer: ArrayBuffer; size: number; fetchedAt: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      signal: ac.signal
    });
    if (!res.ok) throw new Error(`${source} fetch failed: ${res.status}`);

    const ct = res.headers.get('content-type') || '';
    const mimeType = ct.split(';')[0].trim() || 'application/octet-stream';
    if (!mimeType.toLowerCase().startsWith('image/')) {
      throw new Error(`${source} unexpected content-type: ${mimeType || 'empty'}`);
    }

    const buffer = await res.arrayBuffer();
    const size = buffer?.byteLength || 0;
    if (!size) throw new Error(`${source} empty image`);
    if (size > IMAGE_MAX_BYTES) throw new Error(`${source} image too large: ${size}`);
    return { mimeType, buffer, size, fetchedAt: Date.now() };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${source} fetch timeout`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImageCached(
  url: string
): Promise<{ mimeType: string; buffer: ArrayBuffer; size: number; fetchedAt: number }> {
  const cached = imageCache.get(url);
  if (cached) return cached;

  const inFlight = imageInFlight.get(url);
  if (inFlight) return await inFlight;

  const task = (async () => {
    const errors: string[] = [];

    if (isProxyImageUrl(url)) {
      const inner = decodeProxyTargetUrl(url);
      if (inner) {
        try {
          const out = await fetchImageBinary(inner, 'direct');
          if (!looksLikeImageBinary(out.mimeType, out.buffer, out.size)) {
            throw new Error(
              `direct(inner) invalid image binary: mime=${out.mimeType} size=${out.size}`
            );
          }
          imageCache.set(url, out);
          imageCache.set(inner, out);
          return out;
        } catch (error) {
          errors.push(stringifyError(error));
        }
      }
      try {
        const out = await fetchImageBinary(url, 'proxy');
        if (!looksLikeImageBinary(out.mimeType, out.buffer, out.size)) {
          throw new Error(`proxy invalid image binary: mime=${out.mimeType} size=${out.size}`);
        }
        imageCache.set(url, out);
        return out;
      } catch (error) {
        errors.push(stringifyError(error));
      }

      throw new Error(`fetch image failed: ${errors.join(' | ')}`);
    }

    try {
      const out = await fetchImageBinary(url, 'direct');
      if (!looksLikeImageBinary(out.mimeType, out.buffer, out.size)) {
        throw new Error(`direct invalid image binary: mime=${out.mimeType} size=${out.size}`);
      }
      imageCache.set(url, out);
      return out;
    } catch (error) {
      errors.push(stringifyError(error));
    }

    const proxyUrl = `https://read.useai.online/api/image-proxy?url=${encodeURIComponent(url)}`;
    try {
      const out = await fetchImageBinary(proxyUrl, 'proxy');
      if (!looksLikeImageBinary(out.mimeType, out.buffer, out.size)) {
        throw new Error(`proxy invalid image binary: mime=${out.mimeType} size=${out.size}`);
      }
      imageCache.set(url, out);
      imageCache.set(proxyUrl, out);
      return out;
    } catch (error) {
      errors.push(stringifyError(error));
    }

    throw new Error(`fetch image failed: ${errors.join(' | ')}`);
  })();

  imageInFlight.set(url, task);
  try {
    return await task;
  } finally {
    imageInFlight.delete(url);
  }
}

async function handleV3FetchImage(
  message: FetchImageRequest,
  sendResponse: (response: FetchImageResponse) => void
) {
  try {
    const jobId = message.jobId;
    const url = message.url;
    if (!jobId || !url) throw new Error('Missing jobId/url');

    let effectiveUrl = normalizeProxyImageUrl(url);
    if (!isAllowedImageUrl(effectiveUrl)) {
      try {
        const u = new URL(effectiveUrl);
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          effectiveUrl = normalizeProxyImageUrl(
            `${IMAGE_PROXY_ENDPOINT}${encodeURIComponent(u.toString())}`
          );
        }
      } catch {
        // keep original and fail below
      }
    }
    if (!isAllowedImageUrl(effectiveUrl)) {
      throw new Error(
        `Image URL is not allowed: ${String(url).slice(0, 280)} | effective=${String(effectiveUrl).slice(0, 280)}`
      );
    }

    const data = await fetchImageCached(effectiveUrl);
    let set = jobIdToImageUrls.get(jobId);
    if (!set) {
      set = new Set();
      jobIdToImageUrls.set(jobId, set);
    }
    set.add(effectiveUrl);

    const bufferBase64 = arrayBufferToBase64(data.buffer);
    sendResponse({
      success: true,
      mimeType: data.mimeType,
      bufferBase64,
      size: data.size,
      debugMarker: 'v3-image-base64'
    } as FetchImageResponse & { debugMarker: string });
  } catch (error) {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function handleV3ExecuteMainWorld(
  message: ExecuteMainWorldRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: ExecuteMainWorldResponse) => void
) {
  try {
    const tabId = sender.tab?.id || message.tabId;
    if (!tabId) throw new Error('Missing sender tab id');

    if (message.action.startsWith('weixin-')) {
      const response = await chrome.tabs.sendMessage(tabId, message);
      sendResponse(
        (response || {
          success: false,
          error: 'Empty weixin content-script response'
        }) as ExecuteMainWorldResponse
      );
      return;
    }

    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (action: string, payload: Record<string, unknown>) => {
        const bodyText = () => String(document.body?.innerText || '');
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const parseRuntime = () => {
          try {
            const raw = String(
              document.querySelector('#bawei-v2-runtime-state')?.textContent || ''
            ).trim();
            if (!raw) return null;
            return JSON.parse(raw);
          } catch {
            return null;
          }
        };
        const panelVisible = () => {
          const panel = document.querySelector('#bawei-v2-panel');
          if (!(panel instanceof HTMLElement)) return false;
          const rect = panel.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = getComputedStyle(panel);
          return !(
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
          );
        };
        const collectUiState = () => {
          const runtime = parseRuntime();
          const checkedChannels = Array.from(
            document.querySelectorAll('input[id^="bawei-v2-run-"]')
          )
            .filter(
              (node): node is HTMLInputElement => node instanceof HTMLInputElement && node.checked
            )
            .map((node) => String(node.id || '').replace(/^bawei-v2-run-/, ''))
            .filter(Boolean);
          const selectedAction =
            (
              document.querySelector(
                'input[name="bawei_v2_action"]:checked'
              ) as HTMLInputElement | null
            )?.value || '';
          const startButton = document.querySelector('#bawei-v2-start') as HTMLButtonElement | null;
          return {
            url: location.href,
            title: document.title,
            hasLauncher: !!document.querySelector('#bawei-v2-launcher'),
            hasPanel: !!document.querySelector('#bawei-v2-panel'),
            hasMirror: !!document.querySelector('#bawei-v2-runtime-state'),
            panelVisible: panelVisible(),
            selectedAction,
            checkedChannels,
            startButtonText: String(startButton?.textContent || '').trim(),
            startButtonDisabled: !!startButton?.disabled,
            runtime,
            diagnosisText: String(
              document.querySelector('#bawei-v2-diagnosis')?.textContent || ''
            ).trim()
          };
        };
        const dispatchCheckbox = (input: HTMLInputElement, checked: boolean) => {
          if (input.checked === checked) return;
          input.checked = checked;
          input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        };

        type ToutiaoEditor = {
          setHTML?: (
            html: string,
            options?: { allowUndo?: boolean; silent?: boolean; mergeEmpty?: boolean }
          ) => unknown;
          getHTML?: () => string;
          setSelection?: (selection: { index: number; length: number }) => unknown;
          delete?: (
            index: number,
            length: number,
            options?: { allowUndo?: boolean; silent?: boolean }
          ) => unknown;
          view?: {
            state?: {
              doc?: {
                descendants?: (
                  callback: (node: { text?: string }, position: number) => boolean | void
                ) => void;
              };
            };
          };
        };
        type ToutiaoFiber = {
          return?: ToutiaoFiber | null;
          stateNode?: { editor?: ToutiaoEditor } | null;
        };
        const findToutiaoEditor = (): { host: HTMLElement; editor: ToutiaoEditor } | null => {
          const host = document.querySelector<HTMLElement>('.syl-editor');
          if (!host) return null;
          const reactKey = Object.getOwnPropertyNames(host).find(
            (key) => key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$')
          );
          if (!reactKey) return null;

          let fiber = (host as unknown as Record<string, unknown>)[reactKey] as
            | ToutiaoFiber
            | null
            | undefined;
          for (let depth = 0; fiber && depth < 48; depth += 1) {
            const editor = fiber.stateNode?.editor;
            if (
              editor &&
              typeof editor.setHTML === 'function' &&
              typeof editor.getHTML === 'function'
            ) {
              return { host, editor };
            }
            fiber = fiber.return || null;
          }
          return null;
        };

        if (action === 'toutiao-set-html') {
          const html = String(payload?.html || '').trim();
          const markers = Array.isArray(payload?.markers)
            ? (payload.markers as unknown[]).map((value) => String(value || '')).filter(Boolean)
            : [];
          if (!html) return { ok: false, error: 'toutiao-content-html-empty' };
          const binding = findToutiaoEditor();
          if (!binding) return { ok: false, error: 'toutiao-editor-instance-not-found' };

          await Promise.resolve(
            binding.editor.setHTML?.(html, {
              allowUndo: true,
              silent: false,
              mergeEmpty: true
            })
          );
          await wait(180);
          const finalHtml = String(binding.editor.getHTML?.() || '');
          const missingMarkers = markers.filter((marker) => !finalHtml.includes(marker));
          if (missingMarkers.length) {
            return {
              ok: false,
              error: 'toutiao-editor-set-html-incomplete',
              missingMarkers,
              finalHtmlLength: finalHtml.length
            };
          }
          return {
            ok: true,
            finalHtmlLength: finalHtml.length,
            markerCount: markers.length,
            method: 'syl-editor-setHTML'
          };
        }

        if (action === 'toutiao-select-image-marker') {
          const marker = String(payload?.marker || '').trim();
          if (!marker) return { ok: false, error: 'toutiao-image-marker-empty' };
          const binding = findToutiaoEditor();
          if (!binding) return { ok: false, error: 'toutiao-editor-instance-not-found' };
          const editor = binding.editor;
          const editorDoc = editor.view?.state?.doc;
          if (
            typeof editorDoc?.descendants !== 'function' ||
            typeof editor.setSelection !== 'function' ||
            typeof editor.delete !== 'function'
          ) {
            return { ok: false, error: 'toutiao-image-marker-selection-unavailable' };
          }

          let markerIndex = -1;
          try {
            editorDoc.descendants((node, position) => {
              if (markerIndex >= 0) return false;
              const text = String(node?.text || '');
              const offset = text.indexOf(marker);
              if (offset < 0) return true;
              markerIndex = Number(position) + offset;
              return false;
            });
          } catch (error) {
            return {
              ok: false,
              error: `toutiao-image-marker-scan-failed:${error instanceof Error ? error.message : String(error)}`
            };
          }
          if (markerIndex < 0) {
            return { ok: false, error: 'toutiao-image-marker-not-found', marker };
          }

          await Promise.resolve(editor.setSelection({ index: markerIndex, length: marker.length }));
          await Promise.resolve(
            editor.delete(markerIndex, marker.length, { allowUndo: true, silent: false })
          );
          await Promise.resolve(editor.setSelection({ index: markerIndex, length: 0 }));
          await wait(100);
          const finalHtml = String(editor.getHTML?.() || '');
          if (finalHtml.includes(marker)) {
            return { ok: false, error: 'toutiao-image-marker-delete-failed', marker };
          }
          return {
            ok: true,
            marker,
            markerIndex,
            finalHtmlLength: finalHtml.length,
            method: 'syl-editor-selection-delete'
          };
        }

        if (action === 'tencent-set-title') {
          const input = document.querySelector(
            'textarea.article-title'
          ) as HTMLTextAreaElement | null;
          if (!input) return { ok: false, reason: 'title-input-not-found' };
          const value = String(payload?.value || '');
          const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
          input.focus();
          if (typeof desc?.set === 'function') desc.set.call(input, value);
          else input.value = value;
          try {
            input.dispatchEvent(
              new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                data: value,
                inputType: 'insertText'
              })
            );
          } catch {
            input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          }
          input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          return {
            ok: true,
            value: input.value,
            hasCounter: /标题字数[:：]\s*\d+\s*\/\s*80/.test(bodyText())
          };
        }

        if (action === 'tencent-set-tag-input') {
          const input = document.querySelectorAll('input.com-2-tag-input')[0] as
            | HTMLInputElement
            | undefined;
          if (!input) return { ok: false, reason: 'tag-input-not-found' };
          const value = String(payload?.value || '');
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          input.focus();
          if (typeof desc?.set === 'function') desc.set.call(input, value);
          else input.value = value;
          try {
            input.dispatchEvent(
              new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                data: value,
                inputType: 'insertText'
              })
            );
          } catch {
            input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          }
          input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          return { ok: true, value: input.value };
        }

        if (action === 'tencent-click-tag-suggestion') {
          const expected = String(payload?.value || '').trim();
          const isVisible = (node: Element) => {
            const rect = (node as HTMLElement).getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const items = Array.from(document.querySelectorAll('li[data-id]')).filter((node) =>
            isVisible(node)
          );
          const exact = items.find((node) => (node.textContent || '').trim() === expected);
          const fuzzy = items.find((node) => (node.textContent || '').trim().includes(expected));
          const pick = exact || fuzzy || items[0] || null;
          if (!pick) return { ok: false, reason: 'tag-suggestion-not-found' };
          ['mousedown', 'mouseup', 'click'].forEach((type) => {
            pick.dispatchEvent(
              new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1 })
            );
          });
          return { ok: true, picked: (pick.textContent || '').trim() };
        }

        if (action === 'oschina-editor-command') {
          type OschinaEditorCommands = {
            clearContent?: (emitUpdate?: boolean) => boolean;
            focus?: (position?: string) => boolean;
            insertContent?: (content: string) => boolean;
            setContent?: (content: string, emitUpdate?: boolean) => boolean;
            setTextSelection?: (position: { from: number; to: number }) => boolean;
            uploadImage?: (file: File) => boolean;
          };
          type OschinaEditor = {
            commands?: OschinaEditorCommands;
            getHTML?: () => string;
            state?: {
              doc?: {
                descendants?: (
                  callback: (node: { text?: string }, position: number) => boolean
                ) => void;
              };
            };
          };
          const root = document.querySelector(
            '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"].aie-content'
          ) as (HTMLElement & { editor?: OschinaEditor }) | null;
          const editor = root?.editor || null;
          const commands = editor?.commands || null;
          if (!root || !commands) return { ok: false, error: 'oschina-tiptap-editor-not-found' };

          const command = String(payload?.command || '').trim();
          if (command === 'reset') {
            if (typeof editor?.commands?.clearContent !== 'function') {
              return { ok: false, error: 'oschina-clear-content-unavailable' };
            }
            editor.commands.clearContent(true);
            editor.commands?.focus?.('end');
          } else if (command === 'insert-html') {
            const html = String(payload?.html || '');
            if (!html.trim()) return { ok: false, error: 'oschina-insert-html-empty' };
            if (typeof editor?.commands?.insertContent !== 'function') {
              return { ok: false, error: 'oschina-insert-content-unavailable' };
            }
            editor.commands?.focus?.('end');
            editor.commands.insertContent(html);
            editor.commands?.focus?.('end');
          } else if (command === 'replace-html') {
            const html = String(payload?.html || '');
            if (!html.trim()) return { ok: false, error: 'oschina-replace-content-empty' };
            if (typeof editor?.commands?.setContent !== 'function') {
              return { ok: false, error: 'oschina-set-content-unavailable' };
            }
            editor.commands.setContent(html, true);
            editor.commands?.focus?.('end');
          } else if (command === 'focus-end') {
            if (typeof editor?.commands?.focus !== 'function') {
              return { ok: false, error: 'oschina-focus-unavailable' };
            }
            editor.commands.focus('end');
          } else if (command === 'upload-image') {
            if (typeof editor?.commands?.uploadImage !== 'function') {
              return { ok: false, error: 'oschina-upload-image-unavailable' };
            }
            const imageFile = (payload?.imageFile || {}) as Record<string, unknown>;
            const encoded = String(imageFile.base64 || '');
            if (!encoded) return { ok: false, error: 'oschina-upload-image-empty' };
            const binary = atob(encoded);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
              bytes[index] = binary.charCodeAt(index);
            }
            const file = new File([bytes], String(imageFile.name || 'bawei-image'), {
              type: String(imageFile.type || 'application/octet-stream')
            });
            const marker = String(imageFile.marker || '');
            if (marker) {
              if (
                typeof editor.commands?.setTextSelection !== 'function' ||
                typeof editor?.state?.doc?.descendants !== 'function'
              ) {
                return { ok: false, error: 'oschina-image-marker-selection-unavailable' };
              }
              let markerFrom = -1;
              editor.state.doc.descendants((node, position) => {
                if (markerFrom >= 0) return false;
                const text = String(node?.text || '');
                const offset = text.indexOf(marker);
                if (offset < 0) return true;
                markerFrom = Number(position) + offset;
                return false;
              });
              if (markerFrom < 0) {
                return { ok: false, error: 'oschina-image-marker-not-found' };
              }
              editor.commands.setTextSelection({
                from: markerFrom,
                to: markerFrom + marker.length
              });
            } else {
              editor.commands?.focus?.('end');
            }
            editor.commands.uploadImage(file);
          } else {
            return { ok: false, error: `oschina-command-unsupported:${command || 'empty'}` };
          }

          await wait(120);
          const finalHtml = String(editor?.getHTML?.() || root.innerHTML || '');
          return {
            ok: true,
            command,
            finalHtmlLength: finalHtml.length,
            finalTextLength: String(root.innerText || root.textContent || '').length,
            imageCount: root.querySelectorAll('img').length
          };
        }

        if (action === 'baijiahao-set-title') {
          const value = String(payload?.value || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (!value) return { ok: false, error: 'title-value-empty' };

          const titleRoot = document.querySelector<HTMLElement>('[data-testid="news-title-input"]');
          const target = titleRoot?.querySelector<HTMLElement>('[contenteditable="true"]') || null;
          if (!target) return { ok: false, error: 'title-editor-not-found' };

          type LexicalSerializedNode = {
            type?: string;
            text?: string;
            children?: LexicalSerializedNode[];
            [key: string]: unknown;
          };
          type LexicalEditor = {
            getEditorState?: () => { toJSON?: () => LexicalSerializedNode };
            parseEditorState?: (serialized: string) => unknown;
            setEditorState?: (state: unknown, options?: { tag?: string }) => void;
          };
          const lexicalEditor = (target as HTMLElement & { __lexicalEditor?: LexicalEditor })
            .__lexicalEditor;

          if (
            lexicalEditor &&
            typeof lexicalEditor.getEditorState === 'function' &&
            typeof lexicalEditor.parseEditorState === 'function' &&
            typeof lexicalEditor.setEditorState === 'function'
          ) {
            const stateJson = lexicalEditor.getEditorState()?.toJSON?.();
            const root = stateJson?.root as LexicalSerializedNode | undefined;
            const firstBlock = Array.isArray(root?.children) ? root.children[0] : undefined;
            if (!stateJson || !firstBlock || !Array.isArray(firstBlock.children)) {
              return { ok: false, error: 'title-editor-state-invalid' };
            }

            const findFirstText = (node: LexicalSerializedNode): LexicalSerializedNode | null => {
              if (node.type === 'text') return node;
              if (!Array.isArray(node.children)) return null;
              for (const child of node.children) {
                const found = findFirstText(child);
                if (found) return found;
              }
              return null;
            };
            const existingText = findFirstText(firstBlock);
            firstBlock.children = [
              {
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                type: 'text',
                version: 1,
                ...(existingText || {}),
                text: value
              }
            ];

            const nextState = lexicalEditor.parseEditorState(JSON.stringify(stateJson));
            lexicalEditor.setEditorState(nextState, { tag: 'history-push' });
            await wait(80);
            const actual = String(target.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            return {
              ok: actual === value,
              error: actual === value ? '' : 'title-editor-state-not-committed',
              value: actual,
              method: 'lexical-state'
            };
          }

          target.focus();
          target.textContent = value;
          target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
          target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          await wait(50);
          const actual = String(target.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
          return {
            ok: actual === value,
            error: actual === value ? '' : 'title-dom-fallback-not-committed',
            value: actual,
            method: 'dom-fallback'
          };
        }

        if (action === 'baijiahao-open-image-dialog') {
          for (let attempt = 0; attempt < 8; attempt += 1) {
            const editor =
              (window as unknown as { editor?: { focus?: (toEnd?: boolean) => void } }).editor ||
              ((
                window as unknown as {
                  UE_V2?: {
                    getEditor?: (id: string) => { focus?: (toEnd?: boolean) => void } | null;
                  };
                }
              ).UE_V2?.getEditor?.('ueditor_0') as { focus?: (toEnd?: boolean) => void } | null) ||
              null;
            if (typeof editor?.focus === 'function') {
              try {
                editor.focus(true);
                await wait(120);
              } catch {
                // The E2E fixture keeps this branch harmless.
              }
            }
            const button =
              document.querySelector<HTMLElement>('.edui-for-insertimage .edui-button-body') ||
              document.querySelector<HTMLElement>('.edui-for-insertimage');
            if (!button) {
              await wait(250);
              continue;
            }
            button.click();

            for (let index = 0; index < 10; index += 1) {
              const modals = Array.from(
                document.querySelectorAll<HTMLElement>('.cheetah-ui-pro-image-modal')
              );
              const visibleModal = modals.find((modal) => {
                const rect = modal.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return false;
                const style = getComputedStyle(modal);
                return !(
                  style.display === 'none' ||
                  style.visibility === 'hidden' ||
                  style.opacity === '0'
                );
              });
              const inputScope: ParentNode | null =
                visibleModal || (modals.length ? null : document);
              const imageInput = Array.from(
                inputScope?.querySelectorAll<HTMLInputElement>('input[type="file"]') || []
              ).find(
                (input) =>
                  input.accept.toLowerCase().includes('image') ||
                  /image/i.test(`${input.className} ${input.id} ${input.name}`)
              );
              if (imageInput) return { ok: true };
              await wait(100);
            }
          }
          return { ok: false, error: 'image-upload-input-not-ready' };
        }

        if (action === 'baijiahao-set-content') {
          const html = String(payload?.html || '').trim();
          const sourceUrl = String(payload?.sourceUrl || '').trim();
          if (!html) return { ok: false, error: 'content-html-empty' };

          let editor: Record<string, unknown> | null = null;
          let body: HTMLElement | null = null;
          for (let i = 0; i < 40; i += 1) {
            editor =
              (window as unknown as { editor?: Record<string, unknown> }).editor ||
              ((
                window as unknown as {
                  UE_V2?: { getEditor?: (id: string) => Record<string, unknown> | null };
                }
              ).UE_V2?.getEditor?.('ueditor_0') as Record<string, unknown> | null) ||
              null;
            const iframe = document.querySelector('iframe#ueditor_0') as HTMLIFrameElement | null;
            body = (iframe?.contentDocument?.body as HTMLElement | null) || null;
            if (editor && body) break;
            await wait(200);
          }
          if (!editor) return { ok: false, error: 'editor-not-found' };
          if (!body) return { ok: false, error: 'editor-body-not-ready' };

          const execCommand =
            typeof editor.execCommand === 'function' ? editor.execCommand.bind(editor) : null;
          const setContent =
            typeof editor.setContent === 'function' ? editor.setContent.bind(editor) : null;
          const sync = typeof editor.sync === 'function' ? editor.sync.bind(editor) : null;
          const focus = typeof editor.focus === 'function' ? editor.focus.bind(editor) : null;

          if (focus) {
            try {
              focus(true);
            } catch {
              // ignore
            }
          }

          if (setContent) {
            setContent(html);
          } else if (execCommand) {
            try {
              execCommand('cleardoc');
            } catch {
              // ignore
            }
            execCommand('inserthtml', html);
          } else {
            return { ok: false, error: 'editor-write-api-unavailable' };
          }

          for (let i = 0; i < 20; i += 1) {
            const bodyHtml = String(body.innerHTML || '');
            const bodyText = String(body.innerText || body.textContent || '');
            const hasSource =
              !sourceUrl || bodyHtml.includes(sourceUrl) || bodyText.includes(sourceUrl);
            if (bodyHtml.trim() && hasSource) break;
            await wait(150);
          }

          const sourceHtml = sourceUrl
            ? `<p><br></p><p>原文链接：<a href="${sourceUrl}" target="_blank" rel="noreferrer noopener">${sourceUrl}</a></p>`
            : '';
          let finalHtml = String(body.innerHTML || '');
          let finalText = String(body.innerText || body.textContent || '');
          const hasSource =
            !sourceUrl || finalHtml.includes(sourceUrl) || finalText.includes(sourceUrl);
          if (!hasSource && sourceHtml && execCommand) {
            execCommand('inserthtml', sourceHtml);
            await wait(150);
            finalHtml = String(body.innerHTML || '');
            finalText = String(body.innerText || body.textContent || '');
          }

          if (sync) {
            try {
              sync();
            } catch {
              // ignore
            }
          }

          const ok =
            !!finalHtml.trim() &&
            (!sourceUrl || finalHtml.includes(sourceUrl) || finalText.includes(sourceUrl));
          return {
            ok,
            error: ok
              ? ''
              : !finalHtml.trim()
                ? 'editor-body-empty-after-set-content'
                : 'source-url-missing-after-set-content',
            finalHtmlLength: finalHtml.length,
            finalTextLength: finalText.length,
            hasSourceUrl:
              !sourceUrl || finalHtml.includes(sourceUrl) || finalText.includes(sourceUrl)
          };
        }

        if (action === 'weixin-probe-ui') {
          return { ok: true, ...(collectUiState() as Record<string, unknown>) };
        }

        if (action === 'weixin-open-panel') {
          const launcher = document.querySelector('#bawei-v2-launcher') as HTMLElement | null;
          if (launcher) {
            launcher.click();
          } else {
            window.dispatchEvent(
              new CustomEvent('bawei-v2-ensure-panel', { detail: { action: 'show' } })
            );
          }
          for (let i = 0; i < 10; i += 1) {
            if (panelVisible()) break;
            await wait(200);
          }
          return { ok: true, ...(collectUiState() as Record<string, unknown>) };
        }

        if (action === 'weixin-set-action') {
          const value = String(payload?.value || '').trim();
          const input = document.querySelector(
            `input[name="bawei_v2_action"][value="${value}"]`
          ) as HTMLInputElement | null;
          if (!input) return { ok: false, reason: 'action-input-not-found', value };
          input.click();
          input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          await wait(100);
          return { ok: true, ...(collectUiState() as Record<string, unknown>) };
        }

        if (action === 'weixin-set-channels') {
          const wanted = new Set(
            Array.isArray(payload?.channelIds)
              ? payload.channelIds.map((item) => String(item || '').trim()).filter(Boolean)
              : []
          );
          const inputs = Array.from(document.querySelectorAll('input[id^="bawei-v2-run-"]')).filter(
            (node): node is HTMLInputElement => node instanceof HTMLInputElement
          );
          for (const input of inputs) {
            const id = String(input.id || '').replace(/^bawei-v2-run-/, '');
            dispatchCheckbox(input, wanted.has(id));
          }
          await wait(100);
          return { ok: true, ...(collectUiState() as Record<string, unknown>) };
        }

        if (action === 'weixin-start') {
          const startButton = document.querySelector('#bawei-v2-start') as HTMLButtonElement | null;
          if (!startButton) return { ok: false, reason: 'start-button-not-found' };
          if (startButton.disabled)
            return {
              ok: false,
              reason: 'start-button-disabled',
              ...(collectUiState() as Record<string, unknown>)
            };
          startButton.click();
          await wait(200);
          return { ok: true, ...(collectUiState() as Record<string, unknown>) };
        }

        if (action === 'weixin-read-runtime') {
          return { ok: true, ...(collectUiState() as Record<string, unknown>) };
        }

        throw new Error(`Unsupported main-world action: ${action}`);
      },
      args: [message.action, message.payload || {}]
    });

    sendResponse({ success: true, result: injected?.[0]?.result });
  } catch (error) {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

async function handleV2Control(
  message: ContinueRequest | RetryRequest,
  sendResponse: (response: { success: boolean; error?: string }) => void
) {
  try {
    const jobId: string = message.jobId;
    const channelId: ChannelId = message.channelId;
    if (!jobId || !channelId) throw new Error('Missing jobId/channelId');

    const job = await getJobData(jobId);
    if (job?.stoppedAt) {
      sendResponse({ success: false, error: 'Job has been stopped' });
      return;
    }

    const state = jobStateCache.get(jobId) || (await getJobState(jobId));
    const tabId = state?.[channelId]?.tabId;
    if (!tabId) throw new Error('Channel tab not found');

    const channels = (job?.channels || ALL_CHANNELS).filter((id): id is ChannelId =>
      ALL_CHANNELS.includes(id)
    );
    const runningChannel = state ? getRunningSerialChannel(channels, state) : null;
    if (runningChannel && runningChannel !== channelId) {
      throw new Error(`Serial job is running channel: ${runningChannel}`);
    }

    const tab = await chrome.tabs.get(tabId);
    await focusOpenedChannelTab(tab);
    const previousStatus = state?.[channelId]?.status;
    const shouldRestoreStatus = !!state && previousStatus !== 'running';
    if (shouldRestoreStatus) {
      await patchJobChannelState(jobId, channelId, {
        status: 'running',
        userSuggestion: undefined
      });
    }

    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      if (shouldRestoreStatus && previousStatus) {
        await patchJobChannelState(jobId, channelId, { status: previousStatus }).catch(() => {});
      }
      throw error;
    }
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

function looksLikeLoginUrl(url: string, channelId: ChannelId): boolean {
  const raw = String(url || '');
  if (matchesChannelUrl(raw, getChannelConfig(channelId).loginUrlPatterns)) return true;
  return /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i.test(raw);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const ctx = tabIdToContext.get(tabId);
  if (!ctx) return;

  const url = String(changeInfo.url || tab.url || '');
  const status = String(changeInfo.status || '');

  // Best-effort: once page is complete, mark stage=detectLogin (unless already progressed).
  if (status === 'complete') {
    void (async () => {
      try {
        const state = jobStateCache.get(ctx.jobId) || (await getJobState(ctx.jobId));
        const cur = state?.[ctx.channelId];
        const stage = cur?.stage;
        const st = cur?.status;
        if (st && st !== 'running') return;
        if (stage && stage !== 'openEntry') return;
        await patchJobChannelState(ctx.jobId, ctx.channelId, {
          status: 'running',
          stage: 'detectLogin',
          userMessage: chrome.i18n.getMessage('v3MsgDetectingLogin')
        });
      } catch {
        // ignore
      }
    })();
  }

  if (url && looksLikeLoginUrl(url, ctx.channelId)) {
    void patchJobChannelState(ctx.jobId, ctx.channelId, {
      status: 'not_logged_in',
      stage: 'detectLogin',
      userMessage: chrome.i18n.getMessage('v3MsgNotLoggedIn'),
      userSuggestion: chrome.i18n.getMessage('v3SugLoginThenRetry')
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const ctx = tabIdToContext.get(tabId);
  if (!ctx) return;
  tabIdToContext.delete(tabId);

  void (async () => {
    try {
      const state = jobStateCache.get(ctx.jobId) || (await getJobState(ctx.jobId));
      const cur = state?.[ctx.channelId];
      const status = cur?.status || 'not_started';

      // 已完成投稿判断的终态不应因用户关闭 tab 被覆写；等待用户处理的状态仍补充重开提示。
      if (isSerialTerminalStatus(status) && status !== 'waiting_user' && status !== 'not_logged_in')
        return;

      // 对于 waiting_user / not_logged_in：保留原状态，只提示可点击状态重开。
      if (status === 'waiting_user' || status === 'not_logged_in') {
        await patchJobChannelState(ctx.jobId, ctx.channelId, {
          userSuggestion: chrome.i18n.getMessage('v3SugClickStatusToReopen')
        });
        return;
      }

      // running / not_started 等：视为流程被中断
      await patchJobChannelState(ctx.jobId, ctx.channelId, {
        status: 'failed',
        userMessage: chrome.i18n.getMessage('v2MsgFailed'),
        userSuggestion: chrome.i18n.getMessage('v3SugClickStatusToReopen')
      });
    } catch {
      // ignore
    }
  })();
});

// Handle storage changes for cross-device sync
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (changes.copilot_settings && namespace === 'sync') {
    console.debug('Settings synced from another device');
  }
});

async function dispatchDirectMessage(message: unknown): Promise<unknown> {
  const msg = message as { type?: unknown };
  const type = typeof msg.type === 'string' ? msg.type : '';

  if (type === V2_START_JOB) {
    return await new Promise<StartJobResponse>((resolve) => {
      handleV2StartJob(message as StartJobRequest, {} as chrome.runtime.MessageSender, resolve);
    });
  }

  if (type === V2_CHANNEL_UPDATE) {
    return await new Promise<{ success: boolean; error?: string }>((resolve) => {
      handleV2ChannelUpdate(message as ChannelUpdate, {} as chrome.runtime.MessageSender, resolve);
    });
  }

  if (type === V2_REQUEST_CONTINUE || type === V2_REQUEST_RETRY) {
    return await new Promise<{ success: boolean; error?: string }>((resolve) => {
      handleV2Control(message as ContinueRequest | RetryRequest, resolve);
    });
  }

  if (type === V2_REQUEST_STOP) {
    return await new Promise<StopJobResponse>((resolve) => {
      handleV2StopJob(message as StopJobRequest, resolve);
    });
  }

  if (type === V2_FOCUS_CHANNEL_TAB) {
    return await new Promise<FocusChannelTabResponse>((resolve) => {
      handleV2FocusChannelTab(message as FocusChannelTabRequest, resolve);
    });
  }

  if (type === V2_AUDIT_CHANNEL_LOGIN) {
    return await new Promise<AuditChannelLoginResponse>((resolve) => {
      handleV2AuditChannelLogin(
        message as AuditChannelLoginRequest,
        {} as chrome.runtime.MessageSender,
        resolve
      );
    });
  }

  if (type === V3_EXECUTE_MAIN_WORLD) {
    return await new Promise<ExecuteMainWorldResponse>((resolve) => {
      handleV3ExecuteMainWorld(
        message as ExecuteMainWorldRequest,
        {} as chrome.runtime.MessageSender,
        resolve
      );
    });
  }

  return { success: false, error: `Unknown direct type: ${type || 'empty'}` };
}

const directDispatchRef = dispatchDirectMessage;

(
  globalThis as unknown as {
    __BAWEI_V2_DISPATCH_DIRECT?: (message: unknown) => Promise<unknown>;
  }
).__BAWEI_V2_DISPATCH_DIRECT = directDispatchRef;

try {
  (
    chrome.runtime as unknown as {
      __BAWEI_V2_DISPATCH_DIRECT?: (message: unknown) => Promise<unknown>;
    }
  ).__BAWEI_V2_DISPATCH_DIRECT = directDispatchRef;
} catch {
  // ignore
}

try {
  (
    chrome as unknown as {
      __BAWEI_V2_DISPATCH_DIRECT?: (message: unknown) => Promise<unknown>;
    }
  ).__BAWEI_V2_DISPATCH_DIRECT = directDispatchRef;
} catch {
  // ignore
}

console.log('bawei V2 background script loaded');
