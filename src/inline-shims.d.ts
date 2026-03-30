// 仅用于 TypeScript 类型检查：内容脚本通过 /* INLINE:... */ 在构建时内联共享模块，
// 这里提供声明以避免 tsc 在源码阶段报“找不到标识符”。

declare function getSettings(): Promise<unknown>;

declare function showInfo(message: string, duration?: number): void;
declare function showSuccess(message: string, duration?: number): void;
declare function showError(message: string, duration?: number): void;

declare function waitForElement<T extends Element = Element>(
  selector: string,
  timeout?: number,
  root?: Document | Element
): Promise<T>;

declare function waitForVisibleElement<T extends HTMLElement = HTMLElement>(
  selector: string,
  timeout?: number,
  root?: Document | Element
): Promise<T>;

declare function findContentEditor(root?: Document | Element): HTMLElement | null;

declare function simulateFocus(element: HTMLElement): void;
declare function simulateType(input: HTMLInputElement | HTMLTextAreaElement, text: string): void;
declare function simulateClick(element: HTMLElement): void;
declare function simulatePaste(target: HTMLElement, html: string): Promise<boolean>;
declare function setFilesToInput(input: HTMLInputElement, files: File[]): void;
declare function simulateDropFiles(target: HTMLElement, files: File[]): void;
declare function simulatePasteFiles(target: HTMLElement, files: File[]): void;

declare function retryUntil<T>(
  fn: () => Promise<T>,
  options?: { timeoutMs?: number; intervalMs?: number; onError?: (err: unknown) => void }
): Promise<T>;
declare function pageContainsText(text: string): boolean;
declare function pageContainsTitle(title: string): boolean;
declare function titleToken(title: string): string;
declare function pageContainsSourceUrl(sourceUrl: string): boolean;
declare function detectPageLoginState(options?: {
  loginUrlPattern?: RegExp;
  strictLoginPattern?: RegExp;
  loggedInPattern?: RegExp;
}): { status: 'logged_in' | 'not_logged_in' | 'unknown'; reason: string };
declare function normalizeForSearch(value: string): string;
declare function findLinkByText(text: string): HTMLAnchorElement | null;
declare function findAnyElementContainingText(text: string): HTMLElement | null;
declare function findAnchorContainingText(text: string): HTMLAnchorElement | null;
declare function isElementVisible(element: HTMLElement): boolean;
declare function summarizeVerifyDetails<T extends Record<string, unknown> = Record<string, never>>(details: {
  publishedUrl?: string;
  draftUrl?: string;
  editorUrl?: string;
  listUrl?: string;
  listVisible?: boolean;
  sourceUrlPresent?: boolean;
  savedToCloud?: boolean;
} & T): {
  publishedUrl?: string;
  draftUrl?: string;
  editorUrl?: string;
  listUrl?: string;
  verified?: { listVisible?: boolean; sourceUrlPresent?: boolean; savedToCloud?: boolean };
} & T;

declare function htmlToPlainTextSafe(html: string): string;
declare function toProxyImageUrl(raw: string, baseUrl: string): string;
declare function rewriteHtmlImageUrlsToProxy(contentHtml: string, baseUrl: string): string;
declare function buildRichContentTokens(params: {
  contentHtml: string;
  baseUrl: string;
  sourceUrl: string;
  htmlMode?: 'plain' | 'raw';
  splitBlocks?: boolean;
}): Array<
  | {
      kind: 'html';
      html: string;
    }
  | {
      kind: 'image';
      src: string;
      alt?: string;
    }
>;

declare function fetchImageAsFile(jobId: string, url: string): Promise<File>;
declare function insertImageAtCursor(params: { jobId: string; imageUrl: string; editorRoot: HTMLElement }): Promise<void>;
declare function fillEditorByTokens(params: {
  jobId: string;
  tokens: Array<
    | { kind: 'html'; html: string }
    | { kind: 'image'; src: string; alt?: string }
  >;
  editorRoot: HTMLElement;
  writeMode: 'html' | 'text';
  ensureCaretAtEnd?: boolean;
  directHtmlAppend?: boolean;
  skipHtmlPasteEvent?: boolean;
  onImageProgress?: (current: number, total: number, imageUrl: string) => Promise<void> | void;
  insertImageAtCursorOverride?: (args: { jobId: string; imageUrl: string; editorRoot: HTMLElement }) => Promise<void>;
}): Promise<void>;

declare const V2_START_JOB: string;
declare const V2_GET_CONTEXT: string;
declare const V2_CHANNEL_UPDATE: string;
declare const V2_JOB_BROADCAST: string;
declare const V2_REQUEST_CONTINUE: string;
declare const V2_REQUEST_RETRY: string;
declare const V2_REQUEST_STOP: string;
declare const V2_FOCUS_CHANNEL_TAB: string;
declare const V2_AUDIT_CHANNEL_LOGIN: string;
declare const V2_PROBE_LOGIN_STATE: string;

declare const V3_FETCH_IMAGE: string;
declare const V3_EXECUTE_MAIN_WORLD: string;

declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;
