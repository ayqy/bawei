import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { directChromiumArgs } from './channel-network-policy.mjs';

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

function e2eFixtureUrl(url) {
  const target = new URL(url);
  target.searchParams.set('__bawei_e2e', `${Date.now()}_${Math.random().toString(36).slice(2)}`);
  return target.toString();
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
  'feishu-docs'
];

const CHANNEL_ENTRY_URLS = {
  csdn: 'https://mp.csdn.net/mp_blog/creation/editor',
  'tencent-cloud-dev': 'https://cloud.tencent.com/developer/article/write',
  cnblogs: 'https://i.cnblogs.com/posts/edit',
  oschina: 'https://my.oschina.net/blog/ai-write',
  woshipm: 'https://www.woshipm.com/writing',
  mowen: 'https://note.mowen.cn/editor',
  sspai: 'https://sspai.com/write',
  baijiahao: 'https://baijiahao.baidu.com/builder/rc/edit?type=news&is_from_cms=1',
  toutiao: 'https://mp.toutiao.com/profile_v4/graphic/publish',
  'feishu-docs': 'https://wuxinxuexi.feishu.cn/drive/folder/PyWAfSFwrlMgiydvlHectMn2nSd'
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

function imageHandlersScript(
  selector,
  uploadedImagePrefix = 'https://img-blog.csdnimg.cn/bawei-e2e-upload-'
) {
  const sel = JSON.stringify(selector);
  const imagePrefix = JSON.stringify(uploadedImagePrefix);
  return `
    (function(){
      const root = document.querySelector(${sel});
      if (!root) return;
      if (root.__baweiImageHandlersInstalled) return;
      root.__baweiImageHandlersInstalled = true;
      const insertImageFromFile = (file) => {
        const img = document.createElement('img');
        img.alt = 'e2e';
        root.__baweiImageSequence = Number(root.__baweiImageSequence || 0) + 1;
        img.src = ${imagePrefix} + root.__baweiImageSequence + '.png';
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

function iframeEditorSrcdoc(uploadedImagePrefix = 'https://img-blog.csdnimg.cn/bawei-e2e-upload-') {
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
      ${imageHandlersScript('body', uploadedImagePrefix)}
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
    <div id="csdn-cover" class="box">
      <div>封面</div>
      <div class="container-coverimage-box">
        <div class="img-selection-item">
          <img class="select-cover" src="https://img-blog.csdnimg.cn/bawei-e2e-suggested-cover.png" alt="正文候选封面" />
        </div>
        <label>从本地上传<input id="csdn-cover-upload" type="file" accept="image/png,image/jpeg,.png,.jpg" /></label>
        <img class="preview" alt="封面预览" style="display:none;max-width:180px;" />
      </div>
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

    document.querySelector('#csdn-cover .img-selection-item')?.addEventListener('click', (event) => {
      const item = event.currentTarget;
      item.classList.add('selected');
      const preview = document.querySelector('#csdn-cover img.preview');
      if (!preview) return;
      preview.src = 'https://img-blog.csdnimg.cn/bawei-e2e-suggested-cover.png';
      preview.style.display = 'block';
    });

    document.querySelector('#csdn-cover-upload')?.addEventListener('change', () => {
      const preview = document.querySelector('#csdn-cover img.preview');
      if (!preview) return;
      preview.src = 'https://img-blog.csdnimg.cn/bawei-e2e-cover.png';
      preview.style.display = 'block';
    });

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
      <textarea class="article-title" placeholder="标题" style="flex:1; min-height:42px; padding:8px; border:1px solid #ddd; border-radius:8px;"></textarea>
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

function buildTencentListHtml({ title, token, detailUrl, rejected = false }) {
  const rejection = rejected
    ? '<div>你的文章已驳回,原因: 内容包含广告/引流信息</div><button>立即修改</button>'
    : '';
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
      <div class="cdc-2-course-panel${rejected ? ' failed' : ''}">
        <div>${title} ${token}</div>
        ${rejection}
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

function buildOschinaWriteHtml({ action, title, detailUrl, publishRedirectUrl = detailUrl }) {
  const body = `
    <h1>OSCHINA 写作页（E2E）</h1>
    <div class="bar">
      <input name="title" placeholder="文章标题" style="flex:1; padding:8px; border:1px solid #ddd; border-radius:8px;" />
    </div>
    <div class="tiptap ProseMirror aie-content editor" role="textbox" contenteditable="true" style="min-height:220px; border:1px solid #ddd; border-radius:8px;"></div>
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
    const PUBLISH_REDIRECT_URL = ${JSON.stringify(publishRedirectUrl)};
    const editorRoot = document.querySelector('.tiptap.ProseMirror.aie-content');
    editorRoot.__baweiCommandVersion = 0;
    editorRoot.editor = {
      get state() {
        return {
          doc: {
            descendants(callback) {
              const walker = document.createTreeWalker(editorRoot, NodeFilter.SHOW_TEXT);
              const positions = [];
              let position = 1;
              let node = walker.nextNode();
              while (node) {
                const text = String(node.textContent || '');
                positions.push({ from: position, to: position + text.length, node, text });
                callback({ text }, position);
                position += text.length + 2;
                node = walker.nextNode();
              }
              editorRoot.__baweiTextPositions = positions;
            }
          }
        };
      },
      get commands() {
        const snapshotVersion = Number(editorRoot.__baweiCommandVersion || 0);
        const assertFresh = () => {
          if (snapshotVersion !== Number(editorRoot.__baweiCommandVersion || 0)) {
            throw new Error('Applying a mismatched transaction');
          }
        };
        const advance = () => {
          editorRoot.__baweiCommandVersion = Number(editorRoot.__baweiCommandVersion || 0) + 1;
        };
        return {
          clearContent() {
          assertFresh();
          editorRoot.innerHTML = '<p></p>';
          editorRoot.__baweiTextPositions = [];
          editorRoot.__baweiSelectedText = null;
          advance();
          return true;
        },
        focus() {
          assertFresh();
          editorRoot.focus();
          advance();
          return true;
        },
        insertContent(html) {
          assertFresh();
          if (editorRoot.dataset.insertMismatchCovered !== '1') {
            editorRoot.dataset.insertMismatchCovered = '1';
            throw new Error('Applying a mismatched transaction');
          }
          editorRoot.insertAdjacentHTML('beforeend', String(html || ''));
          advance();
          return true;
        },
        setContent(html) {
          assertFresh();
          editorRoot.innerHTML = String(html || '');
          editorRoot.__baweiTextPositions = [];
          editorRoot.__baweiSelectedText = null;
          advance();
          return true;
        },
        setTextSelection(range) {
          assertFresh();
          const row = (editorRoot.__baweiTextPositions || []).find(
            (item) => range.from >= item.from && range.to <= item.to
          );
          editorRoot.__baweiSelectedText = row
            ? {
                node: row.node,
                text: row.text.slice(range.from - row.from, range.to - row.from)
              }
            : null;
          advance();
          return !!row;
        },
        uploadImage(file) {
          assertFresh();
          if (!(file instanceof File)) throw new Error('uploadImage requires File');
          editorRoot.__baweiImageSequence = Number(editorRoot.__baweiImageSequence || 0) + 1;
          const image = document.createElement('img');
          image.alt = file.name || 'e2e';
          image.src =
            'https://oscimg.oschina.net/bawei-e2e-upload-' +
            editorRoot.__baweiImageSequence +
            '.png';
          // 贴近真实 OSCHINA：上传是异步完成的，不能假设完成时仍保留调用前选区。
          editorRoot.__baweiSelectedText = null;
          advance();
          setTimeout(() => {
            editorRoot.appendChild(image);
          }, 250);
          return true;
        }
        };
      },
      getHTML() {
        return editorRoot.innerHTML;
      }
    };
    document.querySelector('#oschina-draft')?.addEventListener('click', () => {
      try { sessionStorage.setItem('__bawei_e2e_oschina_final_html', editorRoot.innerHTML); } catch {}
      try { document.querySelector('#oschina-status').textContent = '保存成功'; } catch {}
      location.href = DETAIL_URL;
    });
    document.querySelector('#oschina-publish')?.addEventListener('click', () => {
      try { document.querySelector('#oschina-status').textContent = '发布中'; } catch {}
    });
    document.querySelector('#oschina-confirm')?.addEventListener('click', () => {
      try { sessionStorage.setItem('__bawei_e2e_oschina_final_html', editorRoot.innerHTML); } catch {}
      try { document.querySelector('#oschina-status').textContent = '发布成功'; } catch {}
      location.href = PUBLISH_REDIRECT_URL;
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
    <iframe id="post_content_ifr" style="width:100%; height:220px; border:1px solid #ddd; border-radius:8px;" srcdoc="${iframeEditorSrcdoc(
      'https://image.woshipm.com/bawei-e2e-upload-'
    ).replaceAll('"', '&quot;')}"></iframe>
    <div class="bar">
      <label><input type="checkbox" name="copyright" />我承诺图片、字体、内容等不存在侵权行为，如侵权愿承担法律风险。</label>
      <label><input type="checkbox" name="copyright_other" />知晓并同意发布后的内容会同步到头条号/网易号/搜狐号等平台。</label>
      <label><input type="checkbox" name="copyright_pm" />已阅读并同意条款</label>
    </div>
    <div class="bar">
      <button id="woshipm-draft" class="btn">保存草稿</button>
      <button id="woshipm-submit" class="btn primary">提交审核</button>
    </div>
  `;
  const script = `
    const ACTION = ${JSON.stringify(action)};
    const DETAIL_URL = ${JSON.stringify(detailUrl)};
    const woshipmFrame = document.querySelector('#post_content_ifr');
    const woshipmEditor = {
      setContent(html) {
        const body = woshipmFrame?.contentDocument?.body;
        if (body) body.innerHTML = String(html || '');
      },
      getContent() {
        return String(woshipmFrame?.contentDocument?.body?.innerHTML || '');
      },
      getBody() {
        return woshipmFrame?.contentDocument?.body || null;
      },
      save() {},
      fire() {},
      nodeChanged() {}
    };
    window.tinymce = { activeEditor: woshipmEditor, editors: [woshipmEditor] };
    const saveFinalHtml = () => {
      try {
        sessionStorage.setItem(
          '__bawei_e2e_woshipm_final_html',
          String(woshipmFrame?.contentDocument?.body?.innerHTML || '')
        );
      } catch {}
    };
    document.querySelector('#woshipm-draft')?.addEventListener('click', () => {
      saveFinalHtml();
      location.href = DETAIL_URL;
    });
    document.querySelector('#woshipm-submit')?.addEventListener('click', () => {
      saveFinalHtml();
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
    ${imageHandlersScript('.ck-editor__editable', 'https://cdnfile.sspai.com/bawei-e2e-upload-')}
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

function buildBaijiahaoEditorHtml({ title, securityResume = false }) {
  const body = `
    <h1>百家号编辑器（E2E）</h1>
    <div data-testid="news-title-input" style="margin:12px 0;">
      <div contenteditable="true" style="min-height:28px;border:1px solid #ddd;border-radius:8px;padding:8px;">标题区</div>
    </div>
    <button type="button" class="edui-for-insertimage btn"><span class="edui-button-body" onclick="window.__baweiOpenImageModal?.(this)">插图</span></button>
    <input id="bjh-video-upload" type="file" accept="video/*" style="display:none;" />
    <div id="bjh-image-modal" class="cheetah-ui-pro-image-modal" style="display:none;width:200px;height:80px;">
      <input id="bjh-inline-upload" type="file" accept="image/png,image/jpeg" style="display:none;" />
      <span>本地上传</span>
    </div>
    <iframe id="ueditor_0" style="width:100%; height:240px; border:1px solid #ddd; border-radius:8px;" srcdoc="${iframeEditorSrcdoc().replaceAll(
      '"',
      '&quot;'
    )}"></iframe>
    <textarea id="abstract" placeholder="摘要" style="width:100%;height:40px;margin-top:10px;"></textarea>
    <div class="box">
      <label class="cheetah-checkbox-wrapper">
        <span class="cheetah-checkbox">
          <input id="bjh-ai-declaration" class="cheetah-checkbox-input" type="checkbox" />
          <span class="cheetah-checkbox-inner"></span>
        </span>
        <span class="aigc_bjh_status">采用AI生成内容</span>
      </label>
    </div>
    <div class="form-item-cover box">
      <span>设置封面</span><span>单图</span><span>三图</span>
      <button id="bjh-cover-select" type="button">选择封面</button>
      <span id="bjh-cover-applied" style="display:none;">编辑 更换</span>
    </div>
    <div class="cheetah-modal" role="dialog" style="display:none;width:200px;height:80px;">其他隐藏弹窗</div>
    <div id="bjh-security" class="mod-dialog-authwidget authwidget-dialog" role="dialog" style="display:none;width:420px;min-height:180px;">
      <div>手机验证</div>
      <div>验证码已发送至你的手机</div>
    </div>
    <div id="bjh-cover-modal" class="cheetah-modal" role="dialog" style="display:none;width:600px;height:400px;">
      <div role="tab">正文/本地上传(1)</div><div role="tab">AI封图</div>
      <div>封面预览 (3:2)</div>
      <button id="bjh-cover-cancel" type="button">取消</button>
      <button id="bjh-cover-confirm" type="button">确定 (1)</button>
    </div>
    <div class="bar" style="justify-content:space-between;">
      <button id="bjh-draft" class="btn">存草稿</button>
      <button id="bjh-publish" class="btn primary" style="margin-top:60px;">发布</button>
    </div>
    <div id="bjh-status" class="hint"></div>
  `;
  const script = `
    window.__baweiSecurityResume = ${securityResume ? 'true' : 'false'};
    window.__baweiSecurityVerified = false;
    try { sessionStorage.setItem('__bawei_e2e_baijiahao_publish_click_count', '0'); } catch {}
    try { sessionStorage.setItem('__bawei_e2e_baijiahao_ai_checked', '0'); } catch {}
    const bjhAiDeclaration = document.querySelector('#bjh-ai-declaration');
    bjhAiDeclaration?.addEventListener('change', () => {
      const checked = Boolean(bjhAiDeclaration.checked);
      bjhAiDeclaration
        .closest('.cheetah-checkbox-wrapper')
        ?.classList.toggle('cheetah-checkbox-wrapper-checked', checked);
      try {
        sessionStorage.setItem('__bawei_e2e_baijiahao_ai_checked', checked ? '1' : '0');
      } catch {}
    });
    window.__baweiOpenImageModal = (target) => {
      if (!target?.isConnected) return;
      setTimeout(() => {
        const modal = document.querySelector('#bjh-image-modal');
        const input = document.querySelector('#bjh-inline-upload');
        const editorBody = document.querySelector('#ueditor_0')?.contentDocument?.body;
        if (editorBody && !editorBody.querySelector('img')) {
          for (let index = 0; index < 3; index += 1) {
            const restored = document.createElement('img');
            restored.src = 'https://pic.rmb.bdstatic.com/bawei-e2e-restored-' + index + '.png';
            editorBody.appendChild(restored);
          }
        }
        if (modal) modal.style.display = 'block';
        if (input) input.dataset.active = '1';
      }, 120);
    };
    window.editor = {
      focus: () => {
        const current = document.querySelector('.edui-for-insertimage .edui-button-body');
        if (current) current.replaceWith(current.cloneNode(true));
      },
      setContent: (html) => {
        const editorBody = document.querySelector('#ueditor_0')?.contentDocument?.body;
        if (editorBody) editorBody.innerHTML = html;
      },
      sync: () => {}
    };
    const bjhTitle = document.querySelector('[data-testid="news-title-input"] [contenteditable="true"]');
    if (bjhTitle) {
      let lexicalState = {
        root: {
          children: [{
            children: [{
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text: bjhTitle.textContent || '',
              type: 'text',
              version: 1
            }],
            direction: null,
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1
          }],
          direction: null,
          format: '',
          indent: 0,
          type: 'root',
          version: 1
        }
      };
      bjhTitle.__lexicalEditor = {
        getEditorState: () => ({ toJSON: () => structuredClone(lexicalState) }),
        parseEditorState: (serialized) => JSON.parse(serialized),
        setEditorState: (nextState) => {
          lexicalState = nextState;
          bjhTitle.textContent = lexicalState?.root?.children?.[0]?.children?.[0]?.text || '';
        }
      };
    }
    document.querySelector('#bjh-inline-upload')?.addEventListener('change', (event) => {
      const input = event.currentTarget;
      if (input?.dataset?.active !== '1') return;
      let editorBody = document.querySelector('#ueditor_0')?.contentDocument?.body;
      if (!editorBody) return;
      editorBody.querySelectorAll('img').forEach((image) => image.remove());
      const replacementBody = document.createElement('body');
      editorBody.replaceWith(replacementBody);
      editorBody = replacementBody;
      const fileCount = Math.max(1, Number(input.files?.length || 0));
      for (let index = 0; index < fileCount; index += 1) {
        editorBody.__baweiImageSequence = Number(editorBody.__baweiImageSequence || 0) + 1;
        const image = document.createElement('img');
        image.src = 'https://pic.rmb.bdstatic.com/bawei-e2e-upload-' + editorBody.__baweiImageSequence + '.png';
        image.alt = 'e2e';
        editorBody.appendChild(image);
      }
      input.dataset.active = '0';
      const modal = document.querySelector('#bjh-image-modal');
      if (modal) modal.style.display = 'none';
    });
    document.querySelector('#bjh-cover-select')?.addEventListener('click', () => {
      const modal = document.querySelector('#bjh-cover-modal');
      if (modal) modal.style.display = 'block';
    });
    document.querySelector('#bjh-cover-confirm')?.addEventListener('click', () => {
      const modal = document.querySelector('#bjh-cover-modal');
      const select = document.querySelector('#bjh-cover-select');
      const applied = document.querySelector('#bjh-cover-applied');
      if (modal) modal.style.display = 'none';
      if (select) select.style.display = 'none';
      if (applied) applied.style.display = 'inline';
    });
    document.querySelector('#bjh-draft')?.addEventListener('click', () => {
      try { document.querySelector('#bjh-status').textContent = '已保存'; } catch {}
      document.body.append(' 已保存');
    });
    document.querySelector('#bjh-publish')?.addEventListener('click', () => {
      const publishClickCount = Number(
        sessionStorage.getItem('__bawei_e2e_baijiahao_publish_click_count') || 0
      ) + 1;
      try {
        sessionStorage.setItem(
          '__bawei_e2e_baijiahao_publish_click_count',
          String(publishClickCount)
        );
      } catch {}
      window.__baweiPublishClickCount = publishClickCount;
      if (window.__baweiSecurityResume && !window.__baweiSecurityVerified) {
        const security = document.querySelector('#bjh-security');
        if (security) security.style.display = 'block';
        return;
      }
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
      <button id="toutiao-preview-publish" class="btn primary">发布</button>
      <button id="toutiao-confirm-publish" class="btn primary" style="display:none;">确认发布</button>
    </div>
  `;

  const script = `
    ${imageHandlersScript('.ProseMirror')}
    document.querySelector('.ProseMirror')?.addEventListener('click', (event) => {
      const root = event.currentTarget;
      const selection = window.getSelection();
      if (!selection || !root) return;
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    });
    document.querySelector('#toutiao-preview-publish')?.addEventListener('click', (event) => {
      const button = event.currentTarget;
      button.style.display = 'none';
      document.querySelector('#toutiao-confirm-publish').style.display = 'inline-block';
      const count = Number(sessionStorage.getItem('__bawei_e2e_toutiao_preview_count') || 0) + 1;
      sessionStorage.setItem('__bawei_e2e_toutiao_preview_count', String(count));
    });
    document.querySelector('#toutiao-confirm-publish')?.addEventListener('click', () => {
      try {
        sessionStorage.setItem(
          '__bawei_e2e_toutiao_final_html',
          document.querySelector('.ProseMirror')?.innerHTML || ''
        );
        const count = Number(
          sessionStorage.getItem('__bawei_e2e_toutiao_confirm_count') || 0
        ) + 1;
        sessionStorage.setItem('__bawei_e2e_toutiao_confirm_count', String(count));
      } catch {}
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

function buildFeishuDocxHtml({ title, runId, restoreStored = true, startBlank = false }) {
  const bodyBlock = startBlank
    ? ''
    : `<div class="block docx-text-block" data-block-id="e2e-body-${runId}">
          <div class="zone-container text-editor editor" contenteditable="true" tabindex="0" style="min-height:220px;"></div>
        </div>`;
  const body = `
    <div class="page-block root-block" data-content-editable-root="true" contenteditable="true">
      <h1 class="page-block-content page-block-title-empty">
        <div class="zone-container text-editor" contenteditable="true">${title}</div>
      </h1>
    </div>
    <div class="note-title__time">已经保存到云端</div>
    <button id="feishu-share" class="btn">分享</button>
    <div id="feishu-share-panel" class="box" style="display:none;">
      <label><input type="checkbox" role="switch" aria-checked="true" checked />互联网上获得链接的任何人可阅读</label>
    </div>
    <div class="bear-web-x-container" style="max-height:360px;overflow:auto;">
      <div class="page-block-children" style="min-height:26px;">${bodyBlock}</div>
    </div>
    <div class="ai-block-write-container" style="${startBlank ? '' : 'display:none;'}">
      <div class="ai-block-write-placeholder is-root">按“/”插入内容，或让 AI 帮我写</div>
    </div>
  `;
  const script = `
    const __baweiFeishuEditorSelector =
      '.page-block-children .block.docx-text-block .zone-container.text-editor';
    function __baweiInstallFeishuImageHandlers() {
      ${imageHandlersScript(
        '.page-block-children .block.docx-text-block .zone-container.text-editor',
        'https://sf3-scmcdn2-cn.feishucdn.com/bawei-e2e-upload-'
      )}
    }
    function __baweiInstallFeishuPersistence() {
      const key = ${JSON.stringify(`__bawei_e2e_feishu_doc_${runId || 'unknown'}`)};
      const editor = document.querySelector(__baweiFeishuEditorSelector);
      if (!editor || editor.__baweiPersistenceInstalled) return;
      editor.__baweiPersistenceInstalled = true;
      try {
        const saved = sessionStorage.getItem(key) || '';
        if (${restoreStored ? 'true' : 'false'} && saved) editor.innerHTML = saved;
      } catch {}
      const save = () => {
        try { sessionStorage.setItem(key, String(editor.innerHTML || '')); } catch {}
      };
      try { editor.addEventListener('input', save); } catch {}
      try {
        const mo = new MutationObserver(save);
        mo.observe(editor, { childList: true, subtree: true, characterData: true });
      } catch {}
    }
    function __baweiCreateBlankFeishuBody() {
      if (document.querySelector(__baweiFeishuEditorSelector)) return;
      const children = document.querySelector('.page-block-children');
      if (!children) return;
      sessionStorage.setItem(
        '__bawei_e2e_feishu_blank_click_count',
        String(Number(sessionStorage.getItem('__bawei_e2e_feishu_blank_click_count') || '0') + 1)
      );
      children.innerHTML = '<div class="block docx-text-block" data-block-id="e2e-body-${runId}"><div class="zone-container text-editor editor" contenteditable="true" tabindex="0" style="min-height:220px;"></div></div>';
      document.querySelector('.ai-block-write-container')?.remove();
      __baweiInstallFeishuImageHandlers();
      __baweiInstallFeishuPersistence();
    }
    document.querySelector('.page-block-children')?.addEventListener(
      'click',
      __baweiCreateBlankFeishuBody
    );
    __baweiInstallFeishuImageHandlers();
    __baweiInstallFeishuPersistence();
    document.querySelector('#feishu-share')?.addEventListener('click', () => {
      const panel = document.querySelector('#feishu-share-panel');
      if (panel) panel.style.display = 'block';
    });
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
  await setSelectedChannelCheckboxes(page, [wantId]);
}

async function setSelectedChannelCheckboxes(page, wantedIds) {
  const wanted = new Set(wantedIds);
  for (const id of ALL_CHANNELS) {
    const sel = `#bawei-v2-run-${id}`;
    if (!(await page.locator(sel).count())) continue;
    await page.setChecked(sel, wanted.has(id));
  }
}

function isReusableChannelPage(channelId, pageUrl) {
  if (channelId === 'oschina') {
    return /^https:\/\/my\.oschina\.net\/u\/[^/]+\/blog\/(?:ai-)?write(?:[/?#]|$)/i.test(pageUrl);
  }
  if (channelId === 'sspai') {
    return /^https:\/\/sspai\.com\/(?:write(?:[/?#]|$)|my(?:[/?#]|$)|whoops(?:[/?#]|$))/i.test(
      pageUrl
    );
  }
  const configured = new URL(CHANNEL_ENTRY_URLS[channelId]);
  return pageUrl.startsWith(`${configured.origin}${configured.pathname}`);
}

async function waitForCreatedOrReusedChannelPage(
  context,
  wechatPage,
  channelId,
  baselinePages,
  timeoutMs = 30_000
) {
  try {
    await wechatPage.waitForFunction(
      () => {
        const raw = document.querySelector('#bawei-v2-runtime-state')?.textContent || '';
        if (!raw.trim()) return false;
        try {
          return Boolean(JSON.parse(raw)?.currentJobId);
        } catch {
          return false;
        }
      },
      null,
      { timeout: timeoutMs }
    );
  } catch (error) {
    const runtime = await wechatPage
      .locator('#bawei-v2-runtime-state')
      .textContent()
      .catch(() => '');
    throw new Error(
      `等待任务启动确认超时：channel=${channelId} runtime=${runtime || 'missing'} cause=${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const pageWaitStartedAt = Date.now();
  while (Date.now() - pageWaitStartedAt < timeoutMs) {
    const pages = context.pages().filter((page) => page !== wechatPage && !page.isClosed());
    // The source mirror receives currentJobId only after the background has bound the tab to the
    // new job. It is therefore safe to accept the same reusable URL contract as production here.
    const reused = pages.find((page) => isReusableChannelPage(channelId, page.url()));
    if (reused) return reused;
    const created = pages.find((page) => !baselinePages.has(page));
    if (created) return created;
    await wechatPage.waitForTimeout(100);
  }

  throw new Error(
    `等待渠道 Tab 超时：channel=${channelId} pages=${JSON.stringify(
      context.pages().map((page) => page.url())
    )}`
  );
}

function waitForSerialChannelPageTransition(context, wechatPage, channelId, timeoutMs = 120_000) {
  const baselinePages = new Set(context.pages());
  const reusablePages = context
    .pages()
    .filter(
      (page) =>
        page !== wechatPage && !page.isClosed() && isReusableChannelPage(channelId, page.url())
    );

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const navigationListeners = new Map();

    const cleanup = () => {
      context.off('page', onPage);
      for (const [page, listener] of navigationListeners) {
        page.off('framenavigated', listener);
      }
      if (timeoutId) clearTimeout(timeoutId);
    };
    const finish = (page) => {
      if (settled || page === wechatPage || page.isClosed()) return;
      settled = true;
      cleanup();
      resolve(page);
    };
    const onPage = (page) => {
      if (!baselinePages.has(page)) finish(page);
    };

    context.on('page', onPage);
    for (const page of reusablePages) {
      const listener = (frame) => {
        if (frame === page.mainFrame()) finish(page);
      };
      navigationListeners.set(page, listener);
      page.on('framenavigated', listener);
    }
    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          `等待串行渠道 Tab 切换超时：channel=${channelId} pages=${JSON.stringify(
            context.pages().map((page) => page.url())
          )}`
        )
      );
    }, timeoutMs);
  });
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
  await wechatPage.check(
    `input[name="bawei_v2_action"][value="${action === 'not_logged_in' ? 'publish' : action}"]`
  );
  await setChannelCheckboxes(wechatPage, channelId);

  const baselinePages = new Set(context.pages());
  await wechatPage.click('#bawei-v2-start');
  const channelPage = await waitForCreatedOrReusedChannelPage(
    context,
    wechatPage,
    channelId,
    baselinePages
  );
  // chrome.tabs.create 打开的页面可能在 Playwright attach 之前就已开始导航，导致 context.route 未能接管首个 document 请求；
  // 这里用 Playwright 主动再跳转一次，确保进入我们的离线 mock 页面。
  // 使用唯一查询参数强制产生一次新 document 导航；对刚由 chrome.tabs.create 打开的相同 URL
  // 再次 page.goto 可能被 Chromium 当作无须重新取文档，导致首个未被接管的真实页面残留。
  await gotoWithRetry(channelPage, e2eFixtureUrl(CHANNEL_ENTRY_URLS[channelId]));

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

async function readChannelRuntimeState(wechatPage, channelId) {
  return await wechatPage.evaluate((id) => {
    const node = document.querySelector('#bawei-v2-runtime-state');
    if (!node?.textContent) return null;
    try {
      const mirror = JSON.parse(node.textContent);
      return mirror?.state?.[id] || null;
    } catch {
      return null;
    }
  }, channelId);
}

async function readStoredChannelRuntimeState(context, wechatPage, channelId) {
  const jobId = await wechatPage.evaluate(() => {
    const node = document.querySelector('#bawei-v2-runtime-state');
    if (!node?.textContent) return '';
    try {
      return String(JSON.parse(node.textContent)?.currentJobId || '');
    } catch {
      return '';
    }
  });
  if (!jobId) return null;

  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  return await worker.evaluate(
    async ({ key, id }) => {
      const result = await chrome.storage.local.get(key);
      return result?.[key]?.[id] || null;
    },
    { key: `bawei_v2_state_${jobId}`, id: channelId }
  );
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

async function clickChannelControl(wechatPage, channelId, text) {
  const clicked = await wechatPage.evaluate(
    ({ id, buttonText }) => {
      const cb = document.querySelector(`#bawei-v2-run-${id}`);
      const row = cb?.closest('div');
      const button = Array.from(row?.querySelectorAll('button') || []).find(
        (candidate) => String(candidate.textContent || '').trim() === buttonText
      );
      if (!button) return false;
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    },
    { id: channelId, buttonText: text }
  );
  assert(clicked, `未找到渠道控制按钮：channel=${channelId} text=${text}`);
}

async function waitForBadgeText(wechatPage, channelId, wantText, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await readChannelBadge(wechatPage, channelId);
    if (info?.ok && info.badge.includes(wantText)) return info;
    await wechatPage.waitForTimeout(350);
  }
  const last = await readChannelBadge(wechatPage, channelId);
  throw new Error(
    `等待渠道状态超时：channel=${channelId} want=${wantText} last=${JSON.stringify(last)}`
  );
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
  const profileRoot = abs('tmp');
  fs.mkdirSync(profileRoot, { recursive: true });
  // 每次使用全新 profile，避免上一次真实站点导航遗留的 Service Worker/HTTP 缓存
  // 在 Playwright 接管新标签页之前抢先响应，破坏离线夹具的确定性。
  const profileDir = fs.mkdtempSync(path.join(profileRoot, 'pw-profile-v3-e2e-'));

  if (!fs.existsSync(path.join(distDir, 'manifest.json'))) {
    throw new Error(`未找到扩展产物：${path.join(distDir, 'manifest.json')}（请先 npm run build）`);
  }

  let currentRun = null;
  let serviceWorkerImageFetchCount = 0;
  let proxyFetchCount = 0;

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    locale: 'zh-CN',
    // 站点 Service Worker 可能直接返回缓存页面，绕过 context.route 的离线夹具。
    // 阻止其接管，确保每个渠道场景都只由下面的显式 mock 路由提供。
    serviceWorkers: 'block',
    args: [
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...directChromiumArgs(ALL_CHANNELS)
    ]
  });

  try {
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

      // 1) Mock local Markdown assets and remote image CDNs.
      if (u.hostname === '127.0.0.1' && u.pathname.startsWith('/bawei-e2e-assets/')) {
        if (currentRun && url.includes(currentRun.runId) && req.resourceType() === 'fetch') {
          serviceWorkerImageFetchCount += 1;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'image/png' },
          body: PNG_1x1
        });
        return;
      }

      if (u.hostname.endsWith('.qpic.cn') || u.hostname.endsWith('.qlogo.cn')) {
        if (currentRun && url.includes(currentRun.runId) && req.resourceType() === 'fetch') {
          serviceWorkerImageFetchCount += 1;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'image/png' },
          body: PNG_1x1
        });
        return;
      }

      // Mock the remote URL produced after an editor finishes uploading a local image.
      if (u.hostname === 'img-blog.csdnimg.cn' || u.hostname === 'cdnfile.sspai.com') {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'image/png' },
          body: PNG_1x1
        });
        return;
      }

      if (u.hostname === 'upload.qiniup.com') {
        currentRun.sspaiDirectUploadCount = Number(currentRun.sspaiDirectUploadCount || 0) + 1;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            hash: `e2e-hash-${currentRun.sspaiDirectUploadCount}`,
            key: `e2e-key-${currentRun.sspaiDirectUploadCount}.png`
          })
        });
        return;
      }

      // 1.5) Track proxy usage for image fetch fallback.
      if (u.hostname === 'read.useai.online' && u.pathname.startsWith('/api/image-proxy')) {
        if (currentRun && url.includes(currentRun.runId) && req.resourceType() === 'fetch') {
          proxyFetchCount += 1;
        }
        await route.fulfill({
          status: 502,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: 'proxy disabled in v3 e2e mock' })
        });
        return;
      }

      // 2) Mock WeChat article.
      if (u.hostname === 'mp.weixin.qq.com' && u.pathname.startsWith('/s/')) {
        const html = currentRun
          ? buildWechatHtml({
              title: currentRun.title,
              imgA: currentRun.imgA,
              imgB: currentRun.imgB
            })
          : buildWechatHtml({
              title: 'E2E 文章',
              imgA: 'https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_dummy_a/0',
              imgB: 'https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_dummy_b/0'
            });
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: html
        });
        return;
      }

      // 3) Per-channel mock pages & APIs.
      if (!currentRun) {
        await route.fulfill({
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: 'no run'
        });
        return;
      }

      const { channelId, action, title, sourceUrl, runId } = currentRun;
      const token12 = title.replace(/\s+/g, ' ').trim().slice(0, 12);
      const articleId = String(runId).match(/(\d+)$/)?.[1] || String(Date.now());

      // CSDN
      if (u.hostname === 'mp.csdn.net') {
        if (u.pathname.startsWith('/mp_blog/creation/editor')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          const detailUrl = `https://blog.csdn.net/e2e/article/details/${runId}`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildCsdnEditorHtml({ action, title, sourceUrl, detailUrl })
          });
          return;
        }
        if (u.pathname.startsWith('/mp_blog/manage/article')) {
          const detailUrl = `https://blog.csdn.net/e2e/article/details/${runId}`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildCsdnManageHtml({ title, token: token12, detailUrl })
          });
          return;
        }
      }
      if (u.hostname === 'blog.csdn.net') {
        const html = buildDetailHtml({ title, sourceUrl });
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: html
        });
        return;
      }

      // Tencent Cloud Dev
      if (u.hostname === 'cloud.tencent.com') {
        if (u.pathname.startsWith('/developer/article/write')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          const detailUrl = `https://cloud.tencent.com/developer/article/${runId}`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildTencentEditorHtml({ action, title, sourceUrl, detailUrl })
          });
          return;
        }

        if (u.pathname.startsWith('/developer/creator/article')) {
          const detailUrl = `https://cloud.tencent.com/developer/article/${runId}`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildTencentListHtml({
              title,
              token: token12,
              detailUrl,
              rejected: action === 'rejected'
            })
          });
          return;
        }

        if (
          u.pathname.startsWith('/developer/article/') &&
          !u.pathname.startsWith('/developer/article/write')
        ) {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildDetailHtml({ title, sourceUrl })
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
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          const detailUrl = `https://www.cnblogs.com/e2e/p/${runId}.html`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildCnblogsEditorHtml({ action, title, detailUrl })
          });
          return;
        }
        if (u.pathname.startsWith('/posts')) {
          const detailUrl = `https://www.cnblogs.com/e2e/p/${runId}.html`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildCnblogsListHtml({ title, detailUrl })
          });
          return;
        }
      }
      if (u.hostname === 'www.cnblogs.com') {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildDetailHtml({ title, sourceUrl })
        });
        return;
      }

      // OSCHINA
      if (u.hostname === 'apiv1.oschina.net' && u.pathname === '/oschinapi/user/osc/myDynamic') {
        currentRun.oschinaDynamicApiCount = Number(currentRun.oschinaDynamicApiCount || 0) + 1;
        await route.fulfill({
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'access-control-allow-origin': 'https://my.oschina.net',
            'access-control-allow-credentials': 'true'
          },
          body: JSON.stringify({
            success: true,
            result: {
              list: [
                {
                  objId: 9002,
                  objType: 3,
                  createdBy: 4581386,
                  title: `${title}（相似旧稿）`,
                  state: 1
                },
                { objId: 9001, objType: 3, createdBy: 4581386, title, state: 1 }
              ]
            }
          })
        });
        return;
      }
      if (u.hostname === 'www.oschina.net' && u.pathname.startsWith('/blog/write')) {
        if (action === 'not_logged_in') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildLoginHtml()
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildOschinaLandingHtml()
        });
        return;
      }
      if (u.hostname === 'my.oschina.net') {
        if (u.pathname.includes('/blog/write') || u.pathname.includes('/blog/ai-write')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          const detailUrl = 'https://my.oschina.net/u/4581386/blog/9001';
          const publishRedirectUrl = 'https://my.oschina.net/u/4581386?tab=newest';
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildOschinaWriteHtml({ action, title, detailUrl, publishRedirectUrl })
          });
          return;
        }
        if (/\/blog\/\d+/.test(u.pathname)) {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildDetailHtml({ title, sourceUrl })
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: pageTemplate({
            title: 'OSCHINA 个人空间',
            body: '<h1>OSCHINA 个人空间（E2E）</h1>'
          })
        });
        return;
      }

      // WoShiPM
      if (u.hostname === 'www.woshipm.com') {
        if (u.pathname.startsWith('/writing')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          const detailUrl = `https://www.woshipm.com/it/${articleId}.html`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildWoshipmWriteHtml({ action, title, detailUrl })
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildDetailHtml({ title, sourceUrl })
        });
        return;
      }

      // MoWen
      if (u.hostname === 'note.mowen.cn') {
        if (u.pathname === '/api/note/wxa/v1/note/show') {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
              detail: {
                noteBase: {
                  title,
                  content: `<p>${title}</p><p>原文链接：<a href="${sourceUrl}">${sourceUrl}</a></p><img uuid="e2e-image-1"><img uuid="e2e-image-2">`
                }
              }
            })
          });
          return;
        }
        if (u.pathname === '/api/note/wxa/v1/note/draft') {
          const imageCount = await req
            .frame()
            .evaluate(() => document.querySelectorAll('.ProseMirror img').length)
            .catch(() => 0);
          const content = JSON.stringify({
            type: 'doc',
            content: Array.from({ length: imageCount }, (_item, index) => ({
              type: 'image',
              attrs: { uuid: `e2e-image-${index + 1}` }
            }))
          });
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ content })
          });
          return;
        }
        if (u.pathname.startsWith('/editor')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          const detailUrl = `https://note.mowen.cn/detail/${runId}`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildMowenEditorHtml({ action, title, detailUrl })
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildDetailHtml({ title, sourceUrl })
        });
        return;
      }

      // SSPAI (API + pages)
      if (u.hostname === 'sspai.com') {
        if (u.pathname.startsWith('/api/v1/matrix/editor/attachment/upload/token/get')) {
          currentRun.sspaiDirectUploadTokenCount =
            Number(currentRun.sspaiDirectUploadTokenCount || 0) + 1;
          const sequence = currentRun.sspaiDirectUploadTokenCount;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
              error: 0,
              msg: 'ok',
              data: {
                file_path: `https://cdnfile.sspai.com/e2e-direct-${runId}-${sequence}.png`,
                id: sequence,
                key: `e2e-direct-${runId}-${sequence}.png`,
                token: `e2e-upload-token-${sequence}`
              }
            })
          });
          return;
        }
        if (u.pathname.startsWith('/api/v1/matrix/editor/attachment/batch/upload')) {
          const payload = (() => {
            try {
              return req.postDataJSON();
            } catch {
              return {};
            }
          })();
          const sourcePicture = String(payload?.pictures?.[0] || '');
          currentRun.sspaiUploadCount = Number(currentRun.sspaiUploadCount || 0) + 1;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
              error: 0,
              msg: 'ok',
              data: [
                {
                  source_url: sourcePicture,
                  download_url: `https://cdnfile.sspai.com/e2e-${runId}-${currentRun.sspaiUploadCount}.png`,
                  status: 2
                }
              ]
            })
          });
          return;
        }
        if (u.pathname.startsWith('/api/v1/matrix/editor/article/update')) {
          const payload = (() => {
            try {
              return req.postDataJSON();
            } catch {
              return {};
            }
          })();
          currentRun.sspaiBodyLast = String(
            payload?.body_last || payload?.body || currentRun.sspaiBodyLast || ''
          );
          currentRun.sspaiType = Number(payload?.type || currentRun.sspaiType || 4);
          if (currentRun.sspaiType === 5) currentRun.sspaiReleasedAt = Date.now();
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ error: 0, msg: 'ok', data: { id: 123, token: 'e2e-token' } })
          });
          return;
        }
        if (u.pathname.startsWith('/api/v1/matrix/editor/article/add')) {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ error: 0, msg: 'ok', data: { id: 123, token: 'e2e-token' } })
          });
          return;
        }
        if (u.pathname.startsWith('/api/v1/matrix/editor/article/single/info/get')) {
          const payload = {
            error: 0,
            msg: 'ok',
            data: {
              id: 123,
              token: 'e2e-token',
              type: Number(currentRun.sspaiType || 4),
              released_at: Number(currentRun.sspaiReleasedAt || 0),
              body: String(currentRun.sspaiBodyLast || ''),
              body_last: String(currentRun.sspaiBodyLast || ''),
              title,
              title_last: title
            }
          };
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(payload)
          });
          return;
        }
        if (u.pathname.startsWith('/write')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildSspaiWriteHtml({ title })
          });
          return;
        }
        if (u.pathname.startsWith('/post/')) {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildDetailHtml({ title, sourceUrl })
          });
          return;
        }
      }

      // Baijiahao
      if (u.hostname === 'baijiahao.baidu.com') {
        if (u.pathname.startsWith('/builder/rc/edit')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildBaijiahaoEditorHtml({
              title,
              securityResume: action === 'waiting_user_resume'
            })
          });
          return;
        }
        if (u.pathname.startsWith('/builder/rc/content')) {
          const previewUrl = `https://baijiahao.baidu.com/builder/preview/${runId}`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildBaijiahaoListHtml({ title, previewUrl })
          });
          return;
        }
        if (u.pathname.startsWith('/builder/preview/')) {
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildDetailHtml({
              title,
              sourceUrl,
              extra: `<a href="https://baijiahao.baidu.com/s?id=${articleId}">公开文章</a>`
            })
          });
          return;
        }
        // Any other page is treated as detail.
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildDetailHtml({ title, sourceUrl })
        });
        return;
      }

      // Toutiao
      if (u.hostname === 'mp.toutiao.com') {
        if (u.pathname.startsWith('/profile_v4/graphic/publish')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildToutiaoEditorHtml({ title })
          });
          return;
        }
        if (u.pathname.startsWith('/profile_v4/manage/content/all')) {
          const detailUrl = `https://www.toutiao.com/item/${runId}/`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildToutiaoListHtml({ title, detailUrl })
          });
          return;
        }
      }
      if (u.hostname === 'www.toutiao.com' && u.pathname.startsWith('/item/')) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: buildDetailHtml({ title, sourceUrl })
        });
        return;
      }

      // Feishu docs
      if (u.hostname === 'wuxinxuexi.feishu.cn') {
        if (u.pathname.startsWith('/space/api/explorer/v2/create/object/')) {
          currentRun.feishuCreateCount = Number(currentRun.feishuCreateCount || 0) + 1;
          const payload = {
            code: 0,
            msg: 'ok',
            data: {
              obj_token: `e2e_doc_${runId}`
            }
          };
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify(payload)
          });
          return;
        }
        if (u.pathname.startsWith('/drive/folder/')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          const docxUrl = `https://wuxinxuexi.feishu.cn/docx/e2e_doc_${runId}`;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildFeishuFolderHtml({ title, docxUrl })
          });
          return;
        }
        if (u.pathname.startsWith('/docx/')) {
          if (action === 'not_logged_in') {
            await route.fulfill({
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
              body: buildLoginHtml()
            });
            return;
          }
          currentRun.feishuDocxRenderCount = Number(currentRun.feishuDocxRenderCount || 0) + 1;
          const dropFirstSerialRestore =
            currentRun.channelId === 'serial-all' && currentRun.feishuDocxRenderCount === 2;
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: buildFeishuDocxHtml({
              title,
              runId,
              restoreStored: !dropFirstSerialRestore,
              startBlank:
                currentRun.channelId === 'feishu-docs' && currentRun.feishuDocxRenderCount === 1
            })
          });
          return;
        }
      }

      // Fallback: empty page (avoid external traffic).
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: pageTemplate({ title: 'E2E', body: '<div />' })
      });
    });

    async function runOne(channelId, action) {
      currentRun = null;
      serviceWorkerImageFetchCount = 0;
      proxyFetchCount = 0;

      const runId = `${channelId}_${action}_${Date.now()}`;
      const title = `E2E ${channelId} ${action} ${runId}`;
      const wechatUrl = `https://mp.weixin.qq.com/s/${runId}`;
      const useLocalSspaiImages = channelId === 'sspai' && action === 'draft';
      // OSCHINA 的生产入口来自本地 Markdown 图片服务，使用 loopback 夹具既贴近
      // 实际链路，也避免扩展 service worker 的远程 CDN 请求污染 Tiptap 回归。
      const useLocalImages = useLocalSspaiImages || channelId === 'oschina';
      currentRun = {
        runId,
        channelId,
        action,
        title,
        sourceUrl: wechatUrl,
        useLocalSspaiImages,
        imgA: useLocalImages
          ? `http://127.0.0.1:43119/bawei-e2e-assets/${runId}-a.png`
          : `https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_${runId}_a/0?wx_fmt=png`,
        imgB: useLocalImages
          ? `http://127.0.0.1:43119/bawei-e2e-assets/${runId}-b.png`
          : `https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_${runId}_b/0?wx_fmt=png`
      };

      console.log(`\n=== [V3 E2E] channel=${channelId} action=${action} ===`);

      // Start from a fresh WeChat page each run to reduce cross-run noise.
      const wechatPage = await context.newPage();

      // Keep console logs readable (only print key ones).
      wechatPage.on('console', (msg) => {
        const text = msg.text();
        if (
          text.includes('[V2]') ||
          text.includes('[V3]') ||
          text.includes('Failed') ||
          text.includes('失败')
        ) {
          console.log('[wechat][console]', text);
        }
      });

      await gotoWithRetry(wechatPage, wechatUrl);
      await openPanel(wechatPage);

      const channelPage = await startJobAndWaitChannelTab(context, wechatPage, {
        channelId,
        action: action === 'rejected' || action === 'waiting_user_resume' ? 'publish' : action
      });

      if (action === 'not_logged_in') {
        try {
          await waitForBadgeText(wechatPage, channelId, '未登录', 30_000);
        } catch (error) {
          const pageState = await channelPage
            .evaluate(() => {
              const visible = (element) => {
                if (!(element instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return (
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  Number(style.opacity || '1') !== 0 &&
                  rect.width > 0 &&
                  rect.height > 0
                );
              };
              const passwords = Array.from(document.querySelectorAll('input[type="password"]'));
              const loginControls = Array.from(
                document.querySelectorAll('button,a,span,div')
              ).filter((element) =>
                /登录|登入|sign in|log in/i.test(String(element.textContent || '').trim())
              );
              return {
                url: location.href,
                title: document.title,
                hasStrictLoginText:
                  /请登录|请先登录|登录后继续|未登录|扫码登录|账号登录|手机号登录/i.test(
                    String(document.body?.innerText || '')
                  ),
                passwordCount: passwords.length,
                visiblePasswordCount: passwords.filter(visible).length,
                loginControlCount: loginControls.length,
                visibleLoginControlCount: loginControls.filter(visible).length
              };
            })
            .catch(() => null);
          const runtimeState = await readChannelRuntimeState(wechatPage, channelId).catch(
            () => null
          );
          const storedState = await readStoredChannelRuntimeState(
            context,
            wechatPage,
            channelId
          ).catch(() => null);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} pageState=${JSON.stringify(pageState)} runtimeState=${JSON.stringify(runtimeState)} storedState=${JSON.stringify(storedState)}`
          );
        }
        // 验证：关闭 tab 后点击 badge 可重开
        await channelPage.close().catch(() => {});
        const reopenPromise = context.waitForEvent('page', { timeout: 15_000 });
        await clickChannelBadge(wechatPage, channelId);
        const reopened = await reopenPromise;
        // 同 startJob 的处理：确保新 tab 真正进入我们的 mock 入口页（避免 attach 竞态导致首个 document 未被 route 接管）。
        await gotoWithRetry(reopened, e2eFixtureUrl(CHANNEL_ENTRY_URLS[channelId]));
        assert(
          String(reopened.url() || '').startsWith(CHANNEL_ENTRY_URLS[channelId]),
          '点击 badge 未重开入口页'
        );
        await reopened.close().catch(() => {});
        await wechatPage.close().catch(() => {});
        return;
      }

      if (action === 'waiting_user_resume') {
        await waitForBadgeText(wechatPage, channelId, '等待', 60_000);
        const beforeContinue = await channelPage.evaluate(() => ({
          publishClickCount: Number(
            sessionStorage.getItem('__bawei_e2e_baijiahao_publish_click_count') || 0
          ),
          securityVisible: Boolean(document.querySelector('#bjh-security')?.offsetParent)
        }));
        assert(
          beforeContinue.publishClickCount === 1 && beforeContinue.securityVisible,
          `百家号首次安全验证状态异常：${JSON.stringify(beforeContinue)}`
        );

        await clickChannelControl(wechatPage, channelId, '继续');
        await wechatPage.waitForTimeout(1_000);
        const blockedContinue = await channelPage.evaluate(() => ({
          publishClickCount: Number(
            sessionStorage.getItem('__bawei_e2e_baijiahao_publish_click_count') || 0
          ),
          securityVisible: Boolean(document.querySelector('#bjh-security')?.offsetParent)
        }));
        assert(
          blockedContinue.publishClickCount === 1 && blockedContinue.securityVisible,
          `验证未完成时“继续”不得二次点击发布：${JSON.stringify(blockedContinue)}`
        );

        await channelPage.evaluate(() => {
          window.__baweiSecurityVerified = true;
          const security = document.querySelector('#bjh-security');
          if (security) security.style.display = 'none';
        });
        await clickChannelControl(wechatPage, channelId, '继续');
        await waitForBadgeText(wechatPage, channelId, '待审', 60_000);

        const resumedState = await readStoredChannelRuntimeState(context, wechatPage, channelId);
        assert(
          resumedState?.status === 'pending_review' &&
            !!resumedState?.devDetails?.candidatePublicUrl,
          `百家号人工验证后未恢复到待审终态：${JSON.stringify(resumedState)}`
        );
        const resumedPage = await channelPage.evaluate(() => ({
          publishClickCount: Number(
            sessionStorage.getItem('__bawei_e2e_baijiahao_publish_click_count') || 0
          ),
          url: location.href
        }));
        assert(
          resumedPage.publishClickCount === 2 &&
            !resumedPage.url.startsWith('https://baijiahao.baidu.com/builder/rc/edit'),
          `百家号验证后必须只追加一次提交：${JSON.stringify(resumedPage)}`
        );
        await channelPage.close().catch(() => {});
        await wechatPage.close().catch(() => {});
        return;
      }

      // 百家号通过主世界 UEditor 整段写入；飞书可能复用已完整落地的同名文档。
      // 两者都不能把“出现逐图上传提示”作为必需的流程信号。
      if (channelId !== 'baijiahao' && channelId !== 'feishu-docs') {
        await waitForDiagnosisContains(wechatPage, '正在上传图片（', 60_000);
      }

      // 草稿落盘是成功终态；发布只代表平台已接收，必须保持待审，不能误报公开成功。
      const expectedBadge = action === 'rejected' ? '退回' : action === 'publish' ? '待审' : '成功';
      try {
        await waitForBadgeText(wechatPage, channelId, expectedBadge, 60_000);
      } catch (error) {
        const channelPageState = await channelPage
          .evaluate(() => {
            const editor = document.querySelector(
              '.tiptap.ProseMirror.aie-content, .page-block-children .block.docx-text-block .zone-container.text-editor'
            );
            const images = Array.from(editor?.querySelectorAll('img') || []).map((image) =>
              String(image.getAttribute('src') || '')
            );
            const bridges = Array.from(
              document.querySelectorAll('script[data-bawei-oschina-bridge]')
            ).map((script) => ({
              hasResult: script.hasAttribute('data-bawei-result'),
              result: script.getAttribute('data-bawei-result') || ''
            }));
            return {
              url: location.href,
              editorConnected: !!editor?.isConnected,
              editorTextLength: String(editor?.textContent || '').length,
              imageCount: images.length,
              imageSources: images,
              blankClickCount: Number(
                sessionStorage.getItem('__bawei_e2e_feishu_blank_click_count') || '0'
              ),
              bridges
            };
          })
          .catch(() => null);
        const runtimeState = await readChannelRuntimeState(wechatPage, channelId).catch(() => null);
        const storedState = await readStoredChannelRuntimeState(
          context,
          wechatPage,
          channelId
        ).catch(() => null);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} channelPageState=${JSON.stringify(channelPageState)} runtimeState=${JSON.stringify(runtimeState)} storedState=${JSON.stringify(storedState)}`
        );
      }
      const runtimeState = await readChannelRuntimeState(wechatPage, channelId);
      const expectedStatus =
        action === 'rejected' ? 'rejected' : action === 'publish' ? 'pending_review' : 'success';
      assert(
        runtimeState?.status === expectedStatus,
        `渠道运行态不符合动作语义：channel=${channelId} action=${action} state=${JSON.stringify(runtimeState)}`
      );
      if (action === 'publish') {
        const storedState = await readStoredChannelRuntimeState(context, wechatPage, channelId);
        assert(
          storedState?.status === 'pending_review' && !!storedState?.devDetails?.candidatePublicUrl,
          `投稿结果缺少待审状态或候选公开地址：channel=${channelId} state=${JSON.stringify(storedState)}`
        );
      }
      if (action === 'rejected') {
        const storedState = await readStoredChannelRuntimeState(context, wechatPage, channelId);
        assert(
          storedState?.status === 'rejected' &&
            storedState?.devDetails?.candidatePublicUrl &&
            storedState?.devDetails?.rejectionReason === '内容包含广告/引流信息',
          `退回结果缺少候选地址或实际原因：channel=${channelId} state=${JSON.stringify(storedState)}`
        );
        assert(
          channelPage.url().startsWith('https://cloud.tencent.com/developer/creator/article'),
          `腾讯云退回稿不应再打开 404 详情页：${channelPage.url()}`
        );
      }
      if (channelId === 'oschina') {
        if (action === 'publish') {
          assert(
            Number(currentRun?.oschinaDynamicApiCount || 0) >= 1,
            'OSCHINA 发布后未通过 myDynamic 接口解析精确标题'
          );
        }
        const oschinaSnapshot = await channelPage.evaluate(() => {
          const html = sessionStorage.getItem('__bawei_e2e_oschina_final_html') || '';
          const root = document.createElement('div');
          root.innerHTML = html;
          const imageSources = Array.from(root.querySelectorAll('img')).map((image) =>
            String(image.getAttribute('src') || '')
          );
          return {
            html,
            text: String(root.textContent || '').replace(/\s+/g, ''),
            imageSources
          };
        });
        const first = oschinaSnapshot.html.indexOf('第一段：用于 E2E 测试。');
        const firstImage = oschinaSnapshot.html.indexOf(
          oschinaSnapshot.imageSources[0] || 'missing'
        );
        const second = oschinaSnapshot.html.indexOf('第二段：图片后继续内容。');
        const secondImage = oschinaSnapshot.html.indexOf(
          oschinaSnapshot.imageSources[1] || 'missing'
        );
        const third = oschinaSnapshot.html.indexOf('第三段：结尾。');
        assert(
          oschinaSnapshot.imageSources.length === 2 &&
            first >= 0 &&
            first < firstImage &&
            firstImage < second &&
            second < secondImage &&
            secondImage < third,
          `OSCHINA 图文顺序损坏：${JSON.stringify(oschinaSnapshot)}`
        );
        for (const paragraph of [
          '第一段：用于E2E测试。',
          '第二段：图片后继续内容。',
          '第三段：结尾。'
        ]) {
          assert(
            oschinaSnapshot.text.split(paragraph).length - 1 === 1,
            `OSCHINA 段落丢失或重复：${paragraph} ${JSON.stringify(oschinaSnapshot)}`
          );
        }
      }
      if (channelId === 'woshipm') {
        const woshipmSnapshot = await channelPage.evaluate(() => {
          const html = sessionStorage.getItem('__bawei_e2e_woshipm_final_html') || '';
          const root = document.createElement('div');
          root.innerHTML = html;
          return {
            html,
            text: String(root.textContent || '').replace(/\s+/g, ''),
            imageSources: Array.from(root.querySelectorAll('img')).map((image) =>
              String(image.getAttribute('src') || '')
            )
          };
        });
        const first = woshipmSnapshot.html.indexOf('第一段：用于 E2E 测试。');
        const firstImage = woshipmSnapshot.html.indexOf(
          woshipmSnapshot.imageSources[0] || 'missing'
        );
        const second = woshipmSnapshot.html.indexOf('第二段：图片后继续内容。');
        const secondImage = woshipmSnapshot.html.indexOf(
          woshipmSnapshot.imageSources[1] || 'missing'
        );
        const third = woshipmSnapshot.html.indexOf('第三段：结尾。');
        assert(
          woshipmSnapshot.imageSources.length === 2 &&
            woshipmSnapshot.imageSources.every((src) =>
              src.startsWith('https://image.woshipm.com/bawei-e2e-upload-')
            ) &&
            first >= 0 &&
            first < firstImage &&
            firstImage < second &&
            second < secondImage &&
            secondImage < third,
          `人人都是产品经理图文原子重建失败：${JSON.stringify(woshipmSnapshot)}`
        );
        for (const paragraph of [
          '第一段：用于E2E测试。',
          '第二段：图片后继续内容。',
          '第三段：结尾。'
        ]) {
          assert(
            woshipmSnapshot.text.split(paragraph).length - 1 === 1,
            `人人都是产品经理段落丢失或重复：${paragraph} ${JSON.stringify(woshipmSnapshot)}`
          );
        }
      }
      if (channelId === 'feishu-docs') {
        const feishuSnapshot = await channelPage.evaluate(() => ({
          blankClickCount: Number(
            sessionStorage.getItem('__bawei_e2e_feishu_blank_click_count') || '0'
          ),
          bodyEditorCount: document.querySelectorAll(
            '.page-block-children .block.docx-text-block .zone-container.text-editor'
          ).length
        }));
        assert(
          Number(currentRun?.feishuCreateCount || 0) === 0,
          `飞书已存在同名文档时不得再次调用创建接口：${currentRun?.feishuCreateCount || 0}`
        );
        assert(
          feishuSnapshot.blankClickCount === 1 && feishuSnapshot.bodyEditorCount === 1,
          `飞书空白正文必须通过正文区域点击创建且不得污染标题：${JSON.stringify(feishuSnapshot)}`
        );
      }
      if (channelId === 'baijiahao' && action === 'publish') {
        const baijiahaoSnapshot = await channelPage.evaluate(() => ({
          aiDeclarationChecked:
            Boolean(document.querySelector('#bjh-ai-declaration')?.checked) ||
            sessionStorage.getItem('__bawei_e2e_baijiahao_ai_checked') === '1',
          publishClickCount: Number(
            sessionStorage.getItem('__bawei_e2e_baijiahao_publish_click_count') ||
              window.__baweiPublishClickCount ||
              0
          )
        }));
        assert(
          baijiahaoSnapshot.aiDeclarationChecked,
          `百家号新版“采用AI生成内容”声明未勾选：${JSON.stringify(baijiahaoSnapshot)}`
        );
        assert(
          baijiahaoSnapshot.publishClickCount === 1,
          `百家号发布按钮必须且只能触发一次：${baijiahaoSnapshot.publishClickCount}`
        );
      }
      if (channelId === 'toutiao') {
        const toutiaoSnapshot = await channelPage.evaluate(() => {
          const html =
            document.querySelector('.ProseMirror')?.innerHTML ||
            sessionStorage.getItem('__bawei_e2e_toutiao_final_html') ||
            '';
          const root = document.createElement('div');
          root.innerHTML = html;
          return {
            html,
            text: String(root.textContent || '').replace(/\s+/g, ''),
            imageSources: Array.from(root.querySelectorAll('img')).map((image) =>
              String(image.getAttribute('src') || '')
            ),
            previewCount: Number(sessionStorage.getItem('__bawei_e2e_toutiao_preview_count') || 0),
            confirmCount: Number(sessionStorage.getItem('__bawei_e2e_toutiao_confirm_count') || 0)
          };
        });
        const first = toutiaoSnapshot.html.indexOf('第一段：用于 E2E 测试。');
        const firstImage = toutiaoSnapshot.html.indexOf(
          toutiaoSnapshot.imageSources[0] || 'missing'
        );
        const second = toutiaoSnapshot.html.indexOf('第二段：图片后继续内容。');
        const secondImage = toutiaoSnapshot.html.indexOf(
          toutiaoSnapshot.imageSources[1] || 'missing'
        );
        const third = toutiaoSnapshot.html.indexOf('第三段：结尾。');
        assert(
          toutiaoSnapshot.imageSources.length === 2 &&
            first >= 0 &&
            first < firstImage &&
            firstImage < second &&
            second < secondImage &&
            secondImage < third,
          `今日头条图文顺序损坏：${JSON.stringify(toutiaoSnapshot)}`
        );
        for (const paragraph of [
          '第一段：用于E2E测试。',
          '第二段：图片后继续内容。',
          '第三段：结尾。'
        ]) {
          assert(
            toutiaoSnapshot.text.split(paragraph).length - 1 === 1,
            `今日头条段落丢失或重复：${paragraph} ${JSON.stringify(toutiaoSnapshot)}`
          );
        }
        if (action === 'publish') {
          assert(
            toutiaoSnapshot.previewCount === 1 && toutiaoSnapshot.confirmCount === 1,
            `今日头条必须且只能经过一次预览和一次最终确认：${JSON.stringify(toutiaoSnapshot)}`
          );
        }
      }

      // SSPAI 的远程图片走官方 URL 批量转存；百家号由 UEditor 验收；飞书允许复用
      // 已有平台托管图片；其余渠道要求本轮至少触发一次 V3_FETCH_IMAGE。
      if (channelId === 'sspai') {
        if (currentRun?.useLocalSspaiImages) {
          assert(serviceWorkerImageFetchCount >= 2, 'SSPAI 本地图片未通过扩展读取');
          assert(
            Number(currentRun?.sspaiUploadCount || 0) === 0,
            'SSPAI loopback 图片不应发送给公网 URL 转存接口'
          );
          assert(
            Number(currentRun?.sspaiDirectUploadCount || 0) >= 2 &&
              Number(currentRun?.sspaiDirectUploadTokenCount || 0) >= 2,
            'SSPAI 本地图片未通过官方令牌与七牛直传链路'
          );
        } else {
          assert(
            Number(currentRun?.sspaiUploadCount || 0) >= 2,
            `未触发 SSPAI 图片转存：action=${action}`
          );
        }
      } else if (channelId !== 'baijiahao' && channelId !== 'feishu-docs') {
        assert(
          serviceWorkerImageFetchCount > 0,
          `未触发 service-worker 图片下载：channel=${channelId} action=${action}`
        );
      }
      assert(
        proxyFetchCount === 0,
        `检测到代理回退请求：channel=${channelId} action=${action} proxyFetchCount=${proxyFetchCount}`
      );

      // 验证：点击 badge 可跳转聚焦到渠道 tab
      await clickChannelBadge(wechatPage, channelId);
      await channelPage
        .waitForFunction(() => document.visibilityState === 'visible', null, { timeout: 15_000 })
        .catch(() => {});

      await channelPage.close().catch(() => {});
      await wechatPage.close().catch(() => {});
    }

    async function runSerialAllChannels() {
      serviceWorkerImageFetchCount = 0;
      proxyFetchCount = 0;

      const action = 'draft';
      const runId = `serial_all_${Date.now()}`;
      const title = `E2E serial all ${runId}`;
      const wechatUrl = `https://mp.weixin.qq.com/s/${runId}`;
      currentRun = {
        runId,
        channelId: 'serial-all',
        action,
        title,
        sourceUrl: wechatUrl,
        imgA: `https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_${runId}_a/0?wx_fmt=png`,
        imgB: `https://mmbiz.qpic.cn/mmbiz_png/bawei_e2e_${runId}_b/0?wx_fmt=png`
      };

      console.log('\n=== [V3 E2E] serial all 10 channels action=draft ===');

      const baselinePages = new Set(context.pages());
      const wechatPage = await context.newPage();
      await gotoWithRetry(wechatPage, wechatUrl);
      await openPanel(wechatPage);
      await wechatPage.check('input[name="bawei_v2_action"][value="draft"]');
      await setSelectedChannelCheckboxes(wechatPage, ALL_CHANNELS);
      await wechatPage.evaluate((channelId) => {
        const select = document.querySelector('#bawei-v2-focus-channel');
        if (!select) return;
        select.value = channelId;
        select.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }, ALL_CHANNELS[0]);

      const startBaselinePages = new Set(context.pages());
      await wechatPage.click('#bawei-v2-start');
      let channelPage = await waitForCreatedOrReusedChannelPage(
        context,
        wechatPage,
        ALL_CHANNELS[0],
        startBaselinePages
      );
      const openedChannelPages = [];

      for (let index = 0; index < ALL_CHANNELS.length; index += 1) {
        const channelId = ALL_CHANNELS[index];
        const createdPages = context
          .pages()
          .filter((page) => page !== wechatPage && !baselinePages.has(page));
        const observedSerialPages = new Set([...createdPages, ...openedChannelPages, channelPage]);
        assert(
          createdPages.length <= index + 1 && observedSerialPages.size === index + 1,
          `串行第 ${index + 1} 步不应预开或重复复用渠道 Tab：expected=${
            index + 1
          } created=${createdPages.length} observed=${observedSerialPages.size} urls=${JSON.stringify(
            [...observedSerialPages].map((page) => page.url())
          )}`
        );

        const nextPagePromise =
          index + 1 < ALL_CHANNELS.length
            ? waitForSerialChannelPageTransition(context, wechatPage, ALL_CHANNELS[index + 1])
            : null;
        await channelPage.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
        const fixtureAlreadyRunning = await channelPage
          .evaluate(() => (document.title || '').includes('E2E'))
          .catch(() => false);
        if (!fixtureAlreadyRunning)
          await gotoWithRetry(channelPage, e2eFixtureUrl(CHANNEL_ENTRY_URLS[channelId]));
        await channelPage.waitForFunction(() => document.visibilityState === 'visible', null, {
          timeout: 15_000
        });
        assert(
          (await channelPage.evaluate(() => document.visibilityState)) === 'visible',
          `串行第 ${index + 1} 步未聚焦 ${channelId}`
        );

        try {
          await waitForBadgeText(wechatPage, channelId, '成功', 120_000);
        } catch (error) {
          const storedState = await readStoredChannelRuntimeState(
            context,
            wechatPage,
            channelId
          ).catch(() => null);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} storedState=${JSON.stringify(storedState)}`
          );
        }
        openedChannelPages.push(channelPage);
        if (nextPagePromise) channelPage = await nextPagePromise;
      }

      for (const channelId of ALL_CHANNELS) {
        const badge = await readChannelBadge(wechatPage, channelId);
        assert(
          badge?.ok && badge.badge.includes('成功'),
          `串行十渠道最终状态异常：${channelId} ${JSON.stringify(badge)}`
        );
      }
      assert(proxyFetchCount === 0, `串行十渠道检测到代理回退请求：${proxyFetchCount}`);

      for (const page of openedChannelPages) await page.close().catch(() => {});
      await wechatPage.close().catch(() => {});
    }

    const onlyChannelArg = String(process.argv[2] || '').trim();
    const onlyActionArg = String(process.argv[3] || '').trim();
    const serialOnly = onlyChannelArg === 'serial-all';
    const onlyChannel =
      onlyChannelArg && ALL_CHANNELS.includes(onlyChannelArg) ? onlyChannelArg : '';
    const onlyAction =
      onlyActionArg &&
      ['not_logged_in', 'draft', 'publish', 'rejected', 'waiting_user_resume'].includes(
        onlyActionArg
      )
        ? onlyActionArg
        : '';

    if (onlyChannelArg && !onlyChannel && !serialOnly) {
      throw new Error(`未知渠道参数：${onlyChannelArg}（可选：${ALL_CHANNELS.join(', ')}）`);
    }
    if (onlyActionArg && !onlyAction) {
      throw new Error(
        `未知 action 参数：${onlyActionArg}（可选：not_logged_in, draft, publish, rejected, waiting_user_resume）`
      );
    }
    if (onlyAction === 'rejected' && onlyChannel !== 'tencent-cloud-dev') {
      throw new Error('rejected 夹具仅适用于 tencent-cloud-dev');
    }
    if (onlyAction === 'waiting_user_resume' && onlyChannel !== 'baijiahao') {
      throw new Error('waiting_user_resume 夹具仅适用于 baijiahao');
    }

    if (serialOnly) {
      await runSerialAllChannels();
      console.log('\n✅ v3 serial-all e2e test passed');
      return;
    }

    const channelsToRun = onlyChannel ? [onlyChannel] : ALL_CHANNELS;
    const actionsToRun = onlyAction ? [onlyAction] : ['not_logged_in', 'draft', 'publish'];

    for (const channelId of channelsToRun) {
      for (const action of actionsToRun) {
        await runOne(channelId, action);
      }
    }

    if (!onlyChannel && !onlyAction) {
      await runOne('tencent-cloud-dev', 'rejected');
      await runSerialAllChannels();
    }

    console.log('\n✅ v3 e2e tests passed (all channels)');
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('\n❌ v3 e2e tests failed:', e);
  process.exit(1);
});
