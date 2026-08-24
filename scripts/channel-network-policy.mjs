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

export function requiredChannelProxyUrl(channel, candidates) {
  if (channelProxyMode(channel) !== 'required_proxy') {
    throw new Error(`${channel} 渠道禁止使用代理`);
  }
  const proxyUrl = (Array.isArray(candidates) ? candidates : [])
    .map((value) => String(value || '').trim())
    .find(Boolean);
  if (!proxyUrl) throw new Error(`${channel} 渠道必须配置网络代理`);
  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error(`${channel} 渠道代理 URL 非法`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${channel} 渠道代理 URL 非法`);
  }
  return proxyUrl;
}
