(() => {
  "use strict";
  // 이미지 글자 번역: the worker reads and translates the picture; this file only asks for
  // it and shows the answer in a popover beside the image.
  const MAX_EDGE = 1568;
  const messages = {
    image_unavailable: "이미지를 불러오지 못했어요", image_too_large: "이미지가 너무 커요", image_type: "지원하지 않는 이미지 형식이에요",
    image_unreadable: "이미지를 읽지 못했어요", api_key_missing: "API 키가 필요해요", worker_timeout: "시간이 너무 오래 걸렸어요", timeout: "시간이 너무 오래 걸렸어요",
  };
  function failureText(code) { return messages[code] || "번역하지 못했어요"; }
  // The already-loaded picture drawn small; null when it is not an <img> or the canvas is tainted.
  function captureImage(image, doc = document) {
    try {
      if (!image || image.tagName !== "IMG" || !image.complete || !image.naturalWidth || !image.naturalHeight) return null;
      const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = doc.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d"); if (!context) return null;
      context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", 0.85);
      return url.startsWith("data:image/") ? url : null;
    } catch { return null; }
  }
  function create({ doc = document, win = window, send, surfaces, alive = () => true, watchSession = () => ({ watch() {}, stop() {} }) } = {}) {
    const model = globalThis.LakomicsContextModel, cache = new Map();
    let current = null, sequence = 0;
    const reduced = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

    async function load(session) {
      const { imageUrl: url, image } = session.context;
      if (/^https:/i.test(url)) {
        const result = await send({ type: "translation:image", url });
        // Only a failed download falls back to the copy already loaded in the page.
        if (result?.ok || result?.code !== "image_unavailable") return result;
      } else if (/^data:image\//i.test(url) && url.length < 11000000) return send({ type: "translation:image", dataUrl: url });
      const dataUrl = captureImage(image, doc);
      return dataUrl ? send({ type: "translation:image", dataUrl }) : { ok: false, code: "image_unavailable" };
    }

    function open(session) {
      if (session.popover) return session.popover;
      const surface = surfaces.host("lakomics-image-popover", session.context.image || session.context.target);
      const box = doc.createElement("div"); box.className = "popA"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "이미지 글자 번역"); box.tabIndex = -1; box.style.pointerEvents = "auto";
      surface.root.append(box);
      const popover = { surface, box, copyTimer: 0 };
      session.popover = popover;
      const touch = () => surface.node.dataset.touch === "true";
      surface.node.dataset.touch = String(Boolean(win.matchMedia?.("(hover: none) and (pointer: coarse)").matches));
      popover.place = () => {
        const image = session.context.image;
        if (!image?.isConnected || surface.closed) return;
        const rect = image.getBoundingClientRect(), view = surfaces.viewport();
        const outside = rect.bottom <= (view.offsetTop || 0) || rect.top >= (view.offsetTop || 0) + view.height || rect.right <= (view.offsetLeft || 0) || rect.left >= (view.offsetLeft || 0) + view.width;
        if (rect.width > 0 && outside) { close(); return; }
        const preferred = touch() ? Math.min(360, view.width - 48) : 300;
        const size = { width: Math.max(160, preferred), height: box.getBoundingClientRect().height || 120 };
        const position = model.imagePlacement(rect, size, view);
        box.style.width = position.width + "px"; popover.side = position.side;
        surface.node.style.left = position.x + "px"; surface.node.style.top = position.y + "px";
      };
      popover.follow = () => popover.place();
      doc.addEventListener("scroll", popover.follow, true); win.addEventListener("resize", popover.follow);
      popover.onKey = event => { if (event.isTrusted === true && event.key === "Escape") close(); };
      win.addEventListener("keydown", popover.onKey, true);
      surfaces.reveal(surface);
      return popover;
    }

    // Replaces the content in one step; the popover height eases over 140 ms.
    function fill(session, build) {
      const popover = open(session), box = popover.box, before = box.getBoundingClientRect().height;
      win.clearTimeout(popover.copyTimer); box.replaceChildren(); build(box); popover.place();
      const after = box.getBoundingClientRect().height;
      if (!before || !after || Math.abs(after - before) < 1 || reduced()) return;
      box.style.height = before + "px"; box.style.overflow = "hidden"; box.getBoundingClientRect();
      box.style.transition = "height 140ms cubic-bezier(.2,0,0,1)"; box.style.height = after + "px";
      win.setTimeout(() => { box.style.height = ""; box.style.transition = ""; box.style.overflow = ""; popover.place(); }, 150);
    }
    function header(title) {
      const bar = doc.createElement("div"); bar.className = "h"; bar.setAttribute("aria-live", "polite");
      const text = doc.createElement("span"); text.textContent = title; const spacer = doc.createElement("span"); spacer.className = "sp";
      const button = doc.createElement("button"); button.className = "x"; button.setAttribute("aria-label", "닫기"); button.append(surfaces.icon("close")); button.addEventListener("click", () => close());
      bar.append(text, spacer, button); return bar;
    }
    function showPending(session) {
      fill(session, box => {
        box.append(header("읽는 중"));
        const body = doc.createElement("div"); body.className = "pb";
        for (const width of ["70%", "90%", "55%"]) { const bar = doc.createElement("span"); bar.className = "sk"; bar.style.width = width; body.append(bar); }
        box.append(body);
      });
      focusIfKeyboard(session);
    }
    function focusIfKeyboard(session) { if (session.keyboard && !session.focused && session.popover) { session.focused = true; session.popover.box.focus({ preventScroll: true }); } }
    function showLines(session, lines) {
      fill(session, box => {
        box.append(header("이미지 글자 번역"));
        const body = doc.createElement("div"); body.className = "pb";
        if (!lines.length) { const none = doc.createElement("p"); none.className = "none"; none.textContent = "글자 없음"; body.append(none); box.append(body); return; }
        const list = doc.createElement("ol");
        for (const line of lines) {
          const item = doc.createElement("li"), korean = doc.createElement("b"); korean.lang = "ko"; korean.textContent = line.korean; item.append(korean);
          if (line.original) { const original = doc.createElement("small"); original.lang = model.sourceLanguage(line.original); original.textContent = line.original; item.append(original); }
          list.append(item);
        }
        body.append(list); box.append(body);
        const footer = doc.createElement("div"), button = doc.createElement("button"); footer.className = "f"; button.type = "button";
        const label = doc.createElement("span"); label.textContent = "모두 복사"; label.setAttribute("aria-live", "polite"); button.append(surfaces.icon("copy"), label);
        button.addEventListener("click", event => { if (event.isTrusted === true) copyAll(session, lines, label); });
        footer.append(button); box.append(footer);
      });
      focusIfKeyboard(session);
    }
    function copyAll(session, lines, label) {
      const text = lines.map(line => line.korean).join("\n"), popover = session.popover;
      const done = ok => { label.textContent = ok ? "복사됨" : "복사 실패"; win.clearTimeout(popover?.copyTimer); if (popover) popover.copyTimer = win.setTimeout(() => { label.textContent = "모두 복사"; }, 1600); };
      let promise;
      try { promise = win.navigator.clipboard.writeText(text); } catch (error) { promise = Promise.reject(error); }
      promise.then(() => done(true), () => send({ type: "context:clipboard", text }).then(result => done(result?.ok === true), () => done(false)));
    }
    function showFailure(session, code) {
      fill(session, box => {
        box.append(header("이미지 글자 번역"));
        const body = doc.createElement("div"); body.className = "pb";
        const text = doc.createElement("p"); text.className = "none bad"; text.setAttribute("role", "alert"); text.textContent = failureText(code); body.append(text);
        const retry = doc.createElement("button"); retry.className = "retry"; retry.type = "button"; retry.textContent = "다시 시도";
        retry.addEventListener("click", event => { if (event.isTrusted === true && current === session && alive(session.context)) { session.focused = false; void run(session, event); } });
        body.append(retry); box.append(body);
      });
      focusIfKeyboard(session);
    }

    async function run(session) {
      const context = session.context, key = `${context.imageModel || ""}\n${context.imageUrl}`, id = ++session.run;
      const cached = cache.get(key);
      if (cached) { showLines(session, cached); return; }
      const result = await globalThis.LakomicsContextSurfaces.delayed(() => load(session), () => { if (current === session && session.run === id && alive(context)) showPending(session); }, { win });
      if (current !== session || session.run !== id || !alive(context)) return;
      if (!result?.ok || !Array.isArray(result.lines)) { showFailure(session, result?.code); return; }
      cache.set(key, result.lines); showLines(session, result.lines);
    }

    function close(ms = 90) {
      const session = current; if (!session) return; current = null; session.watcher?.stop();
      const popover = session.popover; if (!popover) return;
      doc.removeEventListener("scroll", popover.follow, true); win.removeEventListener("resize", popover.follow); win.removeEventListener("keydown", popover.onKey, true); win.clearTimeout(popover.copyTimer);
      surfaces.remove(popover.surface, popover.box, ms);
    }
    function translate(context, event) {
      if (!context.imageUrl) return;
      close(0);
      const session = { id: ++sequence, run: 0, context, popover: null, keyboard: event?.type === "keydown", focused: false, watcher: watchSession() };
      current = session;
      session.watcher.watch(() => { context.departed = true; close(0); });
      return run(session);
    }
    return { translate, close, get open() { return Boolean(current?.popover); }, destroy() { close(0); cache.clear(); } };
  }
  globalThis.LakomicsContextImage = { create, captureImage, failureText };
})();
