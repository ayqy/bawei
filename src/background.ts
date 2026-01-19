import { getSettings } from './shared/settings-manager';
import { cleanExpiredData, getJobData, getJobState, markJobStopped, storeJobData, storeJobState } from './shared/article-data-manager';
import type { ChannelId, ChannelRuntimeState, PublishAction, PublishJob } from './shared/v2-types';
import {
  V2_CHANNEL_UPDATE,
  V2_GET_CONTEXT,
  V2_JOB_BROADCAST,
  V2_REQUEST_CONTINUE,
  V2_REQUEST_RETRY,
  V2_REQUEST_STOP,
  V2_START_JOB,
} from './shared/v2-protocol';
import type {
  ChannelUpdate,
  ContinueRequest,
  GetContextResponse,
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

function newJobId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
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

    const entryUrls: Record<ChannelId, string> = {
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

    // Open selected channel tabs concurrently
    await Promise.all(
      channelsToRun.map(async (channelId) => {
        // Ensure the focus channel is opened in the foreground so that sites with strict
        // user-gesture requirements (e.g. modal dialogs / AI cover pickers) can proceed.
        const tab = await chrome.tabs.create({ url: entryUrls[channelId], active: channelId === message.focusChannel });
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

    sendResponse({ success: true });
  } catch (error) {
    console.warn('[V2] Failed to stop job:', error);
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

// Handle storage changes for cross-device sync
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (changes.copilot_settings && namespace === 'sync') {
    console.debug('Settings synced from another device');
  }
});

console.log('bawei V2 background script loaded');
