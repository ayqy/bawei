/**
 * Tencent Cloud Developer Community Publisher Content Script (V2)
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */
/* INLINE:rich-content */
/* INLINE:image-bridge */

const CHANNEL_ID: ChannelId = 'tencent-cloud-dev';

type AnyJob = Pick<PublishJob, 'jobId' | 'action' | 'article' | 'stoppedAt'>;

let currentJob: AnyJob | null = null;
let currentStage: ChannelRuntimeState['stage'] = 'init';
let publishProbeResourceIndex: number | null = null;
let stopRequested = false;
let lastTencentTitleWriteDebug = '';
let lastTencentMainWorldError = '';

(globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }).__BAWEI_V2_IS_STOP_REQUESTED = () => stopRequested;

function getMessage(key: string, substitutions?: string[]): string {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

function tokenForSearch(title: string): string {
  return titleToken(title);
}

function getProbeKey(jobId: string): string {
  return `bawei_v2_tencent_probe_index_${jobId}`;
}

function getProbeActiveKey(jobId: string): string {
  return `bawei_v2_tencent_probe_active_${jobId}`;
}

function getListUrlKey(jobId: string): string {
  return `bawei_v2_tencent_list_url_${jobId}`;
}

function getListRetryKey(jobId: string): string {
  return `bawei_v2_tencent_list_retry_${jobId}`;
}

function getVerifyReadyKey(jobId: string): string {
  return `bawei_v2_tencent_verify_ready_${jobId}`;
}

function setSessionValue(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function getSessionValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeSessionValue(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function withSourceUrlAppended(contentHtml: string, sourceUrl: string): string {
  const safe = escapeAttr(sourceUrl);
  return `${contentHtml}\n<p><br/></p><p>原文链接：<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a></p>`;
}

function ensureMinLengthText(text: string, minLen: number, sourceUrl: string): string {
  let out = (text || '').trim();
  if (!out) out = '（以下为自动发布内容）';
  if (sourceUrl && !out.includes(sourceUrl)) out += `\n\n原文链接：${sourceUrl}`;
  if (out.length >= minLen) return out;
  let pad = '\n\n（内容来自原文链接，更多细节请查看原文。）';
  if (sourceUrl && !out.includes(sourceUrl) && !pad.includes(sourceUrl)) pad += `\n原文链接：${sourceUrl}`;
  while ((out + pad).length < minLen + 20) pad += '。';
  return `${out}${pad}`;
}

function getTencentEditable(): HTMLElement | null {
  return (
    (document.querySelector<HTMLElement>('div.public-DraftEditor-content[contenteditable="true"]') as HTMLElement | null) ||
    (document.querySelector<HTMLElement>('div[role="textbox"][contenteditable="true"]') as HTMLElement | null) ||
    null
  );
}

function getTencentMarkdownModel(): { getValue: () => string; setValue: (value: string) => void } | null {
  try {
    const view = window as unknown as {
      monaco?: {
        editor?: {
          getModels?: () => Array<{ getValue?: () => string; setValue?: (value: string) => void }>;
        };
      };
    };
    const models = view.monaco?.editor?.getModels?.() || [];
    const model = models[0];
    if (!model || typeof model.getValue !== 'function' || typeof model.setValue !== 'function') return null;
    return {
      getValue: () => String(model.getValue?.() || ''),
      setValue: (value: string) => {
        model.setValue?.(value);
      },
    };
  } catch {
    return null;
  }
}

function getTencentTitleInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('textarea.article-title');
}

function getTencentVisibleButtonByText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => isElementVisible(button) && (button.textContent || '').trim() === text
    ) || null
  );
}

function getTencentDraftFetchCount(): number {
  try {
    return (performance.getEntriesByType('resource') as PerformanceEntry[]).filter((entry) =>
      String(entry?.name || '').includes('/developer/services/ajax/column/article?action=FetchArticleDrafts')
    ).length;
  } catch {
    return 0;
  }
}

function getTencentEditorReadySignature(): string {
  const titleInput = getTencentTitleInput();
  const monacoInput = getTencentMonacoInputArea();
  const monacoView = getTencentMonacoViewLines();
  const editable = getTencentEditable();
  const publishBtn = getTencentVisibleButtonByText('发布');
  const modeSwitch = findTencentSwitchLink('切换到富文本编辑器') || findTencentSwitchLink('切换到Markdown编辑器');
  const bodyText = document.body?.innerText || '';
  const hasCounter = /标题字数[:：]\s*\d+\s*\/\s*80/.test(bodyText);

  return [
    titleInput && isElementVisible(titleInput) ? 'title:1' : 'title:0',
    titleInput?.disabled ? 'disabled:1' : 'disabled:0',
    titleInput?.readOnly ? 'readonly:1' : 'readonly:0',
    monacoInput && isElementVisible(monacoInput) ? 'inputarea:1' : 'inputarea:0',
    monacoView ? 'view:1' : 'view:0',
    editable ? 'editable:1' : 'editable:0',
    publishBtn ? 'publish:1' : 'publish:0',
    modeSwitch ? 'switch:1' : 'switch:0',
    hasCounter ? 'counter:1' : 'counter:0',
    `draftFetch:${getTencentDraftFetchCount()}`,
  ].join('|');
}

function isTencentEditorReady(): boolean {
  const titleInput = getTencentTitleInput();
  if (!titleInput || !isElementVisible(titleInput) || titleInput.disabled || titleInput.readOnly) return false;

  const hasContentSurface = !!(
    (getTencentMonacoInputArea() && isElementVisible(getTencentMonacoInputArea() as HTMLTextAreaElement)) ||
    getTencentMonacoViewLines() ||
    getTencentEditable()
  );
  if (!hasContentSurface) return false;

  const hasEditorActions = !!(
    getTencentVisibleButtonByText('发布') ||
    findTencentSwitchLink('切换到富文本编辑器') ||
    findTencentSwitchLink('切换到Markdown编辑器')
  );

  return hasEditorActions || getTencentDraftFetchCount() > 0;
}

async function waitForTencentEditorReady(): Promise<void> {
  await waitForVisibleElement('textarea.article-title', 30000);
  try {
    await waitForVisibleElement('textarea.inputarea, .monaco-editor, div.public-DraftEditor-content[contenteditable="true"]', 30000);
  } catch {
    // ignore
  }

  await retryUntil(
    async () => {
      const before = getTencentEditorReadySignature();
      if (!isTencentEditorReady()) throw new Error(`editor not ready:${before}`);
      await new Promise((r) => setTimeout(r, 800));
      const after = getTencentEditorReadySignature();
      if (!isTencentEditorReady()) throw new Error(`editor not ready after settle:${after}`);
      if (before !== after) throw new Error(`editor still changing:${before}=>${after}`);
      return true;
    },
    { timeoutMs: 45000, intervalMs: 500 }
  );

  await new Promise((r) => setTimeout(r, 5000));
}

function setTencentNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    Object.getPrototypeOf(input) ||
    (input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
  const desc =
    Object.getOwnPropertyDescriptor(proto, 'value') ||
    Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value');

  if (typeof desc?.set === 'function') {
    desc.set.call(input, value);
    return;
  }

  input.value = value;
}

function dispatchTencentTextInput(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  inputType: string = 'insertText'
): void {
  setTencentNativeValue(input, value);
  try {
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType,
      })
    );
  } catch {
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  }
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

function getTencentPublishSidebar(): HTMLElement | null {
  return (
    (document.querySelector('section.col-editor-sidebar') as HTMLElement | null) ||
    (document.querySelector('section.col-editor-sidebar.publish') as HTMLElement | null) ||
    null
  );
}

function getTencentSelectedTagTexts(sidebar?: HTMLElement | null): string[] {
  const root = sidebar || getTencentPublishSidebar() || document.body;
  const container = root.querySelector('.com-2-tag-cont');
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('.com-2-tag-txt span[title], .com-2-tag-txt > span'))
    .map((n) => (n.getAttribute('title') || n.textContent || '').trim())
    .filter(Boolean);
}

function hasTencentCoverUploaded(sidebar?: HTMLElement | null): boolean {
  const root = sidebar || getTencentPublishSidebar() || document.body;
  if (root.querySelector('img.col-editor-upload-image')) return true;
  const text = (root.textContent || '').trim();
  return text.includes('修改文章封面');
}

function isTencentOriginalChecked(sidebar?: HTMLElement | null): boolean {
  const root = sidebar || getTencentPublishSidebar() || document.body;
  const radio = root.querySelector<HTMLInputElement>('input.c-radio[value="1"]');
  return !!radio?.checked;
}

function isTencentTitleCommitted(expectedTitle: string): boolean {
  const title = String(expectedTitle || '').trim();
  if (!title) return false;
  const input = getTencentTitleInput();
  if (!input || !isElementVisible(input)) return false;
  const current = String(input.value || '').trim();
  if (current !== title) return false;
  const text = document.body?.innerText || '';
  const hasCounter = /标题字数[:：]\s*\d+\s*\/\s*80/.test(text);
  return hasCounter || !!getTencentVisibleButtonByText('发布') || (!input.disabled && !input.readOnly);
}

async function fillTencentTitleByNativeSetter(title: string): Promise<boolean> {
  const input = getTencentTitleInput();
  const expected = String(title || '').trim();
  if (!input || !expected) return false;
  if (isTencentTitleCommitted(expected)) return true;
  lastTencentTitleWriteDebug = 'not-started';

  for (let i = 0; i < 8; i += 1) {
    try {
      simulateFocus(input);
    } catch {
      // ignore
    }
    input.focus();
    try {
      input.value = '';
      input.setSelectionRange(0, 0);
    } catch {
      // ignore
    }

    let execOk = false;
    try {
      execOk = document.execCommand('insertText', false, expected);
    } catch {
      execOk = false;
    }
    if (!execOk) {
      try {
        input.setRangeText(expected, 0, input.value.length, 'end');
        try {
          input.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              cancelable: true,
              data: expected,
              inputType: 'insertText',
            })
          );
        } catch {
          input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        }
      } catch {
        // ignore
      }
    }
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

    const result = {
      value: String(getTencentTitleInput()?.value || '').trim(),
      hasCounter: /标题字数[:：]\s*\d+\s*\/\s*80/.test(document.body?.innerText || ''),
      execOk,
    };
    try {
      lastTencentTitleWriteDebug = JSON.stringify(result ?? null).slice(0, 240);
    } catch {
      lastTencentTitleWriteDebug = String(result);
    }
    await new Promise((r) => setTimeout(r, 1200));
    if (String(result?.value || '').trim() === expected && !!result?.hasCounter) return true;
    const current = String(getTencentTitleInput()?.value || '').trim();
    if (current === expected && isTencentEditorReady()) return true;
    if (isTencentTitleCommitted(expected)) return true;
  }

  return false;
}

function getTencentMonacoInputArea(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('textarea.inputarea');
}

function getTencentMonacoViewLines(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.monaco-editor .view-lines');
}

function getTencentMonacoText(): string {
  try {
    const el = getTencentMonacoViewLines();
    return String(el?.innerText || el?.textContent || '').trim();
  } catch {
    return '';
  }
}

async function fillTencentMonacoByInput(markdown: string): Promise<boolean> {
  const input = getTencentMonacoInputArea();
  if (!input) return false;
  const viewLines = getTencentMonacoViewLines();
  const beforeLen = (viewLines?.innerText || viewLines?.textContent || '').length;

  try {
    simulateFocus(input);
  } catch {
    // ignore
  }

  // Monaco 会从 `.inputarea` 的 value 读取输入内容并写入 model（随后清空 textarea）
  try {
    dispatchTencentTextInput(input, markdown, 'insertFromPaste');
  } catch {
    try {
      dispatchTencentTextInput(input, markdown, 'insertText');
    } catch {
      // ignore
    }
  }

  await new Promise((r) => setTimeout(r, 200));
  const afterLen = (viewLines?.innerText || viewLines?.textContent || '').length;
  if (!viewLines) return (markdown || '').trim().length > 0;
  if (afterLen <= 0) return false;
  if (beforeLen <= 0) return afterLen >= Math.min(40, markdown.length * 0.02);
  return afterLen > beforeLen + 10;
}

function isTencentMarkdownMode(): boolean {
  if (getTencentMarkdownModel()) return true;
  return !!Array.from(document.querySelectorAll('a,button,span,div')).find((n) =>
    (n.textContent || '').trim().includes('切换到富文本编辑器')
  );
}

function isTencentRichMode(): boolean {
  if (getTencentEditable()) return true;
  return !!Array.from(document.querySelectorAll('a,button,span,div')).find((n) =>
    (n.textContent || '').trim().includes('切换到Markdown编辑器')
  );
}

function findTencentSwitchLink(text: string): HTMLElement | null {
  const exact = Array.from(document.querySelectorAll<HTMLElement>('a,button')).find((n) => (n.textContent || '').trim() === text);
  if (exact) return exact;
  const fuzzy = Array.from(document.querySelectorAll<HTMLElement>('a,button,span,div')).find((n) =>
    (n.textContent || '').trim().includes(text)
  );
  if (!fuzzy) return null;
  return (fuzzy.closest('a,button') as HTMLElement | null) || fuzzy;
}

async function ensureTencentMarkdownMode(): Promise<void> {
  if (isTencentMarkdownMode()) return;

  const switchBtn = findTencentSwitchLink('切换到Markdown编辑器');
  if (switchBtn) {
    simulateClick(switchBtn);
  }

  await retryUntil(
    async () => {
      if (!isTencentMarkdownMode()) throw new Error('markdown mode not ready');
      return true;
    },
    { timeoutMs: 15_000, intervalMs: 300 }
  );
}

async function ensureTencentRichMode(): Promise<void> {
  if (isTencentRichMode()) return;

  const switchBtn = findTencentSwitchLink('切换到富文本编辑器');
  if (switchBtn) {
    simulateClick(switchBtn);
  }

  await retryUntil(
    async () => {
      if (!isTencentRichMode()) throw new Error('rich mode not ready');
      return true;
    },
    { timeoutMs: 15_000, intervalMs: 300 }
  );

  await retryUntil(
    async () => {
      const editable = getTencentEditable();
      if (!editable || !isElementVisible(editable)) throw new Error('rich editable not ready');
      return true;
    },
    { timeoutMs: 15_000, intervalMs: 300 }
  );
}

function setTencentCaretToEnd(editorRoot: HTMLElement): void {
  try {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editorRoot);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // ignore
  }
}

function getTencentInlineImageInput(): HTMLInputElement | null {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
  const scored = inputs
    .map((input, index) => {
      const accept = String(input.getAttribute('accept') || '').toLowerCase();
      const cls = String(input.className || '').toLowerCase();
      const parentText = String(input.parentElement?.textContent || input.closest('button,div,section')?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const inSidebar = !!input.closest('section.col-editor-sidebar');
      const inImageButton = !!input.closest('button.qa-r-editor-btn.select-file, .qa-r-editor-btn.select-file');
      let score = 0;
      if (isElementVisible(input)) score += 10;
      if (accept.includes('.png') || accept.includes('.jpg') || accept.includes('.jpeg') || accept.includes('.gif')) score += 12;
      if (inImageButton) score += 20;
      if (cls.includes('upload')) score += 4;
      if (parentText.includes('插入图片')) score += 16;
      if (parentText.includes('上传图片')) score += 10;
      if (inSidebar) score -= 20;
      score -= Math.min(index, 20) * 0.2;
      return { input, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score > 8 ? scored[0].input : null;
}

function getTencentResourceNamesSince(beforeIndex: number): string[] {
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceEntry[];
    return entries
      .slice(Math.max(0, beforeIndex))
      .map((entry) => String(entry?.name || ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasTencentInlineImageUploadStartedSince(beforeIndex: number): boolean {
  const names = getTencentResourceNamesSince(beforeIndex);
  return names.some((name) => {
    return (
      name.includes('action=GenObjectKey') ||
      name.includes('action=GetTmpSecret') ||
      name.includes('/column/article/') ||
      name.includes('developer-private-1258344699.cos.')
    );
  });
}

function hasTencentInlineImageUploadCompletedSince(beforeIndex: number): boolean {
  const names = getTencentResourceNamesSince(beforeIndex);
  return names.some((name) => {
    return (
      name.includes('/column/article/') ||
      name.includes('developer-private-1258344699.cos.') ||
      name.includes('action=CreateArticleDraft') ||
      name.includes('action=UpdateArticleDraft') ||
      name.includes('/developer/api/article/getDraftDetail')
    );
  });
}

async function insertTencentImageAtCursor(args: { jobId: string; imageUrl: string; editorRoot: HTMLElement }): Promise<void> {
  try {
    const file = await fetchImageAsFile(args.jobId, args.imageUrl);
    const input = await retryUntil(
      async () => {
        const node = getTencentInlineImageInput();
        if (!node) throw new Error('tencent inline image input not found');
        return node;
      },
      { timeoutMs: 8000, intervalMs: 250 }
    );

    try {
      simulateClick(args.editorRoot);
    } catch {
      // ignore
    }
    try {
      simulateFocus(args.editorRoot);
    } catch {
      // ignore
    }
    setTencentCaretToEnd(args.editorRoot);

    const beforeIndex = (() => {
      try {
        return performance.getEntriesByType('resource').length;
      } catch {
        return 0;
      }
    })();

    setFilesToInput(input, [file]);

    await retryUntil(
      async () => {
        if (hasTencentInlineImageUploadStartedSince(beforeIndex)) return true;
        throw new Error('tencent inline image upload not started');
      },
      { timeoutMs: 15000, intervalMs: 300 }
    );

    await retryUntil(
      async () => {
        if (hasTencentInlineImageUploadCompletedSince(beforeIndex)) return true;
        throw new Error('tencent inline image upload not completed');
      },
      { timeoutMs: 15000, intervalMs: 300 }
    );

    await new Promise((r) => setTimeout(r, 1200));
    setTencentCaretToEnd(args.editorRoot);
    return;
  } catch (error) {
    await insertImageAtCursor(args).catch(() => {
      throw error;
    });
  }
}

function markdownToPlainText(markdown: string): string {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[>#*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTencentMarkdownFromTokens(tokens: Array<{ kind?: string; html?: string; src?: string; alt?: string }>, sourceUrl: string): string {
  const lines: string[] = [];
  let imageIndex = 0;

  for (const token of tokens) {
    if (!token) continue;

    if (token.kind === 'html') {
      const text = htmlToPlainTextSafe(token.html || '').trim();
      if (text) {
        lines.push(text);
        lines.push('');
      }
      continue;
    }

    if (token.kind === 'image') {
      imageIndex += 1;
      const src = String(token.src || '').trim();
      if (!src) continue;
      const altRaw = String(token.alt || '').trim();
      const alt = (altRaw || `image-${imageIndex}`).replace(/]/g, '').replace(/\n/g, ' ').trim();
      lines.push(`![${alt}](${src})`);
      lines.push('');
    }
  }

  if (sourceUrl) {
    lines.push(`原文链接：${sourceUrl}`);
  }

  const markdown = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return markdown || '（以下为自动发布内容）';
}

function findTencentVisibleTagSuggestion(preferredTag: string): HTMLElement | null {
  const items = Array.from(document.querySelectorAll<HTMLElement>('li[data-id]')).filter((el) => isElementVisible(el));
  if (!items.length) return null;
  const exact = items.find((el) => (el.textContent || '').trim() === preferredTag);
  if (exact) return exact;
  const fuzzy = items.find((el) => (el.textContent || '').trim().includes(preferredTag));
  return fuzzy || items[0] || null;
}

async function ensureTencentOriginalSelected(sidebar?: HTMLElement | null): Promise<boolean> {
  const root = sidebar || getTencentPublishSidebar();
  if (!root) return false;
  if (isTencentOriginalChecked(root)) return true;
  const originalLabel = Array.from(root.querySelectorAll<HTMLElement>('label.com-check-item')).find((n) =>
    ((n.textContent || '').trim() || '').includes('原创')
  );
  if (!originalLabel) return false;
  simulateClick(originalLabel);
  await new Promise((r) => setTimeout(r, 150));
  return isTencentOriginalChecked(root);
}

async function ensureTencentTagSelected(tag: string, sidebar?: HTMLElement | null): Promise<boolean> {
  const root = sidebar || getTencentPublishSidebar();
  if (!root) return false;
  if (getTencentSelectedTagTexts(root).length > 0) return true;

  const tagInput = Array.from(root.querySelectorAll<HTMLInputElement>('input.com-2-tag-input')).find((i) => isElementVisible(i)) || null;
  if (!tagInput) return false;

  try {
    simulateFocus(tagInput);
  } catch {
    // ignore
  }
  tagInput.focus();
  try {
    tagInput.value = '';
    tagInput.setSelectionRange(0, 0);
  } catch {
    // ignore
  }

  let execOk = false;
  try {
    execOk = document.execCommand('insertText', false, tag);
  } catch {
    execOk = false;
  }
  if (!execOk) {
    try {
      tagInput.setRangeText(tag, 0, tagInput.value.length, 'end');
      try {
        tagInput.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            data: tag,
            inputType: 'insertText',
          })
        );
      } catch {
        tagInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      }
    } catch {
      // ignore
    }
  }
  tagInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 1200));

  const suggestion = findTencentVisibleTagSuggestion(tag);
  if (suggestion) {
    try {
      simulateClick(suggestion);
    } catch {
      // ignore
    }
  }

  try {
    await retryUntil(
      async () => {
        if (getTencentSelectedTagTexts(root).length > 0) return true;
        throw new Error('tag not selected yet');
      },
      { timeoutMs: 5000, intervalMs: 300 }
    );
    return true;
  } catch {
    return false;
  }
}

async function ensureTencentCoverUploaded(sidebar?: HTMLElement | null): Promise<boolean> {
  const root = sidebar || getTencentPublishSidebar();
  if (!root) return false;
  if (hasTencentCoverUploaded(root)) return true;

  const coverInput = root.querySelector<HTMLInputElement>('input[type="file"][name="article-cover-image"]');
  if (!coverInput) return false;

  const url = chrome.runtime.getURL('icons/icon-128.png');
  const res = await fetch(url);
  const blob = await res.blob();
  const file = new File([blob], 'cover.png', { type: blob.type || 'image/png' });
  setFilesToInput(coverInput, [file]);

  try {
    await retryUntil(
      async () => {
        if (hasTencentCoverUploaded(root)) return true;
        throw new Error('cover not uploaded yet');
      },
      { timeoutMs: 30000, intervalMs: 500 }
    );
    return true;
  } catch {
    return false;
  }
}

function getTencentContentTextLen(sourceUrl: string): number {
  const editable = getTencentEditable();
  if (editable) {
    return ((editable.innerText || editable.textContent || '').trim() || '').length;
  }

  const model = getTencentMarkdownModel();
  if (model) {
    const plain = markdownToPlainText(model.getValue());
    return ensureMinLengthText(plain, 0, sourceUrl).trim().length;
  }

  const monacoText = getTencentMonacoText();
  if (monacoText) {
    return ensureMinLengthText(monacoText, 0, sourceUrl).trim().length;
  }

  return 0;
}

function ensureTencentMarkdownMinLength(minLen: number, sourceUrl: string): void {
  const model = getTencentMarkdownModel();
  if (!model) return;

  const current = String(model.getValue() || '');
  const plain = markdownToPlainText(current);
  if (plain.length >= minLen) return;

  const padded = ensureMinLengthText(plain, Math.max(minLen, 160), sourceUrl);
  const extra = padded.slice(plain.length).trim();
  if (!extra) return;

  const next = `${current.trim()}\n\n${extra}`.trim();
  model.setValue(next);

  const hiddenInput = document.querySelector<HTMLTextAreaElement>('textarea.inputarea');
  if (hiddenInput) {
    hiddenInput.value = next;
    hiddenInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    hiddenInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }
}

function getTextLen(node: HTMLElement): number {
  return ((node.innerText || node.textContent || '').trim() || '').length;
}

function hasArticleActionSince(before: number | null, action: string): boolean {
  if (before == null) return false;
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceEntry[];
    const recent = entries.slice(Math.max(0, before));
    return recent.some((e) => {
      const name = String(e?.name || '');
      if (!name.includes('article?action=')) return false;
      const m = name.match(/[?&]action=([^&]+)/);
      return m?.[1] === action;
    });
  } catch {
    return false;
  }
}

function shouldRunOnThisPage(): boolean {
  if (location.hostname !== 'cloud.tencent.com') return false;
  if (location.pathname.startsWith('/developer/article/write')) return true;
  if (location.pathname.startsWith('/developer/creator/article')) return true;
  if (location.pathname.startsWith('/developer/article/')) return true;
  return false;
}

function isEditorPage(): boolean {
  return location.hostname === 'cloud.tencent.com' && location.pathname.startsWith('/developer/article/write');
}

function isListPage(): boolean {
  return location.hostname === 'cloud.tencent.com' && location.pathname.startsWith('/developer/creator/article');
}

function isDetailPage(): boolean {
  return (
    location.hostname === 'cloud.tencent.com' &&
    location.pathname.startsWith('/developer/article/') &&
    !location.pathname.startsWith('/developer/article/write')
  );
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

async function stageDetectLogin(): Promise<void> {
  currentStage = 'detectLogin';
  await report({ status: 'running', stage: 'detectLogin', userMessage: getMessage('v3MsgDetectingLogin') });

  const loginState = detectPageLoginState({
    loginUrlPattern: /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i,
    loggedInPattern: /开发者社区|写文章|发布|草稿|内容管理|账号设置|退出登录|个人中心/i,
  });
  if (loginState.status === 'not_logged_in') {
    await report({
      status: 'not_logged_in',
      stage: 'detectLogin',
      userMessage: getMessage('v3MsgNotLoggedIn'),
      userSuggestion: getMessage('v3SugLoginThenRetry'),
    });
    throw new Error('__BAWEI_V2_STOPPED__');
  }
}

async function stageFillTitle(title: string): Promise<void> {
  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle' });
  await waitForTencentEditorReady();
  if (String(getTencentTitleInput()?.value || '').trim() === String(title || '').trim()) return;
  const ok = await fillTencentTitleByNativeSetter(title);
  if (!ok) {
    const current = String(getTencentTitleInput()?.value || '').trim();
    throw new Error(
      `腾讯云标题写入未生效:value=${current.slice(0, 40)}|mainWorld=${lastTencentTitleWriteDebug}|mainErr=${lastTencentMainWorldError}|ready=${getTencentEditorReadySignature()}`
    );
  }
}

async function stageFillContent(contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugTencentNoSourceUrlFieldAppend'),
  });

  const tokens = buildRichContentTokens({ contentHtml, baseUrl: sourceUrl, sourceUrl, htmlMode: 'raw', splitBlocks: true });

  const minLen = 140;
  const expectedImages = tokens.filter((t) => t?.kind === 'image').length;
  let len = 0;
  let mode: 'markdown' | 'rich' | 'textarea' = 'textarea';

  const richFilled = await (async () => {
    try {
      await ensureTencentRichMode();
      const editable = getTencentEditable();
      const editor = editable || findContentEditor(document);
      let target: HTMLElement | null = null;
      if (editor) {
        if ((editor as HTMLElement).getAttribute('contenteditable') === 'true') {
          target = editor as HTMLElement;
        } else {
          target = ((editor as HTMLElement).querySelector('[contenteditable="true"]') as HTMLElement | null) || null;
        }
      }
      if (!target) return false;

      try {
        await fillEditorByTokens({
          jobId: currentJob?.jobId || '',
          tokens,
          editorRoot: target,
          writeMode: 'html',
          ensureCaretAtEnd: true,
          onImageProgress: async (current, total) => {
            await report({
              status: 'running',
              stage: 'fillContent',
              userMessage: getMessage('v3MsgUploadingImageProgress', [String(current), String(total)]),
            });
          },
          insertImageAtCursorOverride: insertTencentImageAtCursor,
        });
      } catch (e) {
        await report({
          status: 'waiting_user',
          stage: 'waitingUser',
          userMessage: getMessage('v3MsgImageUploadFailed'),
          userSuggestion: getMessage('v3SugManualUploadImagesThenContinue'),
          devDetails: { message: e instanceof Error ? e.message : String(e) },
        });
        throw new Error('__BAWEI_V2_STOPPED__');
      }

      await new Promise((r) => setTimeout(r, 1200));
      len = getTextLen(target);
      const currentImages = Array.from(target.querySelectorAll<HTMLImageElement>('img')).filter((img) =>
        isElementVisible(img) || String(img.getAttribute('src') || '').trim().length > 0
      ).length;
      mode = 'rich';

      return len > 20 || expectedImages > 0 || currentImages > 0;
    } catch (error) {
      await report({
        status: 'running',
        stage: 'fillContent',
        devDetails: { message: `rich fill fallback: ${error instanceof Error ? error.message : String(error)}` },
      });
      return false;
    }
  })();

  const markdownFilled = richFilled
    ? false
    : await (async () => {
    try {
      await ensureTencentMarkdownMode();
      const model = getTencentMarkdownModel();

      if (expectedImages > 0) {
        for (let i = 1; i <= expectedImages; i += 1) {
          await report({
            status: 'running',
            stage: 'fillContent',
            userMessage: getMessage('v3MsgUploadingImageProgress', [String(i), String(expectedImages)]),
          });
        }
      }

      const markdown = buildTencentMarkdownFromTokens(tokens as Array<{ kind?: string; html?: string; src?: string; alt?: string }>, sourceUrl);
      let ok = false;
      if (model) {
        model.setValue(markdown);
        ok = true;
      } else {
        ok = await fillTencentMonacoByInput(markdown);
      }
      if (!ok) return false;

      ensureTencentMarkdownMinLength(minLen, sourceUrl);
      len = getTencentContentTextLen(sourceUrl);
      mode = 'markdown';
      return true;
    } catch (error) {
      await report({
        status: 'running',
        stage: 'fillContent',
        devDetails: { message: `markdown fill fallback: ${error instanceof Error ? error.message : String(error)}` },
      });
      return false;
    }
  })();

  if (!richFilled && !markdownFilled) {
    const editable = getTencentEditable();
    const editor = editable || findContentEditor(document);
    let target: HTMLElement | null = null;
    if (editor) {
      if ((editor as HTMLElement).getAttribute('contenteditable') === 'true') {
        target = editor as HTMLElement;
      } else {
        target = ((editor as HTMLElement).querySelector('[contenteditable="true"]') as HTMLElement | null) || null;
      }
    }

    if (target) {
      mode = 'rich';
      const existingText = (() => {
        try {
          return String(target.innerText || target.textContent || '');
        } catch {
          return '';
        }
      })();
      const existingHasSource = !!(sourceUrl && existingText.includes(sourceUrl));
      const existingOk =
        existingHasSource &&
        (expectedImages === 0 ||
          Array.from(target.querySelectorAll<HTMLImageElement>('img')).filter((img) => {
            const src = String(img.getAttribute('src') || '').trim();
            if (!src) return false;
            if (src.startsWith('blob:') || src.startsWith('data:')) return true;
            return !src.includes('qpic.cn') && !src.includes('qlogo.cn');
          }).length >= expectedImages);

      if (!existingOk) {
        try {
          await fillEditorByTokens({
            jobId: currentJob?.jobId || '',
            tokens,
            editorRoot: target,
            writeMode: 'html',
            ensureCaretAtEnd: true,
            onImageProgress: async (current, total) => {
              await report({
                status: 'running',
                stage: 'fillContent',
                userMessage: getMessage('v3MsgUploadingImageProgress', [String(current), String(total)]),
              });
            },
            insertImageAtCursorOverride: insertTencentImageAtCursor,
          });
        } catch (e) {
          await report({
            status: 'waiting_user',
            stage: 'waitingUser',
            userMessage: getMessage('v3MsgImageUploadFailed'),
            userSuggestion: getMessage('v3SugManualUploadImagesThenContinue'),
            devDetails: { message: e instanceof Error ? e.message : String(e) },
          });
          throw new Error('__BAWEI_V2_STOPPED__');
        }
      }

      await new Promise((r) => setTimeout(r, 300));

      len = getTextLen(target);
      if (len < minLen) {
        const currentText = (target.innerText || target.textContent || '').trim();
        const padded = ensureMinLengthText(currentText, 160, sourceUrl);
        const extra = padded.slice(currentText.length);
        if (extra) {
          try {
            document.execCommand('insertText', false, extra);
          } catch {
            // ignore
          }
          await new Promise((r) => setTimeout(r, 200));
          len = getTextLen(target);
        }
      }
    } else {
      mode = 'textarea';
      const textarea = (await waitForElement('textarea', 15000)) as HTMLTextAreaElement;
      simulateFocus(textarea);
      textarea.value = '';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const plain = ensureMinLengthText(htmlToPlainTextSafe(contentHtml), 160, sourceUrl);
      textarea.value = plain;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      len = plain.length;
    }
  }

  await report({
    userMessage: getMessage('v2MsgTencentContentWrittenLenNeedMin', [String(len), String(minLen)]),
    userSuggestion: len < minLen ? getMessage('v2SugContentTooShortMin140AlreadyAutoPadded') : undefined,
    devDetails: { mode, expectedImages, textLength: len },
  });

  await report({
    userMessage: getMessage('v2MsgAppendedSourceLinkKeepOriginal'),
    userSuggestion: getMessage('v2SugAdjustFormatAtEnd'),
  });
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSavingDraft') });
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').includes('保存草稿'));
  if (!btn) throw new Error('未找到保存草稿按钮');
  (btn as HTMLButtonElement).click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgTryingToPublish') });
  const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '发布');
  if (!btn) throw new Error('未找到发布按钮');
  (btn as HTMLButtonElement).click();

  // 发布弹窗：选择“原创”、添加至少一个标签，然后“确认发布”
  const confirm = await retryUntil(
    async () => {
      const c = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent || '').trim() === '确认发布');
      if (!c) throw new Error('confirm not ready');
      return c;
    },
    { timeoutMs: 15000, intervalMs: 400 }
  );

  const sidebar = (confirm.closest('section.col-editor-sidebar') as HTMLElement | null) || getTencentPublishSidebar() || null;

  // 选择“原创”（不选转载）
  try {
    await ensureTencentOriginalSelected(sidebar);
  } catch {
    // ignore
  }

  // 添加一个标签（必填）
  try {
    await ensureTencentTagSelected('前端', sidebar);
  } catch {
    // ignore
  }

  // 封面（部分账号/站点策略为必填）：自动用扩展 icon 作为占位封面
  try {
    await ensureTencentCoverUploaded(sidebar);
  } catch {
    // ignore
  }

  // 腾讯云校验：正文不少于 140 字；若不足则自动补足（避免确认发布后被拦截成草稿）
  try {
    const sourceUrl = currentJob?.article?.sourceUrl || '';
    const currentLen = getTencentContentTextLen(sourceUrl);
    if (currentLen < 140) {
      const editable = getTencentEditable();
      if (editable) {
        const html = withSourceUrlAppended(currentJob?.article?.contentHtml || '', sourceUrl);
        const plain = ensureMinLengthText(htmlToPlainTextSafe(html), 160, sourceUrl);
        simulateFocus(editable);
        try {
          document.execCommand('selectAll', false);
          document.execCommand('delete', false);
        } catch {
          // ignore
        }
        try {
          document.execCommand('insertText', false, plain);
        } catch {
          // ignore
        }
      } else {
        ensureTencentMarkdownMinLength(140, sourceUrl);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
    // ignore
  }

  if (!isTencentTitleCommitted(currentJob?.article?.title || '')) {
    await fillTencentTitleByNativeSetter(currentJob?.article?.title || '');
  }

  // 记录资源列表基线：后续在 confirmSuccess 阶段用来判断是否真正触发 CreateArticle
  try {
    publishProbeResourceIndex = performance.getEntriesByType('resource').length;
  } catch {
    publishProbeResourceIndex = null;
  }

  (confirm as HTMLButtonElement).click();
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  // 发布成功的 toast 文案在腾讯云站点上不稳定，而且页面本身也可能包含“已发布”等文案；
  // 为避免误判（导致提前跳转、只生成草稿不真正发布），publish 仅以 CreateArticle 请求为准。
  const okTexts = action === 'draft' ? ['草稿', '保存成功', '已保存'] : [];

  const deadline = Date.now() + (action === 'publish' ? 60000 : 20000);
  let fixAttempts = 0;
  const maxFixAttempts = 5;
  let createDetectedAt: number | null = null;
  let draftOnlyDetectedAt: number | null = null;
  while (Date.now() < deadline) {
    const text = document.body?.innerText || '';

    // 若发布后已跳转到详情页，优先直接进入详情页验收（避免列表检索误判/超时）。
    if (location.pathname.startsWith('/developer/article/') && !location.pathname.startsWith('/developer/article/write')) {
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgRedirectedToDetailStartVerify') });
      return;
    }

    if (action === 'publish' && fixAttempts < maxFixAttempts) {
      // 站点前端校验：标题/正文为空时，仍可能允许点击“确认发布”，随后 toast 报错并不触发发布。
      // 需要识别 toast 文案并自动补齐后再次点击确认发布。
      if (text.includes('请输入文章标题')) {
        fixAttempts += 1;
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: `检测到校验错误：请输入文章标题（自动补齐并重试 ${fixAttempts}/${maxFixAttempts}）`,
        });
        try {
          await fillTencentTitleByNativeSetter(currentJob?.article?.title || '');
        } catch {
          // ignore
        }
        try {
          const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
            (b) => (b.textContent || '').trim() === '确认发布'
          );
          if (confirmBtn && !confirmBtn.disabled) confirmBtn.click();
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }

      if (text.includes('请输入文章内容')) {
        fixAttempts += 1;
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: `检测到校验错误：请输入文章内容（自动补齐并重试 ${fixAttempts}/${maxFixAttempts}）`,
        });
        try {
          const sourceUrl = currentJob?.article?.sourceUrl || '';
          const html = withSourceUrlAppended(currentJob?.article?.contentHtml || '', sourceUrl);
          const plain = ensureMinLengthText(htmlToPlainTextSafe(html), 160, sourceUrl);
          const monacoOk = await fillTencentMonacoByInput(plain);
          if (!monacoOk) {
            const editable = getTencentEditable();
            if (editable) {
              simulateFocus(editable);
              try {
                document.execCommand('selectAll', false);
                document.execCommand('delete', false);
              } catch {
                // ignore
              }
              try {
                document.execCommand('insertText', false, plain);
              } catch {
                // ignore
              }
            } else {
              ensureTencentMarkdownMinLength(140, sourceUrl);
            }
          }
        } catch {
          // ignore
        }
        try {
          const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
            (b) => (b.textContent || '').trim() === '确认发布'
          );
          if (confirmBtn && !confirmBtn.disabled) confirmBtn.click();
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }

      if (text.includes('请选择文章标签') || text.includes('请添加文章标签')) {
        fixAttempts += 1;
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: `检测到校验错误：文章标签未选择（自动补齐并重试 ${fixAttempts}/${maxFixAttempts}）`,
        });
        try {
          await ensureTencentTagSelected('前端', getTencentPublishSidebar());
        } catch {
          // ignore
        }
        try {
          const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
            (b) => (b.textContent || '').trim() === '确认发布'
          );
          if (confirmBtn && !confirmBtn.disabled) confirmBtn.click();
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }

      if (text.includes('请上传文章封面') || text.includes('请选择文章封面')) {
        fixAttempts += 1;
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: `检测到校验错误：文章封面未上传（自动补齐并重试 ${fixAttempts}/${maxFixAttempts}）`,
        });
        try {
          await ensureTencentCoverUploaded(getTencentPublishSidebar());
        } catch {
          // ignore
        }
        try {
          const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
            (b) => (b.textContent || '').trim() === '确认发布'
          );
          if (confirmBtn && !confirmBtn.disabled) confirmBtn.click();
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
    }
    // 发布动作会先触发 CreateArticle（创建草稿/初次保存），随后才可能继续提交发布；
    // 若此处立刻跳走验收列表，可能把“发布动作”打断，导致最终只落草稿、不进入发布/审核流。
    if (action === 'publish' && hasArticleActionSince(publishProbeResourceIndex, 'CreateArticle')) {
      try {
        const title = String((document.querySelector('textarea.article-title') as HTMLTextAreaElement | null)?.value || '').trim();
        const sourceUrl = currentJob?.article?.sourceUrl || '';
        const len = getTencentContentTextLen(sourceUrl);
        if (!title || len < 20 || text.includes('请输入文章标题') || text.includes('请输入文章内容')) {
          throw new Error('create-article-but-content-missing');
        }
        if (createDetectedAt == null) {
          createDetectedAt = Date.now();
          await report({
            status: 'running',
            stage: 'confirmSuccess',
            userMessage: '检测到 CreateArticle（等待发布链路继续完成…）',
          });
        }
      } catch {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
    }

    if (action === 'publish' && createDetectedAt == null && hasArticleActionSince(publishProbeResourceIndex, 'CreateArticleDraft')) {
      if (draftOnlyDetectedAt == null) {
        draftOnlyDetectedAt = Date.now();
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: '检测到 CreateArticleDraft（仅草稿保存），继续等待真正发布请求…',
        });
      }
    }

    if (action === 'publish' && createDetectedAt != null) {
      const elapsed = Date.now() - createDetectedAt;
      const hasConfirmBtn = Array.from(document.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '确认发布');
      const successToastLike = ['发布成功', '提交成功', '已提交', '已发布', '发布完成'].some((t) => text.includes(t));
      if ((successToastLike || !hasConfirmBtn) && elapsed >= 5000) {
        await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgTencentCreateArticleDetectedStartVerify') });
        return;
      }
    }

    if (okTexts.length && okTexts.some((t) => text.includes(t))) {
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgSuccessDetectedStartVerify') });
      return;
    }

    // 若确认发布后被拦截（常见：正文不足 140 字），自动补足并再次点击确认发布
    if (action === 'publish' && text.includes('文章内容') && text.includes('140') && (text.includes('不能少于') || text.includes('不少于'))) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgContentTooShortAutoPadAndRepublish'),
      });
      try {
        const sourceUrl = currentJob?.article?.sourceUrl || '';
        const editable = getTencentEditable();
        if (editable) {
          const cur = ((editable.innerText || editable.textContent || '').trim() || '') as string;
          if (cur.length < 140) {
            const html = withSourceUrlAppended(currentJob?.article?.contentHtml || '', sourceUrl);
            const plain = ensureMinLengthText(htmlToPlainTextSafe(html), 160, sourceUrl);
            simulateFocus(editable);
            try {
              document.execCommand('selectAll', false);
              document.execCommand('delete', false);
            } catch {
              // ignore
            }
            try {
              document.execCommand('insertText', false, plain);
            } catch {
              // ignore
            }
          }
        } else {
          try {
            const html = withSourceUrlAppended(currentJob?.article?.contentHtml || '', sourceUrl);
            const plain = ensureMinLengthText(htmlToPlainTextSafe(html), 160, sourceUrl);
            await fillTencentMonacoByInput(plain);
          } catch {
            // ignore
          }
          ensureTencentMarkdownMinLength(140, sourceUrl);
        }
      } catch {
        // ignore
      }

      try {
        const confirmBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
          (b) => (b.textContent || '').trim() === '确认发布'
        );
        if (confirmBtn && !confirmBtn.disabled) confirmBtn.click();
      } catch {
        // ignore
      }

      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    if (action === 'draft' && location.pathname.startsWith('/developer/article/') && !location.pathname.startsWith('/developer/article/write')) {
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgRedirectedToDetailStartVerify') });
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  await report({
    status: 'waiting_user',
    stage: 'waitingUser',
    userMessage: action === 'draft' ? getMessage('v2MsgPleaseConfirmDraftSaved') : getMessage('v2MsgPleaseConfirmPublishCompleted'),
    userSuggestion: getMessage('v2SugHandleRequiredCaptchaModalThenContinueOrRetry'),
    devDetails:
      action === 'publish'
        ? {
            createArticleDetected: createDetectedAt != null,
            createArticleDraftDetected: draftOnlyDetectedAt != null,
          }
        : undefined,
  });
  if (currentJob) {
    removeSessionValue(getVerifyReadyKey(currentJob.jobId));
  }
  throw new Error('__BAWEI_V2_STOPPED__');
}

async function runFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredEditorPage') });
  removeSessionValue(getVerifyReadyKey(job.jobId));
  await stageDetectLogin();
  await stageFillTitle(job.article.title);
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl);
  if (job.action === 'draft') {
    await stageSaveDraft();
    await stageConfirmSuccess('draft');
  } else {
    await stageSubmitPublish();
    await stageConfirmSuccess('publish');
    if (isDetailPage()) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgRedirectedToDetailStartVerify'),
        devDetails: summarizeVerifyDetails({ publishedUrl: location.href, sourceUrlPresent: pageContainsSourceUrl(job.article.sourceUrl) }),
      });
      return;
    }
    setSessionValue(getVerifyReadyKey(job.jobId), 'publish');
    await report({
      status: 'running',
      stage: 'confirmSuccess',
      userMessage: getMessage('v2MsgPublishTriggeredGoManageListVerify'),
      devDetails: summarizeVerifyDetails({ listUrl: 'https://cloud.tencent.com/developer/creator/article' }),
    });
    location.href = 'https://cloud.tencent.com/developer/creator/article';
    return;
  }
}

async function bootstrap(): Promise<void> {
  if (!shouldRunOnThisPage()) return;
  try {
    const ctx = await getContextFromBackground();
    if (ctx.channelId !== CHANNEL_ID) return;
    currentJob = ctx.job;
    if (currentJob.stoppedAt) return;

    if (isEditorPage()) {
      await runFlow(currentJob);
      return;
    }

    if (isListPage()) {
      if (currentJob.action === 'publish' && getSessionValue(getVerifyReadyKey(currentJob.jobId)) !== 'publish') {
        await report({
          status: 'waiting_user',
          stage: 'waitingUser',
          userMessage: '腾讯云已到文章管理页，但当前轮未确认真实发布请求，停止自动验收',
          userSuggestion: getMessage('v2SugHandleRequiredCaptchaModalThenContinueOrRetry'),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
        });
        return;
      }

      currentStage = 'confirmSuccess';
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyFindNewArticleInList') });

      // 状态筛选：仅点击可点击元素，且文本 startsWith 匹配
      // 验收只应切到“已发布/审核中/全部”之一，避免误切到“草稿箱”导致无法找到新发布文章
      // 新发布文章大概率先进入“审核中”，因此优先尝试“全部/审核中”，避免遗漏
      const tabOrder = ['全部', '审核中', '已发布'];
      for (const name of tabOrder) {
        const clickable = Array.from(document.querySelectorAll<HTMLElement>('a,button')).find((n) =>
          ((n.textContent || '').trim() || '').startsWith(name)
        );
        if (clickable) {
          try {
            simulateClick(clickable);
            await new Promise((r) => setTimeout(r, 800));
          } catch {
            // ignore
          }
          break;
        }
      }

      // 用 title token 在列表里优先命中（避免依赖站点“搜索”组件）
      const token = tokenForSearch(currentJob.article.title);
      // 注意：页面上的“搜文章名称”组件会跳到全站搜索页（`/developer/search/article-`），且可能残留隐藏列表 DOM；
      // 验收不使用该组件，直接在“文章管理”列表里 probe 详情页直到命中 sourceUrl。

      const listUrl = location.href;
      setSessionValue(getListUrlKey(currentJob.jobId), listUrl);

      let listRoot = (document.querySelector('.com-2-course-panel-list') as HTMLElement | null) || null;
      try {
        listRoot = (await waitForElement('.com-2-course-panel-list', 12000)) as HTMLElement;
      } catch {
        // ignore
      }
      const root = listRoot || document.body;

      // 若站点渲染较慢，先等待列表至少出现 1 条详情链接，避免误入“空列表刷新循环”
      try {
        await retryUntil(
          async () => {
            const count = root.querySelectorAll('a[href*="/developer/article/"]').length;
            if (count > 0) return true;
            throw new Error('list not ready');
          },
          { timeoutMs: 15000, intervalMs: 500 }
        );
      } catch {
        // ignore
      }

      // 若分页不在第 1 页，会导致“最新文章”不在当前列表；尽量回到第 1 页再检索。
      try {
        const pager = document.querySelector<HTMLElement>('.tp1-pagination') as HTMLElement | null;
        const page1 =
          Array.from(pager?.querySelectorAll<HTMLElement>('.tp1-pagination__item') || []).find((n) => (n.textContent || '').trim() === '1') ||
          null;
        if (page1 && isElementVisible(page1) && !page1.classList.contains('is-active')) {
          simulateClick(page1);
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch {
        // ignore
      }

      const panels = Array.from(root.querySelectorAll<HTMLElement>('.cdc-2-course-panel')).filter((p) => isElementVisible(p));
      const panelLinks = panels
        .map((p) => p.querySelector<HTMLAnchorElement>('a[href*="/developer/article/"]')?.href || '')
        .map((href) => href.trim())
        .filter((href) => href.includes('/developer/article/') && !href.includes('/developer/article/write'));
      const uniq = Array.from(new Set(panelLinks));

      // token 命中优先（只在可见 panel 中检索，避免命中隐藏 DOM）
      const hitPanel = panels.find((p) => (p.textContent || '').includes(token)) || null;
      const panelLink = hitPanel?.querySelector<HTMLAnchorElement>('a[href*="/developer/article/"]') || null;

      const tokenLink =
        panelLink ||
        uniq
          .map((href) => {
            const a = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).find((it) => it.href === href) || null;
            return a && isElementVisible(a) ? a : null;
          })
          .find((a) => !!a && ((a.textContent || '') + ' ' + (a.getAttribute('title') || '')).includes(token)) ||
        null;
      if (tokenLink?.href) {
        removeSessionValue(getProbeActiveKey(currentJob.jobId));
        removeSessionValue(getProbeKey(currentJob.jobId));
        removeSessionValue(getListRetryKey(currentJob.jobId));
        removeSessionValue(getVerifyReadyKey(currentJob.jobId));
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyMatchedTokenBySearchOpeningDetail'),
          devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: tokenLink.href }),
        });
        location.href = tokenLink.href;
        return;
      }

      // 兜底探测：依次打开前 25 个详情链接，直到命中 sourceUrl
      setSessionValue(getProbeActiveKey(currentJob.jobId), '1');
      const idx = Number(getSessionValue(getProbeKey(currentJob.jobId)) || '0');
      const candidates = uniq.slice(0, 25);
      if (idx < candidates.length) {
        setSessionValue(getProbeKey(currentJob.jobId), String(idx + 1));
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyTokenNotMatchedProbingDetails', [String(idx + 1), String(candidates.length)]),
          devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: candidates[idx] }),
        });
        location.href = candidates[idx];
        return;
      }

      removeSessionValue(getProbeActiveKey(currentJob.jobId));
      removeSessionValue(getProbeKey(currentJob.jobId));
      {
        const retryKey = getListRetryKey(currentJob.jobId);
        const n = Number(getSessionValue(retryKey) || '0') + 1;
        setSessionValue(retryKey, String(n));
        if (n <= 24) {
          await report({
            status: 'running',
            stage: 'confirmSuccess',
            userMessage: getMessage('v2MsgVerifyListNoNewArticleRefresh3s24', [String(n)]),
            devDetails: summarizeVerifyDetails({ listUrl, listVisible: uniq.length > 0 }),
          });
          setTimeout(() => location.reload(), 3000);
          return;
        }

        removeSessionValue(retryKey);
        removeSessionValue(getVerifyReadyKey(currentJob.jobId));
        await report({
          status: 'waiting_user',
          stage: 'waitingUser',
          userMessage: getMessage('v2MsgVerifyFailedListNoArticleWithSourceLink'),
          userSuggestion: getMessage('v2SugConfirmPublishIndexedOrSearchTitleThenContinue'),
          devDetails: summarizeVerifyDetails({ listUrl, listVisible: false }),
        });
        return;
      }
    }

    if (isDetailPage()) {
      const ok = pageContainsSourceUrl(currentJob.article.sourceUrl);
      const probeActive = getSessionValue(getProbeActiveKey(currentJob.jobId)) === '1';
      const listUrl = getSessionValue(getListUrlKey(currentJob.jobId));
      if (!ok && probeActive && listUrl) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyNoSourceOnPageBackToListProbe'),
          devDetails: summarizeVerifyDetails({ listUrl, listVisible: true, publishedUrl: location.href, sourceUrlPresent: false }),
        });
        location.href = listUrl;
        return;
      }

      removeSessionValue(getVerifyReadyKey(currentJob.jobId));
      await report({
        status: ok ? 'success' : 'waiting_user',
        stage: ok ? 'done' : 'waitingUser',
        userMessage: ok ? getMessage('v2MsgVerifyPassedDetailHasSourceLink') : getMessage('v2MsgVerifyFailedDetailNoSourceLink'),
        userSuggestion: ok ? undefined : getMessage('v2SugCheckSourceLinkAtEndThenContinue'),
        devDetails: summarizeVerifyDetails({ publishedUrl: location.href, sourceUrlPresent: ok }),
      });
      return;
    }
  } catch (error) {
    if (error instanceof Error && error.message === '__BAWEI_V2_STOPPED__') return;
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
