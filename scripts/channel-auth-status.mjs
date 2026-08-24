import { getChannelIds } from './channel-config.mjs';
import { resolveChannelAuth, summarizeChannelAuth } from './channel-auth-consumer.mjs';

const channels = getChannelIds();
const status = channels.map((channel) =>
  summarizeChannelAuth(
    resolveChannelAuth(channel, {
      supportedOfficialKinds: [],
      allowBrowserState: true
    })
  )
);

console.log(JSON.stringify({ channels: status }, null, 2));
