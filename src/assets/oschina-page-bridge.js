(() => {
  const bridge = document.getElementById('bawei-oschina-editor-bridge');
  if (!bridge || bridge.dataset.baweiReady === '1') return;

  const commandEvent = 'bawei:oschina-editor-command';
  const resultEvent = 'bawei:oschina-editor-result';
  const complete = (requestId, result) => {
    bridge.setAttribute('data-bawei-result-id', String(requestId || ''));
    bridge.setAttribute('data-bawei-result', JSON.stringify(result));
    bridge.dispatchEvent(new Event(resultEvent));
  };

  const completeSuccess = (payload) => {
    setTimeout(() => {
      try {
        const currentRoot = document.querySelector(
          '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"].aie-content'
        );
        if (!currentRoot) {
          complete(payload.requestId, {
            ok: false,
            error: 'oschina-tiptap-editor-not-found-after-command'
          });
          return;
        }
        complete(payload.requestId, {
          ok: true,
          command: payload.command,
          finalHtmlLength: String(currentRoot.innerHTML || '').length,
          finalTextLength: String(currentRoot.innerText || currentRoot.textContent || '').length,
          imageCount: currentRoot.querySelectorAll('img').length
        });
      } catch (error) {
        complete(payload.requestId, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, 120);
  };

  const runCommand = (payload, attempt = 0) => {
    let beforeHtml = '';
    try {
      const root = document.querySelector(
        '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"].aie-content'
      );
      const editor = root && root.editor;
      const commands = editor && editor.commands;
      if (!root || !commands) {
        if (attempt < 20) {
          setTimeout(() => runCommand(payload, attempt + 1), 100);
          return;
        }
        complete(payload.requestId, {
          ok: false,
          error: 'oschina-tiptap-editor-not-found'
        });
        return;
      }
      beforeHtml = String(root.innerHTML || '');

      if (payload.command === 'reset') {
        if (typeof editor.commands?.clearContent !== 'function') {
          complete(payload.requestId, {
            ok: false,
            error: 'oschina-clear-content-unavailable'
          });
          return;
        }
        editor.commands.clearContent(true);
        if (typeof editor.commands?.focus === 'function') editor.commands.focus('end');
      } else if (payload.command === 'insert-html') {
        if (!String(payload.html || '').trim()) {
          complete(payload.requestId, { ok: false, error: 'oschina-insert-html-empty' });
          return;
        }
        if (typeof editor.commands?.insertContent !== 'function') {
          complete(payload.requestId, {
            ok: false,
            error: 'oschina-insert-content-unavailable'
          });
          return;
        }
        if (typeof editor.commands?.focus === 'function') editor.commands.focus('end');
        editor.commands.insertContent(String(payload.html));
        if (typeof editor.commands?.focus === 'function') editor.commands.focus('end');
      } else if (payload.command === 'replace-html') {
        if (!String(payload.html || '').trim()) {
          complete(payload.requestId, { ok: false, error: 'oschina-replace-content-empty' });
          return;
        }
        if (typeof editor.commands?.setContent !== 'function') {
          complete(payload.requestId, {
            ok: false,
            error: 'oschina-set-content-unavailable'
          });
          return;
        }
        editor.commands.setContent(String(payload.html), true);
        if (typeof editor.commands?.focus === 'function') editor.commands.focus('end');
      } else if (payload.command === 'focus-end') {
        if (typeof editor.commands?.focus !== 'function') {
          complete(payload.requestId, { ok: false, error: 'oschina-focus-unavailable' });
          return;
        }
        editor.commands.focus('end');
      } else if (payload.command === 'upload-image') {
        if (typeof editor.commands?.uploadImage !== 'function') {
          complete(payload.requestId, { ok: false, error: 'oschina-upload-image-unavailable' });
          return;
        }
        const imageFile = payload.imageFile || {};
        const encoded = String(imageFile.base64 || '');
        if (!encoded) {
          complete(payload.requestId, { ok: false, error: 'oschina-upload-image-empty' });
          return;
        }
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const file = new File([bytes], String(imageFile.name || 'bawei-image'), {
          type: String(imageFile.type || 'application/octet-stream')
        });
        const marker = String(imageFile.marker || '');
        if (marker) {
          if (
            typeof editor.commands?.setTextSelection !== 'function' ||
            typeof editor.state?.doc?.descendants !== 'function'
          ) {
            complete(payload.requestId, {
              ok: false,
              error: 'oschina-image-marker-selection-unavailable'
            });
            return;
          }
          let markerFrom = -1;
          editor.state.doc.descendants((node, position) => {
            if (markerFrom >= 0) return false;
            const text = String(node?.text || '');
            const offset = text.indexOf(marker);
            if (offset < 0) return true;
            markerFrom = Number(position) + offset;
            return false;
          });
          if (markerFrom < 0) {
            complete(payload.requestId, { ok: false, error: 'oschina-image-marker-not-found' });
            return;
          }
          editor.commands.setTextSelection({ from: markerFrom, to: markerFrom + marker.length });
        } else if (typeof editor.commands?.focus === 'function') {
          editor.commands.focus('end');
        }
        editor.commands.uploadImage(file);
      } else {
        complete(payload.requestId, { ok: false, error: 'oschina-command-unsupported' });
        return;
      }

      completeSuccess(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/mismatched transaction/i.test(message)) {
        const currentRoot = document.querySelector(
          '.tiptap.ProseMirror.aie-content, .ProseMirror[role="textbox"].aie-content'
        );
        const afterHtml = String(currentRoot?.innerHTML || '');
        if (
          (payload.command === 'insert-html' || payload.command === 'replace-html') &&
          afterHtml !== beforeHtml
        ) {
          completeSuccess(payload);
          return;
        }
        const safeToRetry =
          payload.command === 'reset' ||
          payload.command === 'focus-end' ||
          ((payload.command === 'insert-html' || payload.command === 'replace-html') &&
            afterHtml === beforeHtml);
        if (safeToRetry && attempt < 5) {
          setTimeout(() => runCommand(payload, attempt + 1), 120);
          return;
        }
      }
      complete(payload.requestId, { ok: false, error: message });
    }
  };

  bridge.addEventListener(commandEvent, () => {
    const requestId = bridge.getAttribute('data-bawei-request-id') || '';
    try {
      const encoded = bridge.getAttribute('data-bawei-request') || '';
      const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      runCommand(payload);
    } catch (error) {
      complete(requestId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
  bridge.dataset.baweiReady = '1';
})();
