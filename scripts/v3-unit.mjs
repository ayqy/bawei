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
      module: ts.ModuleKind.ES2020
    }
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
  assert(
    tokens.some((t) => t.kind === 'image'),
    'tokens should contain image tokens'
  );
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
      return buildRichContentTokens({
        contentHtml,
        baseUrl: sourceUrl,
        sourceUrl,
        htmlMode: 'raw',
        splitBlocks: true
      });
    },
    { contentHtml, sourceUrl }
  );

  assert(Array.isArray(tokens), 'splitBlocks tokens should be an array');
  assert(tokens.length >= 6, 'splitBlocks tokens length should be >= 6');
  assert(
    tokens[0].kind === 'html' && String(tokens[0].html || '').includes('<h2>主标题</h2>'),
    'first token should keep h2 block'
  );
  assert(
    tokens[1].kind === 'html' && String(tokens[1].html || '').includes('<p>第一段</p>'),
    'second token should keep first paragraph'
  );
  assert(
    tokens[2].kind === 'html' && String(tokens[2].html || '').includes('<p>第二段</p>'),
    'third token should split nested paragraph'
  );
  assert(
    tokens[3].kind === 'html' &&
      String(tokens[3].html || '').includes('<blockquote>引用块</blockquote>'),
    'fourth token should split blockquote'
  );
  assert(
    tokens.some((t) => t.kind === 'image'),
    'splitBlocks tokens should contain image token'
  );
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
        img.src =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ZqCsAAAAASUVORK5CYII=';
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
    { kind: 'html', html: '<p>World</p>' }
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
      html: editor.innerHTML
    };
  });

  assert(result.ok, 'editor result should be ok');
  assert(
    result.text.includes('Hello') && result.text.includes('World'),
    'editor should contain text'
  );
  assert(result.imgCount >= 1, 'editor should contain at least 1 img');
}

async function testVisibleLoginSignals(page) {
  await page.setContent(`
    <div>创作中心 退出登录</div>
    <input type="password" style="display:none" />
  `);
  const hiddenPassword = await page.evaluate(() => detectPageLoginState());
  assert(
    hiddenPassword.status === 'logged_in',
    'hidden password input must not be treated as logged out'
  );

  await page.setContent(`
    <button>登录</button>
    <input type="password" style="display:block;width:200px;height:30px" />
  `);
  const visiblePassword = await page.evaluate(() => detectPageLoginState());
  assert(
    visiblePassword.status === 'not_logged_in',
    'visible password form must be treated as logged out'
  );
}

async function testPublishOutcomeAndImageStability(page) {
  const result = await page.evaluate(() => ({
    pending: classifySubmittedPublishPage({
      pageText: '文章审核中',
      pendingPatterns: ['审核中'],
      rejectedPatterns: ['未通过']
    }),
    rejected: classifySubmittedPublishPage({
      pageText: '审核未通过，文章已退回',
      pendingPatterns: ['审核中'],
      rejectedPatterns: ['未通过']
    }),
    loopback: isTransientImageUrl('http://127.0.0.1:1234/a.png'),
    proxy: isTransientImageUrl('https://read.useai.online/api/image-proxy?url=x'),
    hosted: isPlatformHostedImageUrl(
      'https://cdn.example.com/a.png',
      'https://source.example.com/a.png'
    )
  }));
  assert(result.pending.status === 'pending_review', 'reviewing content should be pending_review');
  assert(result.rejected.status === 'rejected', 'rejected content should be rejected');
  assert(result.loopback && result.proxy, 'loopback and proxy images should be transient');
  assert(result.hosted, 'platform-hosted image should be accepted');
}

async function testOschinaLegacyRuntimeRecovery(page) {
  const polyfillSource = `
    window.System = {
      import: async (src) => {
        const comma = String(src || '').indexOf(',');
        if (comma < 0) throw new Error('invalid legacy entry data url');
        const code = decodeURIComponent(String(src).slice(comma + 1));
        (0, eval)(code);
        return {};
      }
    };
  `;
  const entrySource = `
    const title = document.createElement('input');
    title.name = 'title';
    title.placeholder = '文章标题';
    const editor = document.createElement('div');
    editor.className = 'tiptap ProseMirror aie-content';
    editor.setAttribute('role', 'textbox');
    editor.contentEditable = 'true';
    editor.editor = { commands: { focus() { return true; } } };
    document.body.append(title, editor);
  `;
  const polyfillUrl = `data:text/javascript,${encodeURIComponent(polyfillSource)}`;
  const entryUrl = `data:text/javascript,${encodeURIComponent(entrySource)}`;
  await page.setContent(`
    <div id="bawei-oschina-editor-bridge" hidden></div>
    <script id="vite-legacy-polyfill" type="application/x-bawei-disabled" crossorigin src="${polyfillUrl}"></script>
    <script id="vite-legacy-entry" type="application/x-bawei-disabled" crossorigin data-src="${entryUrl}"></script>
  `);
  const bridgeSource = fs.readFileSync(abs('src/assets/oschina-page-bridge.js'), 'utf8');
  await page.addScriptTag({ content: bridgeSource });
  const result = await page.evaluate(async () => {
    const bridge = document.querySelector('#bawei-oschina-editor-bridge');
    if (!(bridge instanceof HTMLElement)) throw new Error('missing bridge');
    const payload = {
      requestId: 'oschina-legacy-unit',
      command: 'ensure-editor'
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    bridge.setAttribute('data-bawei-request-id', payload.requestId);
    bridge.setAttribute('data-bawei-request', btoa(binary));
    bridge.dispatchEvent(new Event('bawei:oschina-editor-command'));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (bridge.getAttribute('data-bawei-result-id') === payload.requestId) {
        return JSON.parse(bridge.getAttribute('data-bawei-result') || '{}');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('OSCHINA legacy recovery unit timeout');
  });
  assert(result.ok === true, `OSCHINA legacy recovery failed: ${JSON.stringify(result)}`);
  assert(result.recoveredLegacyRuntime === true, 'OSCHINA should report legacy runtime recovery');
  const recovered = await page.evaluate(() => ({
    system: typeof window.System,
    title: !!document.querySelector('input[name="title"]'),
    editor: !!document.querySelector('.tiptap.ProseMirror.aie-content')
  }));
  assert(
    recovered.system === 'object' && recovered.title && recovered.editor,
    `OSCHINA recovered runtime incomplete: ${JSON.stringify(recovered)}`
  );
}

function testFeishuBlankDocumentRecoveryContract() {
  const publisher = fs.readFileSync(abs('src/content/feishu-docs-publisher.ts'), 'utf8');
  const liveRunner = fs.readFileSync(abs('scripts/live-publish-chrome-cdp.mjs'), 'utf8');
  const ensureBodyStart = publisher.indexOf('async function ensureFeishuBodyEditor');
  const ensureBodyEnd = publisher.indexOf('type FeishuDocumentEvidence', ensureBodyStart);
  const ensureBody = publisher.slice(ensureBodyStart, ensureBodyEnd);

  assert(
    ensureBody.includes("document.querySelector<HTMLElement>('.page-block-children')"),
    'Feishu blank document recovery must target the empty body surface'
  );
  assert(
    ensureBody.includes('simulateClick(bodySurface)'),
    'Feishu content publisher must click the blank body surface'
  );
  assert(
    !ensureBody.includes("document.execCommand('insertParagraph'"),
    'Feishu blank document recovery must not insert a paragraph from the title'
  );
  assert(
    liveRunner.includes("const bodySurface = page.locator('.page-block-children').first()"),
    'Feishu trusted recovery must locate the blank body surface'
  );
  assert(
    liveRunner.includes('await page.mouse.click('),
    'Feishu trusted recovery must use a real pointer click'
  );
  assert(
    !liveRunner.includes("await page.keyboard.press('Meta+ArrowDown')"),
    'Feishu trusted recovery must not navigate from the title with Meta+ArrowDown'
  );
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
    `
  });
  await page.addScriptTag({ content: imageBridge });

  await testBuildRichContentTokens(page);
  await testBuildRichContentTokensSplitBlocks(page);
  await testFillEditorByTokensWithImage(page);
  await testVisibleLoginSignals(page);
  await testPublishOutcomeAndImageStability(page);
  await testOschinaLegacyRuntimeRecovery(page);
  testFeishuBlankDocumentRecoveryContract();

  await browser.close();
  console.log('✅ v3 unit tests passed');
}

main().catch((e) => {
  console.error('❌ v3 unit tests failed:', e);
  process.exit(1);
});
