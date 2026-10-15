(() => {
  "use strict";
  const SETTLE_MS = 250;
  // Shadow-local styles: the button never inherits a page's button/selection rules.
  const CSS = `
    .selection-chip{box-sizing:border-box;display:block;width:72px;height:44px;padding:0 12px;
      border:1px solid var(--m-line);border-radius:22px;background:var(--m-bg);color:var(--m-text);
      box-shadow:var(--m-shadow);font:500 15px/1 var(--ui);pointer-events:auto;touch-action:manipulation;
      user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;animation:selectionChipIn 160ms ease-out both}
    .selection-chip:focus-visible{outline:2px solid var(--m-focus);outline-offset:2px}
    @keyframes selectionChipIn{from{opacity:0}to{opacity:1}}
    @media(prefers-reduced-motion:reduce){.selection-chip{animation:none}}
    @media(forced-colors:active){.selection-chip{background:Canvas;color:CanvasText;border-color:ButtonText;box-shadow:none}}
  `;
  function shouldShow({ text = "", collapsed = false, pointerType = "", coarse = false, blocked = false, editable = false, pointers = 0 } = {}) {
    return Boolean(text.trim()) && text.length <= 12000 && !collapsed && !blocked && !editable && pointers === 0
      && (pointerType === "touch" || pointerType === "pen" || (!pointerType && coarse));
  }
  function placement(rect, view, size = { width: 72, height: 44 }) {
    const left = view.offsetLeft || 0, top = view.offsetTop || 0;
    const right = left + view.width, bottom = top + view.height, margin = 8;
    if (size.width + margin * 2 > view.width || size.height + margin * 2 > view.height
      || rect.right <= left || rect.left >= right || rect.bottom <= top || rect.top >= bottom) return null;
    const clampX = x => Math.max(left + margin, Math.min(x, right - size.width - margin));
    const x = clampX((Math.max(left, rect.left) + Math.min(right, rect.right) - size.width) / 2);
    // Chromium does not expose native selection toolbar bounds. Reserve a toolbar
    // band above/below and a handle gap at either side instead of overlapping it.
    const above = rect.top - 64 - size.height;
    if (above >= top + margin) return { x, y: above, side: "above" };
    const below = rect.bottom + 64;
    if (below + size.height <= bottom - margin) return { x, y: below, side: "below" };
    const y = Math.max(top + margin, Math.min(rect.top, bottom - size.height - margin));
    if (rect.right + 28 + size.width <= right - margin) return { x: rect.right + 28, y, side: "right" };
    if (rect.left - 28 - size.width >= left + margin) return { x: rect.left - 28 - size.width, y, side: "left" };
    return null;
  }
  function sameSelection(a, b) {
    return Boolean(a && b && a.text === b.text && a.range.startContainer === b.range.startContainer
      && a.range.startOffset === b.range.startOffset && a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset);
  }
  function create({ doc = document, win = window, css = "", canShow = () => true,
    send = globalThis.LakomicsContextActions.runtime, watchSession = () => ({ watch() {}, stop() {} }) } = {}) {
    const model = globalThis.LakomicsContextModel;
    const surfaces = globalThis.LakomicsContextSurfaces.createSurfaces({ doc, win, css: css + CSS });
    const popover = globalThis.LakomicsContextImage.create({ doc, win, send, surfaces, watchSession,
      alive: context => !context.departed && context.href === win.location.href && context.target.isConnected });
    const pointers = new Set(), watcher = watchSession();
    let pointerType = "", timer = null, current = null, dismissed = null, destroyed = false;
    function hide() {
      win.clearTimeout(timer); timer = null; watcher.stop();
      if (current) { surfaces.remove(current.surface, current.button, 0); current = null; }
    }
    function read() {
      const selection = win.getSelection?.();
      if (!selection?.rangeCount || selection.isCollapsed) return null;
      const range = selection.getRangeAt(0).cloneRange();
      const element = node => node?.nodeType === 1 ? node : node?.parentElement;
      const target = element(range.startContainer), end = element(range.endContainer);
      const text = selection.toString();
      if (!target?.isConnected || !end?.isConnected || target.closest(model.ownSelector) || end.closest(model.ownSelector)) return null;
      if (!shouldShow({ text, collapsed: selection.isCollapsed, pointerType, coarse: Boolean(win.matchMedia?.("(pointer: coarse)").matches),
        editable: Boolean(model.editable(target) || model.editable(end) || model.editable(doc.activeElement)), pointers: pointers.size,
        blocked: doc.hidden || !canShow({ isTrusted: true, target, composedPath: () => [target] }) })) return null;
      const rect = range.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return { text, range, target, rect, href: win.location.href, touch: true };
    }
    function schedule() {
      const next = read();
      if (sameSelection(next, current?.context)) return;
      hide();
      if (!next) { dismissed = null; return; }
      if (sameSelection(next, dismissed)) return;
      timer = win.setTimeout(() => {
        timer = null;
        const context = read();
        if (destroyed || next.href !== win.location.href || !sameSelection(next, context)) return;
        const view = surfaces.viewport(), position = placement(context.rect, view);
        if (!position) return;
        const surface = surfaces.host("lakomics-selection-chip", context.target), button = doc.createElement("button");
        surface.node.dataset.touch = "true";
        button.className = "selection-chip"; button.type = "button"; button.textContent = "번역";
        button.setAttribute("aria-label", "선택한 글 번역");
        surface.root.append(button);
        surface.node.style.left = position.x + "px"; surface.node.style.top = position.y + "px";
        current = { surface, button, context }; watcher.watch(() => { dismissed = context; hide(); });
        // Prevent focus on the button from clearing the native text selection.
        button.addEventListener("pointerdown", event => { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener("click", event => {
          event.preventDefault(); event.stopPropagation();
          if (event.isTrusted !== true || current?.context !== context || !sameSelection(context, read())) return;
          dismissed = context; hide();
          void (async () => {
            const available = await send({ type: "translation:settings" });
            if (destroyed || context.href !== win.location.href || !context.target.isConnected || !canShow({ isTrusted: true, target: context.target, composedPath: () => [context.target] })) return;
            if (!available?.ok) return;
            if (!(available.hasContextApiKey ?? available.hasApiKey)) { await send({ type: "context:settings" }); return; }
            await popover.translate({ ...context, selectionText: context.text, selectionRect: context.rect }, event);
          })().catch(() => {});
        });
        surfaces.reveal(surface);
      }, SETTLE_MS);
    }
    function inside(event) { return event.composedPath?.().some(node => node?.tagName === "LAKOMICS-SELECTION-CHIP"); }
    function down(event) {
      if (inside(event) || event.isTrusted !== true) return;
      pointerType = event.pointerType || ""; pointers.add(event.pointerId); hide();
    }
    function up(event) { if (inside(event)) return; pointers.delete(event.pointerId); schedule(); }
    function cancel(event) { pointers.delete(event.pointerId); hide(); }
    function dismiss() { dismissed = current?.context || read(); hide(); }
    function depart() { dismiss(); pointers.clear(); popover.close(0); }
    function key(event) { if (event.key === "Escape") dismiss(); else if (!inside(event)) { pointerType = "keyboard"; hide(); } }
    doc.addEventListener("selectionchange", schedule);
    win.addEventListener("pointerdown", down, true); win.addEventListener("pointerup", up, true); win.addEventListener("pointercancel", cancel, true);
    doc.addEventListener("scroll", dismiss, true); win.addEventListener("resize", dismiss); win.addEventListener("blur", depart);
    doc.addEventListener("visibilitychange", depart); win.addEventListener("keydown", key, true);
    for (const type of ["pagehide", "popstate", "hashchange"]) win.addEventListener(type, depart);
    win.visualViewport?.addEventListener("scroll", dismiss); win.visualViewport?.addEventListener("resize", dismiss);
    return { refresh: dismiss, destroy() {
      destroyed = true; hide(); popover.destroy(); surfaces.destroy();
      doc.removeEventListener("selectionchange", schedule);
      win.removeEventListener("pointerdown", down, true); win.removeEventListener("pointerup", up, true); win.removeEventListener("pointercancel", cancel, true);
      doc.removeEventListener("scroll", dismiss, true); win.removeEventListener("resize", dismiss); win.removeEventListener("blur", depart);
      doc.removeEventListener("visibilitychange", depart); win.removeEventListener("keydown", key, true);
      for (const type of ["pagehide", "popstate", "hashchange"]) win.removeEventListener(type, depart);
      win.visualViewport?.removeEventListener("scroll", dismiss); win.visualViewport?.removeEventListener("resize", dismiss);
    } };
  }
  globalThis.LakomicsSelectionChip = { SETTLE_MS, shouldShow, placement, create };
})();
