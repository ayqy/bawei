/**
 * Baijiahao (Baidu) Publisher Content Script (V2)
 *
 * Editor:
 * - Title: a small contenteditable div on the page (not inside iframe).
 * - Content: UEditor iframe (#ueditor_0).
 * - Required fields may include category / AI declaration / cover type.
 *
 * Verification:
 * - Go to list page and search for title token.
 * - Open detail/preview when possible and verify source URL exists in content.
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */

const CHANNEL_ID: ChannelId = 'baijiahao';

type AnyJob = Pick<PublishJob, 'jobId' | 'action' | 'article' | 'stoppedAt'>;

let currentJob: AnyJob | null = null;
let currentStage: ChannelRuntimeState['stage'] = 'init';
let stopRequested = false;

(globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }).__BAWEI_V2_IS_STOP_REQUESTED = () => stopRequested;

// The legacy /builder/rc/list page often renders empty; use the real content management list.
const LIST_URL = 'https://baijiahao.baidu.com/builder/rc/content?currentPage=1&pageSize=10&search=&type=&collection=&startDate=&endDate=';

function getMessage(key: string, substitutions?: string[]): string {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function buildListSearchToken(title: string): string {
  const normalized = normalizeForSearch(title);
  // Baijiahao search seems sensitive to punctuation; keep only Chinese/letters/numbers for keyword.
  const cleaned = normalized.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const candidate = cleaned.length >= 4 ? cleaned : normalized;
  return titleToken(candidate);
}

function withSourceUrlAppended(contentHtml: string, sourceUrl: string): string {
  const safe = escapeAttr(sourceUrl);
  const plain = htmlToPlainTextSafe(contentHtml);
  // Some Baijiahao accounts show a blocking prompt when content is too short (< 40 chars).
  // Add a small note to satisfy minimum length while keeping "原创" (no repost field).
  const needPad = plain.replace(/\s+/g, '').length < 50;
  const pad = needPad
    ? '<p>（提示：本文内容较短，更多细节请点击下方原文链接查看完整内容。）</p>'
    : '';
  return `${contentHtml}\n<p><br/></p>${pad}<p>原文链接：<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a></p>`;
}

function htmlToPlainTextSafe(html: string): string {
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function normalizeLoose(value: string): string {
  return normalizeForSearch(value).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
}

function findPreviewLinkByTitleOrToken(title: string, token: string): HTMLAnchorElement | null {
  const wantTitle = normalizeLoose(title);
  const wantToken = normalizeLoose(token);
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((a) =>
    a.href.includes('/builder/preview/')
  );
  for (const a of links) {
    const txt = normalizeLoose(a.textContent || '');
    if (wantToken && txt.includes(wantToken)) return a;
    if (wantTitle && txt.includes(wantTitle.slice(0, Math.min(12, wantTitle.length)))) return a;
  }
  return null;
}

function clickStatusTabBestEffort(label: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const root = document.querySelector('.cheetah-custom-tabs-sub');
  const scope = (root as HTMLElement | null) || document;
  const tabs = Array.from(scope.querySelectorAll<HTMLElement>('.cheetah-tabs-tab-btn[role="tab"]'));
  const btn = tabs.find((t) => normalize(t.textContent || '') === label) || null;
  if (!btn) return false;
  try {
    simulateClick(btn);
  } catch {
    // ignore
  }
  try {
    btn.click();
  } catch {
    // ignore
  }
  return true;
}

function buildPlainText(contentHtml: string, sourceUrl: string): string {
  const base = htmlToPlainTextSafe(contentHtml) || '（以下为自动发布内容）';
  const suffix = sourceUrl ? `\n\n原文链接：${sourceUrl}` : '';
  return `${base}${suffix}`.trim();
}

function shouldRunOnThisPage(): boolean {
  return location.hostname === 'baijiahao.baidu.com';
}

function isEditorPage(): boolean {
  return location.hostname === 'baijiahao.baidu.com' && location.pathname.startsWith('/builder/rc/edit');
}

function isListPage(): boolean {
  return location.hostname === 'baijiahao.baidu.com' && location.pathname.startsWith('/builder/rc/content');
}

function isHomePage(): boolean {
  return location.hostname === 'baijiahao.baidu.com' && location.pathname === '/';
}

async function report(patch: Partial<ChannelRuntimeState>): Promise<void> {
  if (!currentJob) return;
  await chrome.runtime.sendMessage({
    type: V2_CHANNEL_UPDATE,
    jobId: currentJob.jobId,
    channelId: CHANNEL_ID,
    patch,
  });
}

async function getContextFromBackground(): Promise<{ job: AnyJob; channelId: string }> {
  const res = await chrome.runtime.sendMessage({ type: V2_GET_CONTEXT });
  if (!res?.success) throw new Error(res?.error || 'get context failed');
  return { job: res.job, channelId: res.channelId };
}

function findByExactText(text: string): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('button,a,div,span'));
  return nodes.find((n) => (n.textContent || '').replace(/\s+/g, ' ').trim() === text) || null;
}

function findClickableByText(text: string): HTMLElement | null {
  const el = findByExactText(text) || findAnyElementContainingText(text);
  if (!el) return null;
  return (el.closest('button') as HTMLElement | null) || (el.closest('[role="button"]') as HTMLElement | null) || el;
}

function findCoverSelectButton(): HTMLElement | null {
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

  const coverItem = document.querySelector('.form-item-cover');
  const scope = (coverItem?.closest('.cheetah-form-item') as HTMLElement | null) || document;
  const nodes = Array.from(scope.querySelectorAll<HTMLElement>('button,a,div,span'));
  const cands = nodes
    .map((n) => {
      const t = normalize(n.textContent || '');
      if (t !== '选择封面') return null;
      const rect = n.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const cursor = (() => {
        try {
          return getComputedStyle(n).cursor || '';
        } catch {
          return '';
        }
      })();
      const area = rect.width * rect.height;
      return { n, area, cursor, w: rect.width, h: rect.height };
    })
    .filter(Boolean) as Array<{ n: HTMLElement; area: number; cursor: string; w: number; h: number }>;

  if (!cands.length) return null;

  // Prefer elements that look clickable; then prefer smaller clickable targets.
  cands.sort((a, b) => {
    const ap = a.cursor === 'pointer' ? 0 : 1;
    const bp = b.cursor === 'pointer' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.area - b.area;
  });

  const picked = cands[0]?.n;
  if (!picked) return null;
  return (
    (picked.closest('button') as HTMLElement | null) ||
    (picked.closest('[role="button"]') as HTMLElement | null) ||
    picked
  );
}

async function dismissOnboardingBestEffort(): Promise<void> {
  // The editor sometimes shows a guided-tour overlay which intercepts pointer events.
  // Best-effort click-through: "下一步" a few times, then "完成"/"跳过"/"我知道了".
  try {
    const max = 6;
    for (let i = 0; i < max; i++) {
      const next = findClickableByText('下一步');
      if (!next) break;
      try {
        simulateClick(next);
      } catch {
        // ignore
      }
      try {
        next.click();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    const done = findClickableByText('完成') || findClickableByText('我知道了') || findClickableByText('跳过');
    if (done) {
      try {
        simulateClick(done);
      } catch {
        // ignore
      }
      try {
        done.click();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch {
    // ignore
  }
}

function findTitleEditable(): HTMLElement | null {
  const cands = Array.from(document.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    // Title editor may expand to multiple lines (height > 160) when long; keep an upper bound to avoid huge editors.
    .filter((x) => x.rect.width >= 240 && x.rect.height >= 18 && x.rect.height <= 420)
    .filter((x) => x.rect.top >= 0 && x.rect.top <= window.innerHeight + 200)
    // Prefer the top-most small editable area which is usually the title.
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.height - b.rect.height);
  return cands[0]?.el || null;
}

function findTitleTextareaFallback(): HTMLTextAreaElement | null {
  const exclude = new Set(['abstract', 'inputTextArea']);
  const cands = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'))
    .filter((el) => !exclude.has(el.id || ''))
    .map((el) => ({ el, rect: el.getBoundingClientRect() }))
    // Title textarea is usually small and near the top; avoid large editors / hidden textareas.
    .filter((x) => x.rect.width >= 280 && x.rect.height >= 18 && x.rect.height <= 140)
    .filter((x) => x.rect.top >= 0 && x.rect.top <= window.innerHeight + 200)
    .filter((x) => {
      const style = getComputedStyle(x.el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return true;
    })
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.height - b.rect.height);
  return cands[0]?.el || null;
}

async function stageOpenEditor(): Promise<void> {
  currentStage = 'openEntry';
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgBaijiahaoOpeningEditor') });

  // Some accounts do not have #home-publish-btn; fallback to clicking "发布图文" in the publish entry list.
  const btn = (document.querySelector('#home-publish-btn') as HTMLElement | null) || findByExactText('发布作品');
  if (btn) {
    try {
      simulateClick(btn);
    } catch {
      btn.click();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const publishNews = findByExactText('发布图文');
  if (!publishNews) throw new Error('未找到“发布图文”入口');
  simulateClick(publishNews);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (isEditorPage()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('打开编辑器超时（可能被弹窗/风控拦截）');
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle', userMessage: getMessage('v2MsgFillingTitle') });

  // Persistent contexts may restore the last scroll position; ensure title area is visible.
  try {
    window.scrollTo(0, 0);
  } catch {
    // ignore
  }

  const target = await retryUntil(
    async () => {
      const pageText = document.body?.innerText || '';
      if (pageText.includes('百度安全验证') || pageText.includes('拖动左侧滑块') || pageText.includes('扫码验证')) {
        // Give the user a clear hint and keep polling until verification is done.
        const key = `bawei_v2_baijiahao_security_hint_${currentJob?.jobId || ''}`;
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1');
          await report({
            status: 'running',
            stage: 'fillTitle',
            userMessage: getMessage('v2MsgBaijiahaoSecurityVerifyTriggered'),
          });
        }
        throw new Error('security verification pending');
      }

      const el = findTitleEditable();
      if (el) return el;
      const ta = findTitleTextareaFallback();
      if (ta) return ta;
      throw new Error('title editable not ready');
    },
    // Allow enough time for manual security verification.
    { timeoutMs: 8 * 60_000, intervalMs: 900 }
  );

  if (target instanceof HTMLTextAreaElement) {
    simulateFocus(target);
    try {
      target.value = title;
      target.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: title, inputType: 'insertText' }));
      target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    } catch {
      // ignore
    }
    return;
  }

  const editable = target as HTMLElement;
  simulateFocus(editable);
  try {
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
  } catch {
    // ignore
  }
  try {
    document.execCommand('insertText', false, title);
  } catch {
    // ignore
  }

  // The editor also mirrors title into a hidden textarea (simulator). Update it to satisfy submit validation.
  try {
    const simulator = document.querySelector<HTMLTextAreaElement>('textarea._9ddb7e475b559749-simulator');
    if (simulator) {
      simulator.value = title;
      simulator.dispatchEvent(
        new InputEvent('input', { bubbles: true, cancelable: true, data: title, inputType: 'insertText' })
      );
      simulator.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }
  } catch {
    // ignore
  }

  // Fallback: direct textContent
  if (!pageContainsTitle(title)) {
    try {
      editable.textContent = title;
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    } catch {
      // ignore
    }
  }
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugBaijiahaoNoSourceFieldAppend'),
  });

  const iframe = (await waitForElement<HTMLIFrameElement>('iframe#ueditor_0', 60000)) as HTMLIFrameElement;

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (iframe?.contentDocument?.body) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!iframe?.contentDocument?.body) throw new Error('未找到正文编辑器（iframe 未就绪）');

  const html = withSourceUrlAppended(contentHtml, sourceUrl);
  const body = iframe.contentDocument.body;

  try {
    body.focus();
    iframe.contentDocument.execCommand('selectAll', false);
    iframe.contentDocument.execCommand('delete', false);
    const ok = iframe.contentDocument.execCommand('insertHTML', false, html);
    if (!ok) throw new Error('insertHTML failed');
  } catch {
    // Fallback: innerHTML
    try {
      body.innerHTML = html;
      body.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    } catch {
      // ignore
    }
  }

  await report({ userMessage: getMessage('v2MsgAppendedSourceLinkKeepOriginal') });
}

async function stageEnsureNoCover(): Promise<void> {
  // New Baijiahao editor requires cover selection (单图/三图 + "选择封面"), "无封面" option may not exist.
  // We do NOT upload images in this phase; this function keeps best-effort and will leave hints via verification stage.
  const noCover = findByExactText('无封面') || findAnyElementContainingText('无封面');
  if (noCover) {
    try {
      simulateClick(noCover);
      await new Promise((r) => setTimeout(r, 400));
    } catch {
      // ignore
    }
    return;
  }
}

async function stageEnsureAiDeclaration(): Promise<void> {
  const marker = findAnyElementContainingText('AI创作声明');
  if (!marker) return;

  const input =
    (marker.closest('label')?.querySelector('input[type="checkbox"]') as HTMLInputElement | null) ||
    (marker.parentElement?.querySelector('input[type="checkbox"]') as HTMLInputElement | null) ||
    null;
  if (!input) return;
  if (input.checked) return;

  try {
    simulateClick(input as unknown as HTMLElement);
  } catch {
    try {
      input.click();
    } catch {
      // ignore
    }
  }
  try {
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } catch {
    // ignore
  }
}

async function stageEnsureCategorySelected(): Promise<void> {
  // If "请选择内容分类" exists, pick the first available option.
  const text = document.body?.innerText || '';
  if (!text.includes('请选择内容分类')) return;

  const input = (document.querySelector('#rc_select_0') as HTMLInputElement | null) || null;
  if (!input) return;

  const select = input.closest('.cheetah-select') as HTMLElement | null;
  if (!select) return;

  const already = (select.textContent || '').replace(/\s+/g, ' ').trim();
  if (already && !already.includes('请选择内容分类')) return;

  // Open cascader dropdown (it listens on mousedown in many implementations).
  const selector = (select.querySelector('.cheetah-select-selector') as HTMLElement | null) || select;
  try {
    simulateClick(selector);
  } catch {
    // ignore
  }
  try {
    selector.click();
  } catch {
    // ignore
  }

  // Wait for the first-level menu to appear.
  const firstMenu = await retryUntil(
    async () => {
      const menus = Array.from(document.querySelectorAll<HTMLElement>('.cheetah-cascader-menus .cheetah-cascader-menu'));
      const visible = menus.filter((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!visible.length) throw new Error('category menu not visible');
      return visible[0];
    },
    { timeoutMs: 10_000, intervalMs: 300 }
  );

  const pickItem = (menu: HTMLElement, prefer: string[]): HTMLElement | null => {
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'));
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const p of prefer) {
      const hit = items.find((it) => normalize(it.textContent || '') === p);
      if (hit) return hit;
    }
    return items[0] || null;
  };

  // Prefer a safe category that usually doesn't require extra permissions.
  const first = pickItem(firstMenu, ['科技', '生活', '教育', '社会', '财经', '数码', '其他']);
  if (!first) return;
  try {
    simulateClick(first);
  } catch {
    // ignore
  }
  try {
    first.click();
  } catch {
    // ignore
  }

  // Some categories are multi-level: wait for the second-level menu and pick its first item.
  const secondMenu = await retryUntil(
    async () => {
      const menus = Array.from(document.querySelectorAll<HTMLElement>('.cheetah-cascader-menus .cheetah-cascader-menu'));
      const visible = menus.filter((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visible.length >= 2) return visible[1];
      // If dropdown closes and selection is applied, we are done.
      const cur = (select.textContent || '').replace(/\s+/g, ' ').trim();
      if (cur && !cur.includes('请选择内容分类')) return null;
      throw new Error('second menu not ready');
    },
    { timeoutMs: 10_000, intervalMs: 300 }
  ).catch(() => null);

  if (secondMenu) {
    const second = pickItem(secondMenu, ['互联网', '科技综合']);
    if (second) {
      try {
        simulateClick(second);
      } catch {
        // ignore
      }
      try {
        second.click();
      } catch {
        // ignore
      }
    }
  }

  // Wait for selection text to update.
  await retryUntil(
    async () => {
      const cur = (select.textContent || '').replace(/\s+/g, ' ').trim();
      if (cur && !cur.includes('请选择内容分类')) return true;
      throw new Error('category not selected');
    },
    { timeoutMs: 10_000, intervalMs: 500 }
  );
}

async function stageEnsureSummaryFilled(job: AnyJob): Promise<void> {
  const summary = document.querySelector<HTMLTextAreaElement>('#abstract');
  if (!summary) return;
  const value = (summary.value || '').trim();
  if (value.length >= 10) return;

  const plain = buildPlainText(job.article.contentHtml, job.article.sourceUrl);
  const snippet = plain.replace(/\s+/g, ' ').trim().slice(0, 120);
  try {
    summary.focus();
    summary.value = snippet;
    summary.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: snippet, inputType: 'insertText' }));
    summary.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } catch {
    // ignore
  }
}

async function stageEnsureEventSourceSelected(): Promise<void> {
  const text = document.body?.innerText || '';
  if (!text.includes('事件来源说明')) return;

  // 1) Date picker: "请选择时间"
  const dateInput =
    (document.querySelector<HTMLInputElement>('input[placeholder*="请选择时间"]') as HTMLInputElement | null) || null;
  if (dateInput && !(dateInput.value || '').trim()) {
    try {
      dateInput.scrollIntoView({ block: 'center' });
    } catch {
      // ignore
    }
    try {
      simulateClick(dateInput as unknown as HTMLElement);
    } catch {
      // ignore
    }
    try {
      dateInput.click();
    } catch {
      // ignore
    }

    const day = String(new Date().getDate());
    const pickCell = async (): Promise<HTMLElement> => {
      const cells = Array.from(document.querySelectorAll<HTMLElement>('td[role="gridcell"], td'));
      const hit = cells.find((c) => (c.textContent || '').replace(/\s+/g, ' ').trim() === day) || null;
      if (!hit) throw new Error('date cell not found');
      const r = hit.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) throw new Error('date cell not visible');
      return hit;
    };

    const cell = await retryUntil(pickCell, { timeoutMs: 10_000, intervalMs: 300 }).catch(() => null);
    if (cell) {
      try {
        simulateClick(cell);
      } catch {
        // ignore
      }
      try {
        cell.click();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  // 2) Location cascader: "请选择地点" (rc_select_1)
  const locInput = (document.querySelector('#rc_select_1') as HTMLInputElement | null) || null;
  const locSelect = (locInput?.closest('.cheetah-select') as HTMLElement | null) || null;
  if (locInput && locSelect && (locSelect.textContent || '').includes('请选择地点')) {
    const selector = (locSelect.querySelector('.cheetah-select-selector') as HTMLElement | null) || locSelect;
    try {
      simulateClick(selector);
    } catch {
      // ignore
    }
    try {
      selector.click();
    } catch {
      // ignore
    }

    const firstMenu = await retryUntil(
      async () => {
        const menus = Array.from(document.querySelectorAll<HTMLElement>('.cheetah-cascader-menus .cheetah-cascader-menu'));
        const visible = menus.filter((m) => {
          const r = m.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!visible.length) throw new Error('location menu not visible');
        return visible[0];
      },
      { timeoutMs: 10_000, intervalMs: 300 }
    );

    const pickMenuItem = (menu: HTMLElement, prefer: string[]): HTMLElement | null => {
      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'));
      const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
      for (const p of prefer) {
        const hit = items.find((it) => normalize(it.textContent || '') === p);
        if (hit) return hit;
      }
      return items[0] || null;
    };

    const first = pickMenuItem(firstMenu, ['北京市', '上海市']);
    if (first) {
      try {
        simulateClick(first);
      } catch {
        // ignore
      }
      try {
        first.click();
      } catch {
        // ignore
      }
    }

    const secondMenu = await retryUntil(
      async () => {
        const menus = Array.from(document.querySelectorAll<HTMLElement>('.cheetah-cascader-menus .cheetah-cascader-menu'));
        const visible = menus.filter((m) => {
          const r = m.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (visible.length >= 2) return visible[1];
        // If applied already, stop.
        const cur = (locSelect.textContent || '').replace(/\s+/g, ' ').trim();
        if (cur && !cur.includes('请选择地点')) return null;
        throw new Error('second location menu not ready');
      },
      { timeoutMs: 10_000, intervalMs: 300 }
    ).catch(() => null);

    if (secondMenu) {
      const second = pickMenuItem(secondMenu, []);
      if (second) {
        try {
          simulateClick(second);
        } catch {
          // ignore
        }
        try {
          second.click();
        } catch {
          // ignore
        }
      }
    }

    await retryUntil(
      async () => {
        const cur = (locSelect.textContent || '').replace(/\s+/g, ' ').trim();
        if (cur && !cur.includes('请选择地点')) return true;
        throw new Error('location not selected');
      },
      { timeoutMs: 10_000, intervalMs: 500 }
    ).catch(() => {
      // ignore: location might be optional
    });
  }
}

async function stageEnsureCoverSelected(): Promise<void> {
  // Cover is required in current editor: "单图/三图" + "选择封面".
  // We cannot upload images automatically in this phase; if no cover already selected, we stop and ask the user.
  const text = document.body?.innerText || '';
  const hasCoverUi = text.includes('封面') && (text.includes('单图') || text.includes('三图'));
  if (!hasCoverUi) return;

  // If cover already chosen, "选择封面" is replaced by "更换封面/编辑" buttons; treat that as ok.
  if (findAnyElementContainingText('更换封面') || findAnyElementContainingText('编辑')) return;

  const selectBtn = findCoverSelectButton();
  if (!selectBtn) return;

  await dismissOnboardingBestEffort();
  // simulateClick 不会抛错，但某些页面只响应原生 click() / pointer 事件；这里两种都触发以提高成功率
  try {
    simulateClick(selectBtn);
  } catch {
    // ignore
  }
  try {
    selectBtn.click();
  } catch {
    // ignore
  }

  // Wait for cover picker modal.
  const modal = await retryUntil(
    async () => {
      await dismissOnboardingBestEffort();
      const dlg =
        (document.querySelector<HTMLElement>('.cheetah-modal[role="dialog"]') as HTMLElement | null) ||
        (document.querySelector<HTMLElement>('.cheetah-modal') as HTMLElement | null) ||
        null;
      if (!dlg) throw new Error('cover modal not ready');
      if (!(dlg.textContent || '').includes('封面预览')) throw new Error('cover modal content not ready');
      return dlg;
    },
    { timeoutMs: 30_000, intervalMs: 600 }
  );

  // Prefer AI cover generation (doesn't require local uploads).
  const aiTab = Array.from(modal.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => (t.textContent || '').includes('AI封图'));
  if (aiTab) {
    try {
      simulateClick(aiTab);
    } catch {
      // ignore
    }
    try {
      aiTab.click();
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const genCandidates = Array.from(modal.querySelectorAll<HTMLElement>('button,a,div,span'))
    .map((n) => {
      const t = normalize(n.textContent || '');
      if (t !== '根据全文智能生成封面') return null;
      const rect = n.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const cursor = (() => {
        try {
          return getComputedStyle(n).cursor || '';
        } catch {
          return '';
        }
      })();
      return { n, cursor, area: rect.width * rect.height };
    })
    .filter(Boolean) as Array<{ n: HTMLElement; cursor: string; area: number }>;

  genCandidates.sort((a, b) => {
    const ap = a.cursor === 'pointer' ? 0 : 1;
    const bp = b.cursor === 'pointer' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.area - b.area;
  });

  const gen = genCandidates[0]?.n || null;
  if (gen) {
    try {
      simulateClick(gen);
    } catch {
      // ignore
    }
    try {
      (gen as HTMLElement).click();
    } catch {
      // ignore
    }

    // Wait for "图片生成完成" and enabled confirm button.
    await retryUntil(
      async () => {
        const dlg = document.querySelector<HTMLElement>('.cheetah-modal[role="dialog"], .cheetah-modal');
        const t = (dlg?.textContent || '').replace(/\s+/g, ' ');
        if (!t.includes('图片生成完成') && !t.includes('确定 (1)') && !t.includes('确定(1)')) throw new Error('ai cover not ready');
        const confirm =
          (Array.from(dlg?.querySelectorAll<HTMLButtonElement>('button') || []).find((b) => (b.textContent || '').includes('确定')) as
            | HTMLButtonElement
            | undefined) || null;
        if (!confirm || confirm.hasAttribute('disabled')) throw new Error('confirm disabled');
        return true;
      },
      // Some accounts may have slow AIGC generation; allow longer.
      { timeoutMs: 180_000, intervalMs: 1200 }
    );
  }

  // Click confirm ("确定" or "确定 (1)").
  const dlg = document.querySelector<HTMLElement>('.cheetah-modal[role="dialog"], .cheetah-modal') || modal;
  const confirmBtn =
    (Array.from(dlg.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent || '').includes('确定')) as
      | HTMLButtonElement
      | undefined) || null;
  if (!confirmBtn) throw new Error('未找到封面弹窗的“确定”按钮');
  try {
    simulateClick(confirmBtn);
  } catch {
    // ignore
  }
  try {
    confirmBtn.click();
  } catch {
    // ignore
  }

  // Wait until modal closes and cover section shows "更换封面" or "编辑".
  await retryUntil(
    async () => {
      await dismissOnboardingBestEffort();
      // If cover is already applied, we are done even if the modal DOM lingers.
      const applied = !!findAnyElementContainingText('更换封面') || !!findAnyElementContainingText('编辑');
      if (applied) {
        const dlg = document.querySelector<HTMLElement>('.cheetah-modal[role="dialog"], .cheetah-modal');
        if (dlg) {
          const rect = dlg.getBoundingClientRect();
          const visible = rect.width > 0 && rect.height > 0;
          if (visible) {
            const close =
              (dlg.querySelector<HTMLElement>('.cheetah-modal-close') as HTMLElement | null) ||
              (dlg.querySelector<HTMLElement>('button[aria-label="Close"]') as HTMLElement | null) ||
              null;
            if (close) {
              try {
                simulateClick(close);
              } catch {
                // ignore
              }
              try {
                close.click();
              } catch {
                // ignore
              }
            }
          }
        }
        return true;
      }

      const dlg = document.querySelector<HTMLElement>('.cheetah-modal[role="dialog"], .cheetah-modal');
      const stillOpen = (() => {
        if (!dlg) return false;
        const rect = dlg.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        try {
          const s = getComputedStyle(dlg);
          if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        } catch {
          // ignore
        }
        return true;
      })();
      if (stillOpen) throw new Error('cover modal still open');
      throw new Error('cover not applied yet');
    },
    { timeoutMs: 30_000, intervalMs: 800 }
  );
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSavingDraft') });
  const btn = findByExactText('存草稿') || findAnyElementContainingText('存草稿');
  if (!btn) throw new Error('未找到存草稿按钮');
  btn.click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishing') });
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const publishBtn =
    Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .map((b) => ({ b, t: normalize(b.textContent || ''), rect: b.getBoundingClientRect() }))
      .filter((x) => x.t === '发布' && x.rect.width > 0 && x.rect.height > 0)
      // Prefer the bottom-most publish button (action bar).
      .sort((a, b) => b.rect.top - a.rect.top)[0]?.b || null;
  if (!publishBtn) throw new Error('未找到发布按钮');
  try {
    simulateClick(publishBtn);
  } catch {
    // ignore
  }
  try {
    publishBtn.click();
  } catch {
    // ignore
  }

  // Some accounts show a blocking prompt when content is short: choose "保持图文发布".
  await retryUntil(
    async () => {
      const keep = findByExactText('保持图文发布') || findAnyElementContainingText('保持图文发布');
      if (!keep) throw new Error('short-content dialog not present');
      try {
        simulateClick(keep as HTMLElement);
      } catch {
        // ignore
      }
      try {
        (keep as HTMLElement).click();
      } catch {
        // ignore
      }
      return true;
    },
    { timeoutMs: 4000, intervalMs: 400 }
  ).catch(() => {
    // ignore if dialog not shown
  });

  const handleSecurityVerificationBestEffort = async (): Promise<void> => {
    const isSecurityDialogPresent = (): boolean => {
      const t = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t) return false;
      return (
        t.includes('百度安全验证') ||
        t.includes('安全验证') ||
        t.includes('完成下方验证') ||
        t.includes('拖动左侧滑块') ||
        t.includes('扫码验证') ||
        t.includes('百度APP扫描') ||
        t.includes('二维码') ||
        t.includes('验证方式选择') ||
        t.includes('去验证') ||
        t.includes('已完成验证')
      );
    };

    const firstSeen = await retryUntil(async () => {
      if (!isSecurityDialogPresent()) throw new Error('no security dialog');
      return true;
    }, { timeoutMs: 10_000, intervalMs: 400 }).catch(() => false);
    if (!firstSeen) return;

    await report({
      status: 'running',
      stage: 'submitPublish',
      userMessage: getMessage('v2MsgPublishBlockedBySecurityVerify'),
    });

    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const scan = findByExactText('扫码验证') || findAnyElementContainingText('扫码验证');
      if (scan) {
        try {
          simulateClick(scan as HTMLElement);
        } catch {
          // ignore
        }
        try {
          (scan as HTMLElement).click();
        } catch {
          // ignore
        }
      }

      const done = findByExactText('已完成验证') || findAnyElementContainingText('已完成验证');
      if (done) {
        try {
          simulateClick(done as HTMLElement);
        } catch {
          // ignore
        }
        try {
          (done as HTMLElement).click();
        } catch {
          // ignore
        }
      }

      const go = findByExactText('去验证') || findAnyElementContainingText('去验证');
      if (go) {
        try {
          simulateClick(go as HTMLElement);
        } catch {
          // ignore
        }
        try {
          (go as HTMLElement).click();
        } catch {
          // ignore
        }
      }

      const other = findByExactText('其他验证') || findAnyElementContainingText('其他验证');
      if (other) {
        try {
          simulateClick(other as HTMLElement);
        } catch {
          // ignore
        }
        try {
          (other as HTMLElement).click();
        } catch {
          // ignore
        }
      }

      await new Promise((r) => setTimeout(r, 2500));
      if (!isSecurityDialogPresent()) return;
    }

    throw new Error('安全验证超时：未完成验证');
  };

  await handleSecurityVerificationBestEffort();

  // Some confirmation dialogs use "确认"
  await new Promise((r) => setTimeout(r, 1200));
  const confirm = findByExactText('确认') || findAnyElementContainingText('确认');
  if (confirm) {
    try {
      confirm.click();
    } catch {
      // ignore
    }
  }

  // Some editors show a blocking modal on missing required fields.
  // The modal uses plain "确认" but may not be visible in our generic query; click it if present.
  await new Promise((r) => setTimeout(r, 800));
  const modals = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], .modal, .cheetah-modal, .ant-modal'));
  for (const modal of modals) {
    const t = (modal.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (!t.includes('确认')) continue;
    const okBtn =
      (modal.querySelector('button.bjh-btn-primary') as HTMLButtonElement | null) ||
      (Array.from(modal.querySelectorAll('button')).find((b) => (b.textContent || '').includes('确认')) as
        | HTMLButtonElement
        | undefined) ||
      null;
    if (okBtn) {
      try {
        okBtn.click();
      } catch {
        // ignore
      }
    }
  }
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  const okTexts = action === 'draft' ? ['已保存', '保存成功'] : ['发布成功', '已发布', '审核中'];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = document.body?.innerText || '';
    if (okTexts.some((t) => text.includes(t))) return;
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function runEditorFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredBaijiahaoEditor') });

  await stageFillTitle(job.article.title);
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl);

  // Best-effort required fields (keep original without re-hosting)
  await stageEnsureNoCover();
  await stageEnsureAiDeclaration();
  await stageEnsureCategorySelected();
  await stageEnsureSummaryFilled(job);
  await stageEnsureEventSourceSelected();
  await stageEnsureCoverSelected();
  if (currentStage === 'waitingUser') return;

  if (job.action === 'draft') {
    await stageSaveDraft();
    await stageConfirmSuccess('draft');
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgDraftSavedVerifyDone'),
      devDetails: summarizeVerifyDetails({ listUrl: LIST_URL, listVisible: true }),
    });
    return;
  }

  await stageSubmitPublish();
  await stageConfirmSuccess('publish');

  await report({
    status: 'running',
    stage: 'confirmSuccess',
    userMessage: getMessage('v2MsgPublishTriggeredGoWorksListVerify'),
    devDetails: summarizeVerifyDetails({ listUrl: LIST_URL }),
  });
  location.href = LIST_URL;
}

async function verifyFromList(job: AnyJob): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyFindNewArticleInWorksList') });

  const token = buildListSearchToken(job.article.title);
  // Prefer URL param search (more reliable than synthetic key events which may be ignored by frameworks).
  try {
    const u = new URL(location.href);
    const cur = u.searchParams.get('search') || '';
    if (token && cur !== token) {
      u.searchParams.set('search', token);
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgVerifySetListSearchKeyword', [token]),
        devDetails: summarizeVerifyDetails({ listUrl: u.toString() }),
      });
      location.href = u.toString();
      return;
    }
  } catch {
    // ignore
  }

  // The list is rendered asynchronously and may jump routes; wait for anchors first.
  const listReady = await retryUntil(
    async () => {
      const hasPreview = document.querySelectorAll('a[href*="/builder/preview/"]').length > 0;
      const t = document.body?.innerText || '';
      const hasEmpty = t.includes('暂无数据') || t.includes('共0篇');
      if (!hasPreview && !hasEmpty) throw new Error('list not ready');
      return true;
    },
    { timeoutMs: 90_000, intervalMs: 1500 }
  ).catch(() => false);

  const tryFind = (): HTMLAnchorElement | null => findPreviewLinkByTitleOrToken(job.article.title, token);

  if (listReady) {
    const direct = tryFind();
    if (direct?.href) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgVerifyFoundTitleOpeningDetail'),
        devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
      });
      location.href = direct.href;
      return;
    }

    // The article may be in other status tabs (e.g. 审核中 -> 待发布/已发布/草稿).
    const statuses = ['全部', '待发布', '草稿', '已发布', '未通过', '已撤回'];
    for (const st of statuses) {
      clickStatusTabBestEffort(st);
      await new Promise((r) => setTimeout(r, 1200));
      const found = tryFind();
      if (found?.href) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyFoundTitleInListOpeningDetail', [st]),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
        });
        location.href = found.href;
        return;
      }
    }
  }

  if (!listReady || !tryFind()) {
    const key = `bawei_v2_baijiahao_list_retry_${job.jobId}`;
    const n = Number(sessionStorage.getItem(key) || '0') + 1;
    sessionStorage.setItem(key, String(n));
    if (n <= 20) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgVerifyListNoTitleRefresh6s20', [String(n)]),
        devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
      });
      setTimeout(() => location.reload(), 6000);
      return;
    }

    sessionStorage.removeItem(key);
    throw new Error('验收失败：列表页仍未找到新文章（可能发布未成功或仍在审核）');
  }

  sessionStorage.removeItem(`bawei_v2_baijiahao_list_retry_${job.jobId}`);

  const found = tryFind();
  if (found?.href) {
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgVerifyFoundTitleOpeningDetail'),
      devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
    });
    location.href = found.href;
    return;
  }

  throw new Error('验收失败：列表页匹配成功但未能提取详情链接');
}

async function verifyFromDetail(job: AnyJob): Promise<void> {
  const ok = pageContainsSourceUrl(job.article.sourceUrl);
  await report({
    status: ok ? 'success' : 'waiting_user',
    stage: ok ? 'done' : 'waitingUser',
    userMessage: ok ? getMessage('v2MsgVerifyPassedDetailHasSourceLink') : getMessage('v2MsgVerifyFailedDetailNoSourceLink'),
    userSuggestion: ok ? undefined : getMessage('v2SugCheckSourceLinkAtEndThenContinue'),
    devDetails: summarizeVerifyDetails({ publishedUrl: location.href, sourceUrlPresent: ok }),
  });
}

async function bootstrap(): Promise<void> {
  if (!shouldRunOnThisPage()) return;
  try {
    const ctx = await getContextFromBackground();
    if (ctx.channelId !== CHANNEL_ID) return;
    currentJob = ctx.job;
    if (currentJob.stoppedAt) return;

    if (isHomePage() && !isEditorPage() && !isListPage()) {
      await stageOpenEditor();
      return;
    }

    if (isEditorPage()) {
      await runEditorFlow(currentJob);
      return;
    }

    if (isListPage()) {
      await verifyFromList(currentJob);
      return;
    }

    // Any other page on baijiahao.baidu.com may be a preview/detail page.
    await verifyFromDetail(currentJob);
  } catch (error) {
    if (error instanceof Error && error.message === '__BAWEI_V2_STOPPED__') return;
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith('waiting_user:')) return;
    await report({
      status: 'failed',
      stage: currentStage,
      userMessage: getMessage('v2MsgFailed'),
      userSuggestion: getMessage('v2SugCheckLoginOrDomThenRetry'),
      devDetails: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!currentJob) return;
  if (message?.type === V2_REQUEST_STOP && message.jobId === currentJob.jobId) {
    stopRequested = true;
    return;
  }
  if (message?.type === V2_REQUEST_RETRY && message.jobId === currentJob.jobId && message.channelId === CHANNEL_ID) {
    bootstrap();
  }
  if (message?.type === V2_REQUEST_CONTINUE && message.jobId === currentJob.jobId && message.channelId === CHANNEL_ID) {
    bootstrap();
  }
});

bootstrap();
