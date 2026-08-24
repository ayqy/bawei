const PROXY_REQUIRED = new Set(['cws', 'x']);

export const PROXY_REQUIRED_CHANNELS = Object.freeze([...PROXY_REQUIRED]);

export function channelProxyMode(channel) {
  const normalized = String(channel || '')
    .trim()
    .toLowerCase();
  return PROXY_REQUIRED.has(normalized) ? 'required_proxy' : 'direct';
}

export function directChromiumArgs(channels) {
  const normalized = Array.from(
    new Set((Array.isArray(channels) ? channels : []).map((channel) => String(channel).trim()))
  ).filter(Boolean);
  const proxyOnly = normalized.filter((channel) => channelProxyMode(channel) === 'required_proxy');
  if (proxyOnly.length) {
    throw new Error(
      `渠道必须使用独立代理运行时，不能进入通用直连 Chromium：${proxyOnly.join(',')}`
    );
  }
  return ['--no-proxy-server'];
}

export function isExplicitDirectChromiumCommand(command) {
  return /(?:^|\s)--no-proxy-server(?:\s|$)/.test(String(command || ''));
}
