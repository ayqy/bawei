import type { ChannelId, ChannelResultStatus, ChannelRuntimeState } from './v2-types';

const SERIAL_TERMINAL_STATUSES: ReadonlySet<ChannelResultStatus> = new Set([
  'success',
  'failed',
  'waiting_user',
  'not_logged_in'
]);

export function isSerialTerminalStatus(status: ChannelResultStatus | undefined): boolean {
  return !!status && SERIAL_TERMINAL_STATUSES.has(status);
}

export function getRunningSerialChannel(
  channels: ChannelId[],
  state: Record<ChannelId, ChannelRuntimeState>
): ChannelId | null {
  return channels.find((channelId) => state[channelId]?.status === 'running') || null;
}

export function getNextSerialChannel(
  channels: ChannelId[],
  state: Record<ChannelId, ChannelRuntimeState>
): ChannelId | null {
  if (getRunningSerialChannel(channels, state)) return null;
  return (
    channels.find((channelId) => (state[channelId]?.status || 'not_started') === 'not_started') ||
    null
  );
}

export function hasQueuedSerialChannel(
  channels: ChannelId[],
  state: Record<ChannelId, ChannelRuntimeState>
): boolean {
  return channels.some((channelId) => {
    const status = state[channelId]?.status || 'not_started';
    return status === 'not_started' || status === 'running';
  });
}
