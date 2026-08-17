import assert from 'node:assert/strict';
import { deriveBodyAnchors, isDurablePublicImageUrl, redactEvidenceUrl } from './publication-verifier.mjs';

const anchors = deriveBodyAnchors('<p>第一个用于公开验收的正文段落，长度足够。</p><p>第二个用于公开验收的正文段落，长度同样足够。</p>');
assert.equal(anchors.length, 2);
assert.equal(isDurablePublicImageUrl('http://127.0.0.1:1234/a.png'), false);
assert.equal(isDurablePublicImageUrl('blob:https://example.com/a'), false);
assert.equal(isDurablePublicImageUrl('https://read.useai.online/api/image-proxy?url=x'), false);
assert.equal(isDurablePublicImageUrl('https://img.example.com/a.png'), true);
assert.equal(isDurablePublicImageUrl('https://img.example.com/a.png?platform=1', ['https://img.example.com/a.png?source=1']), false);
assert.match(redactEvidenceUrl('https://example.com/a?id=1&access_token=secret'), /id=1/);
assert.doesNotMatch(redactEvidenceUrl('https://example.com/a?id=1&access_token=secret'), /secret/);
console.log('✅ publication verifier unit tests passed');
