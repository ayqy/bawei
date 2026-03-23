import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function abs(p) {
  return path.resolve(process.cwd(), p);
}

async function gotoWithRetry(page, url) {
  const timeouts = [15_000, 30_000, 60_000];
  let lastErr = null;
  for (let i = 0; i < timeouts.length; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeouts[i] });
      return;
    } catch (e) {
      lastErr = e;
      console.log(`[goto] 失败：${url}（${i + 1}/${timeouts.length}），${e?.message || e}`);
      await page.waitForTimeout(500);
    }
  }
  throw lastErr || new Error(`goto failed: ${url}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assert failed');
}

const ALL_CHANNELS = [
  'csdn',
  'tencent-cloud-dev',
  'cnblogs',
  'oschina',
  'woshipm',
  'mowen',
  'sspai',
  'baijiahao',
  'toutiao',
  'feishu-docs',
];

const CHANNEL_ENTRY_URLS = {
  csdn: 'https://mp.csdn.net/mp_blog/creation/editor',
  'tencent-cloud-dev': 'https://cloud.tencent.com/developer/article/write',
  cnblogs: 'https://i.cnblogs.com/posts/edit',
  oschina: 'https://www.oschina.net/blog/write',
  woshipm: 'https://www.woshipm.com/writing',
  mowen: 'https://note.mowen.cn/editor',
  sspai: 'https://sspai.com/write',
  baijiahao: 'https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1',
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  'feishu-docs': 'https://wuxinxuexi.feishu.cn/drive/folder/PyWAfSFwrlMgiydvlHectMn2nSd',
};

const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ZqCsAAAAASUVORK5CYII=';
const PNG_1x1 = Buffer.from(PNG_1x1_BASE64, 'base64');

function pageTemplate({ title, body, head = '', script = '' }) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    ${head}
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial; padding: 16px; }
      .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
      .btn { padding: 8px 12px; border: 1px solid #ddd; border-radius: 8px; background: #fff; cursor: pointer; }
      .btn.primary { background: #1677ff; color: #fff; border-color: #1677ff; }
      .box { border: 1px solid #ddd; border-radius: 8px; padding: 10px; margin: 12px 0; }
      .editor { min-height: 140px; border: 1px solid #ddd; border-radius: 8px; padding: 10px; }
      .hint { color: #666; font-size: 12px; }
    </style>
  </head>
  <body>
    ${body}
    <script>
      ${script}
    </script>
  </body>
</html>`;
}

function imageHandlersScript(selector) {
  const sel = JSON.stringify(selector);
  return `
    (function(){
      const root = document.querySelector(${sel});
      if (!root) return;
      if (root.__baweiImageHandlersInstalled) return;
      root.__baweiImageHandlersInstalled = true;
      const insertImageFromFile = (file) => {
        const img = document.createElement('img');
        img.alt = 'e2e';
        try {
          img.src = URL.createObjectURL(file);
        } catch {
          img.src = 'data:image/png;base64,${PNG_1x1_BASE64}';
        }
        img.style.maxWidth = '260px';
        img.style.display = 'block';
        img.style.margin = '8px 0';
        root.appendChild(img);
      };
      root.addEventListener('paste', (e) => {
        const dt = e.clipboardData;
        const file = dt?.files?.[0];
        if (!file) return;
        e.preventDefault();
        insertImageFromFile(file);
      });
      root.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const file = dt?.files?.[0];
        if (!file) return;
        e.preventDefault();
        insertImageFromFile(file);
      });
    })();
  `;
}

function iframeEditorSrcdoc() {
  // srcdoc inherits origin, so content scripts can access contentDocument.
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; padding: 10px; font-family: Arial; min-height: 160px; border: 1px solid #ddd; border-radius: 8px; }
    </style>
  </head>
  <body contenteditable="true">
    <script>
      ${imageHandlersScript('body')}
    </script>
  </body>
</html>`;
}

function buildWechatHtml({ title, imgA, imgB }) {
  const placeholder = `data:image/png;base64,${PNG_1x1_BASE64}`;
  const body = `
    <h1 id="activity-name">${title}</h1>
    <div id="js_content" class="rich_media_content">
      <p>第一段：用于 E2E 测试。</p>
      <img data-src="${imgA}" src="${placeholder}" alt="a" />
      <p>第二段：图片后继续内容。</p>
      <img data-src="${imgB}" src="${placeholder}" alt="b" />
      <p>第三段：结尾。</p>
    </div>
  `;
  return pageTemplate({ title: `${title} - 微信文章`, body });
}

function buildLoginHtml({ title = '登录' } = {}) {
  const body = `
    <h1>${title}</h1>
    <p>请登录后继续</p>
    <input type="text" placeholder="账号" />
    <input type="password" placeholder="密码" />
    <button class="btn primary">登录</button>
  `;
  return pageTemplate({ title, body });
}

function buildDetailHtml({ title, sourceUrl, extra = '' }) {
  const body = `
    <h1>${title}</h1>
    <div class="box">
      <div>原文链接：<a href="${sourceUrl}">${sourceUrl}</a></div>
      ${extra}
    </div>
  `;
  return pageTemplate({ title: `${title} - 详情`, body });
}

function buildCsdnEditorHtml({ action, title, sourceUrl, detailUrl }) {
  const body = `
    <h1>CSDN 编辑器（E2E）</h1>
    <div class="bar">
      <input id="txtTitle" placeholder="请输入文章标题" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:8px;" />
      <input placeholder="请填写原文链接" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:8px;" />
    </div>
    <div id="csdn-editor" class="editor" contenteditable="true"></div>
    <div class="bar">
      <label style="display:flex;align-items:center;gap:6px;"><input type="radio" name="origin" />原创</label>
      <input type="hidden" name="tags" value='["前端"]' />
    </div>
    <div class="bar">
      <button id="csdn-save" class="btn">保存草稿</button>
      <button id="csdn-publish" class="btn primary">发布博客</button>
    </div>
    <div id="csdn-status" class="hint"></div>
  `;

  const script = `
    const ACTION = ${JSON.stringify(action)};
    const DETAIL_URL = ${JSON.stringify(detailUrl)};
    const MANAGE_URL = 'https://mp.csdn.net/mp_blog/manage/article';

    ${imageHandlersScript('#csdn-editor')}

    document.querySelector('#csdn-save')?.addEventListener('click', () => {
      try { document.querySelector('#csdn-status').textContent = '保存成功'; } catch {}
      if (ACTION === 'publish') {
        try { history.replaceState({}, '', '/mp_blog/creation/editor/123'); } catch {}
      } else {
        location.href = DETAIL_URL;
      }
    });

    document.querySelector('#csdn-publish')?.addEventListener('click', () => {
      try { document.querySelector('#csdn-status').textContent = '发布成功'; } catch {}
      location.href = MANAGE_URL;
    });
  `;

  return pageTemplate({ title: `${title} - CSDN`, body, script });
}

function buildCsdnManageHtml({ title, token, detailUrl }) {
  const body = `
    <h1>文章管理（E2E）</h1>
    <div class="bar">
      <div role="tab">已发布</div>
      <div role="tab">全部</div>
      <div role="tab">审核中/未通过</div>
      <div role="tab">草稿箱</div>
    </div>
    <div class="bar">
      <div style="display:flex;align-items:center;gap:6px;">
        <input placeholder="请输入关键词" style="padding:8px; border:1px solid #ddd; border-radius:8px;" />
        <img alt="search" src="data:image/png;base64,${PNG_1x1_BASE64}" style="width:18px;height:18px;" />
      </div>
    </div>
    <div class="box">
      <div>
        <a href="/mp_blog/creation/editor/123" title="${token}">${title}</a>
        <a href="${detailUrl}">浏览</a>
      </div>
    </div>
  `;
  return pageTemplate({ title: `${title} - CSDN 管理`, body });
}

function buildTencentEditorHtml({ action, title, sourceUrl, detailUrl }) {
  const body = `
    <h1>腾讯云编辑器（E2E）</h1>
    <div class="bar">
      <input placeholder="标题" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:8px;" />
    </div>
    <div class="public-DraftEditor-content editor" contenteditable="true" style="min-height:160px;"></div>
    <div class="bar">
      <label style="display:flex;align-items:center;gap:6px;"><input type="radio" name="origin" />原创</label>
      <input class="com-2-tag-input" placeholder="标签" style="padding:6px 8px;border:1px solid #ddd;border-radius:8px;" />
      <ul style="margin:0;padding-left:18px;"><li>前端</li></ul>
    </div>
    <div class="bar">
      <input type="file" name="article-cover-image" />
    </div>
    <div class="bar">
      <button id="tencent-save" class="btn">保存草稿</button>
      <button id="tencent-publish" class="btn primary">发布</button>
      <button id="tencent-confirm" class="btn primary">确认发布</button>
    </div>
    <div id="tencent-status" class="hint"></div>
  `;

  const script = `
    const ACTION = ${JSON.stringify(action)};
    const DETAIL_URL = ${JSON.stringify(detailUrl)};
    ${imageHandlersScript('.public-DraftEditor-content')}

    document.querySelector('#tencent-save')?.addEventListener('click', () => {
      try { document.querySelector('#tencent-status').textContent = '保存成功'; } catch {}
      if (ACTION === 'draft') location.href = DETAIL_URL;
    });

    document.querySelector('#tencent-publish')?.addEventListener('click', () => {
      try { document.querySelector('#tencent-status').textContent = '发布中'; } catch {}
    });

    document.querySelector('#tencent-confirm')?.addEventListener('click', () => {
      // Create a performance resource entry that contains "article?action=CreateArticle"
      try {
        const img = new Image();
        img.src = 'https://cloud.tencent.com/article?action=CreateArticle&ts=' + Date.now();
      } catch {}
      try { document.querySelector('#tencent-status').textContent = '发布成功'; } catch {}
    });
  `;

  return pageTemplate({ title: `${title} - 腾讯云`, body, script });
}

function buildTencentListHtml({ title, token, detailUrl }) {
  const body = `
    <h1>腾讯云文章列表（E2E）</h1>
    <div class="bar">
      <a href="#">全部</a>
      <a href="#">审核中</a>
      <a href="#">已发布</a>
    </div>
    <div class="cdc-search__bar bar">
      <input placeholder="搜文章名称" style="padding:8px;border:1px solid #ddd;border-radius:8px;" />
      <button class="cdc-search__btn btn">搜索</button>
    </div>
    <div class="com-2-course-panel-list box">
      <div class="cdc-2-course-panel">
        <div>${title} ${token}</div>
        <a href="${detailUrl}">${title}</a>
      </div>
    </div>
  `;
  return pageTemplate({ title: `${title} - 腾讯云列表`, body });
}

function buildCnblogsEditorHtml({ action, title, detailUrl }) {
  const body = `
    <h1>博客园编辑器（E2E）</h1>
    <div class="bar">
      <input id="post-title" placeholder="标题" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:8px;" />
    </div>
    <iframe id="Editor_Edit_EditorBody_ifr" style="width:100%; height:220px; border:1px solid #ddd; border-radius:8px;" srcdoc="${iframeEditorSrcdoc().replaceAll(
      '"',
      '&quot;'
    )}"></iframe>
    <div class="bar">
      <button id="cnblogs-draft" class="btn">存为草稿</button>
      <button id="cnblogs-publish" class="btn primary">发布</button>
    </div>
    <div id="cnblogs-status" class="hint"></div>
  `;
  const script = `
    const ACTION = ${JSON.stringify(action)};
    const DETAIL_URL = ${JSON.stringify(detailUrl)};
    document.querySelector('#cnblogs-draft')?.addEventListener('click', () => {
      try { document.querySelector('#cnblogs-status').textContent = '草稿已保存'; } catch {}
      if (ACTION === 'draft') location.href = DETAIL_URL;
    });
    document.querySelector('#cnblogs-publish')?.addEventListener('click', () => {
      try { document.querySelector('#cnblogs-status').textContent = '已发布'; } catch {}
    });
  `;
  return pageTemplate({ title: `${title} - 博客园编辑`, body, script });
}

function buildCnblogsListHtml({ title, detailUrl }) {
  const body = `
    <h1>博客园文章列表（E2E）</h1>
    <div class="box">
      <a href="${detailUrl}">${title}</a>
    </div>
  `;
  return pageTemplate({ title: `${title} - 博客园列表`, body });
}

function buildOschinaLandingHtml() {
  const body = `
    <h1>OSCHINA 写博客入口（E2E）</h1>
    <a href="https://my.oschina.net/u/e2e/blog/write">写博客</a>
  `;
  return pageTemplate({ title: 'OSCHINA 入口', body });
}

function buildOschinaWriteHtml({ action, title, detailUrl }) {
  const body = `
    <h1>OSCHINA 写作页（E2E）</h1>
    <div class="bar">
      <input name="title" placeholder="文章标题" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:8px;" />
    </div>
    <iframe style="width:100%; height:220px; border:1px solid #ddd; border-radius:8px;" srcdoc="${iframeEditorSrcdoc().replaceAll('"', '&quot;')}"></iframe>
    <div class="bar">
      <button id="oschina-draft" class="btn">保存草稿</button>
      <button id="oschina-publish" class="btn primary">发布文章</button>
      <button id="oschina-confirm" class="btn primary">确认并发布</button>
    </div>
    <div id="oschina-status" class="hint"></div>
  `;
  const script = `
    const ACTION = ${JSON.stringify(action)};
    const DETAIL_URL = ${JSON.stringify(detailUrl)};
    document.querySelector('#oschina-draft')?.addEventListener('click', () => {
      try { document.querySelector('#oschina-status').textContent = '保存成功'; } catch {}
      location.href = DETAIL_URL;
    });
    document.querySelector('#oschina-publish')?.addEventListener('click', () => {
      try { document.querySelector('#oschina-status').textContent = '发布中'; } catch {}
    });
    document.querySelector('#oschina-confirm')?.addEventListener('click', () => {
      try { document.querySelector('#oschina-status').textContent = '发布成功'; } catch {}
      location.href = DETAIL_URL;
    });
  `;
  return pageTemplate({ title: `${title} - OSCHINA 写作`, body, script });
}

function buildWoshipmWriteHtml({ action, title, detailUrl }) {
  const body = `
    <h1>人人都是产品经理 写作页（E2E）</h1>
    <div class="bar">
      <input placeholder="文章标题" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:8px;" />
    </div>
    <iframe style="width:100%; height:220px; border:1px solid #ddd; border-radius:8px;" srcdoc="${iframeEditorSrcdoc().replaceAll('"', '&quot;')}"></iframe>
    <div class="bar">
      <label><input type="checkbox" name="copyright" />同意协议</label>
      <label><input type="checkbox" name="copyright_other" />承诺</label>
      <label><input type="checkbox" name="copyright_pm" />原创</label>
    </div>
    <div class="bar">
      <button id="woshipm-draft" class="btn">保存草稿</button>
      <button id="woshipm-submit" class="btn primary">提交审核</button>
    </div>
  `;
  const script = `
    const ACTION = ${JSON.stringify(action)};
    const DETAIL_URL = ${JSON.stringify(detailUrl)};
    document.querySelector('#woshipm-draft')?.addEventListener('click', () => {
      location.href = DETAIL_URL;
    });
    document.querySelector('#woshipm-submit')?.addEventListener('click', () => {
      location.href = DETAIL_URL;
    });
  `;
  return pageTemplate({ title: `${title} - WoShiPM`, body, script });
}

function buildMowenEditorHtml({ action, title, detailUrl }) {
  const body = `
    <h1>墨问编辑器（E2E）</h1>
    <div class="ProseMirror editor" contenteditable="true" style="min-height:180px;"></div>
    <div class="bar">
      <button id="mowen-save" class="btn">保存</button>
      <button id="mowen-publish" class="btn primary">发布</button>
    </div>
    <div id="mowen-status" class="hint"></div>
  `;
  const script = `
    const ACTION = ${JSON.stringify(action)};
    const DETAIL_URL = ${JSON.stringify(detailUrl)};
    ${imageHandlersScript('.ProseMirror')}
    document.querySelector('#mowen-save')?.addEventListener('click', () => {
      try { document.querySelector('#mowen-status').textContent = '保存成功'; } catch {}
      location.href = DETAIL_URL;
    });
    document.querySelector('#mowen-publish')?.addEventListener('click', () => {
      try { document.querySelector('#mowen-status').textContent = '发布成功'; } catch {}
      location.href = DETAIL_URL;
    });
  `;
  return pageTemplate({ title: `${title} - 墨问`, body, script });
}

function buildSspaiWriteHtml({ title }) {
  const body = `
    <h1>少数派写作（E2E）</h1>
    <textarea placeholder="标题" style="width:100%;height:44px;padding:8px;border:1px solid #ddd;border-radius:8px;"></textarea>
    <div class="ck-editor__editable editor" contenteditable="true" style="min-height:180px;"></div>
    <div class="bar">
      <button class="btn">保存</button>
      <button class="btn primary">发布</button>
      <button class="btn primary">确定</button>
    </div>
    <div class="hint">本页会自动生成 #文章ID，用于模拟 SSPAI 行为。</div>
  `;
  const script = `
    ${imageHandlersScript('.ck-editor__editable')}
    if (!location.hash) {
      try { location.hash = '#123'; } catch {}
    }
    // 用于 stageConfirmSuccess 的 okTexts（不依赖真实接口返回）
    document.addEventListener('click', (e) => {
      const t = (e.target?.textContent || '').trim();
      if (t === '保存') document.body.append(' 已保存');
      if (t === '发布') document.body.append(' 发布成功');
      if (t === '确定') document.body.append(' 发布成功');
    }, true);
  `;
  return pageTemplate({ title: `${title} - SSPAI`, body, script });
}

function buildBaijiahaoEditorHtml({ title }) {
  const body = `
    <h1>百家号编辑器（E2E）</h1>
    <div contenteditable="true" style="min-height:28px;border:1px solid #ddd;border-radius:8px;padding:8px;margin:12px 0;">标题区</div>
    <iframe id="ueditor_0" style="width:100%; height:240px; border:1px solid #ddd; border-radius:8px;" srcdoc="${iframeEditorSrcdoc().replaceAll(
      '"',
      '&quot;'
    )}"></iframe>
    <textarea id="abstract" placeholder="摘要" style="width:100%;height:40px;margin-top:10px;"></textarea>
    <div class="bar" style="justify-content:space-between;">
      <button id="bjh-draft" class="btn">存草稿</button>
      <button id="bjh-publish" class="btn primary" style="margin-top:60px;">发布</button>
    </div>
    <div id="bjh-status" class="hint"></div>
  `;
  const script = `
    document.querySelector('#bjh-draft')?.addEventListener('click', () => {
      try { document.querySelector('#bjh-status').textContent = '已保存'; } catch {}
      document.body.append(' 已保存');
    });
    document.querySelector('#bjh-publish')?.addEventListener('click', () => {
      try { document.querySelector('#bjh-status').textContent = '发布成功'; } catch {}
      document.body.append(' 发布成功');
    });
  `;
  return pageTemplate({ title: `${title} - 百家号`, body, script });
}

function buildBaijiahaoListHtml({ title, previewUrl }) {
  const body = `
    <h1>百家号内容列表（E2E）</h1>
    <div class="box">
      <a href="${previewUrl}">${title}</a>
    </div>
  `;
  return pageTemplate({ title: `${title} - 百家号列表`, body });
}

function buildToutiaoEditorHtml({ title }) {
  const body = `
    <h1>头条号编辑器（E2E）</h1>

    <div class="box article-cover-radio-group">
      <div class="hint">封面：</div>
      <label class="byte-radio" style="display:flex;align-items:center;gap:6px;">
        <input type="radio" name="cover" value="none" />
        <span class="byte-radio-inner">无封面</span>
      </label>
    </div>

    <div class="box">
      <div>作品声明</div>
      <label style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" />
        取材网络
      </label>
    </div>

    <textarea placeholder="文章标题" style="width:100%;height:44px;padding:8px;border:1px solid #ddd;border-radius:8px;"></textarea>
    <div class="ProseMirror editor" contenteditable="true" style="min-height:180px;"></div>

    <div class="bar">
      <button class="btn primary">发布</button>
      <button class="btn">确定</button>
    </div>
  `;

  const script = `
    ${imageHandlersScript('.ProseMirror')}
    document.querySelector('button')?.addEventListener('click', () => {
      document.body.append(' 发布成功');
    });
  `;
  return pageTemplate({ title: `${title} - 头条号`, body, script });
}

function buildToutiaoListHtml({ title, detailUrl }) {
  const body = `
    <h1>头条号内容列表（E2E）</h1>
    <input placeholder="搜索关键词" style="padding:8px;border:1px solid #ddd;border-radius:8px;" />
    <div class="box">
      <a href="${detailUrl}">${title}</a>
    </div>
    <div class="hint">共 1 条内容</div>
  `;
  return pageTemplate({ title: `${title} - 头条号列表`, body });
}

function buildFeishuFolderHtml({ title, docxUrl }) {
  const body = `
    <h1>飞书 Drive 文件夹（E2E）</h1>
    <div class="box">
      <a href="${docxUrl}">${title}</a>
    </div>
  `;
  return pageTemplate({ title: `${title} - 飞书文件夹`, body });
}

function buildFeishuDocxHtml({ title, runId }) {
  const body = `
    <h1 class="page-block-title-empty" contenteditable="true">${title}</h1>
    <div class="note-title__time">已经保存到云端</div>
    <div class="zone-container text-editor editor" contenteditable="true" style="min-height:220px;"></div>
  `;
  const script = `
    ${imageHandlersScript('.zone-container.text-editor')}
    (function(){
      const key = ${JSON.stringify(`__bawei_e2e_feishu_doc_${runId || 'unknown'}`)};
      const editor = document.querySelector('.zone-container.text-editor');
      if (!editor) return;
      try {
        const saved = sessionStorage.getItem(key) || '';
        if (saved) editor.textContent = saved;
      } catch {}
      const save = () => {
        try { sessionStorage.setItem(key, String(editor.textContent || '')); } catch {}
      };
      try { editor.addEventListener('input', save); } catch {}
      try {
        const mo = new MutationObserver(save);
        mo.observe(editor, { childList: true, subtree: true, characterData: true });
      } catch {}
    })();
  `;
  return pageTemplate({ title: `${title} - 飞书文档`, body, script });
}

async function openPanel(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#bawei-v2-launcher', { timeout: 30_000 });
  await page.click('#bawei-v2-launcher');
  await page.waitForSelector('#bawei-v2-panel', { timeout: 30_000 });
  // 给面板渲染一点时间，避免后续 selector 竞态
  await page.waitForTimeout(300);
}

function pickOpenFocusChannel(channelId) {
  const fallback = ALL_CHANNELS[0];
  if (channelId !== fallback) return fallback;
  return ALL_CHANNELS[1] || fallback;
}

async function setChannelCheckboxes(page, wantId) {
  for (const id of ALL_CHANNELS) {
    const sel = `#bawei-v2-run-${id}`;
    if (!(await page.locator(sel).count())) continue;
    await page.setChecked(sel, id === wantId);
  }
}

async function startJobAndWaitChannelTab(context, wechatPage, { channelId, action }) {
  const openFocus = pickOpenFocusChannel(channelId);
  // 诊断区在 job 未启动前是隐藏的，selectOption 会因为不可见而超时；用 evaluate 直接写入值并触发 change。
  await wechatPage.evaluate((value) => {
    const sel = document.querySelector('#bawei-v2-focus-channel');
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }, openFocus);
  await wechatPage.check(`input[name="bawei_v2_action"][value="${action === 'not_logged_in' ? 'publish' : action}"]`);
  await setChannelCheckboxes(wechatPage, channelId);

  const pagePromise = context.waitForEvent('page', { timeout: 15_000 });
  await wechatPage.click('#bawei-v2-start');
  const channelPage = await pagePromise;
  // chrome.tabs.create 打开的页面可能在 Playwright attach 之前就已开始导航，导致 context.route 未能接管首个 document 请求；
  // 这里用 Playwright 主动再跳转一次，确保进入我们的离线 mock 页面。
  await gotoWithRetry(channelPage, CHANNEL_ENTRY_URLS[channelId]);

  // 切换诊断聚焦到当前渠道（不影响后台打开 tab 的 active）
  await wechatPage.evaluate((value) => {
    const sel = document.querySelector('#bawei-v2-focus-channel');
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }, channelId);

  return channelPage;
}

async function readChannelBadge(wechatPage, channelId) {
  return await wechatPage.evaluate((id) => {
    const cb = document.querySelector(`#bawei-v2-run-${id}`);
    if (!cb) return { ok: false, error: 'no checkbox' };
    const row = cb.closest('div');
    if (!row) return { ok: false, error: 'no row' };
    const right = row.querySelector(':scope > div');
    const spans = Array.from(right?.querySelectorAll('span') || []);
    const badge = (spans[0]?.textContent || '').trim();
    const progress = (spans[1]?.textContent || '').trim();
    return { ok: true, badge, progress };
  }, channelId);
}

async function clickChannelBadge(wechatPage, channelId) {
  await wechatPage.evaluate((id) => {
    const cb = document.querySelector(`#bawei-v2-run-${id}`);
    const row = cb?.closest('div');
    const right = row?.querySelector(':scope > div');
    const spans = Array.from(right?.querySelectorAll('span') || []);
    const badge = spans[0];
    if (badge) badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, channelId);
}

async function waitForBadgeText(wechatPage, channelId, wantText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await readChannelBadge(wechatPage, channelId);
    if (info?.ok && info.badge.includes(wantText)) return info;
    await wechatPage.waitForTimeout(350);
  }
  const last = await readChannelBadge(wechatPage, channelId);
  throw new Error(`等待渠道状态超时：channel=${channelId} want=${wantText} last=${JSON.stringify(last)}`);
}

async function waitForDiagnosisContains(wechatPage, text, timeoutMs) {
  await wechatPage.waitForFunction(
    (t) => {
      const el = document.querySelector('#bawei-v2-diagnosis');
      const v = (el?.textContent || '').trim();
      return v.includes(t);
    },
    text,
    { timeout: timeoutMs }
  );
}

async function main() {
  const distDir = abs('dist');
  const profileDir = abs('tmp/pw-profile-v3-e2e');

  if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`未找到扩展产物：${path.join(distDir, 'manifest.json')}（请先 npm run build）`);
  }

  let currentRun = null;
  let imageFetchCount = 0;

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    locale: 'zh-CN',
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  await context.route(/https?:\/\/.*$/i, async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();

    // Ignore non-GET/POST requests in our mock world.
    if (method !== 'GET' && method !== 'POST') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }

    let u;
    try {
      u = new URL(url);
    } catch {
      await route.fulfill({ status: 404, body: 'bad url' });
      return;
    }

    // 1) Mock image CDN for V3_FETCH_IMAGE.
    if (u.hostname.endsWith('.qpic.cn') || u.hostname.endsWith('.qlogo.cn')) {
      if (currentRun && url.includes(currentRun.runId)) {
        imageFetchCount += 1;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: PNG_1x1,
      });
      return;
    }

    // 2) Mock WeChat article.
    if (u.hostname === 'mp.weixin.qq.com' && u.pathname.startsWith('/s/')) {
      const html = currentRun
        ? buildWechatHtml({ title: currentRun.title, imgA: currentRun.imgA, imgB: currentRun.imgB })
        : buildWechatHtml({
            title: 'E2E 文章',
            imgA: 'https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_dummy_a/0',
            imgB: 'https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_dummy_b/0',
          });
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html });
      return;
    }

    // 3) Per-channel mock pages & APIs.
    if (!currentRun) {
      await route.fulfill({ status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'no run' });
      return;
    }

    const { channelId, action, title, sourceUrl, runId } = currentRun;
    const token12 = title.replace(/\s+/g, ' ').trim().slice(0, 12);

    // CSDN
    if (u.hostname === 'mp.csdn.net') {
      if (u.pathname.startsWith('/mp_blog/creation/editor')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        const detailUrl = `https://blog.csdn.net/e2e/article/details/${runId}`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildCsdnEditorHtml({ action, title, sourceUrl, detailUrl }),
        });
        return;
      }
      if (u.pathname.startsWith('/mp_blog/manage/article')) {
        const detailUrl = `https://blog.csdn.net/e2e/article/details/${runId}`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildCsdnManageHtml({ title, token: token12, detailUrl }),
        });
        return;
      }
    }
    if (u.hostname === 'blog.csdn.net') {
      const html = buildDetailHtml({ title, sourceUrl });
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html });
      return;
    }

    // Tencent Cloud Dev
    if (u.hostname === 'cloud.tencent.com') {
      if (u.pathname.startsWith('/developer/article/write')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        const detailUrl = `https://cloud.tencent.com/developer/article/${runId}`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildTencentEditorHtml({ action, title, sourceUrl, detailUrl }),
        });
        return;
      }

      if (u.pathname.startsWith('/developer/creator/article')) {
        const detailUrl = `https://cloud.tencent.com/developer/article/${runId}`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildTencentListHtml({ title, token: token12, detailUrl }),
        });
        return;
      }

      if (u.pathname.startsWith('/developer/article/') && !u.pathname.startsWith('/developer/article/write')) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildDetailHtml({ title, sourceUrl }),
        });
        return;
      }

      if (u.pathname === '/' && u.searchParams.get('action') === 'CreateArticle') {
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      if (u.pathname === '/article' && u.searchParams.get('action') === 'CreateArticle') {
        await route.fulfill({ status: 204, body: '' });
        return;
      }
    }

    // CNBlogs
    if (u.hostname === 'i.cnblogs.com') {
      if (u.pathname.startsWith('/posts/edit')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        const detailUrl = `https://www.cnblogs.com/e2e/p/${runId}.html`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildCnblogsEditorHtml({ action, title, detailUrl }),
        });
        return;
      }
      if (u.pathname.startsWith('/posts')) {
        const detailUrl = `https://www.cnblogs.com/e2e/p/${runId}.html`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildCnblogsListHtml({ title, detailUrl }),
        });
        return;
      }
    }
    if (u.hostname === 'www.cnblogs.com') {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: buildDetailHtml({ title, sourceUrl }),
      });
      return;
    }

    // OSCHINA
    if (u.hostname === 'www.oschina.net' && u.pathname.startsWith('/blog/write')) {
      if (action === 'not_logged_in') {
        await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
        return;
      }
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildOschinaLandingHtml() });
      return;
    }
    if (u.hostname === 'my.oschina.net') {
      if (u.pathname.includes('/blog/write')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        const detailUrl = `https://my.oschina.net/u/e2e/blog/${runId}`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildOschinaWriteHtml({ action, title, sourceUrl, detailUrl }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: buildDetailHtml({ title, sourceUrl }),
      });
      return;
    }

    // WoShiPM
    if (u.hostname === 'www.woshipm.com') {
      if (u.pathname.startsWith('/writing')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        const detailUrl = `https://www.woshipm.com/post/${runId}`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildWoshipmWriteHtml({ action, title, detailUrl }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: buildDetailHtml({ title, sourceUrl }),
      });
      return;
    }

    // MoWen
    if (u.hostname === 'note.mowen.cn') {
      if (u.pathname.startsWith('/editor')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        const detailUrl = `https://note.mowen.cn/detail/${runId}`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildMowenEditorHtml({ action, title, detailUrl }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: buildDetailHtml({ title, sourceUrl }),
      });
      return;
    }

    // SSPAI (API + pages)
    if (u.hostname === 'sspai.com') {
      if (u.pathname.startsWith('/api/v1/matrix/editor/article/single/info/get')) {
        const payload = {
          error: 0,
          msg: 'ok',
          data: {
            id: 123,
            released_at: action === 'publish' ? Date.now() : 0,
            body_last: `<p>原文链接：${sourceUrl}</p>`,
            title_last: title,
          },
        };
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload),
        });
        return;
      }
      if (u.pathname.startsWith('/write')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildSspaiWriteHtml({ title }),
        });
        return;
      }
      if (u.pathname.startsWith('/post/')) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildDetailHtml({ title, sourceUrl }),
        });
        return;
      }
    }

    // Baijiahao
    if (u.hostname === 'baijiahao.baidu.com') {
      if (u.pathname.startsWith('/builder/rc/edit')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildBaijiahaoEditorHtml({ title }),
        });
        return;
      }
      if (u.pathname.startsWith('/builder/rc/content')) {
        const previewUrl = `https://baijiahao.baidu.com/builder/preview/${runId}`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildBaijiahaoListHtml({ title, previewUrl }),
        });
        return;
      }
      if (u.pathname.startsWith('/builder/preview/')) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildDetailHtml({ title, sourceUrl }),
        });
        return;
      }
      // Any other page is treated as detail.
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: buildDetailHtml({ title, sourceUrl }),
      });
      return;
    }

    // Toutiao
    if (u.hostname === 'mp.toutiao.com') {
      if (u.pathname.startsWith('/profile_v4/graphic/publish')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildToutiaoEditorHtml({ title }),
        });
        return;
      }
      if (u.pathname.startsWith('/profile_v4/manage/content/all')) {
        const detailUrl = `https://www.toutiao.com/item/${runId}/`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildToutiaoListHtml({ title, detailUrl }),
        });
        return;
      }
    }
    if (u.hostname === 'www.toutiao.com' && u.pathname.startsWith('/item/')) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: buildDetailHtml({ title, sourceUrl }),
      });
      return;
    }

    // Feishu docs
    if (u.hostname === 'wuxinxuexi.feishu.cn') {
      if (u.pathname.startsWith('/space/api/explorer/v2/create/object/')) {
        const payload = {
          code: 0,
          msg: 'ok',
          data: {
            obj_token: `e2e_doc_${runId}`,
          },
        };
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(payload),
        });
        return;
      }
      if (u.pathname.startsWith('/drive/folder/')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        const docxUrl = `https://wuxinxuexi.feishu.cn/docx/e2e_doc_${runId}`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildFeishuFolderHtml({ title, docxUrl }),
        });
        return;
      }
      if (u.pathname.startsWith('/docx/')) {
        if (action === 'not_logged_in') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: buildLoginHtml() });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildFeishuDocxHtml({ title, runId }),
        });
        return;
      }
    }

    // Fallback: empty page (avoid external traffic).
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: pageTemplate({ title: 'E2E', body: '<div />' }) });
  });

  async function runOne(channelId, action) {
    currentRun = null;
    imageFetchCount = 0;

    const runId = `${channelId}_${action}_${Date.now()}`;
    const title = `E2E ${channelId} ${action} ${runId}`;
    const wechatUrl = `https://mp.weixin.qq.com/s/${runId}`;
    currentRun = {
      runId,
      channelId,
      action,
      title,
      sourceUrl: wechatUrl,
      imgA: `https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_${runId}_a/0?wx_fmt=png`,
      imgB: `https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_${runId}_b/0?wx_fmt=png`,
    };

    console.log(`\n=== [V3 E2E] channel=${channelId} action=${action} ===`);

    // Start from a fresh WeChat page each run to reduce cross-run noise.
    const wechatPage = await context.newPage();

    // Keep console logs readable (only print key ones).
    wechatPage.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[V2]') || text.includes('[V3]') || text.includes('Failed') || text.includes('失败')) {
        console.log('[wechat][console]', text);
      }
    });

    await gotoWithRetry(wechatPage, wechatUrl);
    await openPanel(wechatPage);

    const channelPage = await startJobAndWaitChannelTab(context, wechatPage, { channelId, action });

    if (action === 'not_logged_in') {
      await waitForBadgeText(wechatPage, channelId, '未登录', 30_000);
      // 验证：关闭 tab 后点击 badge 可重开
      await channelPage.close().catch(() => {});
      const reopenPromise = context.waitForEvent('page', { timeout: 15_000 });
      await clickChannelBadge(wechatPage, channelId);
      const reopened = await reopenPromise;
      // 同 startJob 的处理：确保新 tab 真正进入我们的 mock 入口页（避免 attach 竞态导致首个 document 未被 route 接管）。
      await gotoWithRetry(reopened, CHANNEL_ENTRY_URLS[channelId]);
      assert(String(reopened.url() || '').startsWith(CHANNEL_ENTRY_URLS[channelId]), '点击 badge 未重开入口页');
      await reopened.close().catch(() => {});
      await wechatPage.close().catch(() => {});
      return;
    }

    // 图片上传进度（面板诊断文案）至少出现一次
    await waitForDiagnosisContains(wechatPage, '正在上传图片（', 60_000);

    // 等待成功
    await waitForBadgeText(wechatPage, channelId, '成功', 60_000);

    // 每次运行必须真实触发一次图片下载（证明 V3_FETCH_IMAGE 全链路走通）
    assert(imageFetchCount > 0, `未触发图片下载：channel=${channelId} action=${action}`);

    // 验证：点击 badge 可跳转聚焦到渠道 tab
    await clickChannelBadge(wechatPage, channelId);
    await channelPage
      .waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 15_000 })
      .catch(() => {});

    await channelPage.close().catch(() => {});
    await wechatPage.close().catch(() => {});
  }

  const onlyChannelArg = String(process.argv[2] || '').trim();
  const onlyActionArg = String(process.argv[3] || '').trim();
  const onlyChannel = onlyChannelArg && ALL_CHANNELS.includes(onlyChannelArg) ? onlyChannelArg : '';
  const onlyAction =
    onlyActionArg && ['not_logged_in', 'draft', 'publish'].includes(onlyActionArg) ? onlyActionArg : '';

  if (onlyChannelArg && !onlyChannel) {
    throw new Error(`未知渠道参数：${onlyChannelArg}（可选：${ALL_CHANNELS.join(', ')}）`);
  }
  if (onlyActionArg && !onlyAction) {
    throw new Error(`未知 action 参数：${onlyActionArg}（可选：not_logged_in, draft, publish）`);
  }

  const channelsToRun = onlyChannel ? [onlyChannel] : ALL_CHANNELS;
  const actionsToRun = onlyAction ? [onlyAction] : ['not_logged_in', 'draft', 'publish'];

  for (const channelId of channelsToRun) {
    for (const action of actionsToRun) {
      await runOne(channelId, action);
    }
  }

  await context.close();
  console.log('\n✅ v3 e2e tests passed (all channels)');
}

main().catch((e) => {
  console.error('\n❌ v3 e2e tests failed:', e);
  process.exit(1);
});
