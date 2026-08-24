export const PROXY_REQUIRED_CHANNELS: readonly string[];

export function channelProxyMode(channel: unknown): 'required_proxy' | 'direct';

export function directChromiumArgs(channels: unknown[]): string[];

export function isExplicitDirectChromiumCommand(command: unknown): boolean;

export function requiredChannelProxyUrl(channel: unknown, candidates: unknown[]): string;
