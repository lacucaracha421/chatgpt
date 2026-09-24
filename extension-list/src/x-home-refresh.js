(() => {
  "use strict";

  // One left-navigation button on X that does "scroll to the top, then show the new
  // posts" in a single click. It only drives X's own controls (the left-nav Home link,
  // then the "Show N posts" button); it never reloads the page and never clicks a
  // timeline tab.
  const CONTROL_ID = "lakomics-x-new-posts-nav";
  const STYLE_ID = "lakomics-x-new-posts-style";
  const HOME_PATHS = new Set(["/", "/home"]);
  const CLICK_GUARD_MS = 800;
  const FOLLOW_UP_DELAYS_MS = [450, 1100, 2000];
  const NAV_SELECTORS = ['header[role="banner"] nav[role="navigation"]', 'header[role="banner"] nav'];
  // Only X's exact left-nav Home link. Timeline tabs ("For you", "Following") are also
  // a[href="/home"], and clicking one of those switches the tab, so no generic
  // /home anchor is ever used.
  const HOME_LINK_SELECTOR = 'a[data-testid="AppTabBar_Home_Link"]';
  const ACCOUNT_SWITCHER_SELECTOR = '[data-testid="SideNav_AccountSwitcher_Button"]';
  const AVATAR_SELECTORS = ['[data-testid^="UserAvatar-Container"]', "img"];
  const SHIFT_VAR = "--lakomics-x-new-posts-shift";
  const MAX_SHIFT_PX = 48;
  const SETTLE_ALIGN_MS = 500;
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

  function findHomeLink(nav) {
    const link = nav?.querySelector?.(HOME_LINK_SELECTOR);
    if (!link || link.closest('[role="tablist"], [data-testid="primaryColumn"]')) return null;
    return link;
  }

  // The block holding X's round account avatar at the bottom of the left column. The
  // avatar sits below the nav and the Post button, outside the nav; the control goes in
  // front of the avatar's outermost wrapper inside its own bottom block, so it stacks
  // directly above the avatar rather than floating in the column's spacing.
  function findAccountSwitcher(doc) {
    return doc?.querySelector?.(`header[role="banner"] ${ACCOUNT_SWITCHER_SELECTOR}`) ?? null;
  }

  function findAccountSwitcherAnchor(nav) {
    const switcher = findAccountSwitcher(nav?.ownerDocument);
    if (!switcher) return null;
    let block = switcher;
    while (block.parentElement && !block.parentElement.contains(nav)) block = block.parentElement;
    if (block === switcher || !block.parentElement) return switcher;
    let anchor = switcher;
    while (anchor.parentElement && anchor.parentElement !== block) anchor = anchor.parentElement;
    return anchor;
  }

  // Never treat a tab (or anything inside a tab bar) as the new-posts control.
  function isTabControl(element) {
    return Boolean(element?.closest?.('[role="tab"], [role="tablist"]'));
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
      if (button && !isTabControl(button)) return button;
    }
    const cells = Array.from(primary.querySelectorAll('[data-testid="cellInnerDiv"]')).slice(0, 3);
    for (const cell of cells) {
      for (const button of cell.querySelectorAll('[role="button"], button')) {
        if (!isTabControl(button) && isNewPostsText(normalizedText(button))) return button;
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

  // Performs one refresh and reports which X mechanism it used.
  function refreshTimeline(doc = document, win = window) {
    const homeLink = findHomeLink(findNav(doc));
    if (!isHomePath(win.location?.pathname ?? "")) {
      // Elsewhere on X, the Home link is the way back; X reopens the last-used tab.
      if (!homeLink) return "unavailable";
      homeLink.click();
      return "navigate";
    }
    scrollToTop(win);
    // Clicking the left-nav Home icon while on Home is X's own "scroll to the top and
    // load new posts" for the tab that is currently selected.
    if (!homeLink) return "scrolled";
    homeLink.click();
    return "home";
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
      #${CONTROL_ID} .lakomics-x-new-posts-inner { transform: translateX(var(${SHIFT_VAR}, 0px)); display: inline-flex; align-items: center; max-width: 100%; padding: 12px; border-radius: 9999px; transition: background-color .2s; }
      #${CONTROL_ID}:hover .lakomics-x-new-posts-inner { background: color-mix(in srgb, currentColor 10%, transparent); }
      #${CONTROL_ID}:focus { outline: none; }
      #${CONTROL_ID}:focus-visible .lakomics-x-new-posts-inner { box-shadow: 0 0 0 2px rgb(29, 155, 240); }
      #${CONTROL_ID} svg { flex: none; width: 26.25px; height: 26.25px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      #${CONTROL_ID} .lakomics-x-new-posts-label { margin: 0 16px 0 20px; font-size: 20px; line-height: 24px; white-space: nowrap; }
      #${CONTROL_ID}.is-busy svg { animation: lakomics-x-new-posts-spin .7s linear; }
      @keyframes lakomics-x-new-posts-spin { to { transform: rotate(360deg); } }
      /* Icon-only column: X centres its items, so the button centres its icon in the
         column too and only a small measured nudge remains. */
      @media (max-width: 1264px) { #${CONTROL_ID} { justify-content: center; } #${CONTROL_ID} .lakomics-x-new-posts-label { display: none; } }
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
      if (result !== "home") return;
      // After the Home click, X may still park new posts behind its
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

  // Places the control directly above X's account avatar, once. Without the avatar it
  // falls back to the end of the left nav; without a nav it is not shown. X re-renders
  // its column on SPA navigation and resizes, so a missing or misplaced control is put back.
  function ensureControl(doc = document, win = window) {
    const nav = findNav(doc);
    const existing = doc.getElementById(CONTROL_ID);
    if (!nav) return existing?.isConnected ? existing : null;
    const anchor = findAccountSwitcherAnchor(nav);
    const placed = anchor
      ? existing?.nextElementSibling === anchor
      : existing?.parentElement === nav && !existing.nextElementSibling;
    if (existing?.isConnected && placed) return existing;
    ensureStyle(doc);
    const control = existing ?? createControl(doc, win);
    const color = readNavColor(findHomeLink(nav) ?? nav, win);
    if (color) control.style.setProperty("--lakomics-x-nav-color", color);
    if (anchor) anchor.before(control);
    else nav.append(control);
    alignControl(doc, win);
    win.setTimeout(() => { try { alignControl(doc, win); } catch {} }, SETTLE_ALIGN_MS);
    return control;
  }

  // Lines the icon's centre up with the account avatar's centre, measured from the live
  // layout: the avatar's inset differs between X's icon-only and full-width columns.
  // The shift already applied is part of the measured icon position, so it is corrected
  // rather than stacked. Without the avatar (fallback placement) no shift is applied.
  function findAvatar(doc) {
    const switcher = findAccountSwitcher(doc);
    for (const selector of AVATAR_SELECTORS) {
      const avatar = switcher?.querySelector(selector);
      if (avatar) return avatar;
    }
    return null;
  }

  function alignControl(doc = document, win = window) {
    const control = doc.getElementById(CONTROL_ID);
    const icon = control?.querySelector("svg");
    if (!control?.isConnected || !icon) return null;
    const avatar = findAvatar(doc);
    const previous = Number.parseFloat(control.style.getPropertyValue(SHIFT_VAR)) || 0;
    if (!avatar) {
      control.style.removeProperty(SHIFT_VAR);
      return 0;
    }
    const avatarRect = avatar.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    // Hidden or not laid out yet: keep the current shift until the next measurement.
    if (!avatarRect.width || !iconRect.width) return previous;
    const delta = (avatarRect.left + avatarRect.width / 2) - (iconRect.left + iconRect.width / 2);
    const next = Math.max(-MAX_SHIFT_PX, Math.min(MAX_SHIFT_PX, Math.round((previous + delta) * 2) / 2));
    if (next !== previous) control.style.setProperty(SHIFT_VAR, `${next}px`);
    return next;
  }

  function install(doc = document, win = window) {
    let queued = false;
    // X re-renders its column when it switches between the full-width and icon-only
    // layout, after the resize event. Alignment is re-measured two frames after any
    // resize or size change of the avatar block or the button, once X has laid out.
    const nextFrame = (callback) => {
      if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(callback);
      else win.setTimeout(callback, 16);
    };
    let alignQueued = false;
    const queueAlign = () => {
      if (alignQueued) return;
      alignQueued = true;
      nextFrame(() => nextFrame(() => {
        alignQueued = false;
        try { alignControl(doc, win); } catch {}
      }));
    };
    const sizeObserver = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(queueAlign) : null;
    let observed = [];
    // Watches the current avatar block and button; X swaps these nodes on re-render.
    const syncSizeObserver = () => {
      if (!sizeObserver) return;
      const switcher = findAccountSwitcher(doc);
      const targets = [findAccountSwitcherAnchor(findNav(doc)) ?? switcher, findAvatar(doc), doc.getElementById(CONTROL_ID)]
        .filter(Boolean);
      if (targets.length === observed.length && targets.every((node, index) => node === observed[index])) return;
      sizeObserver.disconnect();
      for (const node of targets) sizeObserver.observe(node);
      observed = targets;
    };
    const ensure = () => {
      try { ensureControl(doc, win); syncSizeObserver(); } catch {}
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      nextFrame(() => { queued = false; ensure(); });
    };
    ensure();
    win.addEventListener("resize", queueAlign);
    const observer = new win.MutationObserver(schedule);
    observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true });
    return observer;
  }

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsXHomeRefresh = {
      CONTROL_ID,
      alignControl,
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
