import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildChannelContentHash,
  extractChannelVariants,
  prepareLocalMarkdown,
  validateWoshipmVariant,
} from './local-markdown.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bawei-markdown-test-'));
const pngPath = path.join(tempDir, 'pixel.png');
const markdownPath = path.join(tempDir, 'article.md');
const fallbackPath = path.join(tempDir, 'fallback.md');
const variantPath = path.join(tempDir, 'variant.md');

try {
  fs.writeFileSync(
    pngPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  );
  fs.writeFileSync(
    markdownPath,
    [
      '---',
      'title: 本地发布测试',
      'source_url: https://example.com/posts/local-test',
      '---',
      '# 本地发布测试',
      '',
      '正文。',
      '',
      '![像素](./pixel.png)'
    ].join('\n')
  );
  fs.writeFileSync(fallbackPath, '# 文件标题\n\n没有公开原文链接的正文。\n');
  fs.writeFileSync(
    variantPath,
    [
      '# 默认标题',
      '',
      '默认正文。',
      '',
      '<!-- bawei:variant woshipm -->',
      '# 产品决策复盘',
      '',
      '## 用户问题',
      '真实问题场景。',
      '',
      '## 产品决策',
      '为什么这样设计。',
      '',
      '## 取舍',
      '说明权衡。',
      '',
      '## 适用边界',
      '不适合的情况。',
      '',
      '## 可复用洞察',
      '可复用的方法论。',
      '<!-- /bawei:variant -->',
    ].join('\n')
  );

  const prepared = await prepareLocalMarkdown(markdownPath);
  try {
    assert.equal(prepared.article.title, '本地发布测试');
    assert.equal(prepared.article.sourceUrl, 'https://example.com/posts/local-test');
    assert.equal(prepared.hasDurableSourceUrl, true);
    assert.equal(prepared.assetCount, 1);
    assert.equal(
      (prepared.article.contentHtml.match(/<h1/g) || []).length,
      0,
      '作为标题的首个 H1 不应在正文重复'
    );

    const imageUrl = prepared.article.contentHtml.match(
      /src="(http:\/\/127\.0\.0\.1:\d+\/assets\/[^"]+)"/
    )?.[1];
    assert.ok(imageUrl, '本地图片应转换为受控 loopback URL');
    const imageResponse = await fetch(imageUrl);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.ok((await imageResponse.arrayBuffer()).byteLength > 0);
  } finally {
    await prepared.close();
  }

  const fallback = await prepareLocalMarkdown(fallbackPath);
  try {
    assert.equal(fallback.article.title, '文件标题');
    assert.equal(fallback.hasDurableSourceUrl, false);
    assert.equal(fallback.article.sourceUrl, '');
    assert.doesNotMatch(fallback.article.contentHtml, /127\.0\.0\.1/);
  } finally {
    await fallback.close();
  }

  const variant = await prepareLocalMarkdown(variantPath);
  try {
    assert.equal(variant.channelArticles.csdn.article.title, '默认标题');
    assert.equal(variant.channelArticles.woshipm.article.title, '产品决策复盘');
    assert.notEqual(variant.channelArticles.csdn.contentHash, variant.channelArticles.woshipm.contentHash);
    assert.equal(validateWoshipmVariant(variant.variants.woshipm), true);
    const parsed = extractChannelVariants(fs.readFileSync(variantPath, 'utf8'));
    assert.ok(parsed.variants.woshipm);
  } finally {
    await variant.close();
  }

  const stableA = buildChannelContentHash({
    channelId: 'csdn',
    title: '标题',
    markdown: '正文\r\n',
    imageDigests: ['a'],
    sourceUrl: '',
  });
  const stableB = buildChannelContentHash({
    channelId: 'csdn',
    title: '标题',
    markdown: '正文\n',
    imageDigests: ['a'],
    sourceUrl: '',
  });
  assert.equal(stableA, stableB, '换行符和尾部空白不应改变渠道内容哈希');

  console.log('✅ local markdown unit tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
