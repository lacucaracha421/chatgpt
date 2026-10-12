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
  function normalized(text) { return String(text || "").normalize("NFKC").trim().replace(/\s+/g, " "); }
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
  function create({ doc = document, win = window, send, surfaces, collector = {}, alive = () => true, watchSession = () => ({ watch() {}, stop() {} }) } = {}) {
    const model = globalThis.LakomicsContextModel, cache = new Map();
    let current = null, sequence = 0;
    const reduced = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

    function placeMarkers(session) {
      const popover = session.popover, overlay = popover?.overlay, image = session.context.image;
      if (!overlay || overlay.surface.closed) return;
      const rect = image?.isConnected ? image.getBoundingClientRect() : null;
      overlay.surface.node.style.visibility = popover.pickerOpen || !rect || rect.width <= 0 || rect.height <= 0 ? "hidden" : "visible";
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const size = Math.min(popover.surface.node.dataset.touch === "true" ? 26 : 20, rect.width, rect.height);
      Object.assign(overlay.surface.node.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
      for (const { button, box } of overlay.markers) {
        const x = Math.max(size / 2, Math.min((box.x0 + box.x1) / 2000 * rect.width, rect.width - size / 2));
        const y = Math.max(size / 2, Math.min((box.y0 + box.y1) / 2000 * rect.height, rect.height - size / 2));
        Object.assign(button.style, { left: x / rect.width * 100 + "%", top: y / rect.height * 100 + "%", width: size + "px", height: size + "px" });
      }
    }
    function selectLine(session, index, scroll = false) {
      const popover = session.popover;
      if (current !== session || popover.pickerOpen) return;
      popover.selected = popover.selected === index ? null : index;
      popover.items.forEach((item, i) => item.classList.toggle("selected", i === popover.selected));
      for (const { button, index: i } of popover.overlay?.markers || []) button.setAttribute("aria-pressed", String(i === popover.selected));
      if (scroll && popover.selected !== null) {
        const item = popover.items[index], body = item.closest(".pb"), rect = item.getBoundingClientRect(), view = body.getBoundingClientRect();
        // Scroll only this body, never the underlying page or image.
        if (rect.top < view.top) body.scrollTop += rect.top - view.top;
        else if (rect.bottom > view.bottom) body.scrollTop += rect.bottom - view.bottom;
      }
    }
    function showMarkers(session, lines) {
      const popover = session.popover;
      if (!session.context.image || !lines.some(line => line.box)) return;
      const surface = surfaces.host("lakomics-image-markers", session.context.image), box = doc.createElement("div");
      surface.node.dataset.touch = popover.surface.node.dataset.touch;
      box.className = "image-markers"; surface.root.append(box);
      popover.overlay = { surface, box, markers: [] };
      lines.forEach((line, index) => {
        if (!line.box) return;
        const button = doc.createElement("button"); button.type = "button"; button.className = "image-marker";
        button.textContent = String(index + 1); button.setAttribute("aria-label", `${index + 1}번 대사`); button.setAttribute("aria-pressed", "false");
        // Keep touch/long-press and compatibility mouse events inside our surface.
        for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "contextmenu", "dragstart"]) {
          button.addEventListener(type, event => { event.stopPropagation(); if (type === "contextmenu" || type === "dragstart") event.preventDefault(); });
        }
        button.addEventListener("click", event => {
          event.preventDefault(); event.stopPropagation();
          if (event.isTrusted !== true) return;
          if (event.pointerType === "touch" || (surface.node.dataset.touch === "true" && event.detail > 0)) button.blur();
          selectLine(session, index, true);
        });
        box.append(button); popover.overlay.markers.push({ button, box: line.box, index });
      });
      placeMarkers(session); surfaces.reveal(surface);
    }

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
      const popover = { surface, box, copyTimer: 0, heightTimer: 0 };
      session.popover = popover;
      const touch = () => surface.node.dataset.touch === "true";
      surface.node.dataset.touch = String(Boolean(session.context.touch || win.matchMedia?.("(hover: none) and (pointer: coarse)").matches));
      // Keep the ancestor permissive: the header always uses none, and only the
      // overflowing body uses pan-y. These values must be ready before pointerdown.
      box.style.touchAction = "pan-y";
      popover.scrollability = () => {
        if (popover.pressed) return;
        const body = box.querySelector(".pb");
        popover.scrollable = Boolean(body && body.scrollHeight > body.clientHeight);
        if (body) body.style.touchAction = popover.scrollable ? "pan-y" : "none";
      };
      popover.capBody = () => {
        if (popover.pressed) return;
        const body = box.querySelector(".pb"), view = surfaces.viewport();
        if (!body) return;
        const chrome = (box.querySelector(".h")?.getBoundingClientRect().height || (touch() ? 48 : 36))
          + (box.querySelector(".f")?.getBoundingClientRect().height || (box.querySelector(".f") ? (touch() ? 48 : 32) : 0)) + 2;
        body.style.maxHeight = Math.max(0, Math.min(view.height * .6, 420, view.height - 24 - chrome)) + "px";
      };
      popover.pickerVisibility = hidden => {
        if (current !== session || surface.closed) return;
        popover.pickerOpen = hidden;
        surface.node.inert = hidden;
        surface.node.setAttribute("aria-hidden", String(hidden));
        box.style.pointerEvents = hidden ? "none" : "auto";
        box.classList.toggle("picker-hidden", hidden);
        box.classList.toggle("picker-restored", !hidden);
        if (popover.overlay) {
          popover.overlay.surface.node.inert = hidden;
          popover.overlay.surface.node.setAttribute("aria-hidden", String(hidden));
          placeMarkers(session);
        }
      };
      popover.clamp = (x = parseFloat(surface.node.style.left) || 0, y = parseFloat(surface.node.style.top) || 0) => {
        if (surface.closed) return;
        const view = surfaces.viewport(), left = view.offsetLeft || 0, top = view.offsetTop || 0;
        if (!popover.pressed) {
          box.style.width = Math.max(1, Math.min(parseFloat(box.style.width) || (touch() ? 360 : 300), view.width)) + "px";
          box.style.maxWidth = view.width + "px";
        }
        const width = box.getBoundingClientRect().width || parseFloat(box.style.width);
        popover.capBody();
        const height = box.getBoundingClientRect().height || 120;
        surface.node.style.left = Math.max(left, Math.min(x, left + view.width - width)) + "px";
        surface.node.style.top = Math.max(top + 12, Math.min(y, top + view.height - height - 12)) + "px";
        if (!popover.pressed) popover.scrollability();
      };
      popover.place = () => {
        if (popover.detached) { popover.clamp(); return; }
        const image = session.context.image;
        if (!image?.isConnected || surface.closed) return;
        const rect = image.getBoundingClientRect(), view = surfaces.viewport();
        const outside = rect.bottom <= (view.offsetTop || 0) || rect.top >= (view.offsetTop || 0) + view.height || rect.right <= (view.offsetLeft || 0) || rect.left >= (view.offsetLeft || 0) + view.width;
        if (!touch() && rect.width > 0 && outside) { close(); return; }
        popover.capBody();
        const preferred = touch() ? Math.min(360, view.width - 48) : 300;
        box.style.width = Math.max(touch() ? 1 : 160, preferred) + "px";
        const size = { width: Math.max(touch() ? 1 : 160, preferred), height: box.getBoundingClientRect().height || 120 };
        const position = model.imagePlacement(rect, size, view, touch() ? 12 : 8, touch());
        box.style.width = position.width + "px"; popover.side = position.side;
        surface.node.style.left = position.x + "px"; surface.node.style.top = position.y + "px";
        popover.positioned = true;
        popover.scrollability();
      };
      popover.follow = () => { if (!touch() && !popover.detached) popover.place(); placeMarkers(session); };
      popover.resize = () => { if (popover.detached) popover.clamp(); else popover.place(); placeMarkers(session); };
      doc.addEventListener("scroll", popover.follow, true); win.addEventListener("resize", popover.resize);
      win.addEventListener("orientationchange", popover.resize);
      win.visualViewport?.addEventListener("resize", popover.resize);
      win.visualViewport?.addEventListener("scroll", popover.follow);
      let press = null;
      popover.finishHeight = () => {
        win.clearTimeout(popover.heightTimer); popover.heightTimer = 0;
        box.style.height = ""; box.style.transition = ""; box.style.overflow = "";
      };
      popover.down = event => {
        if (press || event.isPrimary === false || event.button !== 0 || event.target.closest("button")) return;
        const body = event.target.closest(".pb");
        if (popover.heightTimer) {
          const height = box.getBoundingClientRect().height;
          win.clearTimeout(popover.heightTimer); popover.heightTimer = 0;
          box.style.transition = "none"; box.style.height = height + "px";
          popover.heightPaused = true;
        }
        popover.pressed = true;
        press = {id: event.pointerId, x: event.clientX, y: event.clientY, left: parseFloat(surface.node.style.left), top: parseFloat(surface.node.style.top), body: body && body.scrollHeight > body.clientHeight ? body : null, scrollTop: body?.scrollTop || 0, mode: null};
      };
      popover.move = event => {
        if (!press || event.pointerId !== press.id) return;
        const dx = event.clientX - press.x, dy = event.clientY - press.y;
        if (!press.mode) {
          if (Math.hypot(dx, dy) <= 6) return;
          press.mode = press.body && Math.abs(dy) > Math.abs(dx) ? "scroll" : "drag";
          if (press.mode === "drag") {
            popover.detached = true; box.classList.add("dragging");
            // Window listeners already track the gesture. Capture loss is not
            // pointerup, and transferring capture can interrupt tablet drags.
            win.getSelection()?.removeAllRanges();
          }
        }
        if (press.mode === "scroll") {
          // Touch/pen use native pan-y; mouse drags scroll the list directly.
          if (event.pointerType === "mouse") { press.body.scrollTop = press.scrollTop - dy; event.preventDefault(); }
          return;
        }
        event.preventDefault(); popover.clamp(press.left + dx, press.top + dy);
      };
      popover.up = event => {
        if (!press || event.pointerId !== press.id) return;
        press = null; popover.pressed = false;
        box.classList.remove("dragging");
        if (popover.heightPaused) { popover.heightPaused = false; popover.finishHeight(); }
        const pending = popover.pendingFill; popover.pendingFill = null;
        if (pending) fill(session, pending); else popover.scrollability();
      };
      box.addEventListener("pointerdown", popover.down);
      win.addEventListener("pointermove", popover.move, {passive: false});
      win.addEventListener("pointerup", popover.up); win.addEventListener("pointercancel", popover.up);
      if (win.ResizeObserver) { popover.observer = new win.ResizeObserver(() => { popover.scrollability(); placeMarkers(session); }); popover.observer.observe(box); if (session.context.image) popover.observer.observe(session.context.image); }
      popover.onKey = event => { if (event.isTrusted === true && event.key === "Escape" && !popover.pickerOpen) close(); };
      win.addEventListener("keydown", popover.onKey, true);
      surfaces.reveal(surface);
      return popover;
    }

    // Replaces the content in one step; the popover height eases over 140 ms.
    function fill(session, build) {
      const popover = open(session), box = popover.box;
      if (popover.pressed) { popover.pendingFill = build; return; }
      if (popover.overlay) { surfaces.remove(popover.overlay.surface, popover.overlay.box, 0); popover.overlay = null; }
      popover.selected = null; popover.items = [];
      if (popover.heightTimer) popover.finishHeight();
      const before = box.getBoundingClientRect().height;
      win.clearTimeout(popover.copyTimer); box.replaceChildren(); build(box);
      let footer = box.querySelector(".f");
      if (!footer) { footer = doc.createElement("div"); footer.className = "f"; }
      appendSave(session, footer);
      if (footer.childNodes.length && !footer.isConnected) box.append(footer);
      if (popover.detached) popover.clamp(); else popover.place();
      const after = box.getBoundingClientRect().height;
      if (!before || !after || Math.abs(after - before) < 1 || reduced()) return;
      box.style.height = before + "px"; box.style.overflow = "hidden"; box.getBoundingClientRect();
      box.style.transition = "height 140ms cubic-bezier(.2,0,0,1)"; box.style.height = after + "px";
      popover.heightTimer = win.setTimeout(() => { popover.finishHeight(); if (popover.detached) popover.clamp(); else popover.place(); }, 150);
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
      session.imageText = lines;
      fill(session, box => {
        box.append(header("이미지 글자 번역"));
        const body = doc.createElement("div"); body.className = "pb";
        if (!lines.length) { const none = doc.createElement("p"); none.className = "none"; none.textContent = "글자 없음"; body.append(none); box.append(body); return; }
        const list = doc.createElement("ol");
        for (const [index, line] of lines.entries()) {
          const item = doc.createElement("li"), number = doc.createElement("span"), korean = doc.createElement("b");
          item.className = "image-line"; item.tabIndex = 0;
          number.className = "line-number"; number.textContent = String(index + 1);
          korean.lang = "ko"; korean.textContent = line.korean; item.append(number, korean);
          if (line.original && normalized(line.original) !== normalized(line.korean)) { const original = doc.createElement("small"); original.lang = model.sourceLanguage(line.original); original.textContent = line.original; item.append(original); }
          list.append(item);
          session.popover.items.push(item);
          item.addEventListener("click", event => { if (event.isTrusted === true) selectLine(session, index); });
          item.addEventListener("keydown", event => { if (event.isTrusted === true && ["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); selectLine(session, index); } });
        }
        body.append(list); box.append(body);
        const footer = doc.createElement("div"), button = doc.createElement("button"); footer.className = "f"; button.type = "button";
        const label = doc.createElement("span"); label.textContent = "모두 복사"; label.setAttribute("aria-live", "polite"); button.append(surfaces.icon("copy"), label);
        button.addEventListener("click", event => { if (event.isTrusted === true) copyAll(session, lines, label); });
        footer.append(button); box.append(footer);
        showMarkers(session, lines);
      });
      focusIfKeyboard(session);
    }
    function appendSave(session, footer) {
      const image = session.context.image;
      const candidate = image?.tagName === "IMG" && collector.findCandidate?.(image);
      if (!candidate || candidate.type === "video" || !collector.open) return;
      const button = doc.createElement("button"); button.type = "button"; button.dataset.action = "image.lakomics";
      button.append(surfaces.icon("download"), "저장");
      button.addEventListener("click", event => {
        if (event.isTrusted !== true || current !== session || !alive(session.context) || !image.isConnected) return;
        const touch = session.popover.surface.node.dataset.touch === "true";
        if (event.pointerType === "touch" || (touch && event.detail > 0)) button.blur();
        const resolved = collector.findCandidate?.(image);
        if (!resolved || resolved.type === "video") return;
        const rect = image.getBoundingClientRect();
        try { void Promise.resolve(collector.open(resolved,
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, touch ? "touch" : "mouse", {
            imageText: session.imageText,
            onOpen: () => session.popover?.pickerVisibility(true),
            onClose: () => session.popover?.pickerVisibility(false),
          })).catch(() => {}); } catch {}
      });
      footer.append(button);
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
      doc.removeEventListener("scroll", popover.follow, true); win.removeEventListener("resize", popover.resize); win.removeEventListener("orientationchange", popover.resize); win.visualViewport?.removeEventListener("resize", popover.resize);
      win.visualViewport?.removeEventListener("scroll", popover.follow);
      win.removeEventListener("pointermove", popover.move); win.removeEventListener("pointerup", popover.up); win.removeEventListener("pointercancel", popover.up);
      popover.observer?.disconnect(); win.removeEventListener("keydown", popover.onKey, true); win.clearTimeout(popover.copyTimer); win.clearTimeout(popover.heightTimer);
      surfaces.remove(popover.surface, popover.box, ms);
      if (popover.overlay) {
        popover.overlay.surface.node.inert = true;
        popover.overlay.box.querySelectorAll("button").forEach(button => { button.disabled = true; });
        surfaces.remove(popover.overlay.surface, popover.overlay.box, ms);
      }
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
