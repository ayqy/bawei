/**
 * SSPAI Publisher Content Script (V2)
 *
 * Editor: https://sspai.com/write
 * - Title: textarea[placeholder*="标题"]
 * - Content: CKEditor editable div (.ck-editor__editable[contenteditable=true])
 *
 * Note:
 * - Some accounts require real-name verification to publish ("开始认证").
 *   In that case we set status=waiting_user and let the user handle it.
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */
/* INLINE:rich-content */
/* INLINE:image-bridge */

const CHANNEL_ID: ChannelId = 'sspai';

type AnyJob = Pick<PublishJob, 'jobId' | 'action' | 'article' | 'stoppedAt'>;

let currentJob: AnyJob | null = null;
let currentStage: ChannelRuntimeState['stage'] = 'init';
let stopRequested = false;
let lastMetaSnapshot: { tagInputPlaceholder: string; selectedTags: string[] } | null = null;
let expectedImagesForJob = 0;

(globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }).__BAWEI_V2_IS_STOP_REQUESTED = () => stopRequested;

function getMessage(key: string, substitutions?: string[]): string {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

const WRITE_URL = 'https://sspai.com/write';
const ENTRY_URL = 'https://sspai.com/my';

type SspaiArticleInfo = {
  data?: {
    id?: number;
    released_at?: number;
    body?: string;
    body_last?: string;
    title?: string;
    title_last?: string;
    banner?: string;
    banner_id?: number;
    type?: number;
    created_at?: number;
    words_count?: number;
    words_count_last?: number;
    tags?: unknown;
    allow_comment?: boolean;
    custom_tags?: unknown;
    token?: string;
    show_content_table?: boolean;
    delete_status?: boolean;
    free?: boolean;
    benefits_statement_on?: boolean;
    benefits_statement_id?: number;
    body_updated_at?: number;
  };
  error?: number;
  msg?: string;
};

function assertSspaiApiOk(payload: unknown, label: string): void {
  const p = (payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null) || {};
  const err = Number(p?.error || 0);
  if (!err) return;
  const msg = String(p?.msg || '').trim();
  throw new Error(msg ? `${label}: ${msg}` : `${label}: api error=${err}`);
}

function getSspaiJwt(): string {
  // SSPAI API 需要 Authorization Bearer；仅带 cookie 有时会返回“请登录”
  try {
    const t = localStorage.getItem('ssToken') || '';
    if (t) return t;
  } catch {
    // ignore
  }
  try {
    const raw = localStorage.getItem('vuex') || '';
    if (raw) {
      const parsed = JSON.parse(raw) as { token?: unknown } | null;
      const token = parsed && typeof parsed === 'object' ? String((parsed as { token?: unknown }).token || '') : '';
      if (token) return token;
    }
  } catch {
    // ignore
  }
  try {
    const m = String(document.cookie || '').match(/(?:^|;\s*)sspai_jwt_token=([^;]+)/);
    if (m?.[1]) return decodeURIComponent(m[1]);
  } catch {
    // ignore
  }
  return '';
}

function sspaiAuthHeaders(): Record<string, string> {
  const jwt = getSspaiJwt();
  return jwt ? { authorization: `Bearer ${jwt}` } : {};
}

function shouldRunOnThisPage(): boolean {
  if (location.hostname !== 'sspai.com') return false;
  if (location.pathname.startsWith('/write')) return true;
  if (location.pathname.startsWith('/post/')) return true;
  return true;
}

function isWritePage(): boolean {
  return location.hostname === 'sspai.com' && location.pathname.startsWith('/write');
}

function isDetailPage(): boolean {
  return location.hostname === 'sspai.com' && location.pathname.startsWith('/post/');
}

function isMyPage(): boolean {
  return location.hostname === 'sspai.com' && (location.pathname.startsWith('/my') || location.pathname.startsWith('/whoops'));
}

function isEditPage(): boolean {
  // After publishing, SSPAI typically redirects to /write#<id>
  return location.hostname === 'sspai.com' && location.pathname.startsWith('/write') && /#\d+/.test(location.hash || '');
}

function parseArticleIdFromHash(): string {
  const m = String(location.hash || '').match(/#(\d+)/);
  return m?.[1] || '';
}

async function waitForArticleId(): Promise<string> {
  return await retryUntil(
    async () => {
      const id = parseArticleIdFromHash();
      if (!id) throw new Error('article id not ready');
      return id;
    },
    { timeoutMs: 45_000, intervalMs: 600 }
  );
}

async function fetchArticleInfo(id: string): Promise<SspaiArticleInfo> {
  const url = `/api/v1/matrix/editor/article/single/info/get?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      accept: 'application/json, text/plain, */*',
      // 部分接口在缺少该 header 时会返回 HTML（导致 token 取不到）
      'x-requested-with': 'XMLHttpRequest',
      ...sspaiAuthHeaders(),
    },
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`fetch article info failed: ${res.status}`);
  if (!ct.includes('application/json')) {
    const snippet = await res
      .text()
      .then((t) => String(t || '').slice(0, 160))
      .catch(() => '');
    throw new Error(`fetch article info not json: ${ct || 'unknown'} ${snippet ? `| ${snippet}` : ''}`.trim());
  }
  const json = (await res.json().catch(() => ({}))) as SspaiArticleInfo;
  assertSspaiApiOk(json, 'fetch article info failed');
  return json;
}

async function updateArticleViaApi(payload: Record<string, unknown>): Promise<SspaiArticleInfo> {
  const res = await fetch('/api/v1/matrix/editor/article/update', {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      ...sspaiAuthHeaders(),
    },
    body: JSON.stringify(payload),
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`article update failed: ${res.status}`);
  if (!ct.includes('application/json')) {
    const snippet = await res
      .text()
      .then((t) => String(t || '').slice(0, 160))
      .catch(() => '');
    throw new Error(`article update not json: ${ct || 'unknown'} ${snippet ? `| ${snippet}` : ''}`.trim());
  }
  const json = (await res.json().catch(() => ({}))) as SspaiArticleInfo;
  assertSspaiApiOk(json, 'article update failed');
  return json;
}

type SspaiArticleAddResponse = {
  data?: {
    id?: number;
    token?: string;
  };
  error?: number;
  msg?: string;
};

async function createDraftArticleViaApi(title: string): Promise<{ articleId: string; token: string }> {
  const t = String(title || '').trim();
  if (!t) throw new Error('missing title');

  const payload = {
    type: 4,
    banner: '',
    banner_id: 0,
    title: t,
    title_last: t,
    body: '',
    body_last: '',
    allow_comment: true,
    tags: [],
    custom_tags: [],
    delete_status: false,
  };

  const res = await fetch('/api/v1/matrix/editor/article/add', {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      ...sspaiAuthHeaders(),
    },
    body: JSON.stringify(payload),
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`article add failed: ${res.status}`);
  if (!ct.includes('application/json')) {
    const snippet = await res
      .text()
      .then((t2) => String(t2 || '').slice(0, 160))
      .catch(() => '');
    throw new Error(`article add not json: ${ct || 'unknown'} ${snippet ? `| ${snippet}` : ''}`.trim());
  }
  const json = (await res.json().catch(() => ({}))) as SspaiArticleAddResponse;
  assertSspaiApiOk(json, 'article add failed');

  const id = String(json?.data?.id || '').trim();
  const token = String(json?.data?.token || '').trim();
  if (!id) throw new Error('article add missing id');
  return { articleId: id, token };
}

type SspaiAttachmentUploadItem = {
  source_url?: string;
  download_url?: string;
  status?: number;
  msg?: string;
};

type SspaiAttachmentUploadResponse = {
  data?: SspaiAttachmentUploadItem[];
  error?: number;
  msg?: string;
};

function extractOriginalImageUrlFromProxyUrl(proxyUrl: string): string {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.hostname !== 'read.useai.online') return '';
    if (u.pathname !== '/api/image-proxy') return '';
    const inner = u.searchParams.get('url');
    return inner ? String(inner || '').trim() : '';
  } catch {
    return '';
  }
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    if (!ct.includes('application/json')) {
      const snippet = await res
        .text()
        .then((t) => String(t || '').slice(0, 160))
        .catch(() => '');
      throw new Error(`fetch not json: ${ct || 'unknown'} ${snippet ? `| ${snippet}` : ''}`.trim());
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function uploadPictureUrlToSspaiCdn(pictureUrl: string): Promise<string> {
  const src = String(pictureUrl || '').trim();
  if (!src) return '';
  if (src.includes('cdnfile.sspai.com/')) return src;

  const candidates: string[] = [];
  const original = extractOriginalImageUrlFromProxyUrl(src);
  if (original) candidates.push(original);
  candidates.push(src);

  let lastErr = '';
  for (const candidate of candidates) {
    try {
      const json = (await fetchJsonWithTimeout(
        '/api/v1/matrix/editor/attachment/batch/upload',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-requested-with': 'XMLHttpRequest',
            ...sspaiAuthHeaders(),
          },
          body: JSON.stringify({ pictures: [candidate] }),
        },
        240_000
      )) as SspaiAttachmentUploadResponse;
      assertSspaiApiOk(json, 'attachment batch upload failed');
      const item = Array.isArray(json?.data) ? json.data[0] : null;
      const downloadUrl = String(item?.download_url || '').trim();
      const status = Number(item?.status || 0);
      if (!downloadUrl) throw new Error('missing download_url');
      if (status && status !== 2) throw new Error(`upload status=${status}`);
      return downloadUrl;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr || 'attachment upload failed');
}

async function saveBodyLastViaUpdateApi(articleId: string, bodyLast: string): Promise<void> {
  const info = await fetchArticleInfo(articleId);
  const data = info?.data || {};
  const token = String(data?.token || '').trim();
  if (!token) throw new Error('missing article token');

  const payload: Record<string, unknown> = {
    id: Number(articleId),
    title: String(data?.title_last || data?.title || ''),
    title_last: String(data?.title_last || data?.title || ''),
    body: bodyLast,
    body_last: bodyLast,
    banner: String(data?.banner || ''),
    banner_id: Number(data?.banner_id || 0),
    type: Number(data?.type || 4),
    created_at: Number(data?.created_at || 0),
    released_at: Number(data?.released_at || 0),
    words_count: Number(data?.words_count || 0),
    words_count_last: Number(data?.words_count_last || 0),
    tags: Array.isArray(data?.tags) ? data?.tags : [],
    allow_comment: data?.allow_comment !== false,
    custom_tags: Array.isArray((data as { custom_tags?: unknown }).custom_tags) ? (data as { custom_tags?: unknown }).custom_tags : [],
    token,
    show_content_table: Boolean(data?.show_content_table),
    delete_status: Boolean(data?.delete_status),
    free: data?.free !== false,
    benefits_statement_on: Boolean(data?.benefits_statement_on),
    benefits_statement_id: Number(data?.benefits_statement_id || 0),
    body_updated_at: Number(data?.body_updated_at || 0),
  };

  await updateArticleViaApi(payload);
}

async function tryPublishViaApi(articleId: string, preferredTags: string[]): Promise<boolean> {
  try {
    const info = await fetchArticleInfo(articleId);
    const data = info?.data || {};
    const token = String(data?.token || '').trim();
    if (!token) return false;

    const tags = Array.from(new Set((preferredTags || []).map((t) => String(t || '').trim()).filter(Boolean))).slice(0, 8);
    const customTags = tags.length ? tags : ['AI'];

    const bodyLast = String(data?.body_last || data?.body || '').trim();
    if (!bodyLast) return false;

    const payload: Record<string, unknown> = {
      id: Number(articleId),
      title: String(data?.title_last || data?.title || ''),
      title_last: String(data?.title_last || data?.title || ''),
      body: bodyLast,
      body_last: bodyLast,
      banner: String(data?.banner || ''),
      banner_id: Number(data?.banner_id || 0),
      type: 5,
      created_at: Number(data?.created_at || 0),
      released_at: 0,
      words_count: Number(data?.words_count || 0),
      words_count_last: Number(data?.words_count_last || 0),
      tags: Array.isArray(data?.tags) ? data?.tags : [],
      allow_comment: data?.allow_comment !== false,
      custom_tags: customTags,
      token,
      show_content_table: Boolean(data?.show_content_table),
      delete_status: Boolean(data?.delete_status),
      free: data?.free !== false,
      benefits_statement_on: Boolean(data?.benefits_statement_on),
      benefits_statement_id: Number(data?.benefits_statement_id || 0),
      body_updated_at: Number(data?.body_updated_at || 0),
    };

    await updateArticleViaApi(payload);
    return true;
  } catch {
    return false;
  }
}

function containsSourceUrlInHtml(html: string, url: string): boolean {
  if (!html || !url) return false;
  return html.includes(url);
}

type HtmlImageAnalysis = {
  total: number;
  withSrc: number;
  emptySrc: number;
  srcs: string[];
};

function analyzeImagesInHtml(html: string): HtmlImageAnalysis {
  const h = String(html || '');
  const tags = h.match(/<img\b[^>]*>/gi) || [];
  const srcs: string[] = [];
  let emptySrc = 0;
  for (const tag of tags) {
    const m = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const src = String(m?.[1] || m?.[2] || m?.[3] || '').trim();
    if (src) srcs.push(src);
    else emptySrc += 1;
  }
  return { total: tags.length, withSrc: srcs.length, emptySrc, srcs };
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

function findButtonExact(text: string): HTMLButtonElement | null {
  const btns = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  return btns.find((b) => (b.textContent || '').replace(/\s+/g, ' ').trim() === text) || null;
}

function isDialogVisible(el: HTMLElement): boolean {
  try {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (rect.width < 50 || rect.height < 50) return false;
    return true;
  } catch {
    return false;
  }
}

function findVisibleDialogContainingText(text: string): HTMLElement | null {
  const needle = String(text || '').trim();
  if (!needle) return null;
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('.el-dialog[role="dialog"],.el-dialog.ss-dialog[role="dialog"],[role="dialog"].ss-dialog')
  );
  return (
    candidates.find((el) => {
      if (!isDialogVisible(el)) return false;
      const t = String(el.innerText || el.textContent || '').trim();
      return t.includes(needle);
    }) || null
  );
}

function clickDialogButtonByText(root: HTMLElement, text: string): boolean {
  const target = String(text || '').trim();
  if (!target) return false;
  const isVisible = (el: HTMLElement): boolean => {
    try {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return rect.width > 6 && rect.height > 6;
    } catch {
      return false;
    }
  };

  const isClickable = (el: HTMLElement): boolean => {
    if (el.matches('button,a,[role="button"]')) return true;
    try {
      return window.getComputedStyle(el).cursor === 'pointer';
    } catch {
      return false;
    }
  };

  const nodes = Array.from(root.querySelectorAll<HTMLElement>('button,[role="button"],a,div,span'));
  const hit =
    nodes.find((b) => isVisible(b) && isClickable(b) && (b.textContent || '').replace(/\s+/g, ' ').trim() === target) ||
    nodes.find((b) => isVisible(b) && isClickable(b) && (b.textContent || '').replace(/\s+/g, ' ').trim().includes(target)) ||
    null;
  if (!hit) return false;
  try {
    try {
      simulateClick(hit);
    } catch {
      hit.click();
    }
    return true;
  } catch {
    return false;
  }
}

function getVisibleTextSnippet(el: HTMLElement, maxLen = 240): string {
  try {
    const txt = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt) return '';
    return txt.length > maxLen ? `${txt.slice(0, maxLen)}…` : txt;
  } catch {
    return '';
  }
}

function getTagInput(): HTMLInputElement | null {
  const selectors = [
    '.attr-form.tag input.multiselect__input',
    '.attr-form.tag input[placeholder*="标签"]',
    '.attr-form.tag input[type="text"]',
    'input[placeholder*="回车"][placeholder*="标签"]',
    'input[placeholder*="回车键确认标签"]',
    'input[placeholder*="确认标签"]',
    'input[placeholder*="标签"]',
  ];
  for (const selector of selectors) {
    const el = document.querySelector<HTMLInputElement>(selector);
    if (!el) continue;
    return el;
  }
  return null;
}

function collectSelectedTagsNearInput(input: HTMLInputElement): string[] {
  const root =
    (input.closest<HTMLElement>('.attr-form.tag') as HTMLElement | null) ||
    (input.closest<HTMLElement>('.multiselect') as HTMLElement | null) ||
    input.closest('div') ||
    input.parentElement;
  if (!root) return [];

  const selectedFromMultiselect = Array.from(root.querySelectorAll<HTMLElement>('.multiselect__tag, .multiselect__tags-wrap .multiselect__tag'))
    .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((t) => t.length <= 12);
  if (selectedFromMultiselect.length) return Array.from(new Set(selectedFromMultiselect)).slice(0, 8);

  const texts = Array.from(root.querySelectorAll<HTMLElement>('span,div,a'))
    .filter((n) => !n.closest('.multiselect__content-wrapper')) // 排除候选下拉列表
    .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((t) => t.length <= 12 && t !== input.value && !t.includes('标签') && !t.includes('搜索') && !t.includes('回车') && t !== '暂无数据');
  return Array.from(new Set(texts)).slice(0, 8);
}

function refreshMetaSnapshot(): void {
  const input = getTagInput();
  if (!input) {
    lastMetaSnapshot = {
      tagInputPlaceholder: '',
      selectedTags: [],
    };
    return;
  }
  lastMetaSnapshot = {
    tagInputPlaceholder: input.getAttribute('placeholder') || '',
    selectedTags: collectSelectedTagsNearInput(input),
  };
}

async function ensureAtLeastOneTag(): Promise<void> {
  const input = getTagInput();
  if (!input) return;
  const existing = collectSelectedTagsNearInput(input);
  if (existing.length) return;

  const tagRoot =
    (input.closest<HTMLElement>('.attr-form.tag') as HTMLElement | null) ||
    (input.closest<HTMLElement>('.multiselect') as HTMLElement | null) ||
    null;

  const candidates = ['AI', '应用', '开发', 'iOS', '效率'];
  for (const tag of candidates) {
    try {
      try {
        input.scrollIntoView({ block: 'center' });
      } catch {
        // ignore
      }
      if (tagRoot) {
        const tagsBox = tagRoot.querySelector<HTMLElement>('.multiselect__tags') || tagRoot;
        try {
          simulateClick(tagsBox);
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 160));
      }

      simulateFocus(input);
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      simulateType(input, tag);
      await new Promise((r) => setTimeout(r, 650));

      if (tagRoot) {
        await retryUntil(
          async () => {
            const opts = Array.from(tagRoot.querySelectorAll<HTMLElement>('.multiselect__option'));
            if (opts.length) return true;
            throw new Error('tag options not ready');
          },
          { timeoutMs: 6000, intervalMs: 450 }
        ).catch(() => false);
      }

      const pick =
        (tagRoot
          ? Array.from(tagRoot.querySelectorAll<HTMLElement>('.multiselect__option')).find(
              (n) => (n.textContent || '').replace(/\s+/g, ' ').trim() === tag
            )
          : null) ||
        null;
      if (pick) {
        simulateClick(pick);
      } else {
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }));
      }

      const ok = await retryUntil(
        async () => {
          const after = collectSelectedTagsNearInput(input);
          if (after.length) return true;
          throw new Error('waiting tag selected');
        },
        { timeoutMs: 6000, intervalMs: 400 }
      )
        .then(() => true)
        .catch(() => false);

      if (ok) {
        refreshMetaSnapshot();
        return;
      }
    } catch {
      // ignore
    }
  }
}

async function fillCoverIfPossible(articleId?: string): Promise<void> {
  try {
    const coverTrigger =
      Array.from(document.querySelectorAll<HTMLElement>('button,div,a,span')).find((n) =>
        ['添加题图', '替换图片', '上传题图'].some((t) => (n.textContent || '').includes(t))
      ) || null;
    if (coverTrigger) {
      try {
        simulateClick(coverTrigger);
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 260));
    }

    const candidates = await retryUntil(
      async () => {
        const nodes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter((el) => {
          const accept = String(el.getAttribute('accept') || '').toLowerCase();
          return (
            accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg') || accept.includes('gif')
          );
        });
        if (!nodes.length) throw new Error('cover input not ready');
        return nodes;
      },
      { timeoutMs: 15_000, intervalMs: 500 }
    ).catch(() => []);

    const scored = candidates
      .map((input) => {
        const name = String(input.getAttribute('name') || '').toLowerCase();
        const id = String(input.id || '').toLowerCase();
        const cls = String(input.className || '').toLowerCase();
        const parentText = String(input.closest('section,div,form,article')?.textContent || '').slice(0, 240).toLowerCase();
        let score = 0;
        if (name.includes('banner') || id.includes('banner') || cls.includes('banner')) score += 10;
        if (name.includes('cover') || id.includes('cover') || cls.includes('cover')) score += 10;
        if (cls.includes('upload-input')) score += 8;
        if (parentText.includes('题图') || parentText.includes('封面')) score += 10;
        if (parentText.includes('插图') || parentText.includes('正文')) score -= 6;
        return { input, score };
      })
      .sort((a, b) => b.score - a.score);

    const input = scored[0]?.input || null;
    if (!input) return;
    if (input.files && input.files.length > 0) return;

    // NOTE: SSPAI 题图可能要求较大尺寸（页面提示 1600x1200）；使用扩展 icon-128 很可能被拒绝。
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1200;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#f5f6f7';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#222';
      ctx.globalAlpha = 0.12;
      ctx.fillRect(0, 0, canvas.width, 160);
      ctx.globalAlpha = 1;
    }

    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92);
      } catch {
        resolve(null);
      }
    });
    if (!blob) return;
    const file = new File([blob], 'cover.jpg', { type: blob.type || 'image/jpeg' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 1500));

    if (articleId) {
      await retryUntil(
        async () => {
          const info = await fetchArticleInfo(articleId);
          const bannerId = Number(info?.data?.banner_id || 0);
          if (bannerId) return true;
          throw new Error('waiting banner_id update');
        },
        { timeoutMs: 20_000, intervalMs: 1200 }
      ).catch(() => false);
    }
  } catch {
    // ignore
  }
}

function collectPublishBlockersSnapshot(): Record<string, unknown> {
  const editorOpen = findVisibleDialogContainingText('本文编辑窗口已打开');
  const publishDialog = findVisibleDialogContainingText('选择发布通道');
  const tagInput = getTagInput();
  const tags = tagInput ? collectSelectedTagsNearInput(tagInput) : lastMetaSnapshot?.selectedTags || [];

  const toastSelectors = ['.el-message', '.el-notification', '.toast', '.ss-toast', '[role="alert"]'];
  const toasts = toastSelectors
    .flatMap((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel)))
    .filter((el) => isDialogVisible(el))
    .map((el) => getVisibleTextSnippet(el, 180))
    .filter(Boolean)
    .slice(0, 5);

  const publishBtn = publishDialog?.querySelector<HTMLButtonElement>('button.btn__submit') || null;

  return {
    url: location.href,
    editorAlreadyOpenDialog: editorOpen ? getVisibleTextSnippet(editorOpen) : '',
    publishChannelDialog: publishDialog ? getVisibleTextSnippet(publishDialog) : '',
    publishDialogSubmitDisabled: publishBtn ? publishBtn.disabled || publishBtn.getAttribute('aria-disabled') === 'true' : null,
    tagInputPlaceholder: tagInput?.getAttribute('placeholder') || lastMetaSnapshot?.tagInputPlaceholder || '',
    selectedTags: tags,
    toastTexts: toasts,
  };
}

async function dismissEditorAlreadyOpenDialog(): Promise<boolean> {
  const dialog = findVisibleDialogContainingText('本文编辑窗口已打开');
  if (!dialog) return false;
  // ⚠️ 不要点击“返回”：会离开当前页，导致未保存内容丢失。
  const headerClose =
    dialog.querySelector<HTMLElement>('.el-dialog__headerbtn,.el-dialog__header .el-icon-close,[aria-label="Close"]') || null;
  const clicked = (headerClose && (() => {
    try {
      simulateClick(headerClose);
      return true;
    } catch {
      try {
        headerClose.click();
        return true;
      } catch {
        return false;
      }
    }
  })()) || clickDialogButtonByText(dialog, '关闭');

  if (!clicked) return false;

  await retryUntil(
    async () => {
      const still = findVisibleDialogContainingText('本文编辑窗口已打开');
      if (still) throw new Error('dialog still visible');
      return true;
    },
    { timeoutMs: 15_000, intervalMs: 400 }
  ).catch(() => false);
  return true;
}

function findPublishButtonOnWritePage(): HTMLElement | null {
  const isVisible = (el: HTMLElement): boolean => {
    try {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      return rect.width > 8 && rect.height > 8;
    } catch {
      return false;
    }
  };

  const btnByClass = Array.from(document.querySelectorAll<HTMLButtonElement>('button.btn__submit,button.el-button--primary,button'))
    .filter((b) => isVisible(b))
    .map((b) => ({ el: b as HTMLElement, text: (b.textContent || '').replace(/\s+/g, ' ').trim() }))
    .filter((b) => b.text)
    .filter((b) => b.text === '发布' || b.text === '立即发布' || b.text.includes('发布'))
    .filter((b) => !b.el.closest('.el-dialog[role="dialog"],.ss-dialog,[role="dialog"]')) // 排除弹窗内按钮（弹窗由单独逻辑处理）
    .sort((a, b) => {
      const score = (x: { el: HTMLElement; text: string }) => {
        let s = 0;
        if (x.text === '发布') s += 10;
        if (x.text === '立即发布') s += 8;
        if (x.el.classList.contains('btn__submit')) s += 6;
        if (x.el.className.includes('primary')) s += 2;
        return s;
      };
      return score(b) - score(a);
    });

  return btnByClass[0]?.el || null;
}

async function dismissWelcomeWriteDialog(): Promise<boolean> {
  const dialog =
    findVisibleDialogContainingText('欢迎你在少数派写作分享') ||
    findVisibleDialogContainingText('少数派创作手册') ||
    findVisibleDialogContainingText('现在开始创作') ||
    null;
  if (!dialog) return false;

  clickDialogButtonByText(dialog, '开始创作') ||
    clickDialogButtonByText(dialog, '确定') ||
    clickDialogButtonByText(dialog, '关闭') ||
    clickDialogButtonByText(dialog, '返回');

  await retryUntil(
    async () => {
      const still =
        findVisibleDialogContainingText('欢迎你在少数派写作分享') ||
        findVisibleDialogContainingText('少数派创作手册') ||
        findVisibleDialogContainingText('现在开始创作') ||
        null;
      if (still) throw new Error('welcome dialog still visible');
      return true;
    },
    { timeoutMs: 12_000, intervalMs: 400 }
  ).catch(() => false);
  return true;
}

async function handlePublishChannelDialog(): Promise<boolean> {
  const dialog = findVisibleDialogContainingText('选择发布通道');
  if (!dialog) return false;

  const isSelected = (el: HTMLElement): boolean => {
    const cls = String(el.className || '');
    if (/active|selected|checked|current|is-active|is-selected/i.test(cls)) return true;
    const ariaSelected = el.getAttribute('aria-selected');
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaSelected === 'true' || ariaChecked === 'true') return true;
    const input = el.querySelector<HTMLInputElement>('input[type="radio"],input[type="checkbox"]');
    if (input?.checked) return true;
    return false;
  };

  const options = Array.from(dialog.querySelectorAll<HTMLElement>('.contribute-option'));
  const chooseImmediate = options.find((el) => String(el.innerText || '').includes('立即发布')) || options[0] || null;
  const chooseEditorial = options.find((el) => String(el.innerText || '').includes('投稿编辑部')) || null;
  if (chooseImmediate) {
    try {
      simulateClick(chooseImmediate);
    } catch {
      // ignore
    }
  }

  await new Promise((r) => setTimeout(r, 260));

  if (chooseImmediate && !isSelected(chooseImmediate)) {
    const inner =
      (chooseImmediate.querySelector<HTMLElement>('label,[role="button"],button,input') as HTMLElement | null) || chooseImmediate;
    try {
      simulateClick(inner);
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 260));
  }

  if (chooseImmediate && chooseEditorial && isSelected(chooseEditorial) && !isSelected(chooseImmediate)) {
    try {
      simulateClick(chooseImmediate);
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 260));
  }

  const modalPublish =
    (dialog.querySelector<HTMLButtonElement>('button.btn__submit') as HTMLButtonElement | null) ||
    (Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent || '').replace(/\s+/g, ' ').trim() === '发布'
    ) as HTMLButtonElement | null) ||
    null;

  if (modalPublish) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && (modalPublish.disabled || modalPublish.getAttribute('aria-disabled') === 'true')) {
      if (chooseImmediate) {
        try {
          simulateClick(chooseImmediate);
        } catch {
          // ignore
        }
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    try {
      simulateClick(modalPublish);
    } catch {
      // ignore
    }
  }

  const dismissed = await retryUntil(
    async () => {
      const still = findVisibleDialogContainingText('选择发布通道');
      if (still) throw new Error('publish dialog still visible');
      return true;
    },
    { timeoutMs: 20_000, intervalMs: 500 }
  )
    .then(() => true)
    .catch(() => false);

  return dismissed;
}

async function stageDetectLogin(): Promise<void> {
  currentStage = 'detectLogin';
  await report({ status: 'running', stage: 'detectLogin', userMessage: getMessage('v3MsgDetectingLogin') });

  const loginState = detectPageLoginState({
    loginUrlPattern: /(^|[/?#&])(login|signin|passport|oauth|auth)([/?#&]|$)/i,
    loggedInPattern: /写文章|草稿|发布|账号设置|少数派|退出登录|我的文章/i,
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
  await report({ status: 'running', stage: 'fillTitle', userMessage: getMessage('v2MsgFillingTitle') });

  const input = (await waitForElement<HTMLTextAreaElement>('textarea[placeholder*="标题"]', 30000)) as HTMLTextAreaElement;
  simulateFocus(input);
  try {
    input.value = title;
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } catch {
    simulateType(input, title);
  }
}

async function stageFillContent(contentHtml: string, sourceUrl: string, articleId: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgFillingContent'),
    userSuggestion: getMessage('v2SugSspaiNoSourceFieldAppend'),
  });

  // SSPAI 对排版（加粗/段落/换行）较敏感：不要使用微信提取时生成的“plain tokens”，
  // 这里直接基于 contentHtml 重建 raw tokens，尽可能保留原始 HTML 结构。
  const tokens = buildRichContentTokens({ contentHtml, baseUrl: sourceUrl, sourceUrl, htmlMode: 'raw' });

  const plainLen = tokens
    .filter((t) => t?.kind === 'html')
    .map((t) => htmlToPlainTextSafe((t as { html?: string }).html || ''))
    .join('\n')
    .replace(/\s+/g, '')
    .length;

  if (plainLen < 120) {
    let pad = '（内容来自原文链接，更多细节请查看原文。）';
    while (pad.replace(/\s+/g, '').length < 140) pad += '。';
    const padHtml = `<p>${pad}</p>`;
    const last = tokens[tokens.length - 1];
    if (last?.kind === 'html' && sourceUrl && String((last as { html?: string }).html || '').includes(sourceUrl)) {
      tokens.splice(tokens.length - 1, 0, { kind: 'html', html: padHtml });
    } else {
      tokens.push({ kind: 'html', html: padHtml });
    }
  }

  const escapeAttr = (value: string): string =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const buildBodyHtml = (
    items: Array<{ kind?: string; html?: string; src?: string; alt?: string }>,
    imageUrlMap: Map<string, string>
  ): string =>
    items
      .map((token) => {
        if (!token) return '';
        if (token.kind === 'html') return String(token.html || '');
        if (token.kind === 'image') {
          const originalSrc = String(token.src || '').trim();
          const mapped = String(imageUrlMap.get(originalSrc) || '').trim();
          const src = escapeAttr(mapped || originalSrc);
          if (!src) return '<p><br/></p>';
          const alt = escapeAttr(String(token.alt || '').trim());
          return `<figure class="image ss-img-wrapper"><img src="${src}"${alt ? ` alt="${alt}"` : ''} /></figure>`;
        }
        return '';
      })
      .join('\n');

  // 注意：少数派最终要求图片落到自己的 CDN；因此这里不直接保存 image-proxy URL，
  // 而是先 batch/upload 得到 download_url 后再写回 body_last。

  const expectedImages = tokens.filter((t) => t?.kind === 'image').length;
  expectedImagesForJob = expectedImages;

  // SSPAI 图片需要异步上传到 CDN，且部分情况下 editor auto-save 会被 3006 阻塞。
  // 这里主动走 batch/upload 拿到 download_url，再通过 article/update 写回 body_last，避免“空 src 落稿”。
  const imageTokens = (tokens as Array<{ kind?: string; src?: string }>).filter((t) => t?.kind === 'image');
  const uniqueImages = Array.from(
    new Set(
      imageTokens
        .map((t) => String(t?.src || '').trim())
        .filter(Boolean)
    )
  );

  const imageUrlMap = new Map<string, string>();
  for (let i = 0; i < uniqueImages.length; i += 1) {
    await report({
      status: 'running',
      stage: 'fillContent',
      userMessage: getMessage('v3MsgUploadingImageProgress', [String(i + 1), String(uniqueImages.length)]),
    });
    const src = uniqueImages[i];
    if (imageUrlMap.has(src)) continue;
    const downloadUrl = await uploadPictureUrlToSspaiCdn(src);
    if (downloadUrl) imageUrlMap.set(src, downloadUrl);
  }

  const htmlForSave = buildBodyHtml(tokens as Array<{ kind?: string; html?: string; src?: string; alt?: string }>, imageUrlMap);
  await saveBodyLastViaUpdateApi(articleId, htmlForSave);

  // 非写作页（例如 /my）不需要操作编辑器 DOM；写作页仅用于“可视化回填”，失败也不阻塞。
  if (isWritePage()) {
    const editor = await retryUntil(
      async () => {
        const el =
          (document.querySelector<HTMLElement>('.ck-editor__editable[contenteditable="true"]') as HTMLElement | null) ||
          (document.querySelector<HTMLElement>('.ck-editor__editable') as HTMLElement | null) ||
          (document.querySelector<HTMLElement>('.x-editor-inst.wangEditor-txt') as HTMLElement | null) ||
          (document.querySelector<HTMLElement>('[class*="ck-editor__editable"]') as HTMLElement | null) ||
          (findContentEditor(document) as HTMLElement | null) ||
          null;
        if (!el) throw new Error('editor not ready');
        const rect = el.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 80) throw new Error('editor not visible');

        try {
          simulateClick(el);
          simulateFocus(el);
          if (el.getAttribute('contenteditable') !== 'true') {
            el.setAttribute('contenteditable', 'true');
          }
        } catch {
          // ignore
        }
        return el;
      },
      { timeoutMs: 30_000, intervalMs: 800 }
    ).catch(() => null);

    if (editor) {
      const existingHtml = (() => {
        try {
          return String(editor.innerHTML || '');
        } catch {
          return '';
        }
      })();
      const existingHasSource = !!(sourceUrl && existingHtml.includes(sourceUrl));
      const existingImageAnalysis = analyzeImagesInHtml(existingHtml);
      const existingOk =
        existingHasSource &&
        (expectedImages === 0 ||
          (existingImageAnalysis.withSrc >= expectedImages && existingImageAnalysis.emptySrc === 0));

      if (!existingOk) {
        await fillEditorByTokens({
          jobId: currentJob?.jobId || '',
          tokens: [{ kind: 'html', html: htmlForSave }],
          editorRoot: editor,
          writeMode: 'html',
        }).catch(() => {});
      }
    }
  }

  const baselineInfo = await fetchArticleInfo(articleId).catch(() => null);
  const baselineBody = String(baselineInfo?.data?.body_last || baselineInfo?.data?.body || '');
  const baselineLen = baselineBody.replace(/\s+/g, '').length;
  const sourceHost = (() => {
    try {
      return new URL(sourceUrl).hostname;
    } catch {
      return '';
    }
  })();

  const uploadTimeoutMs = expectedImages ? Math.min(20 * 60_000, 180_000 + expectedImages * 120_000) : 120_000;
  const persisted = await retryUntil(
    async () => {
      const info = await fetchArticleInfo(articleId);
      const bodyLast = String(info?.data?.body_last || info?.data?.body || '');
      if (!bodyLast) throw new Error('waiting body_last update');

      const normalized = bodyLast.replace(/\s+/g, '');
      const hasSource = containsSourceUrlInHtml(bodyLast, sourceUrl) || (sourceHost && normalized.includes(sourceHost.replace(/\s+/g, '')));
      const imgAnalysis = analyzeImagesInHtml(bodyLast);
      const imgCount = imgAnalysis.total;
      const imgWithSrc = imgAnalysis.withSrc;
      const imgEmptySrc = imgAnalysis.emptySrc;
      const imgOk = expectedImages ? imgWithSrc >= expectedImages && imgEmptySrc === 0 : true;
      const notDowngraded = !bodyLast.includes('图片：');

      if (expectedImages) {
        await report({
          status: 'running',
          stage: 'fillContent',
          userMessage: getMessage('v3MsgUploadingImageProgress', [String(Math.min(imgWithSrc, expectedImages)), String(expectedImages)]),
        });
      }

      if (hasSource && imgOk && notDowngraded) return true;
      if (normalized.length > Math.max(baselineLen + 80, 240) && imgOk && notDowngraded) return true;
      throw new Error(`waiting body_last update (imgSrc=${imgWithSrc}/${expectedImages || 0}, empty=${imgEmptySrc}, total=${imgCount})`);
    },
    { timeoutMs: uploadTimeoutMs, intervalMs: 1200 }
  ).catch(() => false);

  if (!persisted) {
    await report({
      status: 'waiting_user',
      stage: 'waitingUser',
      userMessage: getMessage('v3MsgImageUploadFailed'),
      userSuggestion: getMessage('v3SugManualUploadImagesThenContinue'),
      devDetails: { message: 'SSPAI: body_last 未包含足够图片或仍为降级占位（图片：），已停止以避免发布缺图文章' },
    });
    throw new Error('__BAWEI_V2_STOPPED__');
  }
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSavingDraft') });
  const btn = findButtonExact('保存') || findAnyElementContainingText('保存');
  if (!btn) throw new Error('未找到保存按钮');
  (btn as HTMLElement).click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishing') });

  await dismissWelcomeWriteDialog().catch(() => false);
  await dismissEditorAlreadyOpenDialog().catch(() => false);

  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgSettingTags') });
  await retryUntil(
    async () => {
      const input = getTagInput();
      if (!input) throw new Error('tag input not ready');
      return true;
    },
    { timeoutMs: 15_000, intervalMs: 500 }
  ).catch(() => false);
  await ensureAtLeastOneTag();
  refreshMetaSnapshot();
  await fillCoverIfPossible(parseArticleIdFromHash());

  // 在部分情况下，点击 UI 发布按钮会导致页面跳转到草稿列表并触发 3006；
  // 这里先尝试在写作页用 API 直接提交更新（type=5），成功后交给 released_at 验收。
  const articleId = parseArticleIdFromHash();
  if (articleId) {
    const tags = lastMetaSnapshot?.selectedTags || [];
    const ok = await tryPublishViaApi(articleId, tags);
    if (ok) {
      await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishing') });
      return;
    }
  }

  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishing') });

  // `findButtonExact('发布')` 在少数派页面上可能命中“列表/导航”区域的发布按钮，导致跳转到草稿页并触发 3006；
  // 因此优先使用更精准的写作页发布按钮定位逻辑。
  const btn = findPublishButtonOnWritePage() || findButtonExact('发布');
  if (!btn) throw new Error('未找到发布按钮');
  (btn as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 900));

  // SSPAI 会先弹出“选择发布通道”，需要在弹窗中二次点击“发布”
  await retryUntil(
    async () => {
      const handledEditorPrompt = await dismissEditorAlreadyOpenDialog().catch(() => false);
      const handledPublishDialog = await handlePublishChannelDialog().catch(() => false);
      if (handledEditorPrompt || handledPublishDialog) return true;
      throw new Error('waiting dialog');
    },
    { timeoutMs: 35_000, intervalMs: 800 }
  ).catch(() => {});

  // Some flows use a final confirm button.
  const confirm = findButtonExact('确定') || findButtonExact('确认') || findAnyElementContainingText('确定');
  if (confirm) {
    try {
      (confirm as HTMLElement).click();
    } catch {
      // ignore
    }
  }
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<'ok' | 'waiting_user'> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  const text = document.body?.innerText || '';
  if (action === 'publish') {
    if (text.includes('完成实名认证') || text.includes('开始认证') || text.includes('最后一步')) {
      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v2MsgIdentityVerificationRequiredToPublish'),
        userSuggestion: getMessage('v2SugCompleteIdentityVerificationThenContinue'),
      });
      return 'waiting_user';
    }
  }

  const okTexts = action === 'draft' ? ['草稿已保存', '已保存'] : ['发布成功', '已发布'];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const body = document.body?.innerText || '';
    if (okTexts.some((t) => body.includes(t))) return 'ok';
    if (action === 'publish' && (body.includes('完成实名认证') || body.includes('开始认证'))) {
      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v2MsgIdentityVerificationRequiredToPublish'),
        userSuggestion: getMessage('v2SugCompleteIdentityVerificationThenContinue'),
      });
      return 'waiting_user';
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return 'ok';
}

async function stageVerifyPublished(articleId: string): Promise<void> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyConfirmPublishedVisibleOnDetail') });

  const deadline = Date.now() + 120_000;
  let lastReleasedAt = 0;
  let lastInfo: SspaiArticleInfo | null = null;
  let lastFetchError = '';
  while (Date.now() < deadline) {
    try {
      const info = await fetchArticleInfo(articleId);
      lastInfo = info;
      lastFetchError = '';
      const releasedAt = Number(info?.data?.released_at || 0);
      lastReleasedAt = releasedAt;
      if (releasedAt) break;
    } catch (error) {
      lastFetchError = error instanceof Error ? error.message : String(error);
    }

    const handledEditorPrompt = await dismissEditorAlreadyOpenDialog().catch(() => false);
    const handledPublishDialog = await handlePublishChannelDialog().catch(() => false);

    if (handledEditorPrompt || handledPublishDialog) {
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!lastReleasedAt) {
    const blockers = collectPublishBlockersSnapshot();
    const data = lastInfo?.data || {};
    await report({
      status: 'waiting_user',
      stage: 'waitingUser',
      userMessage: getMessage('v2MsgVerifyBlockedNotPublishedYet'),
      userSuggestion: getMessage('v2SugCompleteVerificationOrRequiredThenContinueToRetry'),
      devDetails: {
        articleId,
        releasedAt: lastReleasedAt,
        apiError: lastFetchError,
        type: (data as { type?: unknown }).type,
        createdAt: (data as { created_at?: unknown }).created_at,
        bodyUpdatedAt: (data as { body_updated_at?: unknown }).body_updated_at,
        wordsCount: (data as { words_count_last?: unknown; words_count?: unknown }).words_count_last ?? (data as { words_count?: unknown }).words_count,
        bannerId: (data as { banner_id?: unknown }).banner_id,
        allowComment: (data as { allow_comment?: unknown }).allow_comment,
        blockers,
      },
    });
    return;
  }

  // 已发布：打开详情页验收原文链接
  location.href = `https://sspai.com/post/${articleId}`;
}

async function runWriteFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredSspaiWritePage') });

  await stageDetectLogin();
  await stageFillTitle(job.article.title);
  const articleId = await waitForArticleId();
  await stageFillContent(job.article.contentHtml, job.article.sourceUrl, articleId);

  if (job.action === 'draft') {
    await stageSaveDraft();
    await stageConfirmSuccess('draft');
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgDraftSavedVerifyDone'),
      devDetails: summarizeVerifyDetails({ listUrl: WRITE_URL, listVisible: true }),
    });
    return;
  }

  await stageSubmitPublish();
  const confirm = await stageConfirmSuccess('publish');
  if (confirm === 'waiting_user') return;

  // SSPAI 的发布后跳转路径不稳定（可能到 /write#id、/post/id、或草稿列表等），统一以 API 验收为准。
  await stageVerifyPublished(articleId);
}

async function runApiFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredSspaiWritePage') });
  await stageDetectLogin();

  currentStage = 'fillTitle';
  await report({ status: 'running', stage: 'fillTitle', userMessage: getMessage('v2MsgFillingTitle') });
  const created = await createDraftArticleViaApi(job.article.title);
  const articleId = created.articleId;

  await stageFillContent(job.article.contentHtml, job.article.sourceUrl, articleId);

  if (job.action === 'draft') {
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgDraftSavedVerifyDone'),
      devDetails: summarizeVerifyDetails({ listUrl: ENTRY_URL, listVisible: true }),
    });
    return;
  }

  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishing') });
  const ok = await tryPublishViaApi(articleId, ['AI']);
  if (!ok) {
    await report({
      status: 'failed',
      stage: 'submitPublish',
      userMessage: getMessage('v2MsgFailed'),
      userSuggestion: getMessage('v2SugCheckLoginOrDomThenRetry'),
      devDetails: { message: 'SSPAI: API 发布失败（article/update 未成功）' },
    });
    throw new Error('__BAWEI_V2_STOPPED__');
  }

  await stageVerifyPublished(articleId);
}

async function verifyFromDetail(job: AnyJob): Promise<void> {
  const articleId = (() => {
    try {
      const m = String(location.pathname || '').match(/\/post\/(\d+)/);
      return m?.[1] || '';
    } catch {
      return '';
    }
  })();

  const expectedImages = expectedImagesForJob;

  const ok = await retryUntil(
    async () => {
      const info = articleId ? await fetchArticleInfo(articleId).catch(() => null) : null;
      const bodyHtml = String(info?.data?.body || info?.data?.body_last || '');
      const domContainer = (document.querySelector('article,main') as HTMLElement | null) || document.body;
      const domHtml = String(domContainer?.innerHTML || '');
      const htmlForCheck = bodyHtml || domHtml;

      const sourceOk =
        pageContainsSourceUrl(job.article.sourceUrl) ||
        pageContainsText('原文链接') ||
        containsSourceUrlInHtml(htmlForCheck, job.article.sourceUrl);
      if (!sourceOk) throw new Error('waiting source url');

      if (expectedImages) {
        if (bodyHtml) {
          const imgAnalysis = analyzeImagesInHtml(bodyHtml);
          if (imgAnalysis.withSrc < expectedImages) {
            throw new Error(`waiting images (${imgAnalysis.withSrc}/${expectedImages}, empty=${imgAnalysis.emptySrc})`);
          }
          if (imgAnalysis.emptySrc) throw new Error(`waiting images upload complete (empty=${imgAnalysis.emptySrc})`);
        } else {
          const imgs = Array.from(domContainer.querySelectorAll<HTMLImageElement>('img'));
          const withSrc = imgs.filter((img) => Boolean(String(img.getAttribute('src') || '').trim())).length;
          const empty = Math.max(0, imgs.length - withSrc);
          if (withSrc < expectedImages) throw new Error(`waiting images (${withSrc}/${expectedImages}, empty=${empty})`);
          if (empty) throw new Error(`waiting images upload complete (empty=${empty})`);
        }
      }

      if (htmlForCheck.includes('图片：')) throw new Error('downgraded image placeholder detected');
      return true;
    },
    { timeoutMs: 60_000, intervalMs: 1200 }
  )
    .then(() => true)
    .catch(() => false);
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

    if (!expectedImagesForJob) {
      try {
        const jobTokens = currentJob?.article?.contentTokens;
        if (Array.isArray(jobTokens)) {
          expectedImagesForJob = jobTokens.filter((t) => t?.kind === 'image').length;
        } else {
          expectedImagesForJob = buildRichContentTokens({
            contentHtml: currentJob.article.contentHtml,
            baseUrl: currentJob.article.sourceUrl,
            sourceUrl: currentJob.article.sourceUrl,
            htmlMode: 'raw',
          }).filter((t) => t?.kind === 'image').length;
        }
      } catch {
        expectedImagesForJob = 0;
      }
    }

    if (isWritePage()) {
      await runWriteFlow(currentJob);
      return;
    }

    if (isDetailPage()) {
      await verifyFromDetail(currentJob);
      return;
    }

    if (isEditPage()) {
      const id = await waitForArticleId().catch(() => '');
      if (!id) throw new Error('未能获取文章ID（/write#<id>）');
      await stageVerifyPublished(id);
      return;
    }

    // 非写作页（推荐入口：/my）：用 API 流程避免“编辑窗口已打开(3006)”锁。
    if (isMyPage()) {
      await runApiFlow(currentJob);
      return;
    }

    await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgSspaiOpeningWritePage') });
    location.href = ENTRY_URL;
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
