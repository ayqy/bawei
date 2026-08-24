#!/usr/bin/env node

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { resolveChannelAuth } from './channel-auth-consumer.mjs';

const PRODUCT_NAME = 'bawei';
const API_ROOT = 'https://chromewebstore.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EXPECTED_PUBLISH_TYPE = 'DEFAULT_PUBLISH';

type RevisionStatus = {
  state?: string;
  distributionChannels?: Array<{ crxVersion?: string }>;
};

type CwsStatus = {
  name?: string;
  itemId?: string;
  lastAsyncUploadState?: string;
  submittedItemRevisionStatus?: RevisionStatus;
  publishedItemRevisionStatus?: RevisionStatus;
  error?: { status?: string; message?: string };
};

type CliOptions = {
  dryRun: boolean;
  statusOnly: boolean;
  evidenceDir: string | null;
};

type ReleaseIdentity = {
  publisherId: string;
  itemId: string;
  itemName: string;
};

type CwsOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  source: 'channel_auth' | 'process_environment';
};

function parseCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  const valueAfter = (flag: string): string | null => {
    const direct = args.indexOf(flag);
    if (direct >= 0) return args[direct + 1] || '';
    const prefixed = args.find((arg) => arg.startsWith(`${flag}=`));
    return prefixed ? prefixed.slice(flag.length + 1) : null;
  };
  const evidenceDir = valueAfter('--evidence-dir');
  if (evidenceDir === '') throw new Error('--evidence-dir 必须提供目录');
  return {
    dryRun: args.includes('--dry-run'),
    statusOnly: args.includes('--status'),
    evidenceDir
  };
}

function setupProxy(): void {
  const proxyUrl =
    process.env.CWS_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (!proxyUrl) {
    console.log('[CWS] 未启用代理');
    return;
  }
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log('[CWS] 已启用代理（地址已隐藏）');
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function resolveCwsOAuthCredentials(): CwsOAuthCredentials {
  const neutral = resolveChannelAuth('cws', {
    supportedOfficialKinds: ['oauth2'],
    allowBrowserState: false,
    allowExpiredRefreshableOAuth: true
  });
  if (neutral.status === 'ready' && neutral.selected === 'oauth2') {
    if (!neutral.state) throw new Error('CWS channel-auth 状态缺少明文契约');
    const payload = neutral.state.payload as Record<string, unknown>;
    const tokenUrl = String(payload.token_url || '').trim();
    const clientId = String(payload.client_id || '').trim();
    const clientSecret = String(payload.client_secret || '').trim();
    const refreshToken = String(payload.refresh_token || '').trim();
    if (tokenUrl !== TOKEN_URL) throw new Error('CWS OAuth token_url 与固定官方端点不匹配');
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('CWS channel-auth OAuth 刷新凭据不完整');
    }
    return { clientId, clientSecret, refreshToken, source: 'channel_auth' };
  }

  // GitHub Actions 等无 macOS Keychain 的环境仍可用平台 Secret 注入官方 OAuth。
  const clientId = String(process.env.CWS_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.CWS_CLIENT_SECRET || '').trim();
  const refreshToken = String(process.env.CWS_REFRESH_TOKEN || '').trim();
  if (clientId && clientSecret && refreshToken) {
    return { clientId, clientSecret, refreshToken, source: 'process_environment' };
  }
  throw new Error(
    'CWS 官方 OAuth 不可用：请提供 channel-auth cws.oauth2 状态，或在受控 CI 中注入 CWS OAuth Secret'
  );
}

function resolveIdentity(): ReleaseIdentity {
  const publisherId = requiredEnv('CWS_PUBLISHER_ID');
  const itemId = requiredEnv('CWS_EXTENSION_ID');
  if (!/^[0-9a-f-]{36}$/i.test(publisherId)) throw new Error('CWS_PUBLISHER_ID 格式非法');
  if (!/^[a-p]{32}$/.test(itemId)) throw new Error('CWS_EXTENSION_ID 格式非法');
  return {
    publisherId,
    itemId,
    itemName: `publishers/${publisherId}/items/${itemId}`
  };
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(access_token|refresh_token|client_secret|authorization)(["'=:\s]+)[^\s,"'}]+/gi,
      '$1$2[REDACTED]'
    );
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error: unknown) {
    const cause =
      error && typeof error === 'object' && 'cause' in error
        ? (error.cause as { code?: unknown } | undefined)
        : undefined;
    const code = typeof cause?.code === 'string' ? cause.code : 'network_error';
    throw new Error(`CWS 网络请求失败：${code}`);
  }
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await safeFetch(url, init);
  const payload = await responsePayload(response);
  if (!response.ok) {
    const apiError =
      payload.error && typeof payload.error === 'object'
        ? (payload.error as Record<string, unknown>)
        : {};
    const status = typeof apiError.status === 'string' ? apiError.status : 'unknown';
    const message =
      typeof apiError.message === 'string' ? redact(apiError.message) : 'request failed';
    throw new Error(`CWS API HTTP ${response.status} ${status}: ${message}`);
  }
  return payload;
}

async function fetchAccessToken(credentials: CwsOAuthCredentials): Promise<string> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token'
  });
  const response = await safeFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await responsePayload(response);
  const token = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!response.ok || !token) {
    const code = typeof payload.error === 'string' ? payload.error : 'unknown';
    throw new Error(`OAuth 刷新失败：HTTP ${response.status} ${redact(code)}`);
  }
  return token;
}

function v2ActionUrl(identity: ReleaseIdentity, action: 'fetchStatus' | 'publish'): string {
  return `${API_ROOT}/v2/${identity.itemName}:${action}`;
}

function v2UploadUrl(identity: ReleaseIdentity): string {
  return `${API_ROOT}/upload/v2/${identity.itemName}:upload`;
}

export function buildPublishRequest(): {
  publishType: 'DEFAULT_PUBLISH';
  skipReview: false;
  blockOnWarnings: true;
} {
  return {
    publishType: EXPECTED_PUBLISH_TYPE,
    skipReview: false,
    blockOnWarnings: true
  };
}

export async function fetchStatus(
  identity: ReleaseIdentity,
  accessToken: string
): Promise<CwsStatus> {
  const payload = (await requestJson(v2ActionUrl(identity, 'fetchStatus'), {
    headers: { authorization: `Bearer ${accessToken}` }
  })) as CwsStatus;
  if (payload.itemId !== identity.itemId || payload.name !== identity.itemName) {
    throw new Error('CWS fetchStatus 返回的发布者或扩展身份不匹配');
  }
  return payload;
}

export async function upload(
  identity: ReleaseIdentity,
  accessToken: string,
  zipFilePath: string
): Promise<Record<string, unknown>> {
  const bytes = await fs.readFile(zipFilePath);
  return await requestJson(v2UploadUrl(identity), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/octet-stream'
    },
    body: bytes as unknown as BodyInit
  });
}

export async function publish(
  identity: ReleaseIdentity,
  accessToken: string
): Promise<Record<string, unknown>> {
  const payload = await requestJson(v2ActionUrl(identity, 'publish'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(buildPublishRequest())
  });
  if (payload.itemId !== identity.itemId || payload.name !== identity.itemName) {
    throw new Error('CWS publish 返回的发布者或扩展身份不匹配');
  }
  return payload;
}

function revisionVersions(revision: RevisionStatus | undefined): string[] {
  return (revision?.distributionChannels || [])
    .map((channel) => String(channel.crxVersion || '').trim())
    .filter(Boolean);
}

function sanitizeStatus(status: CwsStatus): Record<string, unknown> {
  return {
    identityVerified: Boolean(status.itemId && status.name),
    lastAsyncUploadState: status.lastAsyncUploadState || null,
    submitted: {
      state: status.submittedItemRevisionStatus?.state || null,
      versions: revisionVersions(status.submittedItemRevisionStatus)
    },
    published: {
      state: status.publishedItemRevisionStatus?.state || null,
      versions: revisionVersions(status.publishedItemRevisionStatus)
    }
  };
}

function targetTerminalState(
  status: CwsStatus,
  version: string
): 'public' | 'pending_review' | null {
  if (
    status.publishedItemRevisionStatus?.state === 'PUBLISHED' &&
    revisionVersions(status.publishedItemRevisionStatus).includes(version)
  ) {
    return 'public';
  }
  if (
    ['PENDING_REVIEW', 'SUBMITTED'].includes(
      String(status.submittedItemRevisionStatus?.state || '')
    ) &&
    revisionVersions(status.submittedItemRevisionStatus).includes(version)
  ) {
    return 'pending_review';
  }
  return null;
}

function activeSubmittedVersion(status: CwsStatus): string | null {
  const state = String(status.submittedItemRevisionStatus?.state || '');
  if (!['PENDING_REVIEW', 'SUBMITTED'].includes(state)) return null;
  return revisionVersions(status.submittedItemRevisionStatus)[0] || null;
}

async function pollUpload(identity: ReleaseIdentity, accessToken: string): Promise<CwsStatus> {
  const deadline = Date.now() + 180_000;
  let latest = await fetchStatus(identity, accessToken);
  while (latest.lastAsyncUploadState === 'IN_PROGRESS' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    latest = await fetchStatus(identity, accessToken);
  }
  if (latest.lastAsyncUploadState && latest.lastAsyncUploadState !== 'SUCCEEDED') {
    throw new Error(`CWS 上传未成功：${latest.lastAsyncUploadState}`);
  }
  return latest;
}

async function pollSubmitted(
  identity: ReleaseIdentity,
  accessToken: string,
  version: string
): Promise<CwsStatus> {
  const deadline = Date.now() + 180_000;
  let latest = await fetchStatus(identity, accessToken);
  while (!targetTerminalState(latest, version) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    latest = await fetchStatus(identity, accessToken);
  }
  if (!targetTerminalState(latest, version)) {
    throw new Error(`CWS ${version} 未进入 PENDING_REVIEW 或 PUBLISHED`);
  }
  return latest;
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
}

async function preparePackage(): Promise<{ version: string; zipFilePath: string; sha256: string }> {
  const root = process.cwd();
  const manifestPath = path.join(root, 'manifest.json');
  const packagePath = path.join(root, 'package.json');
  const manifest = await readJson(manifestPath);
  const packageJson = await readJson(packagePath);
  const version = String(manifest.version || '');
  if (!version || packageJson.version !== version) {
    throw new Error(
      `版本不一致：manifest=${version || 'missing'} package=${String(packageJson.version || 'missing')}`
    );
  }

  console.log('[CWS] 构建生产扩展');
  execFileSync('npm', ['run', 'build:prod'], { cwd: root, stdio: 'inherit' });
  const distManifest = await readJson(path.join(root, 'dist', 'manifest.json'));
  if (distManifest.version !== version) {
    throw new Error(`dist 版本不一致：${String(distManifest.version || 'missing')} != ${version}`);
  }

  const zipFilePath = path.join(root, `plugin-${version}.zip`);
  await fs.rm(zipFilePath, { force: true });
  execFileSync('zip', ['-q', '-r', zipFilePath, '.'], {
    cwd: path.join(root, 'dist'),
    stdio: 'inherit'
  });
  return { version, zipFilePath, sha256: await sha256(zipFilePath) };
}

function assertSubmitPhase(version: string): void {
  if (process.env.PUB_RELEASE_PHASE !== 'submit') {
    throw new Error('拒绝外部变更：PUB_RELEASE_PHASE 必须为 submit');
  }
  const expectedIdentity = `${PRODUCT_NAME}:${version}`;
  if (process.env.PUB_RELEASE_IDENTITY !== expectedIdentity) {
    throw new Error(`拒绝外部变更：PUB_RELEASE_IDENTITY 必须为 ${expectedIdentity}`);
  }
}

async function writeEvidence(
  options: CliOptions,
  version: string,
  filename: string,
  payload: Record<string, unknown>
): Promise<string> {
  const evidenceDir = path.resolve(options.evidenceDir || path.join('artifacts', 'cws', version));
  await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await fs.chmod(evidenceDir, 0o700);
  const output = path.join(evidenceDir, filename);
  await fs.writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await fs.chmod(output, 0o600);
  return output;
}

async function main(): Promise<void> {
  const options = parseCliOptions();
  const identity = resolveIdentity();
  const oauthCredentials = resolveCwsOAuthCredentials();

  if (options.statusOnly) {
    setupProxy();
    const accessToken = await fetchAccessToken(oauthCredentials);
    const status = await fetchStatus(identity, accessToken);
    const version = String((await readJson(path.resolve('manifest.json'))).version || 'unknown');
    const evidence = {
      ok: true,
      action: 'status',
      externalMutation: false,
      product: PRODUCT_NAME,
      version,
      status: sanitizeStatus(status),
      targetTerminalState: targetTerminalState(status, version),
      checkedAt: new Date().toISOString()
    };
    const output = await writeEvidence(options, version, 'cws-status.json', evidence);
    console.log(JSON.stringify({ ...evidence, evidence: output }, null, 2));
    return;
  }

  const prepared = await preparePackage();
  const common = {
    product: PRODUCT_NAME,
    version: prepared.version,
    package: {
      path: path.basename(prepared.zipFilePath),
      sha256: prepared.sha256
    },
    publishRequest: buildPublishRequest()
  };

  if (options.dryRun) {
    const evidence = {
      ok: true,
      action: 'dry_run',
      externalMutation: false,
      ...common,
      credentials: {
        extensionId: Boolean(process.env.CWS_EXTENSION_ID),
        oauthReady: true,
        source: oauthCredentials.source
      },
      checkedAt: new Date().toISOString()
    };
    const output = await writeEvidence(options, prepared.version, 'cws-dry-run.json', evidence);
    console.log(JSON.stringify({ ...evidence, evidence: output }, null, 2));
    return;
  }

  assertSubmitPhase(prepared.version);
  setupProxy();
  const accessToken = await fetchAccessToken(oauthCredentials);
  const before = await fetchStatus(identity, accessToken);
  const existingTerminal = targetTerminalState(before, prepared.version);
  if (existingTerminal) {
    const evidence = {
      ok: true,
      action: 'submit',
      externalMutation: false,
      alreadySubmitted: true,
      ...common,
      before: sanitizeStatus(before),
      after: sanitizeStatus(before),
      terminalState: existingTerminal,
      automaticPublishAfterApproval: true,
      completedAt: new Date().toISOString()
    };
    const output = await writeEvidence(options, prepared.version, 'cws-submit.json', evidence);
    console.log(JSON.stringify({ ...evidence, evidence: output }, null, 2));
    return;
  }

  const activeVersion = activeSubmittedVersion(before);
  if (activeVersion && activeVersion !== prepared.version) {
    throw new Error(`已有其他版本处于审核流程：${activeVersion}`);
  }

  assertSubmitPhase(prepared.version);
  const uploadResponse = await upload(identity, accessToken, prepared.zipFilePath);
  const afterUpload = await pollUpload(identity, accessToken);
  assertSubmitPhase(prepared.version);
  const publishResponse = await publish(identity, accessToken);
  const after = await pollSubmitted(identity, accessToken, prepared.version);
  const terminalState = targetTerminalState(after, prepared.version);
  const evidence = {
    ok: true,
    action: 'submit',
    externalMutation: true,
    ...common,
    before: sanitizeStatus(before),
    upload: {
      state: typeof uploadResponse.uploadState === 'string' ? uploadResponse.uploadState : null,
      itemIdMatches: uploadResponse.itemId === identity.itemId
    },
    afterUpload: sanitizeStatus(afterUpload),
    submission: {
      state: typeof publishResponse.state === 'string' ? publishResponse.state : null,
      itemIdMatches: publishResponse.itemId === identity.itemId,
      publishType: EXPECTED_PUBLISH_TYPE,
      skipReview: false
    },
    after: sanitizeStatus(after),
    terminalState,
    automaticPublishAfterApproval: true,
    publicReleaseTriggered: terminalState === 'public',
    completedAt: new Date().toISOString()
  };
  const output = await writeEvidence(options, prepared.version, 'cws-submit.json', evidence);
  console.log(JSON.stringify({ ...evidence, evidence: output }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[CWS] ${redact(message)}`);
  process.exitCode = 1;
});
