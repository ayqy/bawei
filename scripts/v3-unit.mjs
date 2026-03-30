import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as ts from 'typescript';
import { chromium } from 'playwright';

function abs(p) {
  return path.resolve(process.cwd(), p);
}

function stripModuleSyntax(code) {
  return String(code || '')
    .replace(/^\s*import[^;]*;?\s*$/gm, '')
    .replace(/^\s*export\s+(default\s+)?/gm, '');
}

function transpileTsToBrowserScript(filePath) {
  const tsCode = fs.readFileSync(filePath, 'utf8');
  const out = ts.transpileModule(tsCode, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ES2020,
    },
  }).outputText;
  return stripModuleSyntax(out).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assert failed');
}

async function testBuildRichContentTokens(page) {
  const contentHtml = `
    <p>第一段</p>
    <img data-src="https://mmbiz.qpic.cn/mmbiz_png/abc/0?wx_fmt=png" alt="a" />
    <p>第二段</p>
    <img src="https://mmbiz.qpic.cn/mmbiz_jpg/def/0?wx_fmt=jpg" />
    <p>第三段</p>
  `;
  const sourceUrl = 'https://mp.weixin.qq.com/s/TEST_SOURCE_URL';

  const tokens = await page.evaluate(
    ({ contentHtml, sourceUrl }) => {
      return buildRichContentTokens({ contentHtml, baseUrl: sourceUrl, sourceUrl });
    },
    { contentHtml, sourceUrl }
  );

  assert(Array.isArray(tokens), 'tokens should be an array');
  assert(tokens.length >= 5, 'tokens length should be >= 5');
  assert(tokens.some((t) => t.kind === 'image'), 'tokens should contain image tokens');
  const images = tokens.filter((t) => t.kind === 'image');
  assert(images.length === 2, 'should extract 2 images');
  assert(String(images[0].src || '').includes('mmbiz_png'), 'first image should use data-src');
  assert(String(images[1].src || '').includes('mmbiz_jpg'), 'second image should use src');

  const last = tokens[tokens.length - 1];
  assert(last.kind === 'html', 'last token should be html');
  assert(String(last.html || '').includes(sourceUrl), 'last token should contain sourceUrl');
}

async function testBuildRichContentTokensSplitBlocks(page) {
  const contentHtml = `
    <h2>主标题</h2>
    <p>第一段</p>
    <div><p>第二段</p><blockquote>引用块</blockquote></div>
    <img src="https://mmbiz.qpic.cn/mmbiz_jpg/split/0?wx_fmt=jpg" />
    <section><p>第三段</p></section>
  `;
  const sourceUrl = 'https://mp.weixin.qq.com/s/SPLIT_BLOCKS';

  const tokens = await page.evaluate(
    ({ contentHtml, sourceUrl }) => {
      return buildRichContentTokens({ contentHtml, baseUrl: sourceUrl, sourceUrl, htmlMode: 'raw', splitBlocks: true });
    },
    { contentHtml, sourceUrl }
  );

  assert(Array.isArray(tokens), 'splitBlocks tokens should be an array');
  assert(tokens.length >= 6, 'splitBlocks tokens length should be >= 6');
  assert(tokens[0].kind === 'html' && String(tokens[0].html || '').includes('<h2>主标题</h2>'), 'first token should keep h2 block');
  assert(tokens[1].kind === 'html' && String(tokens[1].html || '').includes('<p>第一段</p>'), 'second token should keep first paragraph');
  assert(tokens[2].kind === 'html' && String(tokens[2].html || '').includes('<p>第二段</p>'), 'third token should split nested paragraph');
  assert(tokens[3].kind === 'html' && String(tokens[3].html || '').includes('<blockquote>引用块</blockquote>'), 'fourth token should split blockquote');
  assert(tokens.some((t) => t.kind === 'image'), 'splitBlocks tokens should contain image token');
}

async function testFillEditorByTokensWithImage(page) {
  await page.setContent(`
    <html>
      <body>
        <div id="editor" contenteditable="true" style="min-height:120px;border:1px solid #ddd;padding:8px;"></div>
      </body>
    </html>
  `);

  await page.evaluate(() => {
    const editor = document.querySelector('#editor');
    if (!editor) throw new Error('missing editor');

    const insertImageFromFile = (file) => {
      const img = document.createElement('img');
      img.alt = 'unit';
      try {
        img.src = URL.createObjectURL(file);
      } catch {
        img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ZqCsAAAAASUVORK5CYII=';
      }
      editor.appendChild(img);
    };

    editor.addEventListener('paste', (e) => {
      const dt = e.clipboardData;
      const file = dt?.files?.[0];
      if (file) insertImageFromFile(file);
    });

    editor.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const file = dt?.files?.[0];
      if (file) insertImageFromFile(file);
    });
  });

  const tokens = [
    { kind: 'html', html: '<p>Hello</p>' },
    { kind: 'image', src: 'https://mmbiz.qpic.cn/unit-test.png' },
    { kind: 'html', html: '<p>World</p>' },
  ];

  await page.evaluate(async (tokens) => {
    const editorRoot = document.querySelector('#editor');
    if (!editorRoot) throw new Error('missing editor');
    await fillEditorByTokens({ jobId: 'unit-job', tokens, editorRoot, writeMode: 'html' });
  }, tokens);

  const result = await page.evaluate(() => {
    const editor = document.querySelector('#editor');
    if (!editor) return { ok: false };
    return {
      ok: true,
      text: String(editor.textContent || ''),
      imgCount: editor.querySelectorAll('img').length,
      html: editor.innerHTML,
    };
  });

  assert(result.ok, 'editor result should be ok');
  assert(result.text.includes('Hello') && result.text.includes('World'), 'editor should contain text');
  assert(result.imgCount >= 1, 'editor should contain at least 1 img');
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('about:blank');

  const publishVerify = transpileTsToBrowserScript(abs('src/shared/publish-verify.ts'));
  const events = transpileTsToBrowserScript(abs('src/shared/events.ts'));
  const richContent = transpileTsToBrowserScript(abs('src/shared/rich-content.ts'));
  const imageBridge = transpileTsToBrowserScript(abs('src/shared/image-bridge.ts'));

  const png1x1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ZqCsAAAAASUVORK5CYII=';

  await page.addScriptTag({ content: publishVerify });
  await page.addScriptTag({ content: events });
  await page.addScriptTag({ content: richContent });
  await page.addScriptTag({
    content: `
      const V3_FETCH_IMAGE = 'V3_FETCH_IMAGE';
      const __BAWEI_V3_PNG_1x1_BASE64 = '${png1x1}';
      const __BAWEI_V3_PNG_BUF = Uint8Array.from(atob(__BAWEI_V3_PNG_1x1_BASE64), c => c.charCodeAt(0)).buffer;
      window.chrome = window.chrome || {};
      window.chrome.runtime = {
        sendMessage: async (msg) => {
          if (!msg || msg.type !== V3_FETCH_IMAGE) return { success: false, error: 'unknown message' };
          return { success: true, mimeType: 'image/png', buffer: __BAWEI_V3_PNG_BUF, size: __BAWEI_V3_PNG_BUF.byteLength };
        }
      };
    `,
  });
  await page.addScriptTag({ content: imageBridge });

  await testBuildRichContentTokens(page);
  await testBuildRichContentTokensSplitBlocks(page);
  await testFillEditorByTokensWithImage(page);

  await browser.close();
  console.log('✅ v3 unit tests passed');
}

main().catch((e) => {
  console.error('❌ v3 unit tests failed:', e);
  process.exit(1);
});
