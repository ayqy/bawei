/**
 * Event simulation utilities for realistic user interactions
 * Based on user-event library principles for better framework compatibility
 */

const BAWEI_V2_STOP_ERROR_MESSAGE_EVENTS = '__BAWEI_V2_STOPPED__';

type View = Window & typeof globalThis;

function baweiV2IsStopRequestedEvents(): boolean {
  try {
    const fn = (globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }).__BAWEI_V2_IS_STOP_REQUESTED;
    return typeof fn === 'function' ? !!fn() : false;
  } catch {
    return false;
  }
}

function baweiV2ThrowIfStoppedEvents(): void {
  if (baweiV2IsStopRequestedEvents()) throw new Error(BAWEI_V2_STOP_ERROR_MESSAGE_EVENTS);
}

function viewOf(node: unknown): View {
  try {
    const n = node as { ownerDocument?: Document | null } | null;
    const doc = n?.ownerDocument || null;
    return (doc?.defaultView || window) as View;
  } catch {
    return window as View;
  }
}

/**
 * Simulates a realistic click event on an element
 * @param element The element to click
 */
export function simulateClick(element: HTMLElement): void {
  baweiV2ThrowIfStoppedEvents();

  const view = viewOf(element);
  // Dispatch sequence of events that frameworks expect
  const events = ['mousedown', 'mouseup', 'click'];
  
  events.forEach(eventType => {
    const event = new view.MouseEvent(eventType, {
      bubbles: true,
      cancelable: true,
      view,
      button: 0,
      buttons: 1,
    });
    element.dispatchEvent(event);
  });
}

/**
 * Simulates realistic typing into an input element
 * @param input The input element to type into
 * @param text The text to type
 */
export function simulateType(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  baweiV2ThrowIfStoppedEvents();

  const view = viewOf(input);
  // Focus the input first
  input.focus();
  
  // Clear existing value
  input.value = '';
  
  // Type character by character
  for (let i = 0; i < text.length; i++) {
    baweiV2ThrowIfStoppedEvents();
    const char = text[i];
    input.value += char;
    
    // Dispatch input event after each character
    const inputEvent = new view.InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: char,
      inputType: 'insertText',
    });
    input.dispatchEvent(inputEvent);
  }
  
  // Dispatch change event at the end
  const changeEvent = new view.Event('change', {
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(changeEvent);
}

/**
 * Simulates pasting HTML content into an element
 * @param target The target element
 * @param html The HTML content to paste
 */
export async function simulatePaste(target: HTMLElement, html: string): Promise<boolean> {
  baweiV2ThrowIfStoppedEvents();
  const initialLen = (target.textContent || '').length;

  // 保证获得焦点
  target.focus();

  // ---------- 方法 0: 系统剪贴板 + 热键粘贴 ---------- //
  try {
    baweiV2ThrowIfStoppedEvents();
    await writeToClipboard(html);
    baweiV2ThrowIfStoppedEvents();
    const ok = await simulateHotkeyPaste(target);
    if (ok) {
      return true;
    }
  } catch (err) {
    if (err instanceof Error && err.message === BAWEI_V2_STOP_ERROR_MESSAGE_EVENTS) throw err;
    console.warn('系统剪贴板路径失败，转入 ClipboardEvent 方案:', err);
  }

  // ---------- 方法 1: execCommand('insertHTML') ---------- //
  try {
    baweiV2ThrowIfStoppedEvents();
    const success = document.execCommand('insertHTML', false, html);
    if (success) {
      await new Promise(r => requestAnimationFrame(r));
      baweiV2ThrowIfStoppedEvents();
      const afterLen = (target.textContent || '').length;
      if (afterLen - initialLen > Math.min(100, html.length * 0.1)) {
        console.log('execCommand("insertHTML") 成功');
        return true;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message === BAWEI_V2_STOP_ERROR_MESSAGE_EVENTS) throw err;
    console.warn('execCommand insertHTML 失败:', err);
  }

  // ---------- 方法 3: 最终回退 innerHTML ---------- //
  try {
    baweiV2ThrowIfStoppedEvents();
    target.innerHTML = html;

    // 触发 input & composition 事件，兼容 React/DraftJS 更新
    const inputEvt = new InputEvent('input', { bubbles: true, cancelable: true });
    target.dispatchEvent(inputEvt);
    const compStart = new CompositionEvent('compositionstart', { bubbles: true });
    const compEnd = new CompositionEvent('compositionend', { bubbles: true, data: html });
    target.dispatchEvent(compStart);
    target.dispatchEvent(compEnd);

    return true;
  } catch (err) {
    if (err instanceof Error && err.message === BAWEI_V2_STOP_ERROR_MESSAGE_EVENTS) throw err;
    console.error('最终 innerHTML 回退失败:', err);
  }

  return false;
}

/**
 * Simulates focus on an element
 * @param element The element to focus
 */
export function simulateFocus(element: HTMLElement): void {
  baweiV2ThrowIfStoppedEvents();
  const view = viewOf(element);
  element.focus();
  
  const focusEvent = new view.FocusEvent('focus', {
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(focusEvent);
}

export function setFilesToInput(input: HTMLInputElement, files: File[]): void {
  baweiV2ThrowIfStoppedEvents();
  const view = viewOf(input);
  const dt = new view.DataTransfer();
  for (const file of files) {
    try {
      dt.items.add(file);
    } catch {
      // ignore
    }
  }
  try {
    input.files = dt.files;
  } catch {
    // ignore
  }
  try {
    input.dispatchEvent(new view.Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true, cancelable: true }));
  } catch {
    // ignore
  }
}

export function simulateDropFiles(target: HTMLElement, files: File[]): void {
  baweiV2ThrowIfStoppedEvents();
  const view = viewOf(target);
  const dt = new view.DataTransfer();
  for (const file of files) {
    try {
      dt.items.add(file);
    } catch {
      // ignore
    }
  }

  const events: Array<{ type: string; ctor: 'DragEvent' | 'Event' }> = [
    { type: 'dragenter', ctor: 'DragEvent' },
    { type: 'dragover', ctor: 'DragEvent' },
    { type: 'drop', ctor: 'DragEvent' },
  ];

  for (const it of events) {
    baweiV2ThrowIfStoppedEvents();
    try {
      const ev = new (view as unknown as { DragEvent: typeof DragEvent }).DragEvent(it.type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      target.dispatchEvent(ev);
      continue;
    } catch {
      // ignore
    }
    try {
      const ev = new view.Event(it.type, { bubbles: true, cancelable: true });
      (ev as unknown as { dataTransfer?: DataTransfer }).dataTransfer = dt;
      target.dispatchEvent(ev);
    } catch {
      // ignore
    }
  }
}

export function simulatePasteFiles(target: HTMLElement, files: File[]): void {
  baweiV2ThrowIfStoppedEvents();
  const view = viewOf(target);
  const dt = new view.DataTransfer();
  for (const file of files) {
    try {
      dt.items.add(file);
    } catch {
      // ignore
    }
  }

  try {
    const ev = new (view as unknown as { ClipboardEvent: typeof ClipboardEvent }).ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    } as unknown as ClipboardEventInit);
    target.dispatchEvent(ev);
    return;
  } catch {
    // ignore
  }

  try {
    const ev = new view.Event('paste', { bubbles: true, cancelable: true });
    (ev as unknown as { clipboardData?: DataTransfer }).clipboardData = dt;
    target.dispatchEvent(ev);
  } catch {
    // ignore
  }
}

// 将 HTML 转为纯文本，去除标签与多余空白
function htmlToPlainText(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

// —— 系统剪贴板 & 热键粘贴 —————————————— //

/**
 * 将 HTML 与纯文本写入系统剪贴板
 * 若浏览器或用户拒绝权限，将抛出异常由调用方捕获。
 */
async function writeToClipboard(html: string): Promise<void> {
  baweiV2ThrowIfStoppedEvents();
  const plain = htmlToPlainText(html);
  const item = new ClipboardItem({
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([plain], { type: 'text/plain' }),
  });
  await navigator.clipboard.write([item]);
}

/**
 * 模拟 Ctrl/Cmd + V 粘贴热键
 * 返回是否检测到内容增量（粗略成功判定）
 */
async function simulateHotkeyPaste(target: HTMLElement): Promise<boolean> {
  baweiV2ThrowIfStoppedEvents();
  const isMac = /mac/i.test(navigator.platform);
  const initialLen = (target.textContent || '').length;

  target.focus();

  const downEvt = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'v',
    code: 'KeyV',
    [isMac ? 'metaKey' : 'ctrlKey']: true,
  });
  target.dispatchEvent(downEvt);

  const pressEvt = new KeyboardEvent('keypress', {
    bubbles: true,
    cancelable: true,
    key: 'v',
    code: 'KeyV',
    charCode: 118,
    [isMac ? 'metaKey' : 'ctrlKey']: true,
  });
  target.dispatchEvent(pressEvt);

  const upEvt = new KeyboardEvent('keyup', {
    bubbles: true,
    cancelable: true,
    key: 'v',
    code: 'KeyV',
    [isMac ? 'metaKey' : 'ctrlKey']: true,
  });
  target.dispatchEvent(upEvt);

  await new Promise(r => setTimeout(r, 100));
  const afterLen = (target.textContent || '').length;
  return afterLen - initialLen > Math.min(100, initialLen * 0.1);
}

export async function writeHtmlToClipboard(html: string): Promise<void> {
  await writeToClipboard(html);
}
