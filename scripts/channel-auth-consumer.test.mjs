import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ChannelAuthConsumerError,
  applyBrowserState,
  readChannelAuthState,
  resolveChannelAuth,
  summarizeChannelAuth
} from './channel-auth-consumer.mjs';
import { classifyRecoveryPage } from './channel-auth-browser-recovery.mjs';
import { getChannelIds } from './channel-config.mjs';
import {
  channelProxyMode,
  directChromiumArgs,
  isExplicitDirectChromiumCommand,
  PROXY_REQUIRED_CHANNELS,
  requiredChannelProxyUrl
} from './channel-network-policy.mjs';

const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const DEVICE_ID = 'bawei-test-device';

assert.deepEqual(PROXY_REQUIRED_CHANNELS, ['cws', 'x']);
assert.equal(channelProxyMode('cws'), 'required_proxy');
assert.equal(channelProxyMode('x'), 'required_proxy');
for (const channel of getChannelIds()) {
  assert.equal(channelProxyMode(channel), 'direct');
}
assert.deepEqual(directChromiumArgs(getChannelIds()), ['--no-proxy-server']);
assert.throws(() => directChromiumArgs(['x']), /独立代理运行时/);
assert.throws(() => directChromiumArgs(['cws']), /独立代理运行时/);
assert.equal(
  isExplicitDirectChromiumCommand('/path/chrome --remote-debugging-port=123 --no-proxy-server'),
  true
);
assert.equal(
  isExplicitDirectChromiumCommand('/path/chrome --proxy-server=http://127.0.0.1:7890'),
  false
);
assert.equal(
  requiredChannelProxyUrl('cws', ['', 'http://127.0.0.1:7890']),
  'http://127.0.0.1:7890'
);
assert.throws(() => requiredChannelProxyUrl('cws', []), /必须配置网络代理/);
assert.throws(() => requiredChannelProxyUrl('cws', ['socks5://127.0.0.1:7890']), /代理 URL 非法/);
assert.throws(() => requiredChannelProxyUrl('sspai', ['http://127.0.0.1:7890']), /禁止使用代理/);
for (const browserEntry of [
  'channel-auth-probe.mjs',
  'live-publish-chrome-cdp.mjs',
  'mcp-live-publish.mjs',
  'mowen-image-paste-probe.mjs',
  'mowen-image-upload-probe.mjs',
  'mowen-weixin-image-paste-batch.mjs',
  'mowen-weixin-publish-mowen.mjs',
  'v2-e2e.mjs',
  'v3-e2e.mjs',
  'v3-unit.mjs'
]) {
  const source = fs.readFileSync(path.resolve('scripts', browserEntry), 'utf8');
  assert.match(source, /directChromiumArgs\(/, `${browserEntry} 必须应用直连策略`);
}
const livePublishSource = fs.readFileSync(
  path.resolve('scripts', 'live-publish-chrome-cdp.mjs'),
  'utf8'
);
assert.match(
  livePublishSource,
  /assertExistingChromeUsesDirectNetwork\(port\)/,
  '复用已有 CDP 浏览器前必须验证其显式直连'
);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function writeState(root, { channel, kind, payload, expiresAt = null }) {
  const platformName =
    process.platform === 'darwin' ? 'Darwin' : process.platform === 'linux' ? 'Linux' : os.type();
  const deviceBinding = crypto
    .createHash('sha256')
    .update(`${platformName}:${DEVICE_ID}`)
    .digest('hex')
    .slice(0, 32);
  const aad = { schema_version: 1, channel, kind, device_binding: deviceBinding };
  const state = {
    schema_version: 1,
    channel,
    kind,
    issuer: 'independent-test-fixture',
    captured_at: new Date().toISOString(),
    expires_at: expiresAt,
    payload
  };
  const nonce = Buffer.from(Array.from({ length: 12 }, (_, index) => index));
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, nonce);
  cipher.setAAD(Buffer.from(canonical(aad)));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonical(state))),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  fs.mkdirSync(root, { mode: 0o700, recursive: true });
  const output = path.join(root, `${channel}.${kind}.sealed.json`);
  fs.writeFileSync(
    output,
    JSON.stringify({
      ...aad,
      algorithm: 'aes-256-gcm',
      created_at: new Date().toISOString(),
      nonce: nonce.toString('base64').replaceAll('+', '-').replaceAll('/', '_'),
      ciphertext: ciphertext.toString('base64').replaceAll('+', '-').replaceAll('/', '_'),
      aad_sha256: crypto.createHash('sha256').update(canonical(aad)).digest('hex')
    }),
    { mode: 0o600 }
  );
  return output;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bawei-channel-auth-'));
try {
  const csdnPayload = {
    cookies: [
      {
        name: 'UserName',
        value: 'fixture',
        domain: '.csdn.net',
        path: '/',
        secure: true,
        httpOnly: false
      },
      {
        name: 'UserToken',
        value: 'fixture',
        domain: '.csdn.net',
        path: '/',
        secure: true,
        httpOnly: true
      },
      {
        name: 'uuid_tt_dd',
        value: 'fixture',
        domain: '.csdn.net',
        path: '/',
        secure: true,
        httpOnly: false
      }
    ],
    origins: []
  };
  const statePath = writeState(root, {
    channel: 'csdn',
    kind: 'browser_state',
    payload: csdnPayload
  });
  const state = readChannelAuthState('csdn', 'browser_state', {
    root,
    key: KEY,
    deviceId: DEVICE_ID
  });
  assert.equal(state.payload.cookies.length, 3);

  const resolution = resolveChannelAuth('csdn', {
    root,
    key: KEY,
    deviceId: DEVICE_ID,
    allowBrowserState: true,
    keychainRunner: () => ({ status: 1, stdout: '' })
  });
  assert.equal(resolution.status, 'ready');
  assert.equal(resolution.selected, 'browser_state');
  assert.equal('state' in summarizeChannelAuth(resolution), false);
  assert.equal(JSON.stringify(summarizeChannelAuth(resolution)).includes('UserToken'), false);

  const observed = { cookies: [], scripts: [] };
  await applyBrowserState(
    {
      async addCookies(cookies) {
        observed.cookies.push(...cookies);
      },
      async addInitScript(fn, value) {
        observed.scripts.push([fn, value]);
      }
    },
    resolution
  );
  assert.deepEqual(
    observed.cookies.map((cookie) => cookie.name).sort(),
    ['UserName', 'UserToken', 'uuid_tt_dd'].sort()
  );

  const invalidRoot = path.join(root, 'invalid');
  writeState(invalidRoot, {
    channel: 'csdn',
    kind: 'browser_state',
    payload: {
      ...csdnPayload,
      cookies: [
        ...csdnPayload.cookies,
        {
          name: 'unreviewed',
          value: 'must-not-pass',
          domain: '.csdn.net',
          path: '/',
          secure: true,
          httpOnly: true
        }
      ]
    }
  });
  assert.throws(
    () =>
      readChannelAuthState('csdn', 'browser_state', {
        root: invalidRoot,
        key: KEY,
        deviceId: DEVICE_ID
      }),
    (error) => error instanceof ChannelAuthConsumerError && error.code === 'invalid_state'
  );

  statePath && fs.chmodSync(statePath, 0o644);
  assert.throws(
    () =>
      readChannelAuthState('csdn', 'browser_state', {
        root,
        key: KEY,
        deviceId: DEVICE_ID
      }),
    (error) => error instanceof ChannelAuthConsumerError && error.code === 'unsafe_permissions'
  );
  fs.chmodSync(statePath, 0o600);

  fs.chmodSync(statePath, 0o700);
  assert.throws(
    () =>
      readChannelAuthState('csdn', 'browser_state', {
        root,
        key: KEY,
        deviceId: DEVICE_ID
      }),
    (error) => error instanceof ChannelAuthConsumerError && error.code === 'unsafe_permissions'
  );
  fs.chmodSync(statePath, 0o600);

  writeState(root, {
    channel: 'cws',
    kind: 'oauth2',
    payload: {
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      token_url: 'https://oauth2.googleapis.com/token',
      client_id: 'fixture-client',
      client_secret: 'fixture-secret'
    }
  });
  const cws = resolveChannelAuth('cws', {
    root,
    key: KEY,
    deviceId: DEVICE_ID,
    supportedOfficialKinds: ['oauth2'],
    allowBrowserState: false
  });
  assert.equal(cws.selected, 'oauth2');
  assert.equal(cws.state.payload.refresh_token, 'fixture-refresh');

  writeState(root, {
    channel: 'cws',
    kind: 'oauth2',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    payload: {
      access_token: 'expired-fixture-access',
      refresh_token: 'fixture-refresh',
      token_url: 'https://oauth2.googleapis.com/token',
      client_id: 'fixture-client',
      client_secret: 'fixture-secret'
    }
  });
  assert.throws(
    () =>
      readChannelAuthState('cws', 'oauth2', {
        root,
        key: KEY,
        deviceId: DEVICE_ID
      }),
    (error) => error instanceof ChannelAuthConsumerError && error.code === 'expired'
  );
  const refreshableCws = resolveChannelAuth('cws', {
    root,
    key: KEY,
    deviceId: DEVICE_ID,
    supportedOfficialKinds: ['oauth2'],
    allowBrowserState: false,
    allowExpiredRefreshableOAuth: true
  });
  assert.equal(refreshableCws.status, 'ready');
  assert.equal(summarizeChannelAuth(refreshableCws).refreshRequired, true);

  assert.deepEqual(
    classifyRecoveryPage({ riskDetected: true, hasPassword: true, hasUsername: true }),
    {
      allowed: false,
      checkpoint: 'manual_strong_verification_required'
    }
  );
  assert.equal(
    classifyRecoveryPage({ riskDetected: false, hasPassword: true, hasUsername: true }).allowed,
    true
  );
  assert.equal(
    classifyRecoveryPage({
      riskDetected: false,
      qrDetected: true,
      hasPassword: true,
      hasUsername: true
    }).allowed,
    true
  );
  assert.equal(
    classifyRecoveryPage({
      riskDetected: false,
      qrDetected: true,
      hasPassword: false,
      hasUsername: false
    }).checkpoint,
    'manual_strong_verification_required'
  );

  console.log('✅ channel-auth consumer unit tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
