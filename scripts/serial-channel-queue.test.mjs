import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const sourcePath = path.resolve('src/shared/serial-channel-queue.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: sourcePath
});

const moduleRef = { exports: {} };
new Function('module', 'exports', compiled.outputText)(moduleRef, moduleRef.exports);

const {
  getNextSerialChannel,
  getRunningSerialChannel,
  hasQueuedSerialChannel,
  isSerialTerminalStatus
} = moduleRef.exports;
const channels = ['csdn', 'cnblogs', 'toutiao'];

function state(statuses) {
  const now = Date.now();
  return Object.fromEntries(
    channels.map((channelId) => [
      channelId,
      {
        channelId,
        status: statuses[channelId] || 'not_started',
        updatedAt: now
      }
    ])
  );
}

assert.equal(getNextSerialChannel(channels, state({})), 'csdn', '初始任务应选择第一个渠道');
assert.equal(
  getNextSerialChannel(channels, state({ csdn: 'running' })),
  null,
  '已有运行渠道时不得再启动第二个渠道'
);
assert.equal(getRunningSerialChannel(channels, state({ cnblogs: 'running' })), 'cnblogs');
assert.equal(
  getNextSerialChannel(channels, state({ csdn: 'success', cnblogs: 'failed' })),
  'toutiao',
  '终态渠道之后应按原顺序推进'
);
assert.equal(
  getNextSerialChannel(
    channels,
    state({ csdn: 'waiting_user', cnblogs: 'not_logged_in', toutiao: 'success' })
  ),
  null,
  '所有渠道已有终态时队列应结束'
);
assert.equal(
  hasQueuedSerialChannel(channels, state({ csdn: 'success', cnblogs: 'not_started' })),
  true
);
assert.equal(
  hasQueuedSerialChannel(
    channels,
    state({ csdn: 'success', cnblogs: 'failed', toutiao: 'waiting_user' })
  ),
  false
);

for (const status of ['success', 'failed', 'waiting_user', 'not_logged_in']) {
  assert.equal(isSerialTerminalStatus(status), true, `${status} 应结束当前渠道尝试`);
}
assert.equal(isSerialTerminalStatus('running'), false);
assert.equal(isSerialTerminalStatus('not_started'), false);

console.log('✅ serial channel queue unit tests passed');
