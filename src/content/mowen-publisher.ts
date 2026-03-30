/**
 * Mowen Publisher Content Script (V2)
 * Note: Mowen editor has no separate title input; title is the first line of content.
 */

import type { ChannelId, ChannelRuntimeState, PublishJob } from '../shared/v2-types';

/* INLINE:dom */
/* INLINE:events */
/* INLINE:v2-protocol */
/* INLINE:publish-verify */
/* INLINE:rich-content */
/* INLINE:image-bridge */

const CHANNEL_ID: ChannelId = 'mowen';

type AnyJob = Pick<PublishJob, 'jobId' | 'action' | 'article' | 'stoppedAt'>;

let currentJob: AnyJob | null = null;
let currentStage: ChannelRuntimeState['stage'] = 'init';
let stopRequested = false;
let expectedImagesForJob = 0;

(globalThis as unknown as { __BAWEI_V2_IS_STOP_REQUESTED?: () => boolean }).__BAWEI_V2_IS_STOP_REQUESTED = () => stopRequested;

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

function withTitleAndSourceUrl(contentHtml: string, title: string, sourceUrl: string): string {
  const safe = escapeAttr(sourceUrl);
  const titleHtml = `<p>${title.replace(/</g, '&lt;')}</p><p><br/></p>`;
  return `${titleHtml}\n${contentHtml}\n<p><br/></p><p>原文链接：<a href="${safe}" target="_blank" rel="noreferrer noopener">${safe}</a></p>`;
}

function findFirstClickableByExactText(text: string): HTMLElement | null {
  const wanted = String(text || '').trim();
  if (!wanted) return null;
  return (
    Array.from(document.querySelectorAll<HTMLElement>('button, a, div, span'))
      .map((el) => ({ el, txt: String(el.textContent || '').trim() }))
      .find((item) => item.txt === wanted)?.el || null
  );
}

function findFirstClickableByTextContains(text: string): HTMLElement | null {
  const wanted = String(text || '').trim();
  if (!wanted) return null;
  return (
    Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"], div, span'))
      .map((el) => ({ el, txt: String(el.textContent || '').trim() }))
      .find((item) => item.txt.includes(wanted))?.el || null
  );
}

function isRestoreDraftDialogLikelyVisible(): boolean {
  const text = String(document.body?.innerText || '');
  return text.includes('未保存') && text.includes('草稿') && text.includes('恢复');
}

async function ensureEditorSurfaceReady(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastWriteClickAt = 0;

  while (Date.now() < deadline) {
    if (document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror')) return;

    if (isRestoreDraftDialogLikelyVisible()) {
      const cancel =
        findFirstClickableByExactText('取消') ||
        findFirstClickableByTextContains('取消') ||
        findFirstClickableByExactText('不恢复') ||
        findFirstClickableByTextContains('不恢复') ||
        findFirstClickableByExactText('关闭') ||
        findFirstClickableByTextContains('关闭') ||
        null;
      if (cancel) {
        cancel.click();
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }
    }

    const now = Date.now();
    if (now - lastWriteClickAt > 1600) {
      const writeBtn =
        findFirstClickableByExactText('写笔记') ||
        findFirstClickableByTextContains('写笔记') ||
        findFirstClickableByExactText('新建') ||
        findFirstClickableByTextContains('新建') ||
        null;
      if (writeBtn) {
        lastWriteClickAt = now;
        writeBtn.click();
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
    }

    await new Promise((r) => setTimeout(r, 400));
  }
}

function shouldRunOnThisPage(): boolean {
  if (location.hostname !== 'note.mowen.cn') return false;
  if (location.pathname.startsWith('/editor')) return true;
  if (location.pathname.startsWith('/my/notes')) return true;
  if (location.pathname.startsWith('/detail/')) return true;
  return false;
}

function isEditorPage(): boolean {
  return location.hostname === 'note.mowen.cn' && location.pathname.startsWith('/editor');
}

function isListPage(): boolean {
  return location.hostname === 'note.mowen.cn' && location.pathname.startsWith('/my/notes');
}

function isDetailPage(): boolean {
  return location.hostname === 'note.mowen.cn' && location.pathname.startsWith('/detail/');
}

function getMowenProbeActiveKey(jobId: string): string {
  return `bawei_v2_mowen_probe_active_${jobId}`;
}

function getMowenProbeIndexKey(jobId: string): string {
  return `bawei_v2_mowen_probe_index_${jobId}`;
}

function getMowenProbeCandidatesKey(jobId: string): string {
  return `bawei_v2_mowen_probe_candidates_${jobId}`;
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
    strictLoginPattern: /请登录|请先登录|登录后继续|未登录|手机号登录|验证码登录|sign in|log in/i,
    loggedInPattern: /新建|编辑器|我的笔记|工作台|账号设置|退出登录|发布/i,
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

async function stageFillContent(title: string, contentHtml: string, sourceUrl: string): Promise<void> {
  currentStage = 'fillContent';
  await report({
    status: 'running',
    stage: 'fillContent',
    userMessage: getMessage('v2MsgMowenFillingContentTitleFirstLine'),
    userSuggestion: getMessage('v2SugMowenTitleInFirstLine'),
  });

  await ensureEditorSurfaceReady();

  // 墨问编辑器基于 ProseMirror（tiptap），需要等待渲染完成
  const editor =
    ((await (async () => {
      try {
        return await waitForElement<HTMLElement>('.ProseMirror[contenteditable="true"]', 90_000);
      } catch {
        return null;
      }
    })()) as HTMLElement | null) ||
    document.querySelector<HTMLElement>('.ProseMirror') ||
    findContentEditor(document);

  if (!editor) {
    const url = String(location.href || '');
    const bodyText = (() => {
      try {
        return String(document.body?.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 260);
      } catch {
        return '';
      }
    })();
    throw new Error(`未找到内容编辑器（url=${url} body=${bodyText || '<empty>'}）`);
  }

  const html = withTitleAndSourceUrl(contentHtml, title, sourceUrl);
  const tokens = buildRichContentTokens({ contentHtml: html, baseUrl: sourceUrl, sourceUrl: '', htmlMode: 'raw' });

  const countDraftImages = (node: unknown): number => {
    if (!node) return 0;
    if (Array.isArray(node)) return node.reduce((sum, child) => sum + countDraftImages(child), 0);
    if (typeof node !== 'object') return 0;
    const n = node as { type?: unknown; content?: unknown };
    let sum = String(n.type || '') === 'image' ? 1 : 0;
    sum += countDraftImages(n.content);
    return sum;
  };

  const collectDraftImageUuids = (node: unknown, out: string[] = []): string[] => {
    if (!node) return out;
    if (Array.isArray(node)) {
      for (const child of node) collectDraftImageUuids(child, out);
      return out;
    }
    if (typeof node !== 'object') return out;

    const n = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (String(n.type || '') === 'image') {
      try {
        const uuid = String((n.attrs as { uuid?: unknown } | null)?.uuid || '').trim();
        if (uuid) out.push(uuid);
      } catch {
        // ignore
      }
    }
    collectDraftImageUuids(n.content, out);
    return out;
  };

  const fetchDraftSnapshot = async (): Promise<{ count: number; uuids: string[] } | null> => {
    const res = await fetch('/api/note/wxa/v1/note/draft', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene: 2, noteUuid: 'draft', salt: 'web' }),
    });
    if (!res.ok) throw new Error(`draft api failed: ${res.status}`);
    const json = (await res.json().catch(() => null)) as { content?: unknown } | null;
    const raw = String(json?.content || '');
    if (!raw) return { count: 0, uuids: [] };
    try {
      const doc = JSON.parse(raw) as unknown;
      return { count: countDraftImages(doc), uuids: collectDraftImageUuids(doc) };
    } catch {
      return { count: 0, uuids: [] };
    }
  };

  const expectedImages = tokens.filter((t) => t?.kind === 'image').length;
  expectedImagesForJob = expectedImages;
  const existingText = (() => {
    try {
      return String(editor.textContent || '');
    } catch {
      return '';
    }
  })();
  const existingHasSource = !!(sourceUrl && existingText.includes(sourceUrl));
  const existingFirstLine = (() => {
    try {
      const text = String(editor.innerText || editor.textContent || '');
      return text.split('\n')[0]?.trim() || '';
    } catch {
      return '';
    }
  })();
  const existingTitleOk = !!title && existingFirstLine === String(title).trim();
  const existingParagraphsOk = (() => {
    try {
      return editor.querySelectorAll('p').length >= 3;
    } catch {
      return false;
    }
  })();
  const existingOk =
    existingHasSource &&
    existingTitleOk &&
    existingParagraphsOk &&
    (expectedImages === 0 || editor.querySelectorAll('img').length >= expectedImages);

  if (!existingOk) {
    try {
      let insertImageIndex = 0;
      await fillEditorByTokens({
        jobId: currentJob?.jobId || '',
        tokens,
        editorRoot: editor,
        writeMode: 'html',
        onImageProgress: async (current, total) => {
          await report({
            status: 'running',
            stage: 'fillContent',
            userMessage: getMessage('v3MsgUploadingImageProgress', [String(current), String(total)]),
          });
        },
        insertImageAtCursorOverride: async (args) => {
          insertImageIndex += 1;
          const current = insertImageIndex;
          const total = expectedImages || 0;

          const isVisible = (node: HTMLElement): boolean => {
            try {
              const style = window.getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
              const rect = node.getBoundingClientRect();
              return rect.width > 1 && rect.height > 1;
            } catch {
              return false;
            }
          };

          const readVisibleToastText = (): string => {
            try {
              const nodes = Array.from(document.querySelectorAll<HTMLElement>('.toast,[role="alert"],.el-message,.ant-message,.message'));
              return nodes
                .filter(isVisible)
                .map((n) => String(n.textContent || '').trim())
                .filter(Boolean)
                .slice(0, 3)
                .join('\n');
            } catch {
              return '';
            }
          };

          const countImages = (): number => {
            try {
              return args.editorRoot.querySelectorAll('img').length;
            } catch {
              return 0;
            }
          };

          const undoLast = (): void => {
            try {
              args.editorRoot.ownerDocument.execCommand('undo', false);
            } catch {
              // ignore
            }
          };

          const undoIfLikelyInserted = (beforeCount: number): void => {
            try {
              const now = countImages();
              if (now > beforeCount) undoLast();
            } catch {
              // ignore
            }
          };

          const waitUploaded = async (
            beforeCount: number,
            beforeDraft: { count: number; uuids: string[] } | null,
            label: string
          ): Promise<{ expectedCount: number; insertedUuid: string }> => {
            const waitStartAt = Date.now();
            const deadline = waitStartAt + 120_000;
            const noopDeadline = waitStartAt + 3500;
            let lastReportAt = 0;
            const baselineDraftCount = beforeDraft?.count ?? -1;
            const baselineDraftUuids = Array.isArray(beforeDraft?.uuids) ? beforeDraft!.uuids : [];
            let sawDomInsert = false;

            while (Date.now() < deadline) {
              const toastText = readVisibleToastText();
              if (toastText.includes('上传失败') || (toastText.includes('图片') && toastText.includes('失败'))) {
                throw new Error(`图片上传失败（${label}）：${toastText.slice(0, 140)}`);
              }

              const domCount = countImages();
              if (domCount > beforeCount) sawDomInsert = true;

              if (baselineDraftCount >= 0) {
                const snap = await fetchDraftSnapshot().catch(() => null);
                if (snap) {
                  const insertedUuid = snap.uuids.find((uuid) => uuid && !baselineDraftUuids.includes(uuid)) || '';

                  // 期望：图片插入应导致 draft 内 image 节点数量 +1。
                  // 若数量未增长但出现新的 uuid，极可能是“替换已有图片”，必须尽快失败并回滚（否则最终图片数量不足）。
                  if (snap.count === baselineDraftCount && insertedUuid) {
                    throw new Error(`图片疑似替换已有图片（${label}，draftCount=${snap.count} 未增长）`);
                  }

                  if (snap.count >= baselineDraftCount + 1) return { expectedCount: snap.count, insertedUuid };
                }

                // 若 paste/drop 事件被编辑器忽略，draft 与 DOM 都不会产生任何变化，
                // 继续傻等 120s 会导致无法尽快切换到 drop/file-input 兜底。
                if (!sawDomInsert && Date.now() > noopDeadline) {
                  throw new Error(`未触发图片插入（${label}）：draft/DOM 无变化，尝试下一种插图方式`);
                }
              } else {
                const imgs = Array.from(args.editorRoot.querySelectorAll<HTMLImageElement>('img'));
                const newImgs = imgs.slice(Math.max(0, beforeCount));
                const inserted = newImgs.find((img) => String(img.getAttribute('src') || '').trim());
                // 墨问编辑器在上传成功后依然可能保持 blob: 预览图（真实 fileId 存在于 ProseMirror 文档中），
                // 因此这里以“图片节点已插入 + 未出现上传失败 toast”作为成功判定。
                if (inserted) return { expectedCount: -1, insertedUuid: '__dom__' };
              }

              const now = Date.now();
              if (now - lastReportAt > 8000) {
                const waited = Math.round((now - waitStartAt) / 1000);
                await report({
                  status: 'running',
                  stage: 'fillContent',
                  userMessage: `${getMessage('v3MsgUploadingImageProgress', [String(current), String(total || '?')])}（等待上传完成 ${waited}s）`,
                });
                lastReportAt = now;
              }

              await new Promise((r) => setTimeout(r, 600));
            }

            throw new Error(`图片插入超时（${label}，120s）`);
          };

          const scoreFileInput = (input: HTMLInputElement): number => {
            try {
              const accept = String(input.getAttribute('accept') || '').toLowerCase();
              const name = String(input.getAttribute('name') || '').toLowerCase();
              const id = String(input.id || '').toLowerCase();
              const cls = String(input.className || '').toLowerCase();
              const parentText = String(input.closest('form,section,article,div')?.textContent || '').slice(0, 180).toLowerCase();
              const isImage = accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg') || accept.includes('webp');
              const looksImage = name.includes('image') || id.includes('image') || cls.includes('image') || cls.includes('upload');
              const inCover = parentText.includes('封面') || parentText.includes('cover');
              const inImageDialog = parentText.includes('图片') || parentText.includes('插图') || parentText.includes('上传') || parentText.includes('image');
              let score = 0;
              if (isImage) score += 10;
              if (looksImage) score += 4;
              if (inImageDialog) score += 6;
              if (inCover) score -= 8;
              if (isVisible(input)) score += 2;
              return score;
            } catch {
              return 0;
            }
          };

          const listFileInputs = (): HTMLInputElement[] => {
            try {
              const doc = args.editorRoot.ownerDocument || document;
              const nodes = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="file"]'));
              return nodes
                .map((input) => ({ input, score: scoreFileInput(input) }))
                .sort((a, b) => b.score - a.score)
                .map((it) => it.input);
            } catch {
              return [];
            }
          };

          const findImageButtons = (): HTMLElement[] => {
            const out: HTMLElement[] = [];
            try {
              const nodes = Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"],a,span,div'));
              for (const node of nodes) {
                if (!isVisible(node)) continue;
                const txt = `${node.textContent || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('aria-label') || ''}`.toLowerCase();
                if (!txt) continue;
                if (txt.includes('图片') || txt.includes('插图') || txt.includes('上传') || txt.includes('image') || txt.includes('upload')) {
                  out.push(node);
                  if (out.length >= 10) break;
                }
              }
            } catch {
              // ignore
            }
            return out;
          };

          const file = await fetchImageAsFile(args.jobId, args.imageUrl);
          const fileNameHint = String(file?.name || '').slice(0, 80);

          let lastBeforeCount = 0;

          const tryOnce = async (label: string, action: () => Promise<void> | void): Promise<void> => {
            const beforeCount = countImages();
            const beforeDraft = await fetchDraftSnapshot().catch(() => null);
            lastBeforeCount = beforeCount;
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
            // 确保光标落在编辑器末尾（否则 paste 可能只触发上传但不插入节点）
            try {
              const doc = args.editorRoot.ownerDocument || document;
              const view = doc.defaultView || window;
              const range = doc.createRange();
              range.selectNodeContents(args.editorRoot);
              range.collapse(false);
              const sel = view.getSelection?.();
              if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
              }
            } catch {
              // ignore
            }
            await action();
            const uploaded = await waitUploaded(beforeCount, beforeDraft, label);
            await new Promise((r) => setTimeout(r, 10_000));

            if (uploaded.expectedCount >= 0 && uploaded.insertedUuid && uploaded.insertedUuid !== '__dom__') {
              const stable = await fetchDraftSnapshot().catch(() => null);
              if (stable && stable.count < uploaded.expectedCount) {
                throw new Error(`图片未稳定写入草稿（${label}，draft=${stable.count} < ${uploaded.expectedCount}）`);
              }
              if (stable && !stable.uuids.includes(uploaded.insertedUuid)) {
                throw new Error(`图片落稿后又消失（${label}，uuid=${uploaded.insertedUuid}）`);
              }
            }

            // 关键：图片节点插入后，光标可能停留在图片节点上，
            // 后续插入可能“替换图片”导致最终图片数量不足。
            // 这里强制把光标移动到编辑器末尾，并插入一个换行/空段落作为“落点”。
            try {
              const doc = args.editorRoot.ownerDocument || document;
              const view = doc.defaultView || window;
              const range = doc.createRange();
              range.selectNodeContents(args.editorRoot);
              range.collapse(false);
              const sel = view.getSelection?.();
              if (sel) {
                sel.removeAllRanges();
                sel.addRange(range);
              }

              let inserted = false;
              try {
                inserted = !!doc.execCommand('insertHTML', false, '<p><br/></p>');
              } catch {
                inserted = false;
              }
              if (!inserted) {
                try {
                  doc.execCommand('insertText', false, '\n');
                } catch {
                  // ignore
                }
              }
            } catch {
              // ignore
            }
          };

          const errors: string[] = [];

          // Method 1: paste（更贴近真实 Cmd+V 上传）
          try {
            await tryOnce(`paste:${fileNameHint}`, async () => {
              // 墨问的图片粘贴：仅带 File 的 ClipboardEvent 可能会触发上传但不落稿，
              // 这里同时附带 text/html 的 <img src="blob:..."> 以更接近真实剪贴板内容。
              const view = args.editorRoot.ownerDocument?.defaultView || window;
              const dt = new view.DataTransfer();
              try {
                dt.items.add(file);
              } catch {
                // ignore
              }

              let blobUrl = '';
              try {
                blobUrl = view.URL?.createObjectURL ? view.URL.createObjectURL(file) : '';
              } catch {
                blobUrl = '';
              }

              if (blobUrl) {
                try {
                  dt.setData('text/html', `<img src="${blobUrl}" />`);
                } catch {
                  // ignore
                }
                try {
                  dt.setData('text/plain', '');
                } catch {
                  // ignore
                }
                try {
                  view.setTimeout(() => {
                    try {
                      view.URL?.revokeObjectURL?.(blobUrl);
                    } catch {
                      // ignore
                    }
                  }, 30_000);
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
                args.editorRoot.dispatchEvent(ev);
                return;
              } catch {
                // ignore
              }

              try {
                const ev = new view.Event('paste', { bubbles: true, cancelable: true });
                (ev as unknown as { clipboardData?: DataTransfer }).clipboardData = dt;
                args.editorRoot.dispatchEvent(ev);
              } catch {
                // ignore
              }
            });
            return;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`paste: ${msg}`);
            if (/替换|replace/i.test(msg)) undoLast();
            undoIfLikelyInserted(lastBeforeCount);
            await new Promise((r) => setTimeout(r, 600));
          }

          // Method 2: drop
          try {
            await tryOnce(`drop:${fileNameHint}`, async () => {
              simulateDropFiles(args.editorRoot, [file]);
            });
            return;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`drop: ${msg}`);
            if (/替换|replace/i.test(msg)) undoLast();
            undoIfLikelyInserted(lastBeforeCount);
            await new Promise((r) => setTimeout(r, 600));
          }

          // Method 3: file input（兜底）
          try {
            await tryOnce(`file-input:${fileNameHint}`, async () => {
              const before = new Set(listFileInputs());
              const btns = findImageButtons();
              for (const btn of btns) {
                try {
                  simulateClick(btn);
                } catch {
                  // ignore
                }
                await new Promise((r) => setTimeout(r, 260));
                const after = listFileInputs();
                const created = after.filter((input) => !before.has(input));
                const candidate = created[0] || after[0] || null;
                if (!candidate) continue;
                setFilesToInput(candidate, [file]);
                return;
              }
              throw new Error('未找到图片上传 input/button');
            });
            return;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`file-input: ${msg}`);
            if (/替换|replace/i.test(msg)) undoLast();
            undoIfLikelyInserted(lastBeforeCount);
            await new Promise((r) => setTimeout(r, 600));
          }

          throw new Error(errors.join(' | ') || '图片插入失败');
        },
      });

      // 填充完成后做一次质量门禁：标题/段落/图片
      const afterFirstLine = (() => {
        try {
          const text = String(editor.innerText || editor.textContent || '');
          return text.split('\n')[0]?.trim() || '';
        } catch {
          return '';
        }
      })();
      if (afterFirstLine !== String(title || '').trim()) {
        throw new Error(`标题未单独成行（firstLine=${afterFirstLine.slice(0, 40)})`);
      }

      const afterPCount = (() => {
        try {
          return editor.querySelectorAll('p').length;
        } catch {
          return 0;
        }
      })();
      if (afterPCount < 3) throw new Error(`段落数量异常（pCount=${afterPCount}）`);

      const afterImgCount = (() => {
        try {
          return editor.querySelectorAll('img').length;
        } catch {
          return 0;
        }
      })();
      if (expectedImages && afterImgCount < expectedImages) {
        // 有些图片会在插入后延迟渲染，给一个额外窗口等待编辑器 DOM 渲染到位
        await retryUntil(
          async () => {
            const now = editor.querySelectorAll('img').length;
            if (now >= expectedImages) return true;
            throw new Error(`图片仍在上传/渲染（${now}/${expectedImages}）`);
          },
          { timeoutMs: 120_000, intervalMs: 1200 }
        );
      }
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
}

async function stageSaveDraft(): Promise<void> {
  currentStage = 'saveDraft';
  await report({ status: 'running', stage: 'saveDraft', userMessage: getMessage('v2MsgSaving') });
  const el = Array.from(document.querySelectorAll<HTMLElement>('div, button, a')).find((n) => (n.textContent || '').trim() === '保存');
  if (!el) throw new Error('未找到保存按钮');
  el.click();
}

async function stageSubmitPublish(): Promise<void> {
  currentStage = 'submitPublish';
  await report({ status: 'running', stage: 'submitPublish', userMessage: getMessage('v2MsgPublishing') });
  const el = Array.from(document.querySelectorAll<HTMLElement>('div, button, a')).find((n) => (n.textContent || '').trim() === '发布');
  if (!el) throw new Error('未找到发布按钮');
  el.click();
}

async function stageConfirmSuccess(action: 'draft' | 'publish'): Promise<boolean> {
  currentStage = 'confirmSuccess';
  await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgConfirmingResult') });

  const okTexts =
    action === 'draft'
      ? ['保存成功', '已保存']
      : ['发布成功', '已发布'];

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const text = document.body?.innerText || '';
    if (okTexts.some((t) => text.includes(t))) {
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgSuccessDetectedStartVerify') });
      return true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  await report({
    status: 'waiting_user',
    stage: 'waitingUser',
    userMessage: action === 'draft' ? getMessage('v2MsgPleaseConfirmSaveCompleted') : getMessage('v2MsgPleaseConfirmPublishCompleted'),
    userSuggestion: getMessage('v2SugHandleModalRiskRequiredThenContinueOrRetry'),
  });
  return false;
}

async function runFlow(job: AnyJob): Promise<void> {
  await report({ status: 'running', stage: 'openEntry', userMessage: getMessage('v2MsgEnteredEditorPage') });
  await stageDetectLogin();
  await stageFillContent(job.article.title, job.article.contentHtml, job.article.sourceUrl);
  if (job.action === 'draft') {
    await stageSaveDraft();
    const confirmed = await stageConfirmSuccess('draft');
    if (!confirmed) return;
    await report({
      status: 'success',
      stage: 'done',
      userMessage: getMessage('v2MsgDraftSavedVerifyDone'),
      devDetails: summarizeVerifyDetails({ draftUrl: location.href }),
    });
    return;
  } else {
    await stageSubmitPublish();
    const confirmed = await stageConfirmSuccess('publish');
    if (!confirmed) return;

    // 墨问可能在“发布成功”后延迟通过 SPA 切到 detail，这里额外等待一段时间再决定是否跳列表页。
    const detailWaitDeadline = Date.now() + 30_000;
    while (!isDetailPage() && Date.now() < detailWaitDeadline) {
      await new Promise((r) => setTimeout(r, 600));
    }

    // 详情页验收
    if (isDetailPage()) {
      const noteUuid = (() => {
        try {
          const parts = String(location.pathname || '')
            .split('/')
            .filter(Boolean);
          return String(parts[parts.length - 1] || '').trim();
        } catch {
          return '';
        }
      })();

      const htmlContainsSourceUrl = (html: string, sourceUrl: string): boolean => {
        const target = String(sourceUrl || '').trim();
        if (!target) return false;
        const hay = String(html || '');
        if (hay.includes(target)) return true;

        try {
          const decoded = decodeURIComponent(target);
          if (decoded && decoded !== target && hay.includes(decoded)) return true;
        } catch {
          // ignore
        }

        try {
          const u = new URL(target);
          const host = String(u.hostname || '').trim();
          const path = String(u.pathname || '').replace(/\/+$/g, '').trim();
          const pathToken = path
            .split('/')
            .filter(Boolean)
            .pop();
          const hostHit = host ? hay.includes(host) : false;
          if (!hostHit) return false;
          if (!pathToken) return true;
          if (path && hay.includes(path)) return true;
          if (hay.includes(pathToken)) return true;
        } catch {
          // ignore
        }

        return false;
      };

      const countImagesInHtml = (html: string): number => {
        const raw = String(html || '');
        const uuids = new Set<string>();
        const re = /<img\b[^>]*\buuid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
        let m: RegExpExecArray | null = null;
        while ((m = re.exec(raw))) {
          const u = String(m[1] || m[2] || m[3] || '')
            .trim()
            .replace(/^['"]|['"]$/g, '');
          if (u) uuids.add(u);
        }
        if (uuids.size) return uuids.size;
        const imgs = raw.match(/<img\b/gi);
        return Array.isArray(imgs) ? imgs.length : 0;
      };

      let ok = false;
      let imageCount = 0;
      let verifyFrom: 'api' | 'dom' = 'dom';
      let apiTitle = '';
      let apiContentLen = 0;

      try {
        const show = await retryUntil(
          async () => {
            if (!noteUuid) throw new Error('empty note uuid');
            const res = await fetch('/api/note/wxa/v1/note/show', {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ uuid: noteUuid, peekKey: '', accessToken: '' }),
            });
            if (!res.ok) throw new Error(`note/show api failed: ${res.status}`);
            const json = (await res.json().catch(() => null)) as
              | { detail?: { noteBase?: { title?: unknown; content?: unknown } } }
              | null;
            const title = String(json?.detail?.noteBase?.title || '').trim();
            const content = String(json?.detail?.noteBase?.content || '').trim();
            if (!content) throw new Error('note/show empty content');
            if (content.length < 200 && !content.includes('原文链接') && !content.includes('mp.weixin.qq.com')) {
              throw new Error(`note/show content not ready (len=${content.length})`);
            }
            return { title, content };
          },
          { timeoutMs: 60_000, intervalMs: 1200 }
        );
        verifyFrom = 'api';
        apiTitle = show.title;
        apiContentLen = show.content.length;
        ok = htmlContainsSourceUrl(show.content, job.article.sourceUrl);
        imageCount = countImagesInHtml(show.content);
      } catch {
        verifyFrom = 'dom';
        ok = pageContainsSourceUrl(job.article.sourceUrl);
        imageCount = (() => {
          if (!ok) return 0;
          try {
            const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a')).find((a) => {
              const href = String(a.href || '');
              return href && job.article.sourceUrl && href.includes(job.article.sourceUrl);
            });
            const container = (anchor?.closest('article,main,section,div') as HTMLElement | null) || document.body;
            return container ? container.querySelectorAll('img').length : 0;
          } catch {
            return 0;
          }
        })();
      }

      const imageOk = expectedImagesForJob ? imageCount >= expectedImagesForJob : true;
      await report({
        status: ok && imageOk ? 'success' : 'waiting_user',
        stage: ok && imageOk ? 'done' : 'waitingUser',
        userMessage:
          ok && imageOk
            ? getMessage('v2MsgVerifyPassedDetailHasSourceLink')
            : !ok
              ? getMessage('v2MsgVerifyFailedDetailNoSourceLink')
              : getMessage('v2MsgVerifyFailedDetailImageCountInsufficient', [
                  String(imageCount),
                  String(expectedImagesForJob || '?'),
                ]),
        userSuggestion: ok && imageOk ? undefined : getMessage('v2SugCheckSourceLinkAtEndThenContinue'),
        devDetails: {
          ...summarizeVerifyDetails({
            publishedUrl: location.href,
            sourceUrlPresent: ok,
          }),
          verifyFrom,
          ...(expectedImagesForJob ? { imageCount, expectedImages: expectedImagesForJob } : { imageCount }),
          ...(verifyFrom === 'api' ? { apiTitle, apiContentLen, noteUuid } : { noteUuid }),
        },
      });
      return;
    }

    // 发布后跳转到列表页验收；若已进入 detail 则由 detail 分支验收
    if (!isDetailPage()) {
      await report({
        status: 'running',
        stage: 'confirmSuccess',
        userMessage: getMessage('v2MsgMowenPublishTriggeredGoNotesListVerify'),
        devDetails: summarizeVerifyDetails({ listUrl: 'https://note.mowen.cn/my/notes' }),
      });
      location.href = 'https://note.mowen.cn/my/notes';
      return;
    }
  }
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
        const html = withTitleAndSourceUrl(currentJob.article.contentHtml, currentJob.article.title, currentJob.article.sourceUrl);
        const tokens = buildRichContentTokens({
          contentHtml: html,
          baseUrl: currentJob.article.sourceUrl,
          sourceUrl: '',
          htmlMode: 'raw',
        });
        expectedImagesForJob = tokens.filter((t) => t?.kind === 'image').length;
      } catch {
        expectedImagesForJob = 0;
      }
    }

    if (isEditorPage()) {
      await runFlow(currentJob);
      return;
    }

    if (isListPage()) {
      currentStage = 'confirmSuccess';
      await report({ status: 'running', stage: 'confirmSuccess', userMessage: getMessage('v2MsgVerifyFindNewNoteInList') });

      if (!pageContainsTitle(currentJob.article.title)) {
        const key = 'bawei_v2_mowen_list_retry';
        const n = Number(sessionStorage.getItem(key) || '0') + 1;
        sessionStorage.setItem(key, String(n));
        if (n <= 12) {
          await report({
            status: 'running',
            stage: 'confirmSuccess',
            userMessage: getMessage('v2MsgVerifyListNoTitleRefresh8s12', [String(n)]),
            devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
          });
          setTimeout(() => location.reload(), 8000);
          return;
        }

        sessionStorage.removeItem(key);

        // 兜底：列表页标题可能被截断/异步渲染导致 token 不可见，尝试探测打开前几个详情页查找原文链接。
        const probeCandidates = Array.from(
          new Set(
            Array.from(document.querySelectorAll<HTMLAnchorElement>('a'))
              .map((a) => String(a.href || '').trim())
              .filter((href) => href && href.includes('note.mowen.cn/detail/'))
          )
        ).slice(0, 8);

        if (probeCandidates.length) {
          const activeKey = getMowenProbeActiveKey(currentJob.jobId);
          const idxKey = getMowenProbeIndexKey(currentJob.jobId);
          const candidatesKey = getMowenProbeCandidatesKey(currentJob.jobId);
          sessionStorage.setItem(activeKey, '1');
          sessionStorage.setItem(candidatesKey, JSON.stringify(probeCandidates));
          // idx 指向“下一个要打开”的候选（首个由当前跳转消耗）
          sessionStorage.setItem(idxKey, '1');

          await report({
            status: 'running',
            stage: 'confirmSuccess',
            userMessage: getMessage('v2MsgVerifyNotFoundNewArticleProbingDetails', ['1', String(probeCandidates.length)]),
            devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true, publishedUrl: probeCandidates[0] }),
          });
          location.href = probeCandidates[0];
          return;
        }

        await report({
          status: 'waiting_user',
          stage: 'waitingUser',
          userMessage: getMessage('v2MsgVerifyFailedListNoTitleTitleIsFirstLine'),
          userSuggestion: getMessage('v2SugRefreshListThenContinue'),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: false }),
        });
        return;
      }

      sessionStorage.removeItem('bawei_v2_mowen_list_retry');

      const node = findAnyElementContainingText(titleToken(currentJob.article.title));
      const link = (node?.closest('a') as HTMLAnchorElement | null) || findAnchorContainingText(titleToken(currentJob.article.title));
      if (link?.href) {
        await report({
          status: 'running',
          stage: 'confirmSuccess',
          userMessage: getMessage('v2MsgVerifyFoundTitleOpeningDetail'),
          devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
        });
        location.href = link.href;
        return;
      }

      await report({
        status: 'waiting_user',
        stage: 'waitingUser',
        userMessage: getMessage('v2MsgVerifyBlockedNoDetailLink'),
        userSuggestion: getMessage('v2SugOpenDetailManuallyThenWaitVerify'),
        devDetails: summarizeVerifyDetails({ listUrl: location.href, listVisible: true }),
      });
      return;
    }

    if (isDetailPage()) {
      const noteUuid = (() => {
        try {
          const parts = String(location.pathname || '')
            .split('/')
            .filter(Boolean);
          return String(parts[parts.length - 1] || '').trim();
        } catch {
          return '';
        }
      })();

      const htmlContainsSourceUrl = (html: string, sourceUrl: string): boolean => {
        const target = String(sourceUrl || '').trim();
        if (!target) return false;
        const hay = String(html || '');
        if (hay.includes(target)) return true;

        try {
          const decoded = decodeURIComponent(target);
          if (decoded && decoded !== target && hay.includes(decoded)) return true;
        } catch {
          // ignore
        }

        try {
          const u = new URL(target);
          const host = String(u.hostname || '').trim();
          const path = String(u.pathname || '').replace(/\/+$/g, '').trim();
          const pathToken = path
            .split('/')
            .filter(Boolean)
            .pop();
          const hostHit = host ? hay.includes(host) : false;
          if (!hostHit) return false;
          if (!pathToken) return true;
          if (path && hay.includes(path)) return true;
          if (hay.includes(pathToken)) return true;
        } catch {
          // ignore
        }

        return false;
      };

      const countImagesInHtml = (html: string): number => {
        const raw = String(html || '');
        const uuids = new Set<string>();
        const re = /<img\b[^>]*\buuid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
        let m: RegExpExecArray | null = null;
        while ((m = re.exec(raw))) {
          const u = String(m[1] || m[2] || m[3] || '')
            .trim()
            .replace(/^['"]|['"]$/g, '');
          if (u) uuids.add(u);
        }
        if (uuids.size) return uuids.size;
        const imgs = raw.match(/<img\b/gi);
        return Array.isArray(imgs) ? imgs.length : 0;
      };

      let ok = false;
      let imageCount = 0;
      let verifyFrom: 'api' | 'dom' = 'dom';
      let apiTitle = '';
      let apiContentLen = 0;

      // 优先使用 note/show 接口验收（比 DOM 更稳定，避免 SPA 异步渲染导致的假阴性）
      try {
        const show = await retryUntil(
          async () => {
            if (!noteUuid) throw new Error('empty note uuid');
            const res = await fetch('/api/note/wxa/v1/note/show', {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ uuid: noteUuid, peekKey: '', accessToken: '' }),
            });
            if (!res.ok) throw new Error(`note/show api failed: ${res.status}`);
            const json = (await res.json().catch(() => null)) as
              | { detail?: { noteBase?: { title?: unknown; content?: unknown } } }
              | null;
            const title = String(json?.detail?.noteBase?.title || '').trim();
            const content = String(json?.detail?.noteBase?.content || '').trim();
            if (!content) throw new Error('note/show empty content');
            // 刚跳转到详情页时，接口可能返回极短内容；此处等到内容达到一定规模再开始验收。
            if (content.length < 200 && !content.includes('原文链接') && !content.includes('mp.weixin.qq.com')) {
              throw new Error(`note/show content not ready (len=${content.length})`);
            }
            return { title, content };
          },
          { timeoutMs: 60_000, intervalMs: 1200 }
        );
        verifyFrom = 'api';
        apiTitle = show.title;
        apiContentLen = show.content.length;
        ok = htmlContainsSourceUrl(show.content, currentJob.article.sourceUrl);
        imageCount = countImagesInHtml(show.content);
      } catch {
        // fallback: DOM（仍可能因异步渲染而不稳定，但比直接失败更好）
        verifyFrom = 'dom';
        ok = pageContainsSourceUrl(currentJob.article.sourceUrl);
        imageCount = (() => {
          if (!ok) return 0;
          try {
            const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a')).find((a) => {
              const href = String(a.href || '');
              return href && currentJob?.article?.sourceUrl && href.includes(currentJob.article.sourceUrl);
            });
            const container = (anchor?.closest('article,main,section,div') as HTMLElement | null) || document.body;
            return container ? container.querySelectorAll('img').length : 0;
          } catch {
            return 0;
          }
        })();
      }

      const imageOk = expectedImagesForJob ? imageCount >= expectedImagesForJob : true;

      // probe：若未命中 sourceUrl，则依次打开候选详情页继续验收
      if (!ok) {
        const activeKey = getMowenProbeActiveKey(currentJob.jobId);
        const idxKey = getMowenProbeIndexKey(currentJob.jobId);
        const candidatesKey = getMowenProbeCandidatesKey(currentJob.jobId);
        const probeActive = sessionStorage.getItem(activeKey) === '1';
        if (probeActive) {
          const candidates = (() => {
            try {
              const raw = sessionStorage.getItem(candidatesKey) || '[]';
              const parsed = JSON.parse(raw) as unknown;
              return Array.isArray(parsed) ? parsed.map((v) => String(v || '').trim()).filter(Boolean) : [];
            } catch {
              return [];
            }
          })();
          const idx = Number(sessionStorage.getItem(idxKey) || '0');
          if (idx < candidates.length) {
            sessionStorage.setItem(idxKey, String(idx + 1));
            await report({
              status: 'running',
              stage: 'confirmSuccess',
              userMessage: getMessage('v2MsgVerifyNotFoundNewArticleProbingDetails', [String(idx + 1), String(candidates.length)]),
              devDetails: summarizeVerifyDetails({ publishedUrl: candidates[idx], sourceUrlPresent: false }),
            });
            location.href = candidates[idx];
            return;
          }
          sessionStorage.removeItem(activeKey);
          sessionStorage.removeItem(idxKey);
          sessionStorage.removeItem(candidatesKey);
        }
      } else {
        try {
          sessionStorage.removeItem(getMowenProbeActiveKey(currentJob.jobId));
          sessionStorage.removeItem(getMowenProbeIndexKey(currentJob.jobId));
          sessionStorage.removeItem(getMowenProbeCandidatesKey(currentJob.jobId));
        } catch {
          // ignore
        }
      }

      await report({
        status: ok && imageOk ? 'success' : 'waiting_user',
        stage: ok && imageOk ? 'done' : 'waitingUser',
        userMessage:
          ok && imageOk
            ? getMessage('v2MsgVerifyPassedDetailHasSourceLink')
            : !ok
              ? getMessage('v2MsgVerifyFailedDetailNoSourceLink')
              : getMessage('v2MsgVerifyFailedDetailImageCountInsufficient', [
                  String(imageCount),
                  String(expectedImagesForJob || '?'),
                ]),
        userSuggestion: ok && imageOk ? undefined : getMessage('v2SugCheckSourceLinkAtEndThenContinue'),
        devDetails: {
          ...summarizeVerifyDetails({ publishedUrl: location.href, sourceUrlPresent: ok }),
          verifyFrom,
          ...(expectedImagesForJob ? { imageCount, expectedImages: expectedImagesForJob } : { imageCount }),
          ...(verifyFrom === 'api' ? { apiTitle, apiContentLen, noteUuid } : { noteUuid }),
        },
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
