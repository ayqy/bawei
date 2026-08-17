import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/channels.json');

let cachedConfig = null;

function assertStringArray(value, field, channelId) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`渠道配置非法：${channelId}.${field} 必须是字符串数组`);
  }
}

export function loadChannelConfig() {
  if (cachedConfig) return cachedConfig;
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (parsed?.schemaVersion !== 1 || !parsed.channels || typeof parsed.channels !== 'object') {
    throw new Error('渠道配置非法：缺少 schemaVersion=1 或 channels');
  }
  for (const [channelId, channel] of Object.entries(parsed.channels)) {
    for (const field of ['label', 'entryUrl', 'loginAuditUrl', 'managementUrl']) {
      if (typeof channel?.[field] !== 'string' || !channel[field].trim()) {
        throw new Error(`渠道配置非法：${channelId}.${field} 不能为空`);
      }
    }
    for (const field of [
      'loginUrlPatterns',
      'publicUrlPatterns',
      'publicArticleSelectors',
      'publicTitleSelectors',
      'publicImageSelectors',
      'pendingPatterns',
      'rejectedPatterns',
    ]) {
      assertStringArray(channel[field], field, channelId);
    }
    for (const pattern of [...channel.loginUrlPatterns, ...channel.publicUrlPatterns]) {
      new RegExp(pattern, 'i');
    }
  }
  cachedConfig = Object.freeze(parsed);
  return cachedConfig;
}

export function getChannelConfig(channelId) {
  const config = loadChannelConfig().channels[channelId];
  if (!config) throw new Error(`未知渠道：${channelId}`);
  return config;
}

export function getChannelIds() {
  return Object.keys(loadChannelConfig().channels);
}

export function matchesConfiguredUrl(rawUrl, patterns) {
  const value = String(rawUrl || '').trim();
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(value));
}
