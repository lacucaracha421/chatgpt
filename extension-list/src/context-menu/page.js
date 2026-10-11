(() => {
  "use strict";
  // 페이지 본문 번역: finds the main text of a page, translates its blocks progressively
  // (what is on screen first, then downward) and shows each translation right under
  // its original. Translations hide and show again without asking the model.
  const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, figcaption, dd";
  const MAX_BLOCKS = 400, MAX_BLOCK_CHARS = 4000, BATCH_ITEMS = 4, BATCH_CHARS = 3000, CONCURRENCY = 3;
  const HARD = "script, style, noscript, template, svg, math, canvas, iframe, pre, code, kbd, samp, textarea, input, select, button, [contenteditable]:not([contenteditable='false']), [hidden], [aria-hidden='true'], nav, aside, footer, form, menu, dialog, "
    + "[role='navigation'], [role='complementary'], [role='contentinfo'], [role='search'], [role='banner'], [role='dialog'], .lakomics-translation, .lakomics-translation-toggle, #lakomics-translation-controls";
  const NOISE = new Set(["ad", "ads", "advert", "advertisement", "sponsor", "sponsored", "promo", "banner", "cookie", "cookies", "popup", "modal", "share", "sharing", "social", "comment", "comments", "related", "recommend", "recommended", "breadcrumb", "breadcrumbs", "sidebar", "widget", "newsletter", "subscribe", "toolbar"]);
  const INSIDE = /^(?:LI|TD|DD)$/;
  const HALTING = new Set(["api_key_missing", "http_401", "http_402", "http_403", "disabled"]);

  function noisy(node) {
    const className = typeof node.className === "string" ? node.className : node.className?.baseVal || "";
    return `${className} ${node.id || ""}`.toLowerCase().split(/[^a-z0-9]+/).some(token => NOISE.has(token));
  }
  // True when `el` or an ancestor below `stop` is something that is not body text.
  function blocked(el, stop, doc) {
    const own = globalThis.LakomicsContextModel?.ownSelector;
    for (let node = el; node && node !== stop && node.nodeType === 1; node = node.parentElement) {
      if (node.matches(HARD) || (own && node.matches(own)) || noisy(node)) return true;
      if (node.tagName === "HEADER" && node.parentElement === doc.body) return true;
    }
    return false;
  }
  function visible(el, win) {
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function blockText(el) {
    const raw = typeof el.innerText === "string" ? el.innerText : el.textContent;
    return String(raw || "").replace(/[ \t 　]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // Text worth translating: at least two characters with letters, not mostly Korean already.
  function translatable(text) {
    if (text.replace(/\s/g, "").length < 2 || text.length > MAX_BLOCK_CHARS) return false;
    const letters = [...text].filter(char => /\p{L}/u.test(char));
    if (!letters.length) return false;
    return letters.filter(char => /[가-힣ᄀ-ᇿ㄰-㆏]/.test(char)).length / letters.length <= 0.5;
  }
  function proseLength(el) {
    let total = 0;
    for (const node of el.querySelectorAll("p, li, blockquote")) total += (node.textContent || "").trim().length;
    return total;
  }
  function commonAncestor(nodes) {
    let ancestor = nodes[0];
    while (ancestor && !nodes.every(node => ancestor.contains(node))) ancestor = ancestor.parentElement;
    return ancestor;
  }
  // The element that holds the page's own text: article, main, then the best-scoring container.
  function findRoot(doc, win) {
    const articles = [...doc.querySelectorAll("article")].filter(item => !item.parentElement?.closest("article") && visible(item, win) && proseLength(item) >= 200);
    if (articles.length === 1) return articles[0];
    const main = [...doc.querySelectorAll("main, [role='main']")].find(item => visible(item, win) && proseLength(item) >= 120);
    if (main) return main;
    if (articles.length > 1) return commonAncestor(articles);
    const scores = new Map(), decay = [1, 0.5, 0.33];
    for (const node of doc.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, h5, h6")) {
      const text = blockText(node);
      if (text.length < 20 || blocked(node, null, doc)) continue;
      const score = 1 + (text.match(/[,，、。.!?]/g) || []).length + Math.min(3, text.length / 100);
      for (let level = 0, parent = node.parentElement; level < decay.length && parent; level += 1, parent = parent.parentElement) scores.set(parent, (scores.get(parent) || 0) + score * decay[level]);
    }
    let best = null;
    for (const [node, score] of scores) if (!best || score > best.score) best = { node, score };
    return best?.node || doc.body || doc.documentElement;
  }
  // Leaf text blocks in document order.
  function collectBlocks(root, win, doc = root.ownerDocument) {
    const found = [];
    for (const el of root.querySelectorAll(BLOCKS)) {
      if (found.length >= MAX_BLOCKS) break;
      if (el.querySelector(BLOCKS) || blocked(el, root, doc) || !visible(el, win)) continue;
      const text = blockText(el);
      if (translatable(text)) found.push({ el, text, inside: INSIDE.test(el.tagName) });
    }
    return found;
  }

  function create({ doc = document, win = window, send, surfaces, watchSession = () => ({ watch() {}, stop() {} }) } = {}) {
    let job = null, sequence = 0;
    const state = () => (job ? (job.hidden ? "hidden" : "on") : "off");

    function card(j, block) {
      if (!block.card || block.card.closed) block.card = surfaces.inline(block.el, { inside: block.inside });
      block.card.setHidden(j.hidden);
      return block.card;
    }
    function ordered(blocks) {
      const view = win.innerHeight || 0, current = [], below = [], above = [];
      for (const block of blocks) {
        const rect = block.el.getBoundingClientRect();
        (rect.bottom > 0 && rect.top < view ? current : rect.top >= view ? below : above).push(block);
      }
      return [...current, ...below, ...above];
    }
    function label(j) {
      const finished = j.halted || (!j.queue.length && !j.active), processed = j.done + j.failed;
      const count = `${processed}/${j.total}` + (j.failed ? ` · 실패 ${j.failed}` : "");
      const toggle = { label: j.hidden ? "번역 보기" : "원문만 보기", onClick: () => setHidden(!j.hidden) };
      if (j.halted) return { text: j.haltCode === "api_key_missing" ? "API 키가 필요해요" : "번역을 멈췄어요", count, actions: [toggle], finished };
      if (j.hidden) return { text: finished ? "원문 표시 중" : "원문 표시 중 · 번역은 계속돼요", count, actions: [toggle], finished };
      return finished ? { text: "번역 완료", count, actions: [toggle], finished } : { text: "페이지 번역 중…", count, actions: [toggle], finished, pending: true };
    }
    function updateStatus(j) {
      if (j !== job) return;
      const next = label(j);
      if (!j.statusShown) { if (!next.finished) return; j.statusShown = true; win.clearTimeout(j.statusTimer); }
      if (j.status?.closed && !j.statusForced) return;
      if (!j.status || j.status.closed) { j.status = surfaces.status(doc.body); j.statusForced = false; }
      j.status.show(next.text, { pending: next.pending === true, count: next.count, actions: next.actions });
    }

    function takeBatch(j) {
      const batch = []; let chars = 0;
      while (j.queue.length && batch.length < BATCH_ITEMS) {
        const next = j.queue[0];
        if (next.status !== "idle") { j.queue.shift(); continue; }
        if (batch.length && chars + next.text.length > BATCH_CHARS) break;
        batch.push(j.queue.shift()); chars += next.text.length;
      }
      return batch;
    }
    function pump(j) {
      if (j !== job) return;
      if (win.location.href !== j.href) { stop(); return; }
      while (!j.halted && j.active < CONCURRENCY && j.queue.length) {
        const batch = takeBatch(j);
        if (batch.length) dispatch(j, batch);
      }
      updateStatus(j);
    }
    function dispatch(j, batch) {
      j.active += 1;
      for (const block of batch) { block.status = "pending"; j.observer?.unobserve(block.el); }
      void globalThis.LakomicsContextSurfaces.delayed(
        () => send({ type: "translation:page", items: batch.map(block => ({ id: block.id, text: block.text })) }),
        () => { for (const block of batch) if (j === job && block.status === "pending") card(j, block).show("", { pending: true }); },
        { win },
      ).then(result => result, () => ({ ok: false, code: "worker_failed" })).then(result => finish(j, batch, result));
    }
    function fail(j, block) {
      block.status = "fail"; j.failed += 1;
      card(j, block).show("", { error: true, retry: () => retry(j, block) });
    }
    function retry(j, block) {
      if (j !== job || block.status !== "fail") return;
      block.status = "idle"; j.failed -= 1; j.halted = false; j.queue.unshift(block); pump(j);
    }
    function finish(j, batch, result) {
      j.active -= 1;
      if (j !== job) return;
      if (win.location.href !== j.href) { stop(); return; }
      if (!result?.ok || !Array.isArray(result.items)) {
        if (HALTING.has(result?.code)) { j.halted = true; j.haltCode = result.code; }
        for (const block of batch) fail(j, block);
      } else {
        const byId = new Map(result.items.map(item => [item?.id, item]));
        for (const block of batch) {
          const item = byId.get(block.id);
          if (item?.ok === true && typeof item.text === "string" && item.text.trim()) { block.status = "done"; j.done += 1; card(j, block).show(item.text); }
          else if (item?.ok === true && item.text === null) { block.status = "skipped"; j.done += 1; if (block.card && !block.card.closed) block.card.close(); }
          else fail(j, block);
        }
      }
      pump(j);
    }

    function setHidden(value, { forceStatus = false } = {}) {
      const j = job; if (!j) return;
      j.hidden = Boolean(value);
      for (const block of j.blocks) if (block.card && !block.card.closed) block.card.setHidden(j.hidden);
      if (forceStatus) { j.statusShown = true; j.statusForced = true; }
      updateStatus(j);
    }
    function start(context, origin) {
      stop();
      const root = findRoot(doc, win), found = root ? collectBlocks(root, win, doc) : [];
      if (!found.length) { surfaces.toast(origin, context.target).show("번역할 본문을 찾지 못했어요", { error: true }); return; }
      const blocks = found.map((item, index) => ({ ...item, id: String(index), status: "idle", card: null }));
      const j = job = { id: ++sequence, href: win.location.href, blocks, queue: ordered(blocks), active: 0, done: 0, failed: 0, total: blocks.length, hidden: false, halted: false, haltCode: "", status: null, statusShown: false, statusForced: false, statusTimer: 0, observer: null, watcher: null };
      j.watcher = watchSession(); j.watcher.watch(() => { if (job === j) stop(); });
      if (typeof win.IntersectionObserver === "function") {
        const byElement = new Map(blocks.map(block => [block.el, block]));
        j.observer = new win.IntersectionObserver(entries => {
          // What scrolls into view jumps the queue, still in reading order.
          const visibleNow = entries.filter(entry => entry.isIntersecting).map(entry => byElement.get(entry.target)).filter(block => block?.status === "idle");
          if (!visibleNow.length) return;
          visibleNow.sort((a, b) => Number(a.id) - Number(b.id));
          const set = new Set(visibleNow);
          j.queue = [...visibleNow, ...j.queue.filter(block => !set.has(block))];
          pump(j);
        }, { rootMargin: "300px 0px 600px 0px" });
        for (const block of blocks) j.observer.observe(block.el);
      }
      j.statusTimer = win.setTimeout(() => { j.statusShown = true; updateStatus(j); }, 400);
      pump(j);
    }
    function stop() {
      const j = job; if (!j) return; job = null;
      j.watcher?.stop(); j.observer?.disconnect(); win.clearTimeout(j.statusTimer);
      for (const block of j.blocks) block.card?.close();
      j.status?.close(0);
    }
    // The menu item: start, then hide and show the translations.
    function activate(context, origin) {
      if (!job) start(context, origin);
      else setHidden(!job.hidden, { forceStatus: true });
    }
    return { activate, stop, state, destroy: stop, get job() { return job; } };
  }
  globalThis.LakomicsContextPage = { create, findRoot, collectBlocks, translatable, blockText };
})();
