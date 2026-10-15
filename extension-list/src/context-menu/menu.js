(() => {
  "use strict";
  function createController({ doc = document, win = window, css = "", collector = {}, send = globalThis.LakomicsContextActions.runtime, initialSettings = {}, watchSession = () => ({ watch() {}, stop() {} }) } = {}) {
    const model = globalThis.LakomicsContextModel, surfaces = globalThis.LakomicsContextSurfaces.createSurfaces({ doc, win, css });
    const actionWatchers = new Set();
    let config = model.settings(initialSettings), current = null, departing = false;
    const actions = globalThis.LakomicsContextActions.createActions({ doc, win, send, surfaces, collector, watchSession, settings: () => config, alive: context => !departing && context?.departed !== true && (!context?.href || win.location.href === context.href) });
    function close({ restore = true } = {}) {
      const session = current; if (!session) return; current = null; session.watcher.stop();
      // Chrome-like: the menu fades in over 80 ms and disappears instantly.
      surfaces.remove(session.surface, session.menu, 0);
      if (restore) model.restore(session.context, doc, win);
    }
    function active(session, index, keyboard) {
      session.index = index;
      session.nodes.forEach((node, position) => { node.classList.toggle("active", index === position); node.classList.toggle("kbd", keyboard && index === position); });
      if (index >= 0) { session.menu.setAttribute("aria-activedescendant", session.nodes[index].id); session.nodes[index].scrollIntoView?.({ block: "nearest" }); }
      else session.menu.removeAttribute("aria-activedescendant");
    }
    function invoke(session, index, event) {
      const item = session.items[index];
      if (event.isTrusted !== true || !item || item.disabled || current !== session) return;
      if (event.type === "click" && (event.button !== 0 || Date.now() - session.opened < 200)) return;
      event.preventDefault(); event.stopPropagation(); close({ immediate: true });
      const actionWatcher = watchSession(); actionWatchers.add(actionWatcher);
      actionWatcher.watch(() => { session.context.departed = true; surfaces.destroy(); actionWatcher.stop(); actionWatchers.delete(actionWatcher); });
      if (item.setup) void send({ type: "context:settings" });
      else void actions.activate(item.id, session.context, session.origin, event).finally(() => { actionWatcher.stop(); actionWatchers.delete(actionWatcher); });
      if (item.setup) { actionWatcher.stop(); actionWatchers.delete(actionWatcher); }
    }
    function open(event, keyboard = false, touch = false) {
      const state = collector.state?.() || {};
      if (model.bypass(event, { ...config, hostname: model.topHostname(win), ...state }) || collector.controls?.(event)) return false;
      if (!touch && model.pageOwnsMenu(event)) return false;
      if (!keyboard && !touch && (event.button !== 2 || event.pointerType === "touch")) return false;
      const target = keyboard ? doc.activeElement : event.composedPath?.().find(node => node?.nodeType === 1) || event.target;
      const context = model.snapshot(target, doc, win, collector.findCandidate);
      if (!model.items(context, { inFrame: win !== win.top, clipboard: Boolean(win.navigator.clipboard) }).length) return false;
      context.href = win.location.href;
      const rects = context.range?.getClientRects?.();
      const rect = rects?.length ? rects[rects.length - 1] : target?.getBoundingClientRect();
      const origin = keyboard ? { x: rect?.left || 0, y: (rect?.bottom || 0) + 4 } : { x: event.clientX, y: event.clientY };
      close({ immediate: true, restore: false }); departing = false;
      event.preventDefault();
      const surface = surfaces.host("lakomics-menu", target), menu = doc.createElement("div"); menu.className = "cmA"; menu.style.pointerEvents = "auto";
      menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Lakomics 메뉴"); menu.setAttribute("aria-orientation", "vertical"); menu.setAttribute("aria-description", "Shift+우클릭: Chrome 메뉴"); menu.tabIndex = -1;
      surface.node.dataset.touch = String(event.pointerType === "touch" || Boolean(win.matchMedia?.("(hover: none) and (pointer: coarse)").matches));
      const rows = doc.createElement("div"); rows.className = "rows"; menu.append(rows);
      const footer = doc.createElement("div"); footer.className = "foot"; footer.setAttribute("role", "none"); footer.textContent = "Shift+우클릭: Chrome 메뉴"; menu.append(footer); surface.root.append(menu);
      const session = { surface, menu, rows, context, origin, index: -1, nodes: [], items: [], opened: Date.now(), watcher: watchSession() }; current = session;
      function render(available) {
        if (current !== session) return;
        const focusedId = session.items[session.index]?.id;
        rows.replaceChildren(); session.nodes = []; session.items = [];
        context.imageModel = available.imageModel || "";
        for (const item of model.items(context, { ...available, inFrame: win !== win.top, clipboard: Boolean(win.navigator.clipboard), pageState: actions.pageState?.(), href: win.location.href, canGoBack: win.navigation?.canGoBack ?? win.history.length > 1, canGoForward: win.navigation?.canGoForward === true })) {
          if (item.separator) { const separator = doc.createElement("div"); separator.className = "sep"; separator.setAttribute("role", "separator"); rows.append(separator); continue; }
          const index = session.items.length; session.items.push(item);
          const node = doc.createElement("div"); node.className = "it"; node.id = "lkm-item-" + item.id; node.setAttribute("role", "menuitem");
          node.setAttribute("aria-disabled", String(Boolean(item.disabled)));
          if (item.setup) { node.dataset.state = "setup"; node.setAttribute("aria-description", "API 키 필요"); }
          node.append(surfaces.icon(item.icon));
          const label = doc.createElement("span"); label.className = "lb"; const text = doc.createElement("span"); text.className = "t"; text.textContent = item.label; label.append(text);
          if (item.quote) { const quoted = model.quote(item.quote); const quote = doc.createElement("span"); quote.className = "q"; const inside = doc.createElement("span"); inside.className = "qt"; inside.textContent = quoted; quote.append("“", inside, "”"); label.append(quote); node.setAttribute("aria-label", `${item.label} “${quoted}”`); }
          node.append(label);
          if (item.hint || item.setup) { const hint = doc.createElement("span"); hint.className = item.setup ? "why" : "kb"; hint.textContent = item.setup ? "API 키 필요" : item.hint; node.append(hint); }
          node.addEventListener("pointermove", () => active(session, index, false));
          node.addEventListener("click", click => invoke(session, index, click)); rows.append(node); session.nodes.push(node);
        }
        const index = focusedId ? session.items.findIndex(item => item.id === focusedId) : keyboard ? session.items.findIndex(item => !item.disabled) : -1;
        active(session, index, keyboard); surfaces.place(surface, menu, origin);
        rows.style.maxHeight = Math.max(0, surfaces.viewport().height - (surface.node.dataset.touch === "true" ? 26 : 54)) + "px";
      }
      render({ hasApiKey: true }); surfaces.reveal(surface); surfaces.place(surface, menu, origin); menu.focus({ preventScroll: true });
      session.watcher.watch(() => close({ immediate: true, restore: false }));
      void send({ type: "translation:settings" }).then(available => { if (available?.ok) render(available); });
      return true;
    }
    function canTranslateTouch(event) {
      return !model.bypass(event, { ...config, hostname: model.topHostname(win), ...collector.state?.() });
    }
    // The collector is mid-gesture (its own arc is open) when this is called, so its
    // phase must not count as a reason to bypass; settings and the host still do.
    const canTranslateImage = (image, event) => !model.bypass({ isTrusted: event.isTrusted, target: image, composedPath: () => [image] }, { ...config, hostname: model.topHostname(win) });
    // Runs the context menu's "image text translation" for one image, with the
    // same setup (API key) and availability checks as the menu item.
    function translateImage(image, origin, event) {
      if (!image || !canTranslateImage(image, event)) return false;
      const candidate = collector.findCandidate?.(image);
      const context = { target: image, image, candidate, imageUrl: image.currentSrc || image.src || "", href: win.location.href, touch: true };
      const watcher = watchSession(); actionWatchers.add(watcher);
      watcher.watch(() => { context.departed = true; watcher.stop(); actionWatchers.delete(watcher); });
      void (async () => {
        try {
          const available = await send({ type: "translation:settings" });
          if (departing || context.departed || context.href !== win.location.href || !canTranslateImage(image, event)) return;
          context.imageModel = available?.imageModel || "";
          const item = model.items({ imageUrl: context.imageUrl }, { ...available, pageState: null }).find(item => item.id === "image.translate");
          if (item?.setup) await send({ type: "context:settings" });
          else if (item && !item.disabled) await actions.activate("image.translate", context, origin, event);
        } finally { watcher.stop(); actionWatchers.delete(watcher); }
      })().catch(() => {});
      return true;
    }
    function contextmenu(event) { if (event.shiftKey) { close({ restore: false }); return; } open(event); }
    function captureContextmenu(event) {
      // Opt-in only: an unmarked custom menu and a blanket right-click blocker
      // can use identical listeners. Never override that choice on every site.
      if (event.shiftKey || !model.excluded(model.topHostname(win), config.priorityHosts)) return;
      if (open(event)) event.stopImmediatePropagation();
    }
    function keydown(event) {
      if (!current) { if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) open(event, true); return; }
      if (event.isTrusted !== true) return;
      if (["Escape", "Tab"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); event.stopPropagation(); active(current, model.nextIndex(event.key, current.index, current.nodes.length), true); }
      else if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); invoke(current, current.index, event); }
    }
    function outside(event) { if (current && !event.composedPath?.().includes(current.surface.node)) close({ immediate: event.button === 2 }); }
    const dismiss = () => close();
    win.addEventListener("contextmenu", captureContextmenu, true);
    win.addEventListener("contextmenu", contextmenu); win.addEventListener("keydown", keydown);
    doc.addEventListener("pointerdown", outside, true); doc.addEventListener("scroll", dismiss, true); win.addEventListener("resize", dismiss); win.addEventListener("blur", dismiss); doc.addEventListener("visibilitychange", dismiss);
    win.visualViewport?.addEventListener("resize", dismiss); win.visualViewport?.addEventListener("scroll", dismiss);
    return { open, openTouch: event => open(event, false, true), close, keydown, canTranslateTouch, translateImage, get current() { return current; }, update(value) { config = model.settings(value); close(); }, destroy() {
      close({ immediate: true }); departing = true; for (const watcher of actionWatchers) watcher.stop(); actionWatchers.clear(); actions.destroy?.(); surfaces.destroy();
      win.removeEventListener("contextmenu", captureContextmenu, true);
      win.removeEventListener("contextmenu", contextmenu); win.removeEventListener("keydown", keydown); doc.removeEventListener("pointerdown", outside, true); doc.removeEventListener("scroll", dismiss, true); win.removeEventListener("resize", dismiss); win.removeEventListener("blur", dismiss); doc.removeEventListener("visibilitychange", dismiss);
      win.visualViewport?.removeEventListener("resize", dismiss); win.visualViewport?.removeEventListener("scroll", dismiss);
    } };
  }
  globalThis.LakomicsContextMenu = { createController };
})();
