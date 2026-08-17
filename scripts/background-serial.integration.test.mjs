import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { getChannelConfig, getChannelIds } from './channel-config.mjs';

const storageData = new Map();
const tabs = new Map();
const operations = [];
const runtimeMessageListeners = [];
const tabRemovedListeners = [];
let nextTabId = 1;

function eventSink(target) {
  return {
    addListener(listener) {
      target.push(listener);
    }
  };
}

globalThis.chrome = {
  i18n: {
    getMessage(key) {
      return key;
    },
    getUILanguage() {
      return 'zh-CN';
    }
  },
  runtime: {
    id: 'bawei-serial-test',
    onInstalled: eventSink([]),
    onStartup: eventSink([]),
    onMessage: eventSink(runtimeMessageListeners)
  },
  storage: {
    local: {
      async get(key) {
        if (key == null) return Object.fromEntries(storageData);
        if (typeof key === 'string')
          return storageData.has(key) ? { [key]: storageData.get(key) } : {};
        if (Array.isArray(key)) {
          return Object.fromEntries(
            key.filter((item) => storageData.has(item)).map((item) => [item, storageData.get(item)])
          );
        }
        return {};
      },
      async set(values) {
        for (const [key, value] of Object.entries(values || {})) storageData.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) storageData.delete(key);
      }
    },
    sync: {
      async get() {
        return {};
      },
      async set() {}
    },
    onChanged: eventSink([])
  },
  tabs: {
    async query() {
      return Array.from(tabs.values());
    },
    async create(createProperties) {
      const tab = {
        id: nextTabId++,
        windowId: 7,
        url: createProperties.url || 'about:blank',
        active: !!createProperties.active,
        status: 'complete',
        lastAccessed: Date.now()
      };
      tabs.set(tab.id, tab);
      operations.push({ kind: 'create', tabId: tab.id, url: tab.url, active: tab.active });
      return { ...tab };
    },
    async update(tabId, updateProperties) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`missing tab ${tabId}`);
      Object.assign(tab, updateProperties, { lastAccessed: Date.now() });
      operations.push({ kind: 'update', tabId, ...updateProperties });
      return { ...tab };
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`missing tab ${tabId}`);
      return { ...tab };
    },
    async remove(tabIds) {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) tabs.delete(tabId);
    },
    async sendMessage() {
      return { success: true };
    },
    onUpdated: eventSink([]),
    onRemoved: eventSink(tabRemovedListeners)
  },
  windows: {
    async update(windowId, updateInfo) {
      operations.push({ kind: 'window', windowId, ...updateInfo });
      return { id: windowId, ...updateInfo };
    }
  },
  scripting: {
    async executeScript() {
      return [];
    }
  }
};

const backgroundUrl = `${pathToFileURL(path.resolve('dist/src/background.js')).href}?serial-test=${Date.now()}`;
await import(backgroundUrl);

const dispatch = globalThis.__BAWEI_V2_DISPATCH_DIRECT;
assert.equal(typeof dispatch, 'function', '构建产物必须暴露 background 直连入口');
assert.equal(runtimeMessageListeners.length, 1, '应注册一个 runtime message listener');

const start = await dispatch({
  type: 'V2_START_JOB',
  action: 'publish',
  focusChannel: 'csdn',
  channels: ['csdn', 'cnblogs'],
  article: {
    title: '串行集成测试',
    contentHtml: '<p>正文</p>',
    sourceUrl: 'https://example.com/serial-test'
  }
});
assert.equal(start.success, true);
assert.ok(start.jobId);

const firstNavigations = operations.filter(
  (item) => item.kind === 'update' && /^https?:/.test(String(item.url || ''))
);
assert.deepEqual(
  firstNavigations.map((item) => item.url),
  ['https://mp.csdn.net/mp_blog/creation/editor'],
  '任务启动时只能导航第一个渠道'
);
const firstNavIndex = operations.findIndex(
  (item) => item.kind === 'update' && item.url === firstNavigations[0].url
);
const firstFocusIndex = operations.findIndex(
  (item) => item.kind === 'window' && item.focused === true
);
assert.ok(
  firstFocusIndex >= 0 && firstFocusIndex < firstNavIndex,
  '必须在渠道导航前聚焦浏览器窗口'
);

async function sendRuntimeMessage(message, sender) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`message timeout: ${message.type}`)), 5000);
    runtimeMessageListeners[0](message, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

const firstTabId = firstNavigations[0].tabId;
const firstDone = await sendRuntimeMessage(
  {
    type: 'V2_CHANNEL_UPDATE',
    jobId: start.jobId,
    channelId: 'csdn',
    patch: { status: 'success', stage: 'done' }
  },
  { tab: { id: firstTabId } }
);
assert.equal(firstDone.success, true);

const navigationsAfterFirstDone = operations.filter(
  (item) => item.kind === 'update' && /^https?:/.test(String(item.url || ''))
);
assert.deepEqual(
  navigationsAfterFirstDone.map((item) => item.url),
  ['https://mp.csdn.net/mp_blog/creation/editor', 'https://i.cnblogs.com/posts/edit'],
  '首个渠道成功后才可导航第二个渠道'
);

const stateKey = `bawei_v2_state_${start.jobId}`;
const stateAfterAdvance = storageData.get(stateKey);
assert.equal(stateAfterAdvance.csdn.status, 'success');
assert.equal(stateAfterAdvance.cnblogs.status, 'running');
assert.equal(
  Object.values(stateAfterAdvance).filter((item) => item.status === 'running').length,
  1,
  '任意时刻至多一个渠道处于 running'
);

const secondTabId = navigationsAfterFirstDone[1].tabId;
const secondDone = await sendRuntimeMessage(
  {
    type: 'V2_CHANNEL_UPDATE',
    jobId: start.jobId,
    channelId: 'cnblogs',
    patch: { status: 'success', stage: 'done' }
  },
  { tab: { id: secondTabId } }
);
assert.equal(secondDone.success, true);
assert.equal(
  operations.filter((item) => item.kind === 'update' && /^https?:/.test(String(item.url || '')))
    .length,
  2,
  '队列完成后不得额外导航'
);

const allChannels = getChannelIds();
const allEntryUrls = allChannels.map((channelId) => getChannelConfig(channelId).entryUrl);
const terminalStatuses = allChannels.map((_channelId, index) =>
  index === 0 ? 'pending_review' : index === 1 ? 'rejected' : 'success'
);
const allOperationsStart = operations.length;
const allNavigationTabIds = [];
const allStart = await dispatch({
  type: 'V2_START_JOB',
  action: 'publish',
  focusChannel: allChannels[0],
  channels: allChannels,
  article: {
    title: '十渠道串行集成测试',
    contentHtml: '<p>正文</p>',
    sourceUrl: 'https://example.com/serial-ten-channels'
  }
});
assert.equal(allStart.success, true);

for (let index = 0; index < allChannels.length; index += 1) {
  const runOperations = operations.slice(allOperationsStart);
  const navigations = runOperations.filter(
    (item) => item.kind === 'update' && /^https?:/.test(String(item.url || ''))
  );
  assert.deepEqual(
    navigations.map((item) => item.url),
    allEntryUrls.slice(0, index + 1),
    `第 ${index + 1} 步只能导航当前渠道`
  );
  const navigationIndex = runOperations.indexOf(navigations[index]);
  allNavigationTabIds[index] = navigations[index].tabId;
  assert.equal(
    runOperations[navigationIndex - 1]?.kind,
    'window',
    `第 ${index + 1} 步必须在导航前聚焦窗口`
  );
  assert.equal(
    runOperations[navigationIndex - 1]?.focused,
    true,
    `第 ${index + 1} 步的窗口聚焦参数必须为 true`
  );

  const channelState = storageData.get(`bawei_v2_state_${allStart.jobId}`);
  assert.equal(channelState[allChannels[index]].status, 'running');
  assert.equal(
    Object.values(channelState).filter((item) => item.status === 'running').length,
    1,
    `第 ${index + 1} 步必须且只能有一个 running 渠道`
  );

  const done = await sendRuntimeMessage(
    {
      type: 'V2_CHANNEL_UPDATE',
      jobId: allStart.jobId,
      channelId: allChannels[index],
      patch: { status: terminalStatuses[index], stage: 'done' }
    },
    { tab: { id: navigations[index].tabId } }
  );
  assert.equal(done.success, true);
}

const allFinalState = storageData.get(`bawei_v2_state_${allStart.jobId}`);
assert.ok(
  allChannels.every((channelId, index) => allFinalState[channelId].status === terminalStatuses[index]),
  '成功、待审、退回都必须作为串行终态保存并推进队列'
);
assert.equal(tabRemovedListeners.length, 1, '应注册一个 tab 关闭监听器');
tabRemovedListeners[0](allNavigationTabIds[0]);
tabRemovedListeners[0](allNavigationTabIds[1]);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(allFinalState[allChannels[0]].status, 'pending_review', '关闭待审渠道 Tab 不得覆写终态');
assert.equal(allFinalState[allChannels[1]].status, 'rejected', '关闭退回渠道 Tab 不得覆写终态');
assert.equal(
  operations
    .slice(allOperationsStart)
    .filter((item) => item.kind === 'update' && /^https?:/.test(String(item.url || ''))).length,
  10,
  '十渠道完成后不得额外导航'
);

const noSourceStart = await dispatch({
  type: 'V2_START_JOB',
  action: 'draft',
  focusChannel: 'csdn',
  channels: ['csdn'],
  article: {
    title: '无原文链接集成测试',
    contentHtml: '<p>正文</p>'
  }
});
assert.equal(noSourceStart.success, true, '本地 Markdown 未声明 source_url 时仍必须能启动渠道任务');

console.log('✅ background serial integration test passed');
