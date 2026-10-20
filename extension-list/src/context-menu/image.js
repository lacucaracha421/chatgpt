(() => {
  "use strict";
  // 이미지 글자 번역: the worker reads and translates the picture; this file asks for it and
  // lays the answer as small translation notes directly over each text block of the image.
  // Waiting, failure, empty and selection-text answers use a small window (popA) instead.
  const MAX_EDGE = 1568;
  // Image actions may be owned by different controllers in the same document.
  // Their pending requests and fading hosts must share one lifetime.
  const imageOwners = new WeakMap();
  const messages = {
    image_unavailable: "이미지를 불러오지 못했어요", image_too_large: "이미지가 너무 커요", image_type: "지원하지 않는 이미지 형식이에요",
    image_unreadable: "이미지를 읽지 못했어요", api_key_missing: "API 키가 필요해요", worker_timeout: "시간이 너무 오래 걸렸어요", timeout: "시간이 너무 오래 걸렸어요",
  };
  // The code stays visible on the generic text so a model or API failure can be told apart.
  function failureText(code) { return messages[code] || (code ? `번역하지 못했어요 · ${code}` : "번역하지 못했어요"); }
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
  const MIN_FONT = 14, EDGE = 4;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
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
  // All variants use premeasured whole words. Never trade legibility for separation.
  function noteVariants(fit, { W, H }, measure) {
    if (fit.wrap) return [];
    const variants = [];
    for (const f of [...new Set([fit.f, MIN_FONT])]) {
      for (const reduction of [0, 2]) {
        const padX = Math.max(2, fit.padX - reduction), padY = Math.max(2, fit.padY - reduction);
        const minWidth = Math.ceil(measure(f, { w: 2 * padX }, padX, padY, false).overflow + 2 * padX + 1);
        for (const w of [...new Set([fit.w, Math.max(minWidth, fit.w * .9), Math.max(minWidth, fit.w * .8), minWidth])]) {
          if (w > fit.w || w > W - 2 * EDGE) continue;
          const m = measure(f, { w }, padX, padY, false);
          const h = Math.max(fit.h - 2 * reduction, Math.ceil(m.height + 2 * padY));
          if (m.overflow > .5 || h > H - 2 * EDGE) continue;
          variants.push({ ...fit, w, h, f, padX, padY, wrap: false,
            y: Math.min(fit.y, H - EDGE - h) });
        }
      }
    }
    return variants;
  }
  // Pure, bounded coordinate descent. Gap area wins first, then total distance from
  // the fitted OCR anchors, then shape changes; vertical moves win equal ties.
  // `variants` must have been validated with noteVariants before entering this pass.
  function resolveOverlaps(rects, { W, H }) {
    const result = rects.map(r => ({ ...r }));
    const area = (a, b) => Math.max(0, Math.min(a.x + a.w + EDGE, b.x + b.w + EDGE) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.h + EDGE, b.y + b.h + EDGE) - Math.max(a.y, b.y));
    const distance = (r, anchor) => Math.hypot(r.x - anchor.x, r.y - anchor.y);
    const better = (a, b) => {
      for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > .001) return a[k] < b[k];
      return false;
    };
    for (let round = -1; round < 6; round++) {
      let changed = false;
      for (let i = 0; i < result.length; i++) {
        const anchor = rects[i], current = result[i];
        if (!result.some((r, j) => j !== i && area(current, r) > 0)) continue;
        const cap = Math.max(48, .4 * Math.max(anchor.w, anchor.h));
        const score = (r, limit = Infinity) => {
          let overlap = 0;
          for (let j = 0; j < result.length; j++) if (i !== j) {
            overlap += area(r, result[j]);
            if (overlap > limit + .001) return [overlap];
          }
          return [overlap, distance(r, anchor), Math.abs(r.w - anchor.w) + Math.abs(r.h - anchor.h) + Math.abs((r.f || 14) - (anchor.f || 14)), Math.abs(r.x - anchor.x)];
        };
        let best = current, bestScore = score(current);
        const shapes = [...new Map([anchor, ...(anchor.variants || [])].map(r => [[r.w, r.h, r.f, r.padX, r.padY].join('/'), r])).values()];
        const ranked = shapes.map(shape => ({ shape, score: score(shape) })).sort((a, b) => better(a.score, b.score) ? -1 : better(b.score, a.score) ? 1 : 0);
        // Try shrinking at the anchor before movement, and bound the movement search
        // to the three most promising shapes even in very dense OCR results.
        for (const entry of ranked) if (distance(entry.shape, anchor) <= cap && better(entry.score, bestScore)) { best = entry.shape; bestScore = entry.score; }
        // Give every neighbour its chance to shrink before displacing any anchor.
        if (round === -1) {
          if (best !== current) { result[i] = { ...best }; changed = true; }
          continue;
        }
        if (bestScore[0] === 0 && bestScore[1] === 0) { result[i] = { ...best }; changed = true; continue; }
        const blockers = result.filter((other, j) => j !== i && area(current, other) > 0)
          .sort((a, b) => distance(a, current) - distance(b, current)).slice(0, 4);
        for (const shape of [...new Set([anchor, current, ...ranked.slice(0, 3).map(entry => entry.shape)])]) {
          const xs = [current.x, anchor.x], ys = [current.y, shape.y];
          for (const other of blockers) {
            xs.push(other.x - shape.w - EDGE, other.x + other.w + EDGE);
            ys.push(other.y - shape.h - EDGE, other.y + other.h + EDGE);
          }
          const positions = [...new Set(ys)].map(y => [current.x, y]).concat([...new Set(xs)].map(x => [x, current.y]));
          for (const [x0, y0] of positions) {
            let x = clamp(x0, EDGE, Math.max(EDGE, W - EDGE - shape.w));
            let y = clamp(y0, EDGE, Math.max(EDGE, H - EDGE - shape.h));
            const d = Math.hypot(x - anchor.x, y - anchor.y);
            if (d > cap) { x = anchor.x + (x - anchor.x) * cap / d; y = anchor.y + (y - anchor.y) * cap / d; }
            if (x < EDGE || y < EDGE || x + shape.w > W - EDGE || y + shape.h > H - EDGE) continue;
            const candidate = { ...shape, x, y }, candidateScore = score(candidate, bestScore[0]);
            if (better(candidateScore, bestScore)) { best = candidate; bestScore = candidateScore; }
          }
        }
        if (best !== current) { result[i] = best; changed = true; }
      }
      if (!changed && round >= 0) break;
    }
    const stacked = result.map((r, i) => result.some((other, j) => i !== j && area(r, other) > 0));
    const order = result.map((_, i) => i).filter(i => stacked[i]).sort((a, b) =>
      result[b].w * result[b].h - result[a].w * result[a].h || result[b].y - result[a].y || b - a);
    order.forEach((i, rank) => { result[i].stacked = true; result[i].zIndex = rank + 2; });
    return result;
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
  function choosePillPlacement(rects, frame, pw, ph, viewport, neighbours = []) {
    const { x, y, w, h } = frame, left = viewport.offsetLeft || 0, top = viewport.offsetTop || 0;
    const right = left + viewport.width, bottom = top + viewport.height;
    // Keep the full toolbar's footprint even while collapsed, so expanding never
    // moves the chip to a different edge or slides controls beyond the viewport.
    const edge = Math.min(x + w, right), px = edge - pw;
    // Nearby pages share no usable outside edge. Keep ownership unambiguous,
    // even when the space on the opposite side of this page is still empty.
    const nearby = neighbours.some(r => r.x < x + w && r.x + r.w > x && r.y <= y + h + 80 && r.y + r.h >= y - 80);
    if (!nearby && px >= left && edge <= right) {
      for (const [placement, py] of [["below", y + h + 6], ["above", y - ph - 6]]) {
        const blocked = neighbours.some(r => r.x < edge && r.x + r.w > px && r.y < py + ph && r.y + r.h > py);
        if (!blocked && py >= top && py + ph <= bottom) return { placement, x: px - x, y: py - y };
      }
    }
    return { placement: "corner", ...chooseCorner(rects, w, h, pw, ph) };
  }
  const JAPANESE = /[぀-ヿ㐀-鿿]/;
  // Where the picture itself is drawn inside its <img> element. X crops tall pictures with
  // object-fit: cover and letterboxes others, so the element's rectangle is not the picture's.
  // `rect` is the element's viewport rectangle, `inset` its border + padding, `natural` the
  // picture's pixel size. Returns the drawn picture ({x, y, w, h}, viewport pixels, may reach
  // past the element when cropped) and `view`, the part of it that is actually visible.
  const cssPx = value => { const n = parseFloat(value); return Number.isFinite(n) ? n : 0; };
  function axisPosition(token, free, fallback) {
    const word = String(token || fallback).trim();
    if (/%$/.test(word)) return free * (cssPx(word) / 100);
    if (/^-?[\d.]+(px)?$/.test(word)) return cssPx(word);
    return free * ({ left: 0, top: 0, center: .5, right: 1, bottom: 1 }[word] ?? .5);
  }
  function imageFrame({ rect, inset = {}, natural = {}, fit = "fill", position = "50% 50%" }) {
    const box = {
      x: rect.left + cssPx(inset.left), y: rect.top + cssPx(inset.top),
      w: rect.width - cssPx(inset.left) - cssPx(inset.right), h: rect.height - cssPx(inset.top) - cssPx(inset.bottom),
    };
    if (!(box.w > 0 && box.h > 0)) return { drawn: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }, view: { x: rect.left, y: rect.top, w: rect.width, h: rect.height } };
    let w = box.w, h = box.h;
    const nw = natural.width, nh = natural.height, kind = String(fit || "fill").trim().split(/\s+/)[0];
    if (nw > 0 && nh > 0) {
      const contain = Math.min(box.w / nw, box.h / nh), cover = Math.max(box.w / nw, box.h / nh);
      const scale = kind === "contain" ? contain : kind === "cover" ? cover : kind === "none" ? 1 : kind === "scale-down" ? Math.min(1, contain) : 0;
      if (scale > 0) { w = nw * scale; h = nh * scale; }
    }
    const tokens = String(position || "").trim().split(/\s+/).filter(Boolean);
    let px = tokens[0], py = tokens[1];
    if (tokens.length === 1) { if (px === "top" || px === "bottom") { py = px; px = "center"; } else py = "center"; }
    else if (px === "top" || px === "bottom" || py === "left" || py === "right") [px, py] = [py, px];
    const drawn = { x: box.x + axisPosition(px, box.w - w, "50%"), y: box.y + axisPosition(py, box.h - h, "50%"), w, h };
    const left = Math.max(drawn.x, box.x), top = Math.max(drawn.y, box.y);
    const right = Math.min(drawn.x + w, box.x + box.w), bottom = Math.min(drawn.y + h, box.y + box.h);
    const view = right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : { x: drawn.x, y: drawn.y, w: 0, h: 0 };
    return { drawn, view };
  }
  // Maps a normalized (0-1000) box onto the visible part of the picture. `frame` is
  // {W, H, ox, oy, DW, DH}: the visible size, and the drawn picture's offset and size relative
  // to it. Returns null when nothing of the box is visible.
  function lineGeometry(line, W, H, frame = { W, H, ox: 0, oy: 0, DW: W, DH: H }) {
    const b = line.box; if (!b) return null;
    const x0 = frame.ox + b.x0 / 1000 * frame.DW, x1 = frame.ox + b.x1 / 1000 * frame.DW;
    const y0 = frame.oy + b.y0 / 1000 * frame.DH, y1 = frame.oy + b.y1 / 1000 * frame.DH;
    const left = Math.max(0, x0), top = Math.max(0, y0), right = Math.min(frame.W, x1), bottom = Math.min(frame.H, y1);
    const full = { w: x1 - x0, h: y1 - y0 };
    // A box whose centre is cropped away is hidden; a partly cropped one keeps its visible part.
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    if (!(right > left && bottom > top) || cx < 0 || cx > frame.W || cy < 0 || cy > frame.H) return null;
    const box = { x: left, y: top, w: right - left, h: bottom - top };
    return { box, vertical: full.h > full.w * 1.4 && JAPANESE.test(line.original || ""), chars: String(line.original || line.korean).replace(/[\s、。，．,.!！?？…ー〜~]/g, "").length };
  }

  function create({ doc = document, win = window, send, surfaces, collector = {}, alive = () => true, watchSession = () => ({ watch() {}, stop() {} }) } = {}) {
    const model = globalThis.LakomicsContextModel, cache = new Map();
    let current = null, sequence = 0, exitingOverlay = null;
    const reduced = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const touchMode = session => Boolean(session.context.touch || win.matchMedia?.("(hover: none) and (pointer: coarse)").matches);

    function visibleImage(image) {
      if (image?.tagName !== "IMG" || !image.isConnected) return false;
      const rect = image.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      for (let node = image; node; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (node.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      return true;
    }
    function contextImage(context) {
      if (context.image?.tagName === "IMG") return context.image;
      for (const target of [context.image, context.target, context.candidate?.element]) {
        const image = target?.closest?.("img");
        if (image) return image;
        const images = [...(target?.querySelectorAll?.("img") || [])].filter(visibleImage);
        if (images.length === 1) return images[0];
      }
      return null;
    }
    function followImage(session) {
      const image = session.context.image, anchor = session.imageAnchor;
      if (image?.isConnected || !anchor?.scope.isConnected) return image;
      // Stay in this picture's slot: a document-wide URL lookup can pick a
      // preload or a second occurrence of the artwork. An unchanged original
      // link also identifies lazy img-master -> img-original replacements.
      const candidates = [...anchor.scope.querySelectorAll("img")].filter(visibleImage);
      const exact = candidates.filter(node => (node.currentSrc || node.src) === anchor.url);
      const linked = candidates.filter(node => anchor.link && node.closest("a[href]")?.href === anchor.link);
      const matches = exact.length ? exact : linked;
      if (matches.length !== 1) return image;
      session.context.image = matches[0];
      if (session.overlay?.observer) {
        session.overlay.observer.disconnect(); session.overlay.observer.observe(matches[0]);
      }
      return matches[0];
    }

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
    // The picture's visible part inside its <img> (object-fit crops and letterboxing count).
    function frameOf(image, rect) {
      let style = null; try { style = win.getComputedStyle(image); } catch {}
      const inset = style ? {
        left: parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft), right: parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight),
        top: parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop), bottom: parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom),
      } : {};
      for (const key of Object.keys(inset)) if (!Number.isFinite(inset[key])) inset[key] = 0;
      return imageFrame({ rect, inset, natural: { width: image.naturalWidth, height: image.naturalHeight }, fit: style?.objectFit || "fill", position: style?.objectPosition || "50% 50%" });
    }
    function usesDocumentCoordinates(image) {
      // Top-layer absolute popovers use the initial containing block, independent
      // of X's positioned/transformed wrappers. Keep fixed tracking for scrollers
      // and sticky/fixed images whose motion differs from document scrolling.
      if (doc.fullscreenElement || typeof doc.documentElement.showPopover !== "function") return false;
      for (let node = image; node; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (style.position === "fixed" || style.position === "sticky") return false;
        if (node === image || node === doc.scrollingElement || node === doc.documentElement) continue;
        const overflowX = style.overflowX || style.overflow, overflowY = style.overflowY || style.overflow;
        if (/(auto|scroll|overlay)/.test(`${style.overflow} ${overflowX} ${overflowY}`)) return false;
        // X also uses overflow:hidden solely to clip rounded image corners.
        // Those wrappers must not force compositor-scrolled images back to JS.
        if (((overflowX === "hidden" || style.overflow === "hidden") && node.scrollWidth > node.clientWidth) || ((overflowY === "hidden" || style.overflow === "hidden") && node.scrollHeight > node.clientHeight)) return false;
      }
      return true;
    }
    function pillNeighbours(session, view) {
      const neighbours = [], reach = Math.max(80, (session.overlay.pillHeight || 44) + 6);
      // Read candidate rects first; only check ancestor visibility for media in
      // the small region that can affect this toolbar. Ignore our own picture
      // wrapper and host, including any media inside extension shadow roots.
      for (const node of doc.querySelectorAll("img,video,canvas,picture,lakomics-image-markers")) {
        if (node === session.context.image || node === session.overlay.surface.node || node.contains(session.context.image)) continue;
        const r = node.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0) || r.left >= view.x + view.w || r.left + r.width <= Math.min(view.x, view.x + view.w - session.overlay.pillWidth) || r.top > view.y + view.h + reach || r.top + r.height < view.y - reach) continue;
        let visible = true;
        for (let parent = node; parent; parent = parent.parentElement) {
          const style = win.getComputedStyle(parent);
          if (parent.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") { visible = false; break; }
        }
        if (visible) neighbours.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
      return neighbours;
    }
    function extensionNode(node) {
      for (; node; node = node.parentElement || node.getRootNode?.().host) {
        if (node.localName?.startsWith("lakomics-") || node.id === "lakomics-arc-collector" || node.classList?.contains("lakomics-list-toasts")) return true;
      }
      return false;
    }
    function paints(style) {
      return Boolean(style) && ((style.backgroundColor && style.backgroundColor !== "transparent" && !/rgba\([^)]*,\s*0\)/.test(style.backgroundColor))
        || /url\(|gradient\(/.test(style.backgroundImage || ""));
    }
    function pageOccluders(image, area, toolbar = false) {
      const found = new Map(), viewport = surfaces.viewport();
      if (!doc.elementsFromPoint) return [];
      const left = Math.max(area.x, viewport.offsetLeft || 0), top = Math.max(area.y, viewport.offsetTop || 0);
      const right = Math.min(area.x + area.w, (viewport.offsetLeft || 0) + viewport.width), bottom = Math.min(area.y + area.h, (viewport.offsetTop || 0) + viewport.height);
      if (right <= left || bottom <= top) return [];
      const points = toolbar ? [[0, 0], [1, 0], [.5, .5], [0, 1], [1, 1]]
        : Array.from({ length: 25 }, (_, i) => [i % 5 / 4, Math.floor(i / 5) / 4]);
      for (const [px, py] of points) {
        const x = left + .5 + (right - left - 1) * px, y = top + .5 + (bottom - top - 1) * py;
        // Closed shadow roots retarget hits to their host; skip the whole stack
        // of extension layers, including interactive notes, pills and picker UI.
        let node = doc.elementsFromPoint(x, y).find(node => !extensionNode(node));
        if (!node || node === image || node.contains(image) || image.contains(node)) continue;
        if (node.parentElement === image.parentElement && /url\(/.test(win.getComputedStyle(node).backgroundImage)) continue;
        // A label inside a header/menu represents its painted background too.
        const hit = node;
        for (let parent = node.parentElement; parent && !parent.contains(image); parent = parent.parentElement) {
          if (paints(win.getComputedStyle(parent))) node = parent;
        }
        // X lays transparent swipe/zoom layers over viewer photos; they cover nothing.
        if (node === hit && !paints(win.getComputedStyle(node)) && !node.textContent?.trim() && !/^(img|svg|video|canvas|picture)$/i.test(node.localName || "")) continue;
        if (!found.has(node)) {
          const r = node.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) found.set(node, { x: r.left, y: r.top, w: r.width, h: r.height });
        }
      }
      return [...found.values()];
    }
    function clipNotes(session, view, occluders, pillRect) {
      const overlay = session.overlay, viewport = surfaces.viewport();
      let pieces = [{
        x: Math.max(Math.min(view.x, pillRect.x), viewport.offsetLeft || 0),
        y: Math.max(Math.min(view.y, pillRect.y), viewport.offsetTop || 0),
        right: Math.min(Math.max(view.x + view.w, pillRect.x + pillRect.w), (viewport.offsetLeft || 0) + viewport.width),
        bottom: Math.min(Math.max(view.y + view.h, pillRect.y + pillRect.h), (viewport.offsetTop || 0) + viewport.height),
      }].filter(r => r.right > r.x && r.bottom > r.y);
      for (const cut of occluders) {
        pieces = pieces.flatMap(r => {
          const x = Math.max(r.x, cut.x), y = Math.max(r.y, cut.y), right = Math.min(r.right, cut.x + cut.w), bottom = Math.min(r.bottom, cut.y + cut.h);
          if (right <= x || bottom <= y) return [r];
          return [{ x: r.x, y: r.y, right: r.right, bottom: y }, { x: r.x, y: bottom, right: r.right, bottom: r.bottom },
            { x: r.x, y, right: x, bottom }, { x: right, y, right: r.right, bottom }].filter(r => r.right > r.x && r.bottom > r.y);
        });
      }
      let clip;
      if (pieces.length === 1) {
        const r = pieces[0];
        clip = `inset(${r.y - view.y}px ${view.x + view.w - r.right}px ${view.y + view.h - r.bottom}px ${r.x - view.x}px)`;
      } else {
        // Disjoint rectangles share doubled bridges to the origin. Even-odd
        // filling leaves holes without cancelling overlapping page occluders.
        const points = ["0px 0px"];
        for (const r of pieces) {
          const a = `${r.x - view.x}px ${r.y - view.y}px`;
          points.push(a, `${r.right - view.x}px ${r.y - view.y}px`, `${r.right - view.x}px ${r.bottom - view.y}px`, `${r.x - view.x}px ${r.bottom - view.y}px`, a, "0px 0px");
        }
        clip = pieces.length ? `polygon(evenodd, ${points.join(", ")})` : "inset(50%)";
      }
      if (overlay.surface.node.style.clipPath !== clip) overlay.surface.node.style.clipPath = clip;
    }
    function placeNotes(session, { checkOnly = false, scanNeighbours = true } = {}) {
      const overlay = session.overlay;
      if (!overlay || overlay.surface.closed) return;
      const image = followImage(session);
      const rect = image?.isConnected ? image.getBoundingClientRect() : null, empty = !rect || rect.width <= 0 || rect.height <= 0;
      const frame = empty ? null : frameOf(image, rect), view = frame?.view, gone = empty || !(view.w > 0 && view.h > 0);
      const documentCoordinates = usesDocumentCoordinates(image);
      const x = (view?.x || 0) + (documentCoordinates ? win.scrollX : 0), y = (view?.y || 0) + (documentCoordinates ? win.scrollY : 0);
      // Compare document geometry, not viewport geometry: ordinary scrolling
      // must not rewrite the host or flip the toolbar between above and below.
      const d = frame?.drawn;
      if (!gone && (scanNeighbours || !overlay.neighbours)) overlay.neighbours = pillNeighbours(session, view).map(r => ({ ...r, x: r.x - view.x, y: r.y - view.y }));
      const neighbours = gone ? [] : overlay.neighbours.map(r => ({ ...r, x: r.x + view.x, y: r.y + view.y }));
      const occluders = gone ? [] : pageOccluders(image, view);
      const viewport = surfaces.viewport();
      const geometry = JSON.stringify([viewport.width, viewport.height, viewport.offsetLeft, viewport.offsetTop, documentCoordinates, gone, session.pickerOpen, x, y, view?.w, view?.h, d && [d.x - view.x, d.y - view.y, d.w, d.h], neighbours.map(r => [r.x - view.x, r.y - view.y, r.w, r.h])]);
      if (checkOnly && overlay.geometry === geometry) {
        if (!gone) updateOcclusion(session, view, neighbours, occluders, true);
        return;
      }
      overlay.geometry = geometry;
      overlay.surface.node.style.position = documentCoordinates ? "absolute" : "fixed";
      overlay.surface.node.style.visibility = session.pickerOpen || gone ? "hidden" : "visible";
      if (gone) return;
      Object.assign(overlay.surface.node.style, { left: x + "px", top: y + "px", width: view.w + "px", height: view.h + "px" });
      const key = [view.w, view.h, d.x - view.x, d.y - view.y, d.w, d.h].map(Math.round).join("x");
      if (overlay.key !== key) { overlay.key = key; layoutNotes(session, { W: view.w, H: view.h, ox: d.x - view.x, oy: d.y - view.y, DW: d.w, DH: d.h }); }
      updateOcclusion(session, view, neighbours, occluders);
    }
    function layoutNotes(session, frame) {
      const overlay = session.overlay, { W, H } = frame;
      overlay.box.querySelector(".card")?.remove(); overlay.card = null;
      // One DOM measurement batch, followed by pure fitting/resolution and one write batch.
      // Measure whole words at 14px; widths scale with font size, preserving keep-all.
      const rack = doc.createElement("div");
      rack.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;white-space:pre";
      const measured = new Map();
      for (const item of overlay.items) {
        if (item.kind === "sfx") { item.node.style.display = ""; item.node.style.maxWidth = Math.max(40, W - 2 * EDGE) + "px"; continue; }
        const words = item.inner.textContent.trim().split(/\s+/);
        const probes = [...words, " "].map(word => {
          const span = doc.createElement("span"); span.className = "nt"; span.textContent = word;
          span.style.cssText = "display:inline-block;width:auto;font-size:14px;white-space:pre";
          rack.append(span); return span;
        });
        measured.set(item, { words, probes });
      }
      overlay.box.append(rack);
      for (const data of measured.values()) data.widths = data.probes.map(span => span.getBoundingClientRect().width);
      const tags = new Map(overlay.items.filter(item => item.kind === "sfx").map(item => [item, { w: item.node.offsetWidth, h: item.node.offsetHeight }]));
      const chipWidth = overlay.peekButton.offsetWidth || (touchMode(session) ? 50 : 42);
      const pw = chipWidth + (overlay.pillActions.offsetWidth || 174) + 4;
      overlay.pill.style.setProperty("--pill-width", pw + "px");
      overlay.pill.style.setProperty("--chip-width", chipWidth + 4 + "px");
      overlay.pillWidth = pw;
      overlay.pillHeight = overlay.pill.offsetHeight || (touchMode(session) ? 44 : 32);
      rack.remove();
      const rects = [], visible = [];
      for (const item of overlay.items) {
        const geometry = lineGeometry(item.line, W, H, frame);
        // Text cropped out of the visible picture (X's timeline crop) gets no note.
        if (!geometry) continue;
        visible.push(item);
        if (item.kind === "sfx") {
          // Sound effects get a small tag just below their text, or above it at the bottom edge.
          const { w: tw, h: th } = tags.get(item), b = geometry.box;
          const x = clamp(b.x, EDGE, Math.max(EDGE, W - EDGE - tw));
          let y = b.y + b.h + 4;
          if (y + th > H - EDGE) y = b.y - 4 - th;
          if (y < EDGE) y = clamp(b.y + 4, EDGE, Math.max(EDGE, H - EDGE - th));
          rects.push({ x, y, w: tw, h: th });
          continue;
        }
        const { widths, words } = measured.get(item), gap = widths.at(-1);
        const measure = (f, r, padX, padY, wrap) => {
          const available = Math.max(1, r.w - 2 * padX), scale = f / MIN_FONT;
          let lines = 1, used = 0, longest = 0;
          for (let i = 0; i < words.length; i++) {
            // A small rounding allowance keeps fractional glyph widths inside the note.
            const width = widths[i] * scale + (widths[i] > 0 ? 1 : 0);
            longest = Math.max(longest, width);
            if (used && used + gap * scale + width > available) { lines++; used = 0; }
            if (wrap && width > available) { lines += Math.ceil(width / available) - 1; used = width % available; }
            else used += (used ? gap * scale : 0) + width;
          }
          return { overflow: wrap ? 0 : Math.max(0, longest - available), height: lines * f * 1.28 };
        };
        const fit = fitNote({ box: geometry.box, W, H, vertical: geometry.vertical, chars: geometry.chars, measure });
        rects.push({ ...fit, variants: noteVariants(fit, frame, measure) });
      }
      const resolved = resolveOverlaps(rects, frame), raised = resolved.length + 2;
      overlay.box.style.setProperty("--note-top", String(raised));
      overlay.pill.style.zIndex = String(raised + 1);
      for (const item of overlay.items) item.node.style.display = visible.includes(item) ? "" : "none";
      visible.forEach((item, i) => {
        const fit = resolved[i], { node, inner } = item;
        Object.assign(node.style, { left: fit.x + "px", top: fit.y + "px", zIndex: String(fit.zIndex || 1) });
        node.classList.toggle("stacked", Boolean(fit.stacked));
        if (!inner) return;
        Object.assign(node.style, { width: fit.w + "px", height: fit.h + "px", padding: `${fit.padY}px ${fit.padX}px`, borderRadius: Math.min(6, fit.h / 4, fit.w / 4) + "px" });
        inner.style.fontSize = fit.f + "px"; inner.style.overflowWrap = fit.wrap ? "anywhere" : "normal";
      });
      overlay.rects = resolved;
    }
    function placePill(session, view, neighbours) {
      const overlay = session.overlay, pill = overlay.pill;
      const spot = choosePillPlacement(overlay.rects, view, overlay.pillWidth, overlay.pillHeight, surfaces.viewport(), neighbours);
      const left = spot.x + overlay.pillWidth + "px", top = spot.y + "px";
      if (pill.style.left !== left) pill.style.left = left;
      if (pill.style.top !== top) pill.style.top = top;
      if (pill.dataset.placement !== spot.placement) pill.dataset.placement = spot.placement;
      if (spot.corner) { if (pill.dataset.corner !== spot.corner) pill.dataset.corner = spot.corner; } else if (pill.dataset.corner) delete pill.dataset.corner;
    }
    function updateOcclusion(session, view, neighbours, occluders, keepPlacement = false) {
      const overlay = session.overlay;
      if (!keepPlacement) placePill(session, view, neighbours);
      const pillRect = () => ({ x: view.x + parseFloat(overlay.pill.style.left) - overlay.pillWidth, y: view.y + parseFloat(overlay.pill.style.top), w: overlay.pillWidth, h: overlay.pillHeight });
      let pill = pillRect();
      const covered = pageOccluders(session.context.image, pill, true);
      const viewport = surfaces.viewport(), left = viewport.offsetLeft || 0, top = viewport.offsetTop || 0;
      const pictureVisible = view.x + view.w > left && view.y + view.h > top && view.x < left + viewport.width && view.y < top + viewport.height;
      const outside = pill.x < left || pill.y < top || pill.x + pill.w > left + viewport.width || pill.y + pill.h > top + viewport.height;
      if (pictureVisible && (covered.length || outside)) {
        const obstacles = [...occluders, ...covered];
        const free = { x: Math.max(view.x, left), y: Math.max(view.y, top), right: Math.min(view.x + view.w, left + viewport.width), bottom: Math.min(view.y + view.h, top + viewport.height) };
        for (const r of obstacles) {
          if (r.x <= free.x && r.x + r.w >= free.right) {
            if (r.y <= free.y) free.y = Math.max(free.y, r.y + r.h);
            else if (r.y + r.h >= free.bottom) free.bottom = Math.min(free.bottom, r.y);
          }
          if (r.y <= free.y && r.y + r.h >= free.bottom) {
            if (r.x <= free.x) free.x = Math.max(free.x, r.x + r.w);
            else if (r.x + r.w >= free.right) free.right = Math.min(free.right, r.x);
          }
        }
        const rects = [...overlay.rects.map(r => ({ ...r, x: r.x + view.x - free.x, y: r.y + view.y - free.y })),
          ...obstacles.map(r => ({ ...r, x: r.x - free.x, y: r.y - free.y }))];
        const spot = chooseCorner(rects, free.right - free.x, free.bottom - free.y, overlay.pillWidth, overlay.pillHeight);
        Object.assign(overlay.pill.style, { left: free.x - view.x + spot.x + overlay.pillWidth + "px", top: free.y - view.y + spot.y + "px" });
        overlay.pill.dataset.placement = "corner"; overlay.pill.dataset.corner = spot.corner;
        pill = pillRect();
      }
      const finalCover = covered.length || outside ? pageOccluders(session.context.image, pill, true) : [];
      const visibility = !pictureVisible || finalCover.length || pill.x < left || pill.y < top || pill.x + pill.w > left + viewport.width || pill.y + pill.h > top + viewport.height ? "hidden" : "";
      if (overlay.pill.style.visibility !== visibility) overlay.pill.style.visibility = visibility;
      if (doc.elementsFromPoint) clipNotes(session, view, [...occluders, ...covered, ...finalCover], pill);
    }
    function setPeek(session, on) {
      const overlay = session.overlay; if (!overlay || overlay.surface.closed) return;
      overlay.box.classList.toggle("peek", on || overlay.original);
      if (on) { overlay.box.querySelector(".card")?.remove(); overlay.card = null; }
    }
    function toggleOriginal(session) {
      const overlay = session.overlay;
      overlay.original = !overlay.original;
      const on = overlay.original;
      setPeek(session, on);
      overlay.box.classList.toggle("original", on);
      overlay.peekButton.textContent = on ? "번역" : "원문";
      overlay.peekButton.setAttribute("aria-label", on ? "번역 보기" : "원문 보기");
      overlay.peekButton.setAttribute("aria-pressed", String(on));
      overlay.pillActions.inert = on;
      overlay.pillActions.setAttribute("aria-hidden", String(on));
      overlay.pillActions.querySelectorAll("button").forEach(button => { button.tabIndex = on ? -1 : 0; button.disabled = on; });
      for (const item of overlay.items) {
        item.node.inert = on;
        item.node.setAttribute("aria-hidden", String(on));
        item.node.tabIndex = on ? -1 : 0;
      }
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
      card.style.zIndex = String(overlay.items.length + 4);
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
      dropPopover(session, 0);
      dropOverlay(session, 0);
      const image = followImage(session);
      const surface = surfaces.host("lakomics-image-markers", image, true, { documentCoordinates: usesDocumentCoordinates(image) }), box = doc.createElement("div");
      surface.node.dataset.touch = String(touchMode(session));
      box.className = "image-notes"; box.setAttribute("role", "group"); box.setAttribute("aria-label", "이미지 글자 번역");
      if (reduced()) box.style.animation = "none";
      surface.root.append(box);
      // Keep touch/long-press and compatibility mouse events inside our surface (X opens its viewer on a click).
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "contextmenu", "dragstart", "click"]) {
        box.addEventListener(type, event => { event.stopPropagation(); if (type === "contextmenu" || type === "dragstart") event.preventDefault(); });
      }
      const overlay = { surface, box, items: [], key: "", held: false, suppress: false, original: false, card: null, pill: null, peekButton: null };
      session.overlay = overlay;
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
        }
        if (reduced()) node.style.animation = "none";
        node.addEventListener("click", event => {
          if (event.isTrusted !== true) return;
          if (overlay.suppress) { overlay.suppress = false; return; }
          if (event.pointerType === "touch" || (touchMode(session) && event.detail > 0)) node.blur();
          openCard(session, node, line);
        });
        bindHold(session, node);
        const raise = () => {
          for (const other of overlay.items) other.node.classList.toggle("raised", other.node === node);
        };
        node.addEventListener("pointerenter", raise); node.addEventListener("pointerdown", raise); node.addEventListener("focus", raise);
        box.append(node); overlay.items.push(item);
      });
      buildPill(session, lines);
      // Popovers are display:none until revealed. Mount invisibly first so the
      // toolbar and notes can be measured before the browser paints them.
      surface.node.style.visibility = "hidden";
      surfaces.reveal(surface); placeNotes(session);
      watchFollow(session);
      focusIfKeyboard(session);
    }
    function buildPill(session, lines) {
      const overlay = session.overlay, pill = doc.createElement("div");
      pill.className = "pill"; pill.setAttribute("role", "toolbar"); pill.setAttribute("aria-label", "번역 도구");
      const peek = doc.createElement("button"); peek.type = "button"; peek.className = "peek-btn"; peek.textContent = "원문";
      peek.setAttribute("aria-label", "원문 보기"); peek.setAttribute("aria-pressed", "false");
      peek.addEventListener("click", event => { if (event.isTrusted === true) toggleOriginal(session); });
      const copy = doc.createElement("button"), label = doc.createElement("span"); copy.type = "button"; copy.className = "act"; copy.dataset.action = "image.copy";
      label.textContent = "모두 복사"; label.setAttribute("aria-live", "polite"); copy.append(surfaces.icon("copy"), label);
      copy.addEventListener("click", event => { if (event.isTrusted === true) copyText(session, lines.map(line => line.korean).join("\n"), label, "모두 복사"); });
      const save = makeSaveButton(session);
      const close = doc.createElement("button"); close.type = "button"; close.className = "x"; close.setAttribute("aria-label", "번역 닫기"); close.title = "번역 닫기"; close.append(surfaces.icon("close"));
      close.addEventListener("click", event => { if (event.isTrusted === true) dismiss(); });
      const sep = () => { const node = doc.createElement("span"); node.className = "sep"; node.setAttribute("aria-hidden", "true"); return node; };
      const actions = doc.createElement("div"); actions.className = "pill-actions"; actions.setAttribute("aria-hidden", "false");
      actions.append(sep(), copy); if (save) actions.append(save); actions.append(sep(), close);
      pill.append(peek, actions);
      overlay.box.append(pill); overlay.pill = pill; overlay.peekButton = peek; overlay.pillActions = actions;
    }
    function watchFollow(session) {
      const overlay = session.overlay, surfaceHost = overlay.surface.node;
      const schedule = (scanNeighbours = true) => {
        overlay.scanNeighbours ||= scanNeighbours;
        if (overlay.frame) return;
        overlay.frame = win.requestAnimationFrame(() => {
          overlay.frame = 0;
          const scanNeighbours = overlay.scanNeighbours; overlay.scanNeighbours = false;
          placeNotes(session, { checkOnly: true, scanNeighbours });
        });
      };
      overlay.follow = () => schedule();
      overlay.scroll = () => schedule(false);
      doc.addEventListener("scroll", overlay.scroll, true);
      win.visualViewport?.addEventListener("scroll", overlay.scroll);
      win.addEventListener("resize", overlay.follow);
      win.addEventListener("orientationchange", overlay.follow);
      win.visualViewport?.addEventListener("resize", overlay.follow);
      doc.addEventListener("load", overlay.follow, true);
      doc.addEventListener("loadedmetadata", overlay.follow, true);
      if (win.ResizeObserver) { overlay.observer = new win.ResizeObserver(overlay.follow); overlay.observer.observe(session.context.image); }
      if (win.MutationObserver) {
        overlay.mutations = new win.MutationObserver(records => {
          if (records.every(record => record.target === surfaceHost)) return;
          const media = "img,video,canvas,picture,lakomics-image-markers";
          const scanNeighbours = records.some(record => record.target !== surfaceHost && (record.type === "childList"
            ? [...record.addedNodes, ...record.removedNodes].some(node => node.matches?.(media) || node.querySelector?.(media))
            : record.target.matches?.(media) || record.target.querySelector?.(media)));
          schedule(scanNeighbours);
        });
        overlay.mutations.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      const check = () => {
        schedule();
        overlay.checkTimer = win.setTimeout(check, 500);
      };
      overlay.checkTimer = win.setTimeout(check, 500);
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
      doc.removeEventListener("scroll", overlay.scroll, true); win.removeEventListener("resize", overlay.follow); win.removeEventListener("orientationchange", overlay.follow);
      doc.removeEventListener("load", overlay.follow, true); doc.removeEventListener("loadedmetadata", overlay.follow, true);
      win.visualViewport?.removeEventListener("resize", overlay.follow); win.visualViewport?.removeEventListener("scroll", overlay.scroll);
      overlay.mutations?.disconnect(); win.cancelAnimationFrame(overlay.frame); win.clearTimeout(overlay.checkTimer);
      overlay.observer?.disconnect(); win.removeEventListener("keydown", overlay.onKey, true); doc.removeEventListener("pointerdown", overlay.outside, true);
      overlay.surface.node.inert = true;
      overlay.box.querySelectorAll("button").forEach(button => { button.disabled = true; });
      surfaces.remove(overlay.surface, overlay.box, ms);
      exitingOverlay = overlay;
    }

    async function load(session) {
      if (session.context.selectionText) {
        const result = await send({ type: "translation:context", kind: "translate.ko.inline", text: session.context.selectionText });
        return result?.ok && typeof result.text === "string" && result.text.trim()
          ? { ok: true, lines: [{ original: session.context.selectionText, korean: result.text }] } : { ok: false, code: result?.code };
      }
      const { imageUrl: url } = session.context;
      if (/^https:/i.test(url)) {
        const result = await send({ type: "translation:image", url });
        // Only a failed download falls back to the copy already loaded in the page.
        if (result?.ok || result?.code !== "image_unavailable") return result;
      } else if (/^data:image\//i.test(url) && url.length < 11000000) return send({ type: "translation:image", dataUrl: url });
      const dataUrl = captureImage(followImage(session), doc);
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
        const image = followImage(session);
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
        const image = followImage(session);
        if (event.isTrusted !== true || current !== session || !alive(session.context) || !image.isConnected) return;
        const touch = touchMode(session);
        if (event.pointerType === "touch" || (touch && event.detail > 0)) button.blur();
        const resolved = collector.findCandidate?.(image);
        if (!resolved || resolved.type === "video") return;
        const rect = image.getBoundingClientRect();
        try { void Promise.resolve(collector.open(resolved,
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, touch ? "touch" : "mouse", {
            imageText: session.imageText,
            onOpen: () => {
              surfaces.revealAboveNotes(doc.getElementById("lakomics-arc-collector"), 2147483646);
              setPicker(session, true);
            },
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
      // A dismissed session can still be fading when a cached image is reopened.
      // Retire that host too, even though `current` has already been cleared.
      if (exitingOverlay) { exitingOverlay.surface.node.remove(); exitingOverlay = null; }
      // Retain ownership during the exit so another controller can retire it.
      if (!ms && imageOwners.get(doc) === dismiss) imageOwners.delete(doc);
      const session = current; if (!session) return; current = null; session.watcher?.stop();
      win.clearTimeout(session.copyTimer);
      dropPopover(session, ms); dropOverlay(session, ms);
    }
    function translate(context, event) {
      if (!context.imageUrl && !context.selectionText) return;
      dismiss(0);
      if (!context.selectionText) {
        context.image = contextImage(context);
        imageOwners.get(doc)?.(0);
        imageOwners.set(doc, dismiss);
      }
      const session = { id: ++sequence, run: 0, context, popover: null, overlay: null, copyTimer: 0, pickerOpen: false, keyboard: event?.type === "keydown", focused: false, watcher: watchSession() };
      const image = context.image, scope = image?.closest?.("a[href]") || image?.parentElement;
      if (scope) session.imageAnchor = { scope, url: image.currentSrc || image.src, link: image.closest("a[href]")?.href };
      current = session;
      session.watcher.watch(() => { if (current === session) { context.departed = true; dismiss(0); } });
      return run(session);
    }
    return { translate, close: dismiss, get open() { return Boolean(current?.popover || current?.overlay); }, destroy() { dismiss(0); cache.clear(); } };
  }
  globalThis.LakomicsContextImage = { create, captureImage, failureText, fitNote, noteVariants, resolveOverlaps, chooseCorner, choosePillPlacement, lineGeometry, imageFrame, MIN_FONT };
})();
