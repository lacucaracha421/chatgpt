(() => {
  "use strict";

  // One left-navigation button on X that does "scroll to the top, then show the new
  // posts" in a single click. It only drives X's own controls (the "Show N posts"
  // button, the Home tab, the "." shortcut); it never reloads the page.
  const CONTROL_ID = "lakomics-x-new-posts-nav";
  const STYLE_ID = "lakomics-x-new-posts-style";
  const HOME_PATHS = new Set(["/", "/home"]);
  const CLICK_GUARD_MS = 800;
  const FOLLOW_UP_DELAYS_MS = [450, 1100, 2000];
  const NAV_SELECTORS = ['header[role="banner"] nav[role="navigation"]', 'header[role="banner"] nav'];
  const HOME_LINK_SELECTORS = ['a[data-testid="AppTabBar_Home_Link"]', 'a[href="/home"]'];
  // X's in-timeline "Show 35 posts" row, in the languages this user runs X in.
  const NEW_POSTS_TEXT = [
    /^(show|see)\s+[\d.,]+\s*[kmb]?\s+(new\s+)?(posts?|tweets?)$/i,
    /^(새\s*)?(게시물|트윗)\s*[\d.,]+\s*개\s*(보기|표시)$/,
    /^[\d.,]+\s*개의?\s*(새\s*)?(게시물|트윗)\s*(보기|표시)$/,
    /^[\d.,]+\s*件の(新しい)?(ポスト|ツイート)を表示$/,
  ];

  function isHomePath(pathname) {
    return HOME_PATHS.has(pathname);
  }

  function findNav(doc) {
    for (const selector of NAV_SELECTORS) {
      const nav = doc.querySelector?.(selector);
      if (nav) return nav;
    }
    return null;
  }

  function findHomeLink(scope) {
    for (const selector of HOME_LINK_SELECTORS) {
      const link = scope?.querySelector?.(selector);
      if (link) return link;
    }
    return null;
  }

  function normalizedText(element) {
    return String(element?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function isNewPostsText(text) {
    return NEW_POSTS_TEXT.some((pattern) => pattern.test(text));
  }

  // Returns X's own "show new posts" control when it is on screen: the floating pill
  // or the row at the top of the timeline.
  function findNewPostsButton(doc) {
    const primary = doc.querySelector?.('[data-testid="primaryColumn"]');
    if (!primary) return null;
    for (const label of primary.querySelectorAll('[data-testid="pillLabel"]')) {
      const button = label.closest('[role="button"], button');
      if (button) return button;
    }
    const cells = Array.from(primary.querySelectorAll('[data-testid="cellInnerDiv"]')).slice(0, 3);
    for (const cell of cells) {
      for (const button of cell.querySelectorAll('[role="button"], button')) {
        if (isNewPostsText(normalizedText(button))) return button;
      }
    }
    return null;
  }

  function scrollToTop(win) {
    try {
      win.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch {
      try { win.scrollTo(0, 0); } catch {}
    }
  }

  // X's documented keyboard shortcut for "load new posts".
  function pressLoadNewPostsShortcut(doc, win) {
    try {
      const init = { key: ".", code: "Period", bubbles: true, cancelable: true };
      doc.body?.dispatchEvent(new win.KeyboardEvent("keydown", init));
      doc.body?.dispatchEvent(new win.KeyboardEvent("keyup", init));
    } catch {}
  }

  // Performs one refresh and reports which X mechanism it used.
  function refreshTimeline(doc = document, win = window) {
    const homeLink = findHomeLink(findNav(doc)) ?? findHomeLink(doc);
    if (!isHomePath(win.location?.pathname ?? "")) {
      // Elsewhere on X, the Home tab is the way back: X opens Home at the top.
      if (!homeLink) return "unavailable";
      homeLink.click();
      return "navigate";
    }
    scrollToTop(win);
    const pill = findNewPostsButton(doc);
    if (pill) {
      pill.click();
      return "pill";
    }
    // Re-selecting the active Home tab is X's own "scroll to top and load new posts".
    if (homeLink) {
      homeLink.click();
      return "home";
    }
    pressLoadNewPostsShortcut(doc, win);
    return "shortcut";
  }

  function readNavColor(homeLink, win) {
    try {
      const source = homeLink.querySelector("svg") ?? homeLink;
      return win.getComputedStyle(source).color || "";
    } catch {
      return "";
    }
  }

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    // Mirrors X's nav items: a full-width row whose inner pill takes the hover tint,
    // a 26px icon and a 20px label that X hides when the column collapses to icons.
    style.textContent = `
      #${CONTROL_ID} { display: flex; width: 100%; margin: 0; padding: 4px 0; border: 0; background: transparent; color: var(--lakomics-x-nav-color, inherit); font: inherit; text-align: start; cursor: pointer; -webkit-tap-highlight-color: transparent; }
      #${CONTROL_ID} .lakomics-x-new-posts-inner { display: inline-flex; align-items: center; max-width: 100%; padding: 12px; border-radius: 9999px; transition: background-color .2s; }
      #${CONTROL_ID}:hover .lakomics-x-new-posts-inner { background: color-mix(in srgb, currentColor 10%, transparent); }
      #${CONTROL_ID}:focus { outline: none; }
      #${CONTROL_ID}:focus-visible .lakomics-x-new-posts-inner { box-shadow: 0 0 0 2px rgb(29, 155, 240); }
      #${CONTROL_ID} svg { flex: none; width: 26.25px; height: 26.25px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      #${CONTROL_ID} .lakomics-x-new-posts-label { margin: 0 16px 0 20px; font-size: 20px; line-height: 24px; white-space: nowrap; }
      #${CONTROL_ID}.is-busy svg { animation: lakomics-x-new-posts-spin .7s linear; }
      @keyframes lakomics-x-new-posts-spin { to { transform: rotate(360deg); } }
      @media (max-width: 1264px) { #${CONTROL_ID} .lakomics-x-new-posts-label { display: none; } }
      @media (prefers-reduced-motion: reduce) { #${CONTROL_ID} .lakomics-x-new-posts-inner { transition: none; } #${CONTROL_ID}.is-busy svg { animation: none; } }
    `;
    (doc.head ?? doc.documentElement).append(style);
  }

  function createControl(doc, win) {
    const button = doc.createElement("button");
    button.id = CONTROL_ID;
    button.type = "button";
    button.setAttribute("aria-label", "맨 위로 이동해 새 게시물 보기");
    button.innerHTML = `<span class="lakomics-x-new-posts-inner"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/><path d="M12 16V8"/><path d="m8.5 11.5 3.5-3.5 3.5 3.5"/></svg><span class="lakomics-x-new-posts-label">새 게시물</span></span>`;
    let lastClick = -Infinity;
    let followUps = [];
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      if (now - lastClick < CLICK_GUARD_MS) return;
      lastClick = now;
      for (const id of followUps) win.clearTimeout(id);
      followUps = [];
      let result = "unavailable";
      try { result = refreshTimeline(doc, win); } catch {}
      button.classList.add("is-busy");
      win.setTimeout(() => button.classList.remove("is-busy"), 700);
      if (result !== "home" && result !== "shortcut") return;
      // After the Home tab re-selects, X may still park new posts behind its
      // "Show N posts" row; open it once it appears.
      let done = false;
      followUps = FOLLOW_UP_DELAYS_MS.map((delay) => win.setTimeout(() => {
        if (done || !isHomePath(win.location?.pathname ?? "")) return;
        const pill = findNewPostsButton(doc);
        if (!pill) return;
        done = true;
        scrollToTop(win);
        pill.click();
      }, delay));
    });
    return button;
  }

  // Inserts the control right after X's Home link, once. X re-renders its nav on SPA
  // navigation and resizes, so a missing or stale control is simply put back.
  function ensureControl(doc = document, win = window) {
    const existing = doc.getElementById(CONTROL_ID);
    if (existing?.isConnected && findNav(doc)?.contains(existing)) return existing;
    const nav = findNav(doc);
    const homeLink = findHomeLink(nav);
    if (!nav || !homeLink) return null;
    existing?.remove();
    ensureStyle(doc);
    const control = createControl(doc, win);
    const color = readNavColor(homeLink, win);
    if (color) control.style.setProperty("--lakomics-x-nav-color", color);
    homeLink.after(control);
    return control;
  }

  function install(doc = document, win = window) {
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      const run = () => {
        queued = false;
        try { ensureControl(doc, win); } catch {}
      };
      if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(run);
      else win.setTimeout(run, 16);
    };
    try { ensureControl(doc, win); } catch {}
    const observer = new win.MutationObserver(schedule);
    observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
    return observer;
  }

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsXHomeRefresh = {
      CONTROL_ID,
      ensureControl,
      findNewPostsButton,
      install,
      isNewPostsText,
      refreshTimeline,
    };
    return;
  }

  if (globalThis.__LAKOMICS_X_HOME_REFRESH_INSTALLED__) return;
  globalThis.__LAKOMICS_X_HOME_REFRESH_INSTALLED__ = true;
  install();
})();
