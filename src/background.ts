import { getSettings } from './shared/settings-manager';
import { cleanExpiredData, getJobData, getJobState, markJobStopped, storeJobData, storeJobState } from './shared/article-data-manager';
import type { ChannelId, ChannelRuntimeState, PublishAction, PublishJob } from './shared/v2-types';
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
  V3_FETCH_IMAGE,
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
  StopJobResponse,
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
      handleV2StartJob(message as StartJobRequest, sender, sendResponse as (response: StartJobResponse) => void);
      return true; // Indicate async response

    case V2_GET_CONTEXT:
      handleV2GetContext(sender, sendResponse as (response: GetContextResponse) => void);
      return true;

    case V2_CHANNEL_UPDATE:
      handleV2ChannelUpdate(message as ChannelUpdate, sender, sendResponse as (response: { success: boolean; error?: string }) => void);
      return true;

    case V2_REQUEST_CONTINUE:
      handleV2Control(message as ContinueRequest, sendResponse as (response: { success: boolean; error?: string }) => void);
      return true;

    case V2_REQUEST_RETRY:
      handleV2Control(message as RetryRequest, sendResponse as (response: { success: boolean; error?: string }) => void);
      return true;

    case V2_REQUEST_STOP:
      handleV2StopJob(message as StopJobRequest, sendResponse as (response: StopJobResponse) => void);
      return true;

    case V2_FOCUS_CHANNEL_TAB:
      handleV2FocusChannelTab(message as FocusChannelTabRequest, sendResponse as (response: FocusChannelTabResponse) => void);
      return true;

    case V2_AUDIT_CHANNEL_LOGIN:
      handleV2AuditChannelLogin(
        message as AuditChannelLoginRequest,
        sender,
        sendResponse as (response: AuditChannelLoginResponse) => void
      );
      return true;

    case V3_FETCH_IMAGE:
      handleV3FetchImage(message as FetchImageRequest, sendResponse as (response: FetchImageResponse) => void);
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

const CHANNEL_ENTRY_URLS: Record<ChannelId, string> = {
  csdn: 'https://mp.csdn.net/mp_blog/creation/editor',
  'tencent-cloud-dev': 'https://cloud.tencent.com/developer/article/write',
  cnblogs: 'https://i.cnblogs.com/posts/edit',
  oschina: 'https://www.oschina.net/blog/write',
  woshipm: 'https://www.woshipm.com/writing',
  mowen: 'https://note.mowen.cn/editor',
  sspai: 'https://sspai.com/write',
  baijiahao: 'https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1',
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  'feishu-docs': 'https://wuxinxuexi.feishu.cn/drive/folder/PyWAfSFwrlMgiydvlHectMn2nSd',
};

const ALL_CHANNELS: ChannelId[] = [
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
];

function urlPrefix(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

async function openOrReuseChannelTab(channelId: ChannelId, options: { active: boolean }): Promise<chrome.tabs.Tab> {
  const url = CHANNEL_ENTRY_URLS[channelId];
  const prefix = urlPrefix(url);
  try {
    const tabs = await chrome.tabs.query({});
    const matches = tabs.filter((t) => t.id && typeof t.url === 'string' && t.url.startsWith(prefix));
    const sorted = matches
      .slice()
      .sort((a, b) => Number((b as { lastAccessed?: unknown }).lastAccessed || 0) - Number((a as { lastAccessed?: unknown }).lastAccessed || 0));

    const keep = sorted[0] || null;
    const toClose = sorted.slice(1).map((t) => t.id).filter((id): id is number => typeof id === 'number');
    if (toClose.length) {
      await chrome.tabs.remove(toClose).catch(() => {});
    }
    if (keep?.id) {
      return await chrome.tabs.update(keep.id, { url, active: options.active });
    }
  } catch {
    // ignore and fallback create
  }

  return await chrome.tabs.create({ url, active: options.active });
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
    ...patch,
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
    'feishu-docs': nowState('feishu-docs'),
  };
}

async function patchJobChannelState(jobId: string, channelId: ChannelId, patch: Partial<ChannelRuntimeState>): Promise<void> {
  const job = await getJobData(jobId);
  if (job?.stoppedAt) return;

  const current = jobStateCache.get(jobId) || (await getJobState(jobId)) || buildInitialState();
  const prev = current[channelId] || nowState(channelId);
  const next: ChannelRuntimeState = {
    ...prev,
    ...patch,
    channelId,
    updatedAt: Date.now(),
    tabId: patch.tabId ?? prev.tabId,
  };
  current[channelId] = next;
  jobStateCache.set(jobId, current);
  await storeJobState(jobId, current);
  await broadcastJobState(jobId);
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
      state,
    });
  } catch (error) {
    console.warn('[V2] Failed to broadcast state to source tab:', error);
  }
}

/**
 * Handles V2 job start: store job, open channel tabs concurrently, init state and broadcast.
 */
async function handleV2StartJob(message: StartJobRequest, sender: chrome.runtime.MessageSender, sendResponse: (response: StartJobResponse) => void) {
  try {
    const action: PublishAction = message.action;
    const article = message.article;
    if (!article?.title || !article?.contentHtml || !article?.sourceUrl) {
      throw new Error('Missing required fields: title/contentHtml/sourceUrl');
    }

    const jobId = newJobId();
    const createdAt = Date.now();
    const sourceTabId = sender.tab?.id;

    const channelsToRun = (Array.isArray(message.channels) && message.channels.length > 0 ? message.channels : ALL_CHANNELS).filter(
      (c): c is ChannelId => ALL_CHANNELS.includes(c)
    );

    const job: PublishJob = {
      jobId,
      createdAt,
      action,
      article,
      channels: channelsToRun,
      sourceTabId,
    };

    await storeJobData(job);

    const initialState = buildInitialState();
    jobStateCache.set(jobId, initialState);
    await storeJobState(jobId, initialState);

    if (sourceTabId) {
      jobIdToSourceTabId.set(jobId, sourceTabId);
    }

    // Open selected channel tabs concurrently
    await Promise.all(
      channelsToRun.map(async (channelId) => {
        // Ensure the focus channel is opened in the foreground so that sites with strict
        // user-gesture requirements (e.g. modal dialogs / AI cover pickers) can proceed.
        const tab = await openOrReuseChannelTab(channelId, { active: channelId === message.focusChannel });
        if (!tab.id) return;
        tabIdToContext.set(tab.id, { jobId, channelId });
        const next: ChannelRuntimeState = {
          ...initialState[channelId],
          status: 'running',
          stage: 'openEntry',
          updatedAt: Date.now(),
          tabId: tab.id,
        };
        initialState[channelId] = next;
      })
    );

    jobStateCache.set(jobId, initialState);
    await storeJobState(jobId, initialState);
    await broadcastJobState(jobId);

    sendResponse({ success: true, jobId });
  } catch (error) {
    console.error('[V2] Failed to start job:', error);
    sendResponse({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
}

async function handleV2GetContext(sender: chrome.runtime.MessageSender, sendResponse: (response: GetContextResponse) => void) {
  try {
    const tabId = sender.tab?.id;
    if (!tabId) throw new Error('No sender tab id');
    const ctx = tabIdToContext.get(tabId);
    if (!ctx) throw new Error('No context for this tab');
    const job = await getJobData(ctx.jobId);
    if (!job) throw new Error('Job not found');
    sendResponse({ success: true, job, channelId: ctx.channelId });
  } catch (error) {
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

async function handleV2ChannelUpdate(message: ChannelUpdate, sender: chrome.runtime.MessageSender, sendResponse: (response: { success: boolean; error?: string }) => void) {
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
      tabId: sender.tab?.id || prev.tabId,
    };
    current[channelId] = next;

    jobStateCache.set(jobId, current);
    await storeJobState(jobId, current);
    await broadcastJobState(jobId);

    sendResponse({ success: true });
  } catch (error) {
    console.warn('[V2] Failed to handle channel update:', error);
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

async function handleV2StopJob(message: StopJobRequest, sendResponse: (response: StopJobResponse) => void) {
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
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

async function handleV2FocusChannelTab(message: FocusChannelTabRequest, sendResponse: (response: FocusChannelTabResponse) => void) {
  try {
    const { jobId, channelId } = message;
    if (!jobId || !channelId) throw new Error('Missing jobId/channelId');

    const state = jobStateCache.get(jobId) || (await getJobState(jobId));
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
      tabId: tab.id,
    });

    sendResponse({ success: true, tabId: tab.id });
  } catch (error) {
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
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

async function probeLoginStateFromChannelTab(tabId: number, channelId: ChannelId, fallbackUrl: string): Promise<ProbeLoginStateResult> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: V2_PROBE_LOGIN_STATE,
      channelId,
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
    url: fallbackUrl,
  };
}

async function handleV2AuditChannelLogin(
  message: AuditChannelLoginRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: AuditChannelLoginResponse) => void
) {
  const channels = (Array.isArray(message.channels) ? message.channels : []).filter((item): item is ChannelId => ALL_CHANNELS.includes(item));
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
          url: CHANNEL_ENTRY_URLS[channelId],
        };
        continue;
      }

      const readyTab = await waitForTabReady(tab.id, 45000).catch(() => tab);
      const currentUrl = String(readyTab.url || CHANNEL_ENTRY_URLS[channelId]);
      const result = await probeLoginStateFromChannelTab(tab.id, channelId, currentUrl);
      results[channelId] = {
        ...result,
        tabId: tab.id,
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
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const IMAGE_MIN_BYTES = 32;
const imageCache = new Map<string, { mimeType: string; buffer: ArrayBuffer; size: number; fetchedAt: number }>();
const imageInFlight = new Map<string, Promise<{ mimeType: string; buffer: ArrayBuffer; size: number; fetchedAt: number }>>();
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
      if (inner.protocol === 'http:' && (inner.hostname.toLowerCase().endsWith('.qpic.cn') || inner.hostname.toLowerCase().endsWith('.qlogo.cn'))) {
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
    if (inner.protocol === 'http:' && (inner.hostname.toLowerCase().endsWith('.qpic.cn') || inner.hostname.toLowerCase().endsWith('.qlogo.cn'))) {
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
    return head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
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
    return u.hostname.toLowerCase() === 'read.useai.online' && u.pathname.startsWith('/api/image-proxy');
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

async function fetchImageBinary(url: string, source: 'direct' | 'proxy'): Promise<{ mimeType: string; buffer: ArrayBuffer; size: number; fetchedAt: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      signal: ac.signal,
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

async function fetchImageCached(url: string): Promise<{ mimeType: string; buffer: ArrayBuffer; size: number; fetchedAt: number }> {
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
            throw new Error(`direct(inner) invalid image binary: mime=${out.mimeType} size=${out.size}`);
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

async function handleV3FetchImage(message: FetchImageRequest, sendResponse: (response: FetchImageResponse) => void) {
  try {
    const jobId = message.jobId;
    const url = message.url;
    if (!jobId || !url) throw new Error('Missing jobId/url');

    let effectiveUrl = normalizeProxyImageUrl(url);
    if (!isAllowedImageUrl(effectiveUrl)) {
      try {
        const u = new URL(effectiveUrl);
        if (u.protocol === 'https:' || u.protocol === 'http:') {
          effectiveUrl = normalizeProxyImageUrl(`${IMAGE_PROXY_ENDPOINT}${encodeURIComponent(u.toString())}`);
        }
      } catch {
        // keep original and fail below
      }
    }
    if (!isAllowedImageUrl(effectiveUrl)) {
      throw new Error(`Image URL is not allowed: ${String(url).slice(0, 280)} | effective=${String(effectiveUrl).slice(0, 280)}`);
    }

    const data = await fetchImageCached(effectiveUrl);
    let set = jobIdToImageUrls.get(jobId);
    if (!set) {
      set = new Set();
      jobIdToImageUrls.set(jobId, set);
    }
    set.add(effectiveUrl);

    const bufferBase64 = arrayBufferToBase64(data.buffer);
    sendResponse({ success: true, mimeType: data.mimeType, bufferBase64, size: data.size, debugMarker: 'v3-image-base64' } as FetchImageResponse & { debugMarker: string });
  } catch (error) {
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
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
      sendResponse((response || { success: false, error: 'Empty weixin content-script response' }) as ExecuteMainWorldResponse);
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
            const raw = String(document.querySelector('#bawei-v2-runtime-state')?.textContent || '').trim();
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
          return !(style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0');
        };
        const collectUiState = () => {
          const runtime = parseRuntime();
          const checkedChannels = Array.from(document.querySelectorAll('input[id^="bawei-v2-run-"]'))
            .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement && node.checked)
            .map((node) => String(node.id || '').replace(/^bawei-v2-run-/, ''))
            .filter(Boolean);
          const selectedAction =
            (document.querySelector('input[name="bawei_v2_action"]:checked') as HTMLInputElement | null)?.value || '';
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
            diagnosisText: String(document.querySelector('#bawei-v2-diagnosis')?.textContent || '').trim(),
          };
        };
        const dispatchCheckbox = (input: HTMLInputElement, checked: boolean) => {
          if (input.checked === checked) return;
          input.checked = checked;
          input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        };

        if (action === 'tencent-set-title') {
          const input = document.querySelector('textarea.article-title') as HTMLTextAreaElement | null;
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
                inputType: 'insertText',
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
            hasCounter: /标题字数[:：]\s*\d+\s*\/\s*80/.test(bodyText()),
          };
        }

        if (action === 'tencent-set-tag-input') {
          const input = document.querySelectorAll('input.com-2-tag-input')[0] as HTMLInputElement | undefined;
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
                inputType: 'insertText',
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
          const items = Array.from(document.querySelectorAll('li[data-id]')).filter((node) => isVisible(node));
          const exact = items.find((node) => (node.textContent || '').trim() === expected);
          const fuzzy = items.find((node) => (node.textContent || '').trim().includes(expected));
          const pick = exact || fuzzy || items[0] || null;
          if (!pick) return { ok: false, reason: 'tag-suggestion-not-found' };
          ['mousedown', 'mouseup', 'click'].forEach((type) => {
            pick.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
          });
          return { ok: true, picked: (pick.textContent || '').trim() };
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
              ((window as unknown as { UE_V2?: { getEditor?: (id: string) => Record<string, unknown> | null } }).UE_V2?.getEditor?.(
                'ueditor_0'
              ) as Record<string, unknown> | null) ||
              null;
            const iframe = document.querySelector('iframe#ueditor_0') as HTMLIFrameElement | null;
            body = (iframe?.contentDocument?.body as HTMLElement | null) || null;
            if (editor && body) break;
            await wait(200);
          }
          if (!editor) return { ok: false, error: 'editor-not-found' };
          if (!body) return { ok: false, error: 'editor-body-not-ready' };

          const execCommand = typeof editor.execCommand === 'function' ? editor.execCommand.bind(editor) : null;
          const setContent = typeof editor.setContent === 'function' ? editor.setContent.bind(editor) : null;
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
            const hasSource = !sourceUrl || bodyHtml.includes(sourceUrl) || bodyText.includes(sourceUrl);
            if (bodyHtml.trim() && hasSource) break;
            await wait(150);
          }

          const sourceHtml = sourceUrl
            ? `<p><br></p><p>原文链接：<a href="${sourceUrl}" target="_blank" rel="noreferrer noopener">${sourceUrl}</a></p>`
            : '';
          let finalHtml = String(body.innerHTML || '');
          let finalText = String(body.innerText || body.textContent || '');
          const hasSource = !sourceUrl || finalHtml.includes(sourceUrl) || finalText.includes(sourceUrl);
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

          const ok = !!finalHtml.trim() && (!sourceUrl || finalHtml.includes(sourceUrl) || finalText.includes(sourceUrl));
          return {
            ok,
            error: ok ? '' : !finalHtml.trim() ? 'editor-body-empty-after-set-content' : 'source-url-missing-after-set-content',
            finalHtmlLength: finalHtml.length,
            finalTextLength: finalText.length,
            hasSourceUrl: !sourceUrl || finalHtml.includes(sourceUrl) || finalText.includes(sourceUrl),
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
            window.dispatchEvent(new CustomEvent('bawei-v2-ensure-panel', { detail: { action: 'show' } }));
          }
          for (let i = 0; i < 10; i += 1) {
            if (panelVisible()) break;
            await wait(200);
          }
          return { ok: true, ...(collectUiState() as Record<string, unknown>) };
        }

        if (action === 'weixin-set-action') {
          const value = String(payload?.value || '').trim();
          const input = document.querySelector(`input[name="bawei_v2_action"][value="${value}"]`) as HTMLInputElement | null;
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
          if (startButton.disabled) return { ok: false, reason: 'start-button-disabled', ...(collectUiState() as Record<string, unknown>) };
          startButton.click();
          await wait(200);
          return { ok: true, ...(collectUiState() as Record<string, unknown>) };
        }

        if (action === 'weixin-read-runtime') {
          return { ok: true, ...(collectUiState() as Record<string, unknown>) };
        }

        throw new Error(`Unsupported main-world action: ${action}`);
      },
      args: [message.action, message.payload || {}],
    });

    sendResponse({ success: true, result: injected?.[0]?.result });
  } catch (error) {
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

async function handleV2Control(message: ContinueRequest | RetryRequest, sendResponse: (response: { success: boolean; error?: string }) => void) {
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

    await chrome.tabs.sendMessage(tabId, message);
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

function looksLikeLoginUrl(url: string, channelId: ChannelId): boolean {
  const raw = String(url || '');
  const low = raw.toLowerCase();
  const patterns: Record<ChannelId, RegExp[]> = {
    csdn: [/passport\.csdn\.net\/login/i, /\/login/i],
    'tencent-cloud-dev': [/cloud\.tencent\.com\/login/i, /\/account\/login/i, /\/login/i],
    cnblogs: [/account\.cnblogs\.com\/signin/i, /\/signin/i, /\/login/i],
    oschina: [/oschina\.net\/home\/login/i, /\/login/i],
    woshipm: [/passport/i, /\/login/i, /\/signin/i],
    mowen: [/\/login/i, /\/signin/i],
    sspai: [/\/login/i, /\/signin/i],
    baijiahao: [/passport/i, /\/login/i],
    toutiao: [/\/auth\/page\/login/i, /\/login/i],
    'feishu-docs': [/passport\.feishu\.cn/i, /\/login/i, /\/signin/i],
  };

  if (patterns[channelId].some((r) => r.test(low))) return true;
  return /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i.test(low);
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
          userMessage: chrome.i18n.getMessage('v3MsgDetectingLogin'),
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
      userSuggestion: chrome.i18n.getMessage('v3SugLoginThenRetry'),
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

      // 如果渠道已成功/已失败，不要因为用户关闭 tab 而回退状态。
      if (status === 'success' || status === 'failed') return;

      // 对于 waiting_user / not_logged_in：保留原状态，只提示可点击状态重开。
      if (status === 'waiting_user' || status === 'not_logged_in') {
        await patchJobChannelState(ctx.jobId, ctx.channelId, {
          userSuggestion: chrome.i18n.getMessage('v3SugClickStatusToReopen'),
        });
        return;
      }

      // running / not_started 等：视为流程被中断
      await patchJobChannelState(ctx.jobId, ctx.channelId, {
        status: 'failed',
        userMessage: chrome.i18n.getMessage('v2MsgFailed'),
        userSuggestion: chrome.i18n.getMessage('v3SugClickStatusToReopen'),
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
      handleV2AuditChannelLogin(message as AuditChannelLoginRequest, {} as chrome.runtime.MessageSender, resolve);
    });
  }

  if (type === V3_EXECUTE_MAIN_WORLD) {
    return await new Promise<ExecuteMainWorldResponse>((resolve) => {
      handleV3ExecuteMainWorld(message as ExecuteMainWorldRequest, {} as chrome.runtime.MessageSender, resolve);
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
