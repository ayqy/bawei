console.error(
  [
    '已停用全量明文 Cookie/localStorage 导出。',
    '请由独立的 channel-auth 获取端通过 CDP 只采集已验证的渠道白名单状态；',
    'Bawei 只消费 AES-256-GCM 密文契约，不再生成 tmp/mcp-storageState.json。'
  ].join(' ')
);
process.exitCode = 2;
