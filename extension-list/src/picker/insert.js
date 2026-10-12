(() => {
  "use strict";
  // Inserting pictures into Arca Live's Froala editor. A picture is handed to the editor as a
  // synthetic paste (fallback: one synthetic drop) so that Arca uploads the file itself; success
  // is a new <img> hosted on Arca's image host. Nothing here touches #content or submits the form.
  const EDITOR = "form#article_write_form .write-body .fr-element.fr-view";
  const EDITOR_FALLBACK = ".write-body .fr-element.fr-view";
  const ARCA_IMAGE_HOST = /(?:^|\.)(?:arca\.live|namu\.la)$/i;
  const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp" };
  const ACK_MS = 3000, TOTAL_MS = 30000;

  const fileName = (assetId, mime) => `lakomics-${String(assetId).slice(0, 40)}.${EXTENSIONS[mime] || "img"}`;
  function isArcaImage(src, base = "https://arca.live/") {
    try { const url = new URL(src, base); return url.protocol === "https:" && ARCA_IMAGE_HOST.test(url.hostname); } catch { return false; }
  }

  // ---- the editor on the page ------------------------------------------------------------
  function createEditorAdapter({ doc = document, win = window } = {}) {
    // `saved` is the user's caret; `afterSrc` the src of the last inserted picture. Froala re-renders
    // the body (old <img> nodes are replaced), so the next picture's place is found again by src.
    let saved = null, afterSrc = null;
    const find = () => doc.querySelector(EDITOR) || doc.querySelector(EDITOR_FALLBACK);
    const endRange = editor => { const range = doc.createRange(); range.selectNodeContents(editor); range.collapse(false); return range; };
    const select = range => { const selection = win.getSelection(); selection.removeAllRanges(); selection.addRange(range); };
    const arcaImages = editor => Array.from(editor.querySelectorAll("img")).filter(img => isArcaImage(img.getAttribute("src") || "", win.location.href));
    return {
      find, available: () => Boolean(find()),
      // Keep the caret the user last had inside the body.
      remember() {
        const editor = find(), selection = win.getSelection?.();
        if (!editor || !selection || !selection.rangeCount) return false;
        const range = selection.getRangeAt(0);
        if (!editor.contains(range.commonAncestorContainer)) return false;
        saved = range.cloneRange(); return true;
      },
      // Focus the body and put the caret back (end of the body if it never had one).
      restore() {
        const editor = find(); if (!editor) return false;
        editor.focus({ preventScroll: true });
        const anchor = afterSrc && Array.from(editor.querySelectorAll("img")).find(img => img.getAttribute("src") === afterSrc);
        if (anchor) { const range = doc.createRange(); range.setStartAfter(anchor); range.collapse(true); select(range); return true; }
        select(saved && editor.contains(saved.commonAncestorContainer) ? saved.cloneRange() : endRange(editor));
        return true;
      },
      placeCaretAfter(node) {
        const editor = find(); if (!editor || !node?.parentNode) return false;
        afterSrc = node.getAttribute?.("src") || null;
        const range = doc.createRange(); range.setStartAfter(node); range.collapse(true);
        saved = range.cloneRange(); select(range); return true;
      },
      // After an insert Froala keeps the picture selected with its image toolbar open; a paste then
      // goes nowhere. Leave that mode (Escape, as a person would) and wait until it has closed.
      async settle(wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
        const editor = find(); if (!editor) return;
        const busy = () => Boolean(doc.querySelector(".fr-popup.fr-active") || editor.querySelector("img.fr-active, img.fr-uploading"));
        for (let tries = 0; tries < 20 && busy(); tries++) {
          editor.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
          await wait(100);
        }
        await wait(150);
      },
      // `promise` resolves with the first new <img> once it is hosted on Arca (Froala first inserts
      // a blob:/data: placeholder and swaps its src after the upload); `started` resolves as soon as
      // any new <img> appears, which is how a handled paste is recognised even when the editor does
      // not mark the synthetic event as handled.
      watchNewImage() {
        const editor = find(); if (!editor) return null;
        const before = new Set(Array.from(editor.querySelectorAll("img")).map(img => img.getAttribute("src") || ""));
        const isPlaceholder = img => /^(?:blob|data):/i.test(img.getAttribute("src") || "") || img.classList.contains("fr-uploading");
        let observer = null, settle, settleStarted, settleGone, seen = false;
        const started = new Promise(resolve => { settleStarted = resolve; });
        // Resolves when Froala dropped the placeholder without an Arca picture (a refused upload).
        const gone = new Promise(resolve => { settleGone = resolve; });
        const promise = new Promise(resolve => {
          settle = resolve;
          const check = () => {
            const images = Array.from(editor.querySelectorAll("img"));
            const placeholder = images.find(isPlaceholder);
            if (placeholder) { seen = true; settleStarted(placeholder); }
            const added = images.find(img => !isPlaceholder(img) && !before.has(img.getAttribute("src") || "") && isArcaImage(img.getAttribute("src") || "", win.location.href));
            if (added) { observer?.disconnect(); resolve(added); }
            else if (seen && !placeholder) settleGone(true);
          };
          observer = new win.MutationObserver(check);
          observer.observe(editor, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
          check();
        });
        return { promise, started, gone, cancel() { observer?.disconnect(); settle(null); settleStarted(null); settleGone(false); } };
      },
      // A placeholder left behind by a refused upload (Arca answered 503) would stay half-loaded in
      // the post; take it out before trying again.
      removePlaceholders() {
        const editor = find(); if (!editor) return 0;
        const stale = Array.from(editor.querySelectorAll("img")).filter(img => /^(?:blob|data):/i.test(img.getAttribute("src") || "") || img.classList.contains("fr-uploading"));
        stale.forEach(img => img.remove());
        if (stale.length) editor.dispatchEvent(new win.Event("input", { bubbles: true }));
        return stale.length;
      },
    };
  }

  // ---- delivery of the file to the page's handlers ---------------------------------------
  // Direct: the content script dispatches the event itself (isolated world).
  function createDirectTransport({ doc = document, win = window } = {}) {
    return {
      name: "direct",
      async ping() { return true; },
      async dispatch(kind, file) {
        const editor = doc.querySelector(EDITOR) || doc.querySelector(EDITOR_FALLBACK);
        if (!editor) return { handled: false, error: "editor" };
        const transfer = new win.DataTransfer(); transfer.items.add(file);
        let event;
        if (kind === "paste") event = new win.ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
        else {
          const rect = editor.getBoundingClientRect();
          event = new win.DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + 8 });
        }
        editor.dispatchEvent(event);
        return { handled: event.defaultPrevented };
      },
    };
  }
  // Bridge: the same event dispatched by src/picker/page-bridge.js in the page's own JS world,
  // so the File and DataTransfer belong to the page's realm (instanceof checks in Froala hold).
  function createBridgeTransport({ win = window, timeoutMs = 5000, pingMs = 800, newId = () => Math.random().toString(36).slice(2) + Date.now().toString(36) } = {}) {
    const pending = new Map();
    win.addEventListener("message", event => {
      if (event.source !== win || event.origin !== win.location.origin) return;
      const data = event.data;
      if (!data || data.lakomicsPickerReply !== 1 || typeof data.id !== "string") return;
      const entry = pending.get(data.id);
      if (entry) { pending.delete(data.id); entry.resolve(data); }
    });
    function request(message, ms) {
      return new Promise(resolve => {
        const id = newId();
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, ms);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } });
        win.postMessage({ lakomicsPicker: 1, id, ...message }, win.location.origin);
      });
    }
    return {
      name: "bridge",
      async ping() { return Boolean((await request({ kind: "ping" }, pingMs))?.ok); },
      async dispatch(kind, file) {
        const reply = await request({ kind, file }, timeoutMs);
        return reply ? { handled: reply.handled === true, error: reply.error } : { handled: false, error: "bridge" };
      },
    };
  }
  // Prefer the page-world bridge when it answers; otherwise dispatch directly.
  async function chooseTransport(bridge, direct) {
    try { if (await bridge.ping()) return bridge; } catch {}
    return direct;
  }

  // ---- one picture -----------------------------------------------------------------------
  // Timers are wrapped: Chrome throws "Illegal invocation" when setTimeout runs with `this` = an object.
  function createInserter({ editor, getTransport, ackMs = ACK_MS, totalMs = TOTAL_MS, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle) } } = {}) {
    function sleep(ms) {
      let handle;
      const promise = new Promise(resolve => { handle = timers.set(() => resolve(null), ms); });
      return { promise, cancel: () => timers.clear(handle) };
    }
    async function insertOne(file) {
      if (!editor.available()) return { ok: false, reason: "editor" };
      const transport = await getTransport();
      await editor.settle?.();
      editor.restore();
      const watcher = editor.watchNewImage();
      if (!watcher) return { ok: false, reason: "editor" };
      const waits = [];
      const waitFor = ms => { const timer = sleep(ms); waits.push(timer); return Promise.race([watcher.promise, timer.promise, ...(watcher.gone ? [watcher.gone.then(() => null)] : [])]); };
      // A placeholder that never became an Arca picture is a refused upload (retried once); a handled
      // paste that never showed any picture is a plain timeout.
      let placeholderSeen = false;
      watcher.started?.then(found => { if (found) placeholderSeen = true; });
      const failed = () => {
        if (!placeholderSeen) return { ok: false, reason: "editorTimeout" };
        editor.removePlaceholders?.();
        return { ok: false, reason: "uploadFailed" };
      };
      try {
        let image, sent;
        try { sent = await transport.dispatch("paste", file); } catch { sent = { handled: false }; }
        if (sent.error === "editor") return { ok: false, reason: "editor" };
        // A new <img> of any kind (the upload placeholder) means the editor took the paste: never
        // fall back to a drop then, or the picture would be inserted twice.
        const startedOrDone = ms => { const timer = sleep(ms); waits.push(timer); return Promise.race([watcher.started || watcher.promise, watcher.promise, timer.promise]); };
        if (sent.handled) image = await waitFor(totalMs);
        else if (await startedOrDone(ackMs)) image = await waitFor(totalMs);
        else {
          editor.restore();
          try { sent = await transport.dispatch("drop", file); } catch { sent = { handled: false }; }
          if (sent.handled || await startedOrDone(ackMs)) image = await waitFor(totalMs);
          if (!image) return placeholderSeen || sent.handled ? failed() : { ok: false, reason: "ignored" };
        }
        if (!image) return failed();
        editor.placeCaretAfter(image);
        return { ok: true, image };
      } finally { watcher.cancel(); waits.forEach(timer => timer.cancel()); }
    }
    return { insertOne };
  }

  // ---- a queue of pictures ---------------------------------------------------------------
  // `fetchOriginal(id)` -> { ok, mime, bytes } | { ok:false, kind }. One picture at a time, in the
  // given order; a failure never stops the rest (the user can press 중지).
  // Arca's upload endpoint answers 503 to uploads sent back to back, so pictures go in with a short
  // gap, and a refused upload is retried once after a pause.
  function createJobRunner({ fetchOriginal, inserter, onState = () => {}, makeFile = (bytes, name, mime) => new File([bytes], name, { type: mime }), shouldStop = () => false, gapMs = 1200, retryMs = 3000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    async function run(ids) {
      const outcome = [];
      for (const id of ids) {
        if (shouldStop()) break;
        onState(id, "up", "");
        let original;
        try { original = await fetchOriginal(id); } catch { original = { ok: false, kind: "offline" }; }
        if (!original?.ok) { onState(id, "bad", original?.kind || "offline"); outcome.push({ id, ok: false, kind: original?.kind || "offline" }); continue; }
        let result;
        const attempt = async () => {
          try { return await inserter.insertOne(makeFile(original.bytes, fileName(id, original.mime), original.mime)); }
          catch { return { ok: false, reason: "ignored" }; }
        };
        if (outcome.length) await pause(gapMs);
        result = await attempt();
        if (!result.ok && result.reason === "uploadFailed" && !shouldStop()) { await pause(retryMs); result = await attempt(); }
        onState(id, result.ok ? "ok" : "bad", result.ok ? "" : result.reason);
        outcome.push({ id, ok: result.ok, kind: result.reason || "" });
      }
      return outcome;
    }
    return { run };
  }

  globalThis.LakomicsPickerInsert = {
    EDITOR, ARCA_IMAGE_HOST, ACK_MS, TOTAL_MS, fileName, isArcaImage,
    createEditorAdapter, createDirectTransport, createBridgeTransport, chooseTransport, createInserter, createJobRunner,
  };
})();
