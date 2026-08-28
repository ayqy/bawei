import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const MASTER_KEY_SERVICE = 'channel-auth.master-key.v1';
const MASTER_KEY_ACCOUNT = 'default';
const RECOVERY_PAIR_ACCOUNT = 'credential-pair-v1';
const SUPPORTED_KINDS = ['oauth2', 'api_key', 'service_account', 'browser_state'];
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WRAPPER_FIELDS = new Set([
  'schema_version',
  'channel',
  'kind',
  'issuer',
  'captured_at',
  'expires_at',
  'payload'
]);
const OFFICIAL_FIELDS = {
  oauth2: new Set([
    'access_token',
    'refresh_token',
    'token_url',
    'client_id',
    'client_secret',
    'scope',
    'token_type',
    'token_auth_method'
  ]),
  api_key: new Set(['api_key', 'key_id', 'issuer_id', 'private_key', 'audience']),
  service_account: new Set([
    'client_id',
    'client_secret',
    'app_id',
    'app_secret',
    'tenant_id',
    'token_url',
    'scope',
    'access_token',
    'refresh_token',
    'token_type'
  ])
};

// 这是 Bawei 自己支持的跨项目契约副本，不读取或 import login 仓库。
// 只有完成过真实最小集验证的 browser_state 才允许注入。
export const CHANNEL_AUTH_SPECS = Object.freeze({
  csdn: {
    officialKinds: [],
    browserState: {
      validated: true,
      cookieRules: [{ domainSuffix: '.csdn.net', names: ['UserName', 'UserToken', 'uuid_tt_dd'] }],
      origins: [],
      requiredCookieSets: [['UserName', 'UserToken', 'uuid_tt_dd']]
    },
    recovery: ['keychain_password', 'captcha', 'risk_verification']
  },
  'tencent-cloud-dev': {
    officialKinds: [],
    browserState: {
      validated: true,
      cookieRules: [{ domainSuffix: '.cloud.tencent.com', names: ['qcommunity_session'] }],
      origins: [],
      requiredCookieSets: [['qcommunity_session']]
    },
    recovery: ['keychain_password', 'qr', 'risk_verification']
  },
  cnblogs: {
    officialKinds: ['api_key'],
    browserState: { validated: false, cookieRules: [], origins: [] },
    recovery: ['keychain_password', 'captcha']
  },
  oschina: {
    officialKinds: ['oauth2'],
    browserState: { validated: false, cookieRules: [], origins: [] },
    recovery: ['keychain_password', 'captcha']
  },
  woshipm: {
    officialKinds: [],
    browserState: { validated: false, cookieRules: [], origins: [] },
    recovery: ['keychain_password', 'sms', 'captcha']
  },
  mowen: {
    officialKinds: ['api_key'],
    browserState: {
      validated: true,
      cookieRules: [{ domainSuffix: '.mowen.cn', names: ['_MWT', '_MWTH'] }],
      origins: [],
      requiredCookieSets: [['_MWT', '_MWTH']]
    },
    recovery: ['qr', 'sms']
  },
  sspai: {
    officialKinds: [],
    browserState: {
      validated: true,
      cookieRules: [],
      origins: [{ origin: 'https://sspai.com', localStorage: ['ssToken'] }],
      requiredStorageSets: [[{ origin: 'https://sspai.com', name: 'ssToken' }]]
    },
    recovery: ['keychain_password', 'sms', 'captcha']
  },
  baijiahao: {
    officialKinds: ['oauth2'],
    browserState: { validated: false, cookieRules: [], origins: [] },
    recovery: ['keychain_password', 'qr', 'sms', 'risk_verification']
  },
  toutiao: {
    officialKinds: ['oauth2'],
    browserState: {
      validated: true,
      cookieRules: [{ domainSuffix: '.toutiao.com', names: ['sessionid', 'sessionid_ss'] }],
      origins: [],
      requiredCookieSets: [['sessionid'], ['sessionid_ss']]
    },
    recovery: ['qr', 'sms', 'captcha', 'risk_verification']
  },
  'feishu-docs': {
    officialKinds: ['service_account', 'oauth2'],
    browserState: {
      validated: true,
      cookieRules: [{ domainSuffix: '.feishu.cn', names: ['session'] }],
      origins: [],
      requiredCookieSets: [['session']]
    },
    recovery: ['qr', 'sms']
  },
  cws: {
    officialKinds: ['oauth2'],
    browserState: { validated: false, cookieRules: [], origins: [] },
    recovery: ['keychain_password', 'two_factor']
  }
});

export class ChannelAuthConsumerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChannelAuthConsumerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChannelAuthConsumerError(code, message);
}

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

function strictBase64(value, field) {
  const raw = String(value || '');
  if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) {
    fail('invalid_envelope', `channel-auth ${field} 非法`);
  }
  const standard = raw.replaceAll('-', '+').replaceAll('_', '/');
  const decoded = Buffer.from(standard, 'base64');
  const roundTrip = decoded.toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  if (roundTrip !== raw) fail('invalid_envelope', `channel-auth ${field} 非法`);
  return decoded;
}

function systemName() {
  if (process.platform === 'darwin') return 'Darwin';
  if (process.platform === 'linux') return 'Linux';
  if (process.platform === 'win32') return 'Windows';
  return os.type();
}

function deviceBinding(explicitDeviceId = '') {
  let identifier = String(explicitDeviceId || process.env.CHANNEL_AUTH_DEVICE_ID || '').trim();
  if (!identifier && process.platform === 'darwin') {
    try {
      const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      identifier = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || '';
    } catch {
      identifier = '';
    }
  }
  if (!identifier && process.platform === 'linux') {
    try {
      identifier = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    } catch {
      identifier = '';
    }
  }
  if (!identifier) fail('device_unavailable', 'channel-auth 设备绑定不可用');
  return crypto
    .createHash('sha256')
    .update(`${systemName()}:${identifier}`)
    .digest('hex')
    .slice(0, 32);
}

export function channelAuthRoot() {
  const configured = String(process.env.CHANNEL_AUTH_HOME || '').trim();
  return path.resolve(
    configured || path.join(os.homedir(), 'Library/Application Support/channel-auth/v1')
  );
}

function keychainResult(args, { reveal = false, runner = spawnSync } = {}) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/security')) return '';
  try {
    const result = runner('/usr/bin/security', args, {
      encoding: 'utf8',
      timeout: reveal ? 10_000 : 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (!result || result.status !== 0) return '';
    return reveal ? String(result.stdout || '').replace(/\n$/, '') : 'present';
  } catch {
    return '';
  }
}

function keychainSecret(service, account, options = {}) {
  return keychainResult(['find-generic-password', '-s', service, '-a', account, '-w'], {
    ...options,
    reveal: true
  });
}

function keychainItemExists(service, account, options = {}) {
  return Boolean(keychainResult(['find-generic-password', '-s', service, '-a', account], options));
}

function masterKey(explicitKey = null, options = {}) {
  if (explicitKey) {
    if (!Buffer.isBuffer(explicitKey) || explicitKey.length !== 32) {
      fail('master_key_unavailable', 'channel-auth 主密钥不可用');
    }
    return explicitKey;
  }
  const encoded =
    String(process.env.CHANNEL_AUTH_MASTER_KEY || '').trim() ||
    keychainSecret(MASTER_KEY_SERVICE, MASTER_KEY_ACCOUNT, options);
  let decoded;
  try {
    decoded = strictBase64(encoded, '主密钥');
  } catch {
    fail('master_key_unavailable', 'channel-auth 主密钥不可用');
  }
  if (decoded.length !== 32) fail('master_key_unavailable', 'channel-auth 主密钥不可用');
  return decoded;
}

function assertPrivateRegularFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail('missing', 'channel-auth 状态不存在');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    fail('unsafe_permissions', 'channel-auth 状态权限不安全');
  }
}

function assertPrivateRoot(root) {
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    fail('missing', 'channel-auth 状态目录不存在');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    fail('unsafe_permissions', 'channel-auth 状态目录权限不安全');
  }
}

function parseIso(value, field, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  if (typeof value !== 'string' || !value.trim()) fail('invalid_state', `${field} 非法`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    fail('invalid_state', `${field} 非法`);
  }
  return value;
}

function domainMatches(domain, suffix) {
  const normalized = String(domain || '')
    .replace(/^\./, '')
    .toLowerCase();
  const wanted = String(suffix || '')
    .replace(/^\./, '')
    .toLowerCase();
  return normalized === wanted || normalized.endsWith(`.${wanted}`);
}

function validateCookie(cookie, rules) {
  if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) {
    fail('invalid_state', 'Cookie 结构非法');
  }
  const name = String(cookie.name || '').trim();
  const domain = String(cookie.domain || '').trim();
  const value = String(cookie.value || '');
  const allowed = rules.some(
    (rule) => domainMatches(domain, rule.domainSuffix) && rule.names.includes(name)
  );
  if (!name || !domain || !value || !allowed) {
    fail('invalid_state', 'Cookie 超出渠道白名单');
  }
  const normalized = {
    name,
    value,
    domain,
    path: String(cookie.path || '/'),
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly)
  };
  if (cookie.sameSite !== undefined && cookie.sameSite !== '') {
    const raw = String(cookie.sameSite).toLowerCase();
    const sameSite =
      raw === 'lax'
        ? 'Lax'
        : raw === 'strict'
          ? 'Strict'
          : raw === 'none' || raw === 'no_restriction'
            ? 'None'
            : '';
    if (!sameSite) fail('invalid_state', 'Cookie sameSite 非法');
    normalized.sameSite = sameSite;
  }
  if (cookie.expires !== undefined && cookie.expires !== null) {
    const expires = Number(cookie.expires);
    if (!Number.isFinite(expires)) fail('invalid_state', 'Cookie expires 非法');
    normalized.expires = expires;
  }
  return normalized;
}

function validateBrowserPayload(channel, payload, spec) {
  const browserSpec = spec.browserState || {};
  if (browserSpec.validated !== true) {
    fail('not_validated', `${channel} 没有经过验证的轻量浏览器状态`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('invalid_state', 'browser_state payload 非法');
  }
  if (Object.keys(payload).some((field) => !['cookies', 'origins'].includes(field))) {
    fail('invalid_state', 'browser_state 包含未知字段');
  }
  const rawCookies = payload.cookies || [];
  const rawOrigins = payload.origins || [];
  if (!Array.isArray(rawCookies) || !Array.isArray(rawOrigins)) {
    fail('invalid_state', 'browser_state 列表非法');
  }
  const cookies = rawCookies.map((cookie) => validateCookie(cookie, browserSpec.cookieRules || []));
  const cookieKeys = cookies.map((item) => `${item.name}\0${item.domain}\0${item.path}`);
  if (new Set(cookieKeys).size !== cookieKeys.length) {
    fail('invalid_state', 'browser_state 包含重复 Cookie');
  }

  const expectedOrigins = new Map(
    (browserSpec.origins || []).map((item) => [item.origin, new Set(item.localStorage || [])])
  );
  const origins = rawOrigins.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail('invalid_state', 'origin 状态非法');
    }
    const origin = String(item.origin || '').trim();
    let canonicalOrigin = '';
    try {
      const parsed = new URL(origin);
      canonicalOrigin = parsed.origin;
    } catch {
      fail('invalid_state', 'origin 非法');
    }
    const allowedNames = expectedOrigins.get(canonicalOrigin);
    if (!allowedNames || canonicalOrigin !== origin || !Array.isArray(item.localStorage)) {
      fail('invalid_state', 'origin 超出渠道白名单');
    }
    const seen = new Set();
    const localStorage = item.localStorage.map((entry) => {
      const name = String(entry?.name || '').trim();
      const value = String(entry?.value || '');
      if (!name || !value || !allowedNames.has(name) || seen.has(name)) {
        fail('invalid_state', 'localStorage 超出渠道白名单');
      }
      seen.add(name);
      return { name, value };
    });
    return { origin: canonicalOrigin, localStorage };
  });
  if (!cookies.length && !origins.length) fail('invalid_state', 'browser_state 为空');

  const nowSeconds = Date.now() / 1000;
  const liveCookieNames = new Set(
    cookies
      .filter(
        (cookie) =>
          cookie.expires === undefined || cookie.expires < 0 || cookie.expires > nowSeconds + 30
      )
      .map((cookie) => cookie.name)
  );
  const cookieSets = browserSpec.requiredCookieSets || [];
  if (
    cookieSets.length &&
    !cookieSets.some((set) => set.every((name) => liveCookieNames.has(name)))
  ) {
    fail('expired', 'browser_state 缺少有效的必要 Cookie');
  }
  const presentStorage = new Set(
    origins.flatMap((origin) =>
      origin.localStorage.map((entry) => `${origin.origin}\0${entry.name}`)
    )
  );
  const storageSets = browserSpec.requiredStorageSets || [];
  if (
    storageSets.length &&
    !storageSets.some((set) =>
      set.every((entry) => presentStorage.has(`${entry.origin}\0${entry.name}`))
    )
  ) {
    fail('invalid_state', 'browser_state 缺少必要 localStorage');
  }
  return { cookies, origins };
}

function validateOfficialPayload(kind, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('invalid_state', '官方凭据 payload 非法');
  }
  const allowed = OFFICIAL_FIELDS[kind];
  if (Object.keys(payload).some((field) => !allowed.has(field))) {
    fail('invalid_state', '官方凭据包含未知字段');
  }
  for (const value of Object.values(payload)) {
    if (typeof value !== 'string') fail('invalid_state', '官方凭据字段必须是字符串');
  }
  if (kind === 'oauth2') {
    if (!String(payload.access_token || '').trim())
      fail('invalid_state', 'OAuth access_token 缺失');
    if (payload.refresh_token) {
      let tokenUrl;
      try {
        tokenUrl = new URL(String(payload.token_url || ''));
      } catch {
        fail('invalid_state', 'OAuth token_url 非法');
      }
      if (tokenUrl.protocol !== 'https:' || tokenUrl.username || tokenUrl.password) {
        fail('invalid_state', 'OAuth token_url 非法');
      }
      if (!String(payload.client_id || '').trim()) fail('invalid_state', 'OAuth client_id 缺失');
    }
    const authMethod = String(payload.token_auth_method || 'client_secret_post');
    if (!['client_secret_post', 'client_secret_basic', 'none'].includes(authMethod)) {
      fail('invalid_state', 'OAuth token_auth_method 不支持');
    }
  }
  if (kind === 'api_key') {
    const simple = Boolean(String(payload.api_key || '').trim());
    const signed = ['key_id', 'issuer_id', 'private_key'].every((field) =>
      String(payload[field] || '').trim()
    );
    if (!simple && !signed) fail('invalid_state', 'API Key 不完整');
  }
  if (kind === 'service_account') {
    const oauthPair = ['client_id', 'client_secret'].every((field) =>
      String(payload[field] || '').trim()
    );
    const appPair = ['app_id', 'app_secret'].every((field) => String(payload[field] || '').trim());
    if (!oauthPair && !appPair) fail('invalid_state', '服务账号凭据不完整');
  }
  return JSON.parse(JSON.stringify(payload));
}

function validateState(channel, kind, state, { allowExpiredRefreshableOAuth = false } = {}) {
  const spec = CHANNEL_AUTH_SPECS[channel];
  if (!spec) fail('invalid_identifier', '未知 channel-auth 渠道');
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    fail('invalid_state', 'channel-auth 明文结构非法');
  }
  if (Object.keys(state).some((field) => !WRAPPER_FIELDS.has(field))) {
    fail('invalid_state', 'channel-auth 明文包含未知字段');
  }
  if (
    state.schema_version !== 1 ||
    state.channel !== channel ||
    state.kind !== kind ||
    typeof state.issuer !== 'string' ||
    !state.issuer.trim()
  ) {
    fail('invalid_state', 'channel-auth 明文契约不匹配');
  }
  parseIso(state.captured_at, 'captured_at');
  const expiresAt = parseIso(state.expires_at, 'expires_at', { nullable: true });
  const expired = Boolean(expiresAt && Date.parse(expiresAt) <= Date.now());
  if (kind === 'browser_state') {
    state.payload = validateBrowserPayload(channel, state.payload, spec);
  } else {
    if (!spec.officialKinds.includes(kind)) fail('unsupported_kind', '渠道不支持该官方凭据');
    state.payload = validateOfficialPayload(kind, state.payload);
  }
  const refreshableExpiredOAuth =
    expired &&
    kind === 'oauth2' &&
    allowExpiredRefreshableOAuth &&
    Boolean(String(state.payload.refresh_token || '').trim());
  if (expired && !refreshableExpiredOAuth) fail('expired', 'channel-auth 状态已过期');
  return state;
}

export function readChannelAuthState(
  channel,
  kind,
  {
    root = channelAuthRoot(),
    key = null,
    deviceId = '',
    keychainRunner,
    allowExpiredRefreshableOAuth = false
  } = {}
) {
  if (!CHANNEL_PATTERN.test(channel) || !SUPPORTED_KINDS.includes(kind)) {
    fail('invalid_identifier', 'channel-auth 标识非法');
  }
  assertPrivateRoot(root);
  const filePath = path.join(root, `${channel}.${kind}.sealed.json`);
  assertPrivateRegularFile(filePath);
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fail('invalid_envelope', 'channel-auth 密文封装非法');
  }
  const aad = {
    schema_version: 1,
    channel,
    kind,
    device_binding: deviceBinding(deviceId)
  };
  if (Object.entries(aad).some(([field, value]) => envelope?.[field] !== value)) {
    fail('aad_mismatch', 'channel-auth AAD 与当前消费端不匹配');
  }
  if (envelope.algorithm !== 'aes-256-gcm') {
    fail('invalid_envelope', 'channel-auth 加密算法不支持');
  }
  const aadBytes = Buffer.from(canonical(aad), 'utf8');
  if (envelope.aad_sha256 !== crypto.createHash('sha256').update(aadBytes).digest('hex')) {
    fail('invalid_envelope', 'channel-auth AAD 摘要非法');
  }
  const nonce = strictBase64(envelope.nonce, 'nonce');
  const combined = strictBase64(envelope.ciphertext, 'ciphertext');
  if (nonce.length !== 12 || combined.length < 16) {
    fail('invalid_envelope', 'channel-auth 密文长度非法');
  }
  const ciphertext = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  let state;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      masterKey(key, { runner: keychainRunner }),
      nonce
    );
    decipher.setAAD(aadBytes);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    state = JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    if (error instanceof ChannelAuthConsumerError) throw error;
    fail('authentication_failed', 'channel-auth 状态认证失败');
  }
  return validateState(channel, kind, state, { allowExpiredRefreshableOAuth });
}

function manualCheckpoint(spec) {
  const strong = (spec.recovery || []).find((method) => method !== 'keychain_password');
  return strong || 'manual_strong_verification_required';
}

export function resolveChannelAuth(
  channel,
  {
    root = channelAuthRoot(),
    key = null,
    deviceId = '',
    supportedOfficialKinds = [],
    allowBrowserState = true,
    allowExpiredRefreshableOAuth = false,
    keychainRunner
  } = {}
) {
  const spec = CHANNEL_AUTH_SPECS[channel];
  if (!spec) fail('invalid_identifier', '未知 channel-auth 渠道');
  const supportedOfficial = new Set(supportedOfficialKinds);
  const rejected = [];
  for (const kind of SUPPORTED_KINDS) {
    if (kind === 'browser_state') {
      if (!allowBrowserState) continue;
      if (spec.browserState?.validated !== true) {
        rejected.push({ kind, reason: 'not_validated' });
        continue;
      }
    } else {
      if (!spec.officialKinds.includes(kind)) continue;
      if (!supportedOfficial.has(kind)) {
        rejected.push({ kind, reason: 'operation_not_supported' });
        continue;
      }
    }
    try {
      const state = readChannelAuthState(channel, kind, {
        root,
        key,
        deviceId,
        keychainRunner,
        allowExpiredRefreshableOAuth
      });
      return { channel, status: 'ready', selected: kind, state, rejected };
    } catch (error) {
      const reason =
        error instanceof ChannelAuthConsumerError &&
        ['missing', 'expired', 'not_validated'].includes(error.code)
          ? error.code
          : 'unreadable';
      rejected.push({ kind, reason });
    }
  }

  if ((spec.recovery || []).includes('keychain_password')) {
    const service = `channel-auth.recovery.${channel}`;
    const atomic = keychainItemExists(service, RECOVERY_PAIR_ACCOUNT, {
      runner: keychainRunner
    });
    const legacy =
      keychainItemExists(service, 'username', { runner: keychainRunner }) &&
      keychainItemExists(service, 'password', { runner: keychainRunner });
    if (atomic || legacy) {
      return {
        channel,
        status: 'recovery_present',
        selected: 'keychain_password',
        checkpoint: 'keychain_unlock_or_bounded_password_login',
        rejected
      };
    }
    return {
      channel,
      status: 'blocked_external',
      selected: null,
      checkpoint: 'recovery_credentials_required',
      rejected
    };
  }
  return {
    channel,
    status: 'blocked_external',
    selected: null,
    checkpoint: manualCheckpoint(spec),
    rejected
  };
}

export function summarizeChannelAuth(resolution) {
  return {
    channel: resolution.channel,
    status: resolution.status,
    selected: resolution.selected,
    checkpoint: resolution.checkpoint || null,
    expiresAt: resolution.state?.expires_at || null,
    refreshRequired: Boolean(
      resolution.selected === 'oauth2' &&
        resolution.state?.expires_at &&
        Date.parse(resolution.state.expires_at) <= Date.now()
    ),
    issuer: resolution.state?.issuer || null,
    rejected: resolution.rejected || []
  };
}

export function readRecoveryCredentials(channel, { keychainRunner } = {}) {
  const spec = CHANNEL_AUTH_SPECS[channel];
  if (!spec || !(spec.recovery || []).includes('keychain_password')) return null;
  const service = `channel-auth.recovery.${channel}`;
  const atomic = keychainSecret(service, RECOVERY_PAIR_ACCOUNT, { runner: keychainRunner });
  if (atomic) {
    try {
      const parsed = JSON.parse(atomic);
      if (
        parsed?.schema_version === 1 &&
        typeof parsed.username === 'string' &&
        parsed.username &&
        typeof parsed.password === 'string' &&
        parsed.password
      ) {
        return { username: parsed.username, password: parsed.password };
      }
    } catch {
      return null;
    }
  }
  const username = keychainSecret(service, 'username', { runner: keychainRunner });
  const password = keychainSecret(service, 'password', { runner: keychainRunner });
  return username && password ? { username, password } : null;
}

export async function applyBrowserState(context, resolution) {
  if (resolution?.status !== 'ready' || resolution.selected !== 'browser_state') return false;
  const payload = resolution.state.payload;
  if (payload.cookies.length) await context.addCookies(payload.cookies);
  if (payload.origins.length) {
    await context.addInitScript((origins) => {
      try {
        const state = origins.find((item) => item.origin === location.origin);
        if (!state) return;
        for (const entry of state.localStorage || []) {
          localStorage.setItem(entry.name, entry.value);
        }
      } catch {
        // 浏览器拒绝存储时保持 fail closed，由后续真实登录审计给出结果。
      }
    }, payload.origins);
  }
  return true;
}

export async function resolveAndApplyBrowserAuth(context, channelIds, options = {}) {
  const resolutions = new Map();
  for (const channel of channelIds) {
    const resolution = resolveChannelAuth(channel, {
      ...options,
      supportedOfficialKinds: [],
      allowBrowserState: true
    });
    resolutions.set(channel, resolution);
    await applyBrowserState(context, resolution);
  }
  return resolutions;
}
