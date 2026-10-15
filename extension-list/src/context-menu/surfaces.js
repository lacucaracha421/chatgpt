(() => {
  "use strict";
  const revealedLayers = new WeakSet();
  const paths = {
    copy: "M8 7V4h12v13h-3M4 7h12v13H4z", cut: "M8 8l12 12M8 16L20 4M7 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M7 17a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    clipboard: "M9 4H5v17h14V4h-4M9 2h6v4H9z", select: "M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 7h10v10H7z",
    film: "M3 3h18v18H3zM7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4", translate: "M3 5h12M9 2v3M5 5c1 6 5 9 10 11M13 5c-1 6-5 9-10 11M14 21l4-10 4 10M16 17h4",
    archive: "M3 3h18v4H3zM5 7v14h14V7M9 11h6M12 11v6M9 14l3 3 3-3", download: "M12 3v12M7 10l5 5 5-5M3 16v5h18v-5",
    image: "M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M16 7h.01", open: "M14 3h7v7M21 3L10 14M10 3H3v18h18v-7",
    link: "M10 14l4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
    back: "M20 12H4M10 6l-6 6 6 6", forward: "M4 12h16M14 6l6 6-6 6", reload: "M20 11a8 8 0 1 0-2 7M20 3v8h-8", check: "M5 12l4 4L19 6", close: "M6 6l12 12M18 6L6 18",
  };
  function icon(doc, name) {
    if (["가", "あ", "A"].includes(name)) { const node = doc.createElement("span"); node.className = "g" + (name === "あ" ? " jp" : ""); node.textContent = name; node.setAttribute("aria-hidden", "true"); return node; }
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "ic"); svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", paths[name] || paths.copy); svg.append(path); return svg;
  }
  function theme(target, doc = document, win = window) {
    const seen = new Set();
    for (let node = target; node; node = node.parentElement || node.getRootNode?.().host) {
      if (node.nodeType !== 1) continue; seen.add(node);
      const found = opaqueTheme(win.getComputedStyle(node).backgroundColor); if (found) return found;
    }
    for (const node of [doc.body, doc.documentElement]) { if (!node || seen.has(node)) continue; const found = opaqueTheme(win.getComputedStyle(node).backgroundColor); if (found) return found; }
    const scheme = win.getComputedStyle(doc.documentElement).colorScheme || "";
    if (/dark/.test(scheme)) return "dark"; if (/light/.test(scheme)) return "light";
    return win.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function opaqueTheme(color) {
    const values = color.match(/[\d.]+/g)?.map(Number);
    if (!values || values.length < 3 || (values.length > 3 && values[3] < 1)) return null;
    const linear = values.slice(0, 3).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; });
    return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2] < .4 ? "dark" : "light";
  }
  // Collector/toast hosts live outside our shadow roots. z-index alone cannot
  // put them above a top-layer image overlay; they must join the top layer too.
  function revealAboveNotes(node, zIndex = 2147483647) {
    if (!node) return;
    node.style.zIndex = String(zIndex);
    if (typeof node.showPopover !== "function") return;
    if (!node.hasAttribute("popover")) {
      Object.assign(node.style, { margin: "0", border: "0", padding: "0", background: "transparent", width: "auto", height: "auto", overflow: "visible" });
      node.setAttribute("popover", "manual");
    }
    // Showing an already open popover does not change its top-layer order.
    try { node.hidePopover?.(); node.showPopover(); revealedLayers.add(node); } catch {}
  }
  function createSurfaces({ doc = document, win = window, css = "" } = {}) {
    const model = globalThis.LakomicsContextModel, blocks = new WeakMap();
    let sheet = null, currentToast = null;
    if (win.CSSStyleSheet?.prototype.replaceSync) { sheet = new win.CSSStyleSheet(); sheet.replaceSync(css); }
    function host(tag, target, floating = true, { documentCoordinates = false } = {}) {
      const node = doc.createElement(tag), root = node.attachShadow({ mode: "closed" });
      node.dataset.theme = theme(target, doc, win);
      if (sheet) root.adoptedStyleSheets = [sheet]; else { const style = doc.createElement("style"); style.textContent = css; root.append(style); }
      if (floating) {
        node.style.cssText = "all:initial;position:fixed;inset:0 auto auto 0;z-index:2147483647;contain:layout style;pointer-events:none;margin:0;border:0;padding:0;background:transparent;overflow:visible;";
        node.style.zIndex = String(tag === "lakomics-image-markers" ? 2147483644 : ["lakomics-toast", "lakomics-page-status"].includes(tag) ? 2147483647 : 2147483645);
        if (documentCoordinates) node.style.position = "absolute";
        node.style.colorScheme = node.dataset.theme;
        if (typeof node.showPopover === "function") node.setAttribute("popover", "manual");
        (doc.fullscreenElement || doc.documentElement).append(node);
      } else {
        const computed = win.getComputedStyle(target);
        node.style.cssText = "all:initial;display:block;";
        node.style.color = computed.color; node.style.fontSize = computed.fontSize; node.style.lineHeight = "1.7";
      }
      return { node, root };
    }
    function reveal(surface) {
      if (surface.node.hasAttribute("popover")) { try { surface.node.showPopover(); revealedLayers.add(surface.node); } catch {} }
      // Top-layer order follows show order, regardless of host z-index. Restore
      // higher extension layers when notes are recreated from a cached answer.
      const higher = [...doc.querySelectorAll('lakomics-image-popover[popover],lakomics-toast[popover],lakomics-page-status[popover],#lakomics-arc-collector[popover],.lakomics-list-toasts[popover]')]
        .filter(node => revealedLayers.has(node) && Number(node.style.zIndex) > Number(surface.node.style.zIndex))
        .sort((a, b) => Number(a.style.zIndex) - Number(b.style.zIndex));
      for (const node of higher) revealAboveNotes(node, Number(node.style.zIndex));
    }
    function viewport() { return win.visualViewport || { width: win.innerWidth, height: win.innerHeight, offsetLeft: 0, offsetTop: 0 }; }
    function place(surface, box, origin, offset = 2) {
      const rect = box.getBoundingClientRect(), view = viewport();
      box.style.maxHeight = Math.max(0, view.height - 16) + "px";
      const position = model.placement(origin.x, origin.y, rect.width, Math.min(rect.height, view.height - 16), view, offset);
      surface.node.style.left = position.x + "px"; surface.node.style.top = position.y + "px";
      return position;
    }
    function remove(surface, box, ms = 90, collapse = false) {
      if (!surface || surface.closed) return;
      surface.closed = true;
      revealedLayers.delete(surface.node);
      if (!ms || win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { surface.node.remove(); return; }
      box.classList.add("exit");
      win.setTimeout(() => {
        if (!collapse) surface.node.remove();
        else { box.classList.remove("exit"); box.classList.add("collapse"); win.setTimeout(() => surface.node.remove(), 140); }
      }, ms);
    }
    function toast(origin, target) {
      currentToast?.close(0);
      const surface = host("lakomics-toast", target), box = doc.createElement("div"); box.className = "toastA"; box.style.pointerEvents = "auto"; surface.root.append(box);
      let timer;
      const api = {
        show(label, { preview = "", pending = false, error = false, retry = null } = {}) {
          if (surface.closed) return;
          win.clearTimeout(timer); box.replaceChildren(); box.className = "toastA" + (pending ? " pending" : ""); box.setAttribute("role", error ? "alert" : "status");
          if (!pending && !error) box.append(icon(doc, "check"));
          const text = doc.createElement("span"); text.className = error ? "bad" : ""; text.textContent = label; box.append(text);
          if (preview) { const node = doc.createElement("span"); node.className = "pv"; node.textContent = preview.replace(/\s+/g, " "); box.append(node); }
          if (retry) { const button = doc.createElement("button"); button.className = "act"; button.textContent = "다시 시도"; button.addEventListener("click", event => { if (event.isTrusted === true) { api.close(0); retry(event); } }); box.append(button); }
          reveal(surface); place(surface, box, origin, 12);
          if (!pending) timer = win.setTimeout(() => api.close(), error ? 4000 : 1600);
        },
        close(ms = 130) { win.clearTimeout(timer); remove(surface, box, ms); if (currentToast === api) currentToast = null; },
      };
      currentToast = api; return api;
    }
    // `inside` puts the card at the end of the block (table cells and list items), not after it.
    function inline(block, { inside = false } = {}) {
      let api = blocks.get(block); if (api && !api.closed) return api;
      const surface = host("lakomics-translation-block", block, false), box = doc.createElement("div"); box.className = "trA"; box.setAttribute("role", "region"); box.setAttribute("aria-label", "한국어 번역"); surface.root.append(box);
      let version = 0, hidden = false;
      const apply = () => { surface.node.style.display = hidden ? "none" : "block"; };
      api = { get closed() { return surface.closed === true; }, begin() { const request = ++version; return () => request === version && !surface.closed; },
        show(text, { pending = false, error = false, retry = null } = {}) {
          if (surface.closed || !block.isConnected) return;
          if (pending && surface.node.isConnected && !box.classList.contains("pending") && !box.classList.contains("fail")) return;
          box.replaceChildren(); box.className = "trA" + (pending ? " pending" : error ? " fail" : "");
          const header = doc.createElement("div"); header.className = "h"; header.setAttribute("aria-live", "polite");
          const title = doc.createElement("span"); title.textContent = pending ? "번역 중" : error ? "번역 실패 ·" : "번역"; header.append(title);
          if (retry) { const button = doc.createElement("button"); button.className = "retry"; button.textContent = "다시 시도"; button.addEventListener("click", event => { if (event.isTrusted === true) retry(event); }); header.append(button); }
          const spacer = doc.createElement("span"); spacer.className = "sp"; const close = doc.createElement("button"); close.className = "x"; close.setAttribute("aria-label", "번역 닫기"); close.append(icon(doc, "close")); close.addEventListener("click", () => api.close()); header.append(spacer, close); box.append(header);
          if (!pending && !error) { const body = doc.createElement("div"); body.lang = "ko"; body.textContent = text; box.append(body); }
          if (!surface.node.isConnected) { if (inside) block.append(surface.node); else block.after(surface.node); apply(); }
        },
        // Page translation hides and shows its cards without asking again.
        setHidden(value) { hidden = Boolean(value); if (!surface.closed) apply(); },
        get hidden() { return hidden; },
        close() { remove(surface, box, 90, true); blocks.delete(block); },
      };
      blocks.set(block, api); return api;
    }
    // The original text of a translated block: a small floating note that never moves the page.
    // `origin` is the pointer (mouse) or finger (touch) position; a finger's note sits above it.
    function note(text, origin, target, { touch = false } = {}) {
      const surface = host("lakomics-translation-note", target), box = doc.createElement("div"); box.className = "noteA"; box.setAttribute("role", "tooltip");
      surface.node.dataset.touch = String(touch);
      const label = doc.createElement("span"); label.className = "nh"; label.textContent = "원문";
      const body = doc.createElement("div"); body.className = "nb"; body.textContent = text;
      box.append(label, body); surface.root.append(box);
      reveal(surface);
      const size = box.getBoundingClientRect();
      place(surface, box, touch ? { x: origin.x - size.width / 2, y: origin.y - size.height - 28 } : origin, touch ? 8 : 16);
      return { get closed() { return surface.closed === true; }, close(ms = 90) { remove(surface, box, ms); } };
    }
    // The page translation status: top right of the viewport, stays until closed.
    function status(target) {
      const surface = host("lakomics-page-status", target), box = doc.createElement("div"); box.className = "toastA status"; box.style.pointerEvents = "auto"; surface.root.append(box);
      const reposition = () => {
        const view = viewport(), width = box.getBoundingClientRect().width;
        surface.node.style.left = Math.max((view.offsetLeft || 0) + 8, (view.offsetLeft || 0) + view.width - width - 16) + "px";
        surface.node.style.top = (view.offsetTop || 0) + 16 + "px";
      };
      const api = {
        get closed() { return surface.closed === true; },
        show(label, { pending = false, count = "", actions = [] } = {}) {
          if (surface.closed) return;
          box.replaceChildren(); box.className = "toastA status" + (pending ? " pending" : ""); box.setAttribute("role", "status");
          const text = doc.createElement("span"); text.textContent = label; box.append(text);
          if (count) { const node = doc.createElement("span"); node.className = "pv"; node.textContent = count; box.append(node); }
          for (const { label: name, onClick } of actions) {
            const button = doc.createElement("button"); button.className = "act"; button.textContent = name;
            button.addEventListener("click", event => { if (event.isTrusted === true) onClick(event); }); box.append(button);
          }
          const close = doc.createElement("button"); close.className = "act x"; close.setAttribute("aria-label", "닫기"); close.append(icon(doc, "close")); close.addEventListener("click", event => { if (event.isTrusted === true) api.close(); }); box.append(close);
          reveal(surface); reposition();
        },
        close(ms = 130) { remove(surface, box, ms); win.removeEventListener("resize", reposition); },
      };
      win.addEventListener("resize", reposition);
      return api;
    }
    return { host, reveal, revealAboveNotes, place, remove, toast, inline, note, status, viewport, icon: name => icon(doc, name), destroy() { currentToast?.close(0); } };
  }
  // Pending text appears after 400 ms and, once visible, lasts at least 600 ms.
  async function delayed(work, pending, { win = window, now = () => Date.now() } = {}) {
    let shown = null;
    const timer = win.setTimeout(() => { shown = now(); pending(); }, 400);
    try { return await work(); }
    finally { win.clearTimeout(timer); if (shown !== null) await new Promise(resolve => win.setTimeout(resolve, Math.max(0, 600 - (now() - shown)))); }
  }
  globalThis.LakomicsContextSurfaces = { createSurfaces, revealAboveNotes, delayed, theme, opaqueTheme };
})();
