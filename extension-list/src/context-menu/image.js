(() => {
  "use strict";
  // 이미지 글자 번역: the worker reads and translates the picture; this file asks for it and
  // lays the answer as small translation notes directly over each text block of the image.
  // Waiting, failure, empty and selection-text answers use a small window (popA) instead.
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

  // ---- translation notes laid over the picture (pure helpers, unit-tested) ----
  const MIN_FONT = 14, EDGE = 4, DEFAULT_TONE = { bg: [251, 250, 247], fg: [31, 33, 35] };
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const luminance = ([r, g, b]) => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (hi + .05) / (lo + .05); };
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  // Solid note colours from the median of a ring just outside the text box. `pixels` is
  // {data, width, height} (RGBA) and `box` {x, y, w, h} in the same pixel space.
  function toneAround(pixels, box) {
    if (!pixels?.data || !(pixels.width > 0)) return DEFAULT_TONE;
    const { data, width, height } = pixels, edge = Math.max(width, height);
    const m = Math.max(2, Math.round(edge * .005)), t = Math.max(3, Math.round(edge * .008));
    const x0 = Math.max(0, Math.round(box.x - m - t)), y0 = Math.max(0, Math.round(box.y - m - t));
    const x1 = Math.min(width, Math.round(box.x + box.w + m + t)), y1 = Math.min(height, Math.round(box.y + box.h + m + t));
    const rs = [], gs = [], bs = [];
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      if (x > box.x - m && x < box.x + box.w + m && y > box.y - m && y < box.y + box.h + m) continue;
      const i = (y * width + x) * 4; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
    if (!rs.length) return DEFAULT_TONE;
    const med = list => { list.sort((p, q) => p - q); return list[list.length >> 1]; };
    let bg = [med(rs), med(gs), med(bs)], fg;
    if (luminance(bg) > .36) { fg = [28, 29, 31]; for (let k = 0; contrast(bg, fg) < 7 && k < 20; k += 1) bg = mix(bg, [255, 255, 255], .15); }
    else { fg = [251, 250, 247]; for (let k = 0; contrast(bg, fg) < 4.8 && k < 20; k += 1) bg = mix(bg, [0, 0, 0], .1); }
    return { bg, fg };
  }
  // The picture drawn small so notes can match its colours; null when it cannot be read (cross-origin).
  function readPixels(image, doc = document) {
    try {
      if (!image || image.tagName !== "IMG" || !image.complete || !image.naturalWidth || !image.naturalHeight) return null;
      const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = doc.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      return { data, width, height };
    } catch { return null; }
  }
  // Fits one translation note over its OCR box. `measure(f, rect, padX, padY, wrap)` returns
  // {overflow, height}: how far the longest unbreakable word sticks out of the note's text
  // area, and the height of the wrapped text. Rules (user, 2026-10-16): start at the OCR box,
  // never go below 14 px, widen only as far as the longest word needs, then grow downward
  // (upward at the image's bottom edge); words are never split unless one word is wider than
  // the whole image.
  function fitNote({ box, W, H, vertical = false, chars = 1, measure, minF = MIN_FONT }) {
    const padY = clamp(Math.round(Math.min(box.w, box.h) * .1), 3, 8), padX = vertical ? Math.max(2, padY - 2) : padY;
    const start = Math.round(clamp(Math.sqrt(box.w * box.h / Math.max(1, chars)) * .8, minF, 20) * 2) / 2;
    const r = { x: box.x - 3, y: box.y - 3, w: box.w + 6, h: box.h + 6 };
    const right = Math.min(W - EDGE, r.x + r.w), bottom = Math.min(H - EDGE, r.y + r.h);
    r.x = Math.max(EDGE, r.x); r.y = Math.max(EDGE, r.y); r.w = Math.max(1, right - r.x); r.h = Math.max(1, bottom - r.y);
    const base = { ...r }, step = value => Math.round((value - .5) * 2) / 2;
    let wrap = false, widened = false, f = start, done = false;
    const probe = size => measure(size, r, padX, padY, wrap);
    const fits = size => { const m = probe(size); return m.overflow <= .5 && m.height <= r.h - 2 * padY + .5; };
    for (let size = start; size >= minF; size = step(size)) { f = size; if (fits(size)) { done = true; break; } }
    if (!done) f = minF;
    if (!done) {
      const overflow = probe(f).overflow;
      if (overflow > .5) {
        // The longest word is wider than the note: widen just enough for it, centred on the box.
        const w = Math.min(W - 2 * EDGE, r.w + Math.ceil(overflow) + 1), cx = r.x + r.w / 2;
        r.x = clamp(cx - w / 2, EDGE, Math.max(EDGE, W - EDGE - w)); r.w = w; widened = true;
        for (let size = start; size > minF; size = step(size)) if (fits(size)) { f = size; done = true; break; }
        if (!done) { f = minF; done = fits(f); }
      }
    }
    const grow = () => {
      const next = Math.min(H - EDGE, r.y + r.h + 6);
      if (next > r.y + r.h) { r.h = next - r.y; return true; }
      const top = Math.max(EDGE, r.y - 6);
      if (top === r.y) return false;
      r.h += r.y - top; r.y = top; return true;
    };
    while (!done && grow()) if (fits(f)) done = true;
    // Last resort: a single word wider than the whole image may break.
    if (!done) { wrap = true; while (grow()) if (fits(f)) break; }
    return { x: r.x, y: r.y, w: r.w, h: r.h, f, padX, padY, wrap, widened, grown: Math.round(r.h - base.h) };
  }
  // The corner of the image where the button group covers the least note area.
  function chooseCorner(rects, W, H, pw, ph, margin = 8) {
    const corners = [["tr", W - margin - pw, margin], ["tl", margin, margin], ["br", W - margin - pw, H - margin - ph], ["bl", margin, H - margin - ph]];
    let best = corners[0], bestArea = Infinity;
    for (const corner of corners) {
      let area = 0;
      for (const r of rects) area += Math.max(0, Math.min(corner[1] + pw, r.x + r.w) - Math.max(corner[1], r.x)) * Math.max(0, Math.min(corner[2] + ph, r.y + r.h) - Math.max(corner[2], r.y));
      if (area < bestArea - 1) { best = corner; bestArea = area; }
    }
    return { corner: best[0], x: best[1], y: best[2], area: bestArea };
  }
  const JAPANESE = /[぀-ヿ㐀-鿿]/;
  function lineGeometry(line, W, H) {
    const b = line.box; if (!b) return null;
    const box = { x: b.x0 / 1000 * W, y: b.y0 / 1000 * H, w: (b.x1 - b.x0) / 1000 * W, h: (b.y1 - b.y0) / 1000 * H };
    return { box, vertical: box.h > box.w * 1.4 && JAPANESE.test(line.original || ""), chars: String(line.original || line.korean).replace(/[\s、。，．,.!！?？…ー〜~]/g, "").length };
  }

  function create({ doc = document, win = window, send, surfaces, collector = {}, alive = () => true, watchSession = () => ({ watch() {}, stop() {} }) } = {}) {
    const model = globalThis.LakomicsContextModel, cache = new Map();
    let current = null, sequence = 0;
    const reduced = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const touchMode = session => Boolean(session.context.touch || win.matchMedia?.("(hover: none) and (pointer: coarse)").matches);

    // Hides or restores everything of this session while the Lakomics picker is open.
    function setPicker(session, hidden) {
      if (current !== session) return;
      session.pickerOpen = hidden;
      const popover = session.popover;
      if (popover && !popover.surface.closed) {
        popover.surface.node.inert = hidden;
        popover.surface.node.setAttribute("aria-hidden", String(hidden));
        popover.box.style.pointerEvents = hidden ? "none" : "auto";
        popover.box.classList.toggle("picker-hidden", hidden);
        popover.box.classList.toggle("picker-restored", !hidden);
      }
      const overlay = session.overlay;
      if (overlay && !overlay.surface.closed) {
        overlay.surface.node.inert = hidden;
        overlay.surface.node.setAttribute("aria-hidden", String(hidden));
        placeNotes(session);
      }
    }

    // ---------------------------------------------------------------- notes over the picture
    function placeNotes(session) {
      const overlay = session.overlay, image = session.context.image;
      if (!overlay || overlay.surface.closed) return;
      const rect = image?.isConnected ? image.getBoundingClientRect() : null, empty = !rect || rect.width <= 0 || rect.height <= 0;
      overlay.surface.node.style.visibility = session.pickerOpen || empty ? "hidden" : "visible";
      if (empty) return;
      Object.assign(overlay.surface.node.style, { left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px" });
      const key = Math.round(rect.width) + "x" + Math.round(rect.height);
      if (overlay.key !== key) { overlay.key = key; layoutNotes(session, rect.width, rect.height); }
    }
    function layoutNotes(session, W, H) {
      const overlay = session.overlay;
      overlay.box.querySelector(".card")?.remove(); overlay.card = null;
      const rects = [];
      for (const item of overlay.items) {
        const geometry = lineGeometry(item.line, W, H);
        if (item.kind === "sfx") {
          // Sound effects get a small tag just below their text, or above it at the bottom edge.
          const tag = item.node;
          tag.style.maxWidth = Math.max(40, W - 2 * EDGE) + "px";
          Object.assign(tag.style, { left: "0px", top: "0px" });
          const tw = tag.offsetWidth, th = tag.offsetHeight, b = geometry.box;
          const x = clamp(b.x, EDGE, Math.max(EDGE, W - EDGE - tw));
          let y = b.y + b.h + 4;
          if (y + th > H - EDGE) y = b.y - 4 - th;
          if (y < EDGE) y = clamp(b.y + 4, EDGE, Math.max(EDGE, H - EDGE - th));
          Object.assign(tag.style, { left: x + "px", top: y + "px" });
          rects.push({ x, y, w: tw, h: th });
          continue;
        }
        const { node, inner } = item;
        const measure = (f, r, padX, padY, wrap) => {
          Object.assign(node.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px", padding: `${padY}px ${padX}px` });
          inner.style.fontSize = f + "px"; inner.style.overflowWrap = wrap ? "anywhere" : "normal";
          return { overflow: Math.max(0, inner.scrollWidth - inner.clientWidth), height: inner.offsetHeight };
        };
        const fit = fitNote({ box: geometry.box, W, H, vertical: geometry.vertical, chars: geometry.chars, measure });
        measure(fit.f, fit, fit.padX, fit.padY, fit.wrap);
        node.style.borderRadius = Math.min(6, fit.h / 4, fit.w / 4) + "px";
        rects.push({ x: fit.x, y: fit.y, w: fit.w, h: fit.h });
      }
      placePill(session, rects, W, H);
    }
    function placePill(session, rects, W, H) {
      const pill = session.overlay.pill, pw = pill.offsetWidth || 220, ph = pill.offsetHeight || (touchMode(session) ? 44 : 32);
      const spot = chooseCorner(rects, W, H, pw, ph);
      Object.assign(pill.style, { left: spot.x + "px", top: spot.y + "px" });
      pill.dataset.corner = spot.corner;
    }
    function setPeek(session, on) {
      const overlay = session.overlay; if (!overlay || overlay.surface.closed) return;
      overlay.box.classList.toggle("peek", on);
      overlay.peekButton.setAttribute("aria-pressed", String(on));
      if (on) { overlay.box.querySelector(".card")?.remove(); overlay.card = null; }
    }
    // Press-and-hold on a note shows the original picture text for as long as it is held.
    function bindHold(session, node) {
      const overlay = session.overlay;
      let timer = 0, start = null;
      const end = () => {
        win.clearTimeout(timer); start = null;
        if (overlay.held) { overlay.held = false; overlay.suppress = true; setPeek(session, false); win.setTimeout(() => { overlay.suppress = false; }, 50); }
      };
      node.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        start = { x: event.clientX, y: event.clientY }; overlay.held = false;
        timer = win.setTimeout(() => { overlay.held = true; setPeek(session, true); }, event.pointerType === "touch" ? 350 : 220);
      });
      node.addEventListener("pointermove", event => { if (start && !overlay.held && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) { win.clearTimeout(timer); start = null; } });
      for (const type of ["pointerup", "pointercancel", "pointerleave"]) node.addEventListener(type, end);
    }
    function closeCard(session) { const overlay = session.overlay; overlay?.box.querySelector(".card")?.remove(); if (overlay) overlay.card = null; }
    function openCard(session, anchor, line) {
      const overlay = session.overlay;
      if (overlay.card && overlay.card.anchor === anchor) { closeCard(session); return; }
      closeCard(session);
      const card = doc.createElement("div"); card.className = "card"; card.setAttribute("role", "dialog"); card.setAttribute("aria-label", "원문과 번역");
      const showOriginal = line.original && normalized(line.original) !== normalized(line.korean);
      if (showOriginal) {
        const label = doc.createElement("span"); label.className = "lbl"; label.textContent = "원문";
        const original = doc.createElement("span"); original.className = "jp"; original.lang = model.sourceLanguage(line.original); original.textContent = line.original;
        const rule = doc.createElement("hr"); card.append(label, original, rule);
      }
      const korean = doc.createElement("span"); korean.className = "ko"; korean.lang = "ko"; korean.textContent = line.korean; card.append(korean);
      const foot = doc.createElement("div"), button = doc.createElement("button"), label = doc.createElement("span");
      foot.className = "cf"; button.type = "button"; button.className = "cbtn"; button.title = "이 문장 번역만 복사"; label.textContent = "복사"; label.setAttribute("aria-live", "polite");
      button.append(surfaces.icon("copy"), label);
      button.addEventListener("click", event => { if (event.isTrusted === true) copyText(session, line.korean, label, "복사"); });
      foot.append(button); card.append(foot);
      if (reduced()) card.style.animation = "none";
      overlay.box.append(card); overlay.card = { node: card, anchor };
      const W = overlay.box.clientWidth || card.offsetWidth, H = overlay.box.clientHeight || card.offsetHeight, cw = card.offsetWidth, ch = card.offsetHeight;
      const a = { x: anchor.offsetLeft, y: anchor.offsetTop, w: anchor.offsetWidth, h: anchor.offsetHeight };
      let top = a.y + a.h + 6;
      if (top + ch > H - EDGE) top = a.y - 6 - ch;
      if (top < EDGE) top = clamp(a.y + a.h / 2 - ch / 2, EDGE, Math.max(EDGE, H - EDGE - ch));
      Object.assign(card.style, { left: clamp(a.x + a.w / 2 - cw / 2, EDGE, Math.max(EDGE, W - EDGE - cw)) + "px", top: top + "px" });
    }
    function showNotes(session, lines) {
      dropPopover(session, 90);
      const image = session.context.image;
      const surface = surfaces.host("lakomics-image-markers", image), box = doc.createElement("div");
      surface.node.dataset.touch = String(touchMode(session));
      box.className = "image-notes"; box.setAttribute("role", "group"); box.setAttribute("aria-label", "이미지 글자 번역");
      if (reduced()) box.style.animation = "none";
      surface.root.append(box);
      // Keep touch/long-press and compatibility mouse events inside our surface (X opens its viewer on a click).
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "contextmenu", "dragstart", "click"]) {
        box.addEventListener(type, event => { event.stopPropagation(); if (type === "contextmenu" || type === "dragstart") event.preventDefault(); });
      }
      const overlay = { surface, box, items: [], key: "", held: false, suppress: false, card: null, pill: null, peekButton: null };
      session.overlay = overlay;
      const pixels = readPixels(image, doc);
      lines.forEach(line => {
        if (!line.box) return;
        const sfx = line.kind === "sfx", node = doc.createElement("button"); node.type = "button";
        const item = { line, node, kind: sfx ? "sfx" : "dialogue", inner: null };
        if (sfx) {
          node.className = "tag"; node.textContent = line.korean; node.lang = "ko"; node.setAttribute("aria-label", `효과음: ${line.korean}`);
        } else {
          const inner = doc.createElement("span"); inner.className = "nt"; inner.lang = "ko";
          // ~ ! ? … is glued to the word before it (word joiner) so it never starts a line of its own.
          inner.textContent = line.korean.replace(/(\S)\s*([~〜!?！？…]+)/g, "$1\u2060$2");
          node.className = "note"; node.setAttribute("aria-label", `번역: ${line.korean}`); node.append(inner); item.inner = inner;
          const b = line.box, tone = pixels
            ? toneAround(pixels, { x: b.x0 / 1000 * pixels.width, y: b.y0 / 1000 * pixels.height, w: (b.x1 - b.x0) / 1000 * pixels.width, h: (b.y1 - b.y0) / 1000 * pixels.height })
            : DEFAULT_TONE;
          const light = luminance(tone.bg) > .36;
          node.style.background = `rgb(${tone.bg.join(" ")})`; node.style.color = `rgb(${tone.fg.join(" ")})`;
          node.style.setProperty("--edge", light ? "rgb(0 0 0 / 7%)" : "rgb(255 255 255 / 10%)");
        }
        if (reduced()) node.style.animation = "none";
        node.addEventListener("click", event => {
          if (event.isTrusted !== true) return;
          if (overlay.suppress) { overlay.suppress = false; return; }
          if (event.pointerType === "touch" || (touchMode(session) && event.detail > 0)) node.blur();
          openCard(session, node, line);
        });
        bindHold(session, node);
        box.append(node); overlay.items.push(item);
      });
      buildPill(session, lines);
      placeNotes(session); surfaces.reveal(surface);
      watchFollow(session);
      focusIfKeyboard(session);
    }
    function buildPill(session, lines) {
      const overlay = session.overlay, pill = doc.createElement("div");
      pill.className = "pill"; pill.setAttribute("role", "toolbar"); pill.setAttribute("aria-label", "번역 도구");
      const peek = doc.createElement("button"); peek.type = "button"; peek.className = "peek-btn"; peek.textContent = "원문"; peek.title = "누르고 있는 동안 원문 보기";
      peek.setAttribute("aria-label", "원문 보기 (누르고 있기)"); peek.setAttribute("aria-pressed", "false");
      peek.addEventListener("pointerdown", event => { event.preventDefault(); setPeek(session, true); try { peek.setPointerCapture?.(event.pointerId); } catch {} });
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) peek.addEventListener(type, () => setPeek(session, false));
      peek.addEventListener("keydown", event => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); setPeek(session, true); } });
      peek.addEventListener("keyup", event => { if (event.key === " " || event.key === "Enter") setPeek(session, false); });
      const copy = doc.createElement("button"), label = doc.createElement("span"); copy.type = "button"; copy.className = "act"; copy.dataset.action = "image.copy";
      label.textContent = "모두 복사"; label.setAttribute("aria-live", "polite"); copy.append(surfaces.icon("copy"), label);
      copy.addEventListener("click", event => { if (event.isTrusted === true) copyText(session, lines.map(line => line.korean).join("\n"), label, "모두 복사"); });
      const save = makeSaveButton(session);
      const close = doc.createElement("button"); close.type = "button"; close.className = "x"; close.setAttribute("aria-label", "번역 닫기"); close.title = "번역 닫기"; close.append(surfaces.icon("close"));
      close.addEventListener("click", event => { if (event.isTrusted === true) dismiss(); });
      const sep = () => { const node = doc.createElement("span"); node.className = "sep"; node.setAttribute("aria-hidden", "true"); return node; };
      pill.append(peek, sep(), copy); if (save) pill.append(save); pill.append(sep(), close);
      overlay.box.append(pill); overlay.pill = pill; overlay.peekButton = peek;
    }
    function watchFollow(session) {
      const overlay = session.overlay, surfaceHost = overlay.surface.node;
      overlay.follow = () => placeNotes(session);
      doc.addEventListener("scroll", overlay.follow, true); win.addEventListener("resize", overlay.follow);
      win.addEventListener("orientationchange", overlay.follow);
      win.visualViewport?.addEventListener("resize", overlay.follow); win.visualViewport?.addEventListener("scroll", overlay.follow);
      if (win.ResizeObserver) { overlay.observer = new win.ResizeObserver(() => placeNotes(session)); overlay.observer.observe(session.context.image); }
      overlay.onKey = event => {
        if (event.isTrusted !== true || event.key !== "Escape" || session.pickerOpen) return;
        if (overlay.card) closeCard(session); else dismiss();
      };
      win.addEventListener("keydown", overlay.onKey, true);
      // A tap anywhere outside the notes closes the small card.
      overlay.outside = event => { if (overlay.card && event.isTrusted === true && event.target !== surfaceHost) closeCard(session); };
      doc.addEventListener("pointerdown", overlay.outside, true);
    }
    function dropOverlay(session, ms) {
      const overlay = session.overlay; if (!overlay) return;
      session.overlay = null;
      doc.removeEventListener("scroll", overlay.follow, true); win.removeEventListener("resize", overlay.follow); win.removeEventListener("orientationchange", overlay.follow);
      win.visualViewport?.removeEventListener("resize", overlay.follow); win.visualViewport?.removeEventListener("scroll", overlay.follow);
      overlay.observer?.disconnect(); win.removeEventListener("keydown", overlay.onKey, true); doc.removeEventListener("pointerdown", overlay.outside, true);
      overlay.surface.node.inert = true;
      overlay.box.querySelectorAll("button").forEach(button => { button.disabled = true; });
      surfaces.remove(overlay.surface, overlay.box, ms);
    }

    async function load(session) {
      if (session.context.selectionText) {
        const result = await send({ type: "translation:context", kind: "translate.ko.inline", text: session.context.selectionText });
        return result?.ok && typeof result.text === "string" && result.text.trim()
          ? { ok: true, lines: [{ original: session.context.selectionText, korean: result.text }] } : { ok: false, code: result?.code };
      }
      const { imageUrl: url, image } = session.context;
      if (/^https:/i.test(url)) {
        const result = await send({ type: "translation:image", url });
        // Only a failed download falls back to the copy already loaded in the page.
        if (result?.ok || result?.code !== "image_unavailable") return result;
      } else if (/^data:image\//i.test(url) && url.length < 11000000) return send({ type: "translation:image", dataUrl: url });
      const dataUrl = captureImage(image, doc);
      return dataUrl ? send({ type: "translation:image", dataUrl }) : { ok: false, code: "image_unavailable" };
    }

    // ---------------------------------------------------------------- the small window
    // Used for waiting, failure, "no text", the unlocated fallback and selected text.
    function open(session) {
      if (session.popover) return session.popover;
      const surface = surfaces.host("lakomics-image-popover", session.context.image || session.context.target);
      const box = doc.createElement("div"); box.className = "popA"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "이미지 글자 번역"); box.tabIndex = -1; box.style.pointerEvents = "auto";
      if (session.context.selectionText) box.setAttribute("aria-label", "선택한 글 번역");
      surface.root.append(box);
      const popover = { surface, box, heightTimer: 0 };
      session.popover = popover;
      const touch = () => surface.node.dataset.touch === "true";
      surface.node.dataset.touch = String(touchMode(session));
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
        if (session.context.selectionRect) {
          const rect = session.context.selectionRect;
          popover.clamp(rect.left, rect.bottom + 16); return;
        }
        if (!image?.isConnected || surface.closed) return;
        const rect = image.getBoundingClientRect(), view = surfaces.viewport();
        const outside = rect.bottom <= (view.offsetTop || 0) || rect.top >= (view.offsetTop || 0) + view.height || rect.right <= (view.offsetLeft || 0) || rect.left >= (view.offsetLeft || 0) + view.width;
        if (!touch() && rect.width > 0 && outside) { dismiss(); return; }
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
      popover.follow = () => { if (!touch() && !popover.detached) popover.place(); };
      popover.resize = () => { if (popover.detached) popover.clamp(); else popover.place(); };
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
      if (win.ResizeObserver) { popover.observer = new win.ResizeObserver(() => popover.scrollability()); popover.observer.observe(box); if (session.context.image) popover.observer.observe(session.context.image); }
      popover.onKey = event => { if (event.isTrusted === true && event.key === "Escape" && !session.pickerOpen) dismiss(); };
      win.addEventListener("keydown", popover.onKey, true);
      surfaces.reveal(surface);
      return popover;
    }
    function dropPopover(session, ms) {
      const popover = session.popover; if (!popover) return;
      session.popover = null;
      doc.removeEventListener("scroll", popover.follow, true); win.removeEventListener("resize", popover.resize); win.removeEventListener("orientationchange", popover.resize); win.visualViewport?.removeEventListener("resize", popover.resize);
      win.visualViewport?.removeEventListener("scroll", popover.follow);
      win.removeEventListener("pointermove", popover.move); win.removeEventListener("pointerup", popover.up); win.removeEventListener("pointercancel", popover.up);
      popover.observer?.disconnect(); win.removeEventListener("keydown", popover.onKey, true); win.clearTimeout(popover.heightTimer);
      surfaces.remove(popover.surface, popover.box, ms);
    }

    // Replaces the content in one step; the popover height eases over 140 ms.
    function fill(session, build) {
      const popover = open(session), box = popover.box;
      if (popover.pressed) { popover.pendingFill = build; return; }
      if (popover.heightTimer) popover.finishHeight();
      const before = box.getBoundingClientRect().height;
      win.clearTimeout(session.copyTimer); box.replaceChildren(); build(box);
      let footer = box.querySelector(".f");
      if (!footer) { footer = doc.createElement("div"); footer.className = "f"; }
      const save = makeSaveButton(session); if (save) footer.append(save);
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
      const button = doc.createElement("button"); button.className = "x"; button.setAttribute("aria-label", "닫기"); button.append(surfaces.icon("close")); button.addEventListener("click", () => dismiss());
      bar.append(text, spacer, button); return bar;
    }
    function showPending(session) {
      fill(session, box => {
        box.append(header(session.context.selectionText ? "번역 중" : "읽는 중"));
        const body = doc.createElement("div"); body.className = "pb";
        for (const width of ["70%", "90%", "55%"]) { const bar = doc.createElement("span"); bar.className = "sk"; bar.style.width = width; body.append(bar); }
        box.append(body);
      });
      focusIfKeyboard(session);
    }
    function focusIfKeyboard(session) {
      if (!session.keyboard || session.focused) return;
      const target = session.popover?.box || session.overlay?.box.querySelector(".note,.tag,.pill button");
      if (!target) return;
      session.focused = true; target.focus({ preventScroll: true });
    }
    function showLines(session, lines) {
      session.imageText = lines;
      // An image whose answer has positions gets notes over its text; the rest uses the window.
      if (session.context.image && !session.context.selectionText && lines.some(line => line.box)) { showNotes(session, lines); return; }
      fill(session, box => {
        box.append(header(session.context.selectionText ? "선택한 글 번역" : "이미지 글자 번역"));
        const body = doc.createElement("div"); body.className = "pb";
        if (!lines.length) { const none = doc.createElement("p"); none.className = "none"; none.textContent = "글자 없음"; body.append(none); box.append(body); return; }
        const list = doc.createElement("ol");
        for (const line of lines) {
          const item = doc.createElement("li"), korean = doc.createElement("b");
          item.className = "image-line";
          korean.lang = "ko"; korean.textContent = line.korean; item.append(korean);
          if (line.original && normalized(line.original) !== normalized(line.korean)) { const original = doc.createElement("small"); original.lang = model.sourceLanguage(line.original); original.textContent = line.original; item.append(original); }
          list.append(item);
        }
        body.append(list); box.append(body);
        const footer = doc.createElement("div"), button = doc.createElement("button"); footer.className = "f"; button.type = "button";
        const label = doc.createElement("span"); label.textContent = "모두 복사"; label.setAttribute("aria-live", "polite"); button.append(surfaces.icon("copy"), label);
        button.addEventListener("click", event => { if (event.isTrusted === true) copyText(session, lines.map(line => line.korean).join("\n"), label, "모두 복사"); });
        footer.append(button); box.append(footer);
      });
      focusIfKeyboard(session);
    }
    // 저장 button shared by the window footer and the buttons on the picture; null without a candidate.
    function makeSaveButton(session) {
      const image = session.context.image;
      const candidate = image?.tagName === "IMG" && collector.findCandidate?.(image);
      if (!candidate || candidate.type === "video" || !collector.open) return null;
      const button = doc.createElement("button"); button.type = "button"; button.dataset.action = "image.lakomics";
      if (session.overlay) button.className = "act";
      button.append(surfaces.icon("download"), "저장");
      button.addEventListener("click", event => {
        if (event.isTrusted !== true || current !== session || !alive(session.context) || !image.isConnected) return;
        const touch = touchMode(session);
        if (event.pointerType === "touch" || (touch && event.detail > 0)) button.blur();
        const resolved = collector.findCandidate?.(image);
        if (!resolved || resolved.type === "video") return;
        const rect = image.getBoundingClientRect();
        try { void Promise.resolve(collector.open(resolved,
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, touch ? "touch" : "mouse", {
            imageText: session.imageText,
            onOpen: () => setPicker(session, true),
            onClose: () => setPicker(session, false),
          })).catch(() => {}); } catch {}
      });
      return button;
    }
    function copyText(session, text, label, idle) {
      const done = ok => { label.textContent = ok ? "복사됨" : "복사 실패"; win.clearTimeout(session.copyTimer); session.copyTimer = win.setTimeout(() => { label.textContent = idle; }, 1600); };
      let promise;
      try { promise = win.navigator.clipboard.writeText(text); } catch (error) { promise = Promise.reject(error); }
      promise.then(() => done(true), () => send({ type: "context:clipboard", text }).then(result => done(result?.ok === true), () => done(false)));
    }
    function showFailure(session, code) {
      fill(session, box => {
        box.append(header(session.context.selectionText ? "선택한 글 번역" : "이미지 글자 번역"));
        const body = doc.createElement("div"); body.className = "pb";
        const text = doc.createElement("p"); text.className = "none bad"; text.setAttribute("role", "alert"); text.textContent = failureText(code); body.append(text);
        const retry = doc.createElement("button"); retry.className = "retry"; retry.type = "button"; retry.textContent = "다시 시도";
        retry.addEventListener("click", event => { if (event.isTrusted === true && current === session && alive(session.context)) { session.focused = false; void run(session, event); } });
        body.append(retry); box.append(body);
      });
      focusIfKeyboard(session);
    }

    async function run(session) {
      const context = session.context, key = context.selectionText ? `selection\n${context.selectionText}` : `${context.imageModel || ""}\n${context.imageUrl}`, id = ++session.run;
      const cached = cache.get(key);
      if (cached) { showLines(session, cached); return; }
      const result = await globalThis.LakomicsContextSurfaces.delayed(() => load(session), () => { if (current === session && session.run === id && alive(context)) showPending(session); }, { win });
      if (current !== session || session.run !== id || !alive(context)) return;
      if (!result?.ok || !Array.isArray(result.lines)) { showFailure(session, result?.code); return; }
      cache.set(key, result.lines); showLines(session, result.lines);
    }

    function dismiss(ms = 90) {
      const session = current; if (!session) return; current = null; session.watcher?.stop();
      win.clearTimeout(session.copyTimer);
      dropPopover(session, ms); dropOverlay(session, ms);
    }
    function translate(context, event) {
      if (!context.imageUrl && !context.selectionText) return;
      dismiss(0);
      const session = { id: ++sequence, run: 0, context, popover: null, overlay: null, copyTimer: 0, pickerOpen: false, keyboard: event?.type === "keydown", focused: false, watcher: watchSession() };
      current = session;
      session.watcher.watch(() => { context.departed = true; dismiss(0); });
      return run(session);
    }
    return { translate, close: dismiss, get open() { return Boolean(current?.popover || current?.overlay); }, destroy() { dismiss(0); cache.clear(); } };
  }
  globalThis.LakomicsContextImage = { create, captureImage, failureText, fitNote, chooseCorner, toneAround, lineGeometry, MIN_FONT };
})();
