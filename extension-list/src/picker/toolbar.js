(() => {
  "use strict";
  // The Lakomics button in Arca Live's Froala toolbar, right after "이미지 업로드".
  const ANCHOR = 'button#imagesMultiUpload-1[data-cmd="imagesMultiUpload"], button[data-cmd="imagesMultiUpload"]';
  const FORM = "form#article_write_form";
  const MARK = "M2 2h8v2H4v16h14v-6h2v8H2zM8 8h12v4H8z";
  const SVG = "http://www.w3.org/2000/svg";

  // Arca marks its dark theme with a `dark-theme` class (seen on the editor; html/body checked too).
  function detectTheme(doc = document) {
    const dark = node => Boolean(node?.classList?.contains("dark-theme"));
    if (dark(doc.documentElement) || dark(doc.body) || doc.querySelector(".dark-theme")) return "dark";
    return "light";
  }

  function createToolbarButton({ doc = document, win = window, onClick = () => {}, label = "Lakomics에서 그림 넣기", shortcut = "Alt+Shift+L" } = {}) {
    let button = null, observer = null, scheduled = false, pressed = false, started = false, themeObserver = null;
    let measured = null;

    function build() {
      const node = doc.createElement("button");
      node.type = "button"; node.className = "lakomics-arca-pick";
      node.setAttribute("aria-label", label); node.setAttribute("aria-pressed", String(pressed)); node.setAttribute("aria-keyshortcuts", shortcut);
      const svg = doc.createElementNS(SVG, "svg"); svg.setAttribute("viewBox", "0 0 22 24"); svg.setAttribute("width", "18"); svg.setAttribute("height", "20"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
      const path = doc.createElementNS(SVG, "path"); path.setAttribute("d", MARK); path.setAttribute("fill", "currentColor"); svg.append(path); node.append(svg);
      node.dataset.lkTheme = detectTheme(doc);
      // Keep the caret in the post body: a Froala-style button never takes focus on mouse down.
      node.addEventListener("mousedown", event => event.preventDefault());
      // On touch, Froala's toolbar handlers cancel the touch so no click follows (the tablet button
      // did nothing). Keep the touch away from Froala and act on touchend; the synthetic click that
      // may still arrive right after is ignored so the panel does not open and close again.
      let touchedAt = 0;
      node.addEventListener("touchstart", event => { event.stopPropagation(); }, { passive: true });
      node.addEventListener("touchend", event => {
        event.stopPropagation();
        if (event.cancelable) event.preventDefault();
        touchedAt = Date.now(); onClick(event);
      });
      node.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation();
        if (Date.now() - touchedAt < 700) return;
        onClick(event);
      });
      return node;
    }
    // Size and margin come from the neighbouring button, measured once.
    function copySize(anchor, node) {
      if (!measured) {
        const style = win.getComputedStyle(anchor);
        const width = parseFloat(style.width), height = parseFloat(style.height);
        measured = { width: width > 0 ? width + "px" : "", height: height > 0 ? height + "px" : "", margin: style.margin || "" };
      }
      if (measured.width) node.style.width = measured.width;
      if (measured.height) node.style.height = measured.height;
      if (measured.margin) node.style.margin = measured.margin;
    }
    function ensure() {
      const anchor = doc.querySelector(ANCHOR);
      if (!anchor) { button?.remove(); return false; }
      if (button && button.isConnected && button.previousElementSibling === anchor) return true;
      if (!button) button = build();
      button.dataset.lkTheme = detectTheme(doc);
      copySize(anchor, button);
      anchor.after(button);
      return true;
    }
    function schedule() {
      if (scheduled) return; scheduled = true;
      const run = () => { scheduled = false; if (started) ensure(); };
      if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(run); else win.setTimeout(run, 0);
    }
    return {
      start() {
        if (started) return; started = true;
        ensure();
        // Froala may rebuild its toolbar at any time; the observer re-adds the button.
        observer = new win.MutationObserver(schedule);
        observer.observe(doc.querySelector(FORM) || doc.body || doc.documentElement, { childList: true, subtree: true });
        themeObserver = new win.MutationObserver(() => { if (button) button.dataset.lkTheme = detectTheme(doc); });
        for (const node of [doc.documentElement, doc.body]) if (node) themeObserver.observe(node, { attributes: true, attributeFilter: ["class"], subtree: node === doc.body });
      },
      stop() { started = false; observer?.disconnect(); themeObserver?.disconnect(); button?.remove(); },
      ensure,
      setPressed(value) { pressed = Boolean(value); button?.setAttribute("aria-pressed", String(pressed)); },
      get button() { return button; },
    };
  }

  globalThis.LakomicsPickerToolbar = { ANCHOR, MARK, detectTheme, createToolbarButton };
})();
