import rawConfig from '../../config/channels.json';
import type { ChannelId } from './v2-types';

export interface ChannelConfig {
  label: string;
  entryUrl: string;
  loginAuditUrl: string;
  managementUrl: string;
  loginUrlPatterns: string[];
  publicUrlPatterns: string[];
  publicArticleSelectors: string[];
  publicTitleSelectors: string[];
  publicImageSelectors: string[];
  pendingPatterns: string[];
  rejectedPatterns: string[];
}

type ChannelConfigFile = {
  schemaVersion: number;
  channels: Record<ChannelId, ChannelConfig>;
};

const channelConfigFile = rawConfig as ChannelConfigFile;

export const CHANNEL_IDS = Object.freeze(Object.keys(channelConfigFile.channels) as ChannelId[]);

export function getChannelConfig(channelId: ChannelId): ChannelConfig {
  const config = channelConfigFile.channels[channelId];
  if (!config) throw new Error(`Unknown channel: ${channelId}`);
  return config;
}

export function matchesChannelUrl(rawUrl: string, patterns: string[]): boolean {
  const value = String(rawUrl || '').trim();
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(value));
}
