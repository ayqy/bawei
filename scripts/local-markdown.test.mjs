import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareLocalMarkdown } from './local-markdown.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bawei-markdown-test-'));
const pngPath = path.join(tempDir, 'pixel.png');
const markdownPath = path.join(tempDir, 'article.md');
const fallbackPath = path.join(tempDir, 'fallback.md');

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
    assert.match(fallback.article.sourceUrl, /^http:\/\/127\.0\.0\.1:\d+\/source\/fallback\.md$/);
  } finally {
    await fallback.close();
  }

  console.log('✅ local markdown unit tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
