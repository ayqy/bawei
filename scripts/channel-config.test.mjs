import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  getChannelConfig,
  getChannelIds,
  loadChannelConfig,
  matchesConfiguredUrl
} from './channel-config.mjs';

const config = loadChannelConfig();
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.equal(config.schemaVersion, 1);
assert.equal(getChannelIds().length, 10);
assert.equal(new Set(getChannelIds()).size, 10);
assert.equal(getChannelConfig('oschina').entryUrl, 'https://my.oschina.net/blog/ai-write');
assert.equal(manifest.host_permissions.includes('https://my.oschina.net/*'), true);
assert.equal(
  manifest.web_accessible_resources.some(
    (entry) =>
      entry.resources.includes('src/assets/oschina-page-bridge.js') &&
      entry.matches.includes('https://my.oschina.net/*')
  ),
  true
);
assert.equal(getChannelConfig('sspai').entryUrl, 'https://sspai.com/write');
assert.equal(
  matchesConfiguredUrl(
    'https://blog.csdn.net/example/article/details/123',
    getChannelConfig('csdn').publicUrlPatterns
  ),
  true
);
assert.equal(
  matchesConfiguredUrl(
    'https://mp.csdn.net/mp_blog/manage/article',
    getChannelConfig('csdn').publicUrlPatterns
  ),
  false
);
assert.equal(
  matchesConfiguredUrl(
    'https://www.cnblogs.com/example/p/22519377',
    getChannelConfig('cnblogs').publicUrlPatterns
  ),
  true
);
assert.equal(
  matchesConfiguredUrl(
    'https://www.cnblogs.com/example/p/22519377.html',
    getChannelConfig('cnblogs').publicUrlPatterns
  ),
  true
);
assert.equal(
  matchesConfiguredUrl(
    'https://i.cnblogs.com/posts',
    getChannelConfig('cnblogs').publicUrlPatterns
  ),
  false
);
console.log('✅ channel config unit tests passed');
