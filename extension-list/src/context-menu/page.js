(() => {
  "use strict";
  // 페이지 번역 (Google 번역처럼 제자리 번역): every visible text of the page is swapped for Korean
  // in place, block by block (sentence context) and text node by text node (links and inline
  // markup stay). What is on screen goes first, then the content below as the user scrolls;
  // later additions (comments, "load more", SPA routes) are picked up by a MutationObserver.
  // The old "show under the original" mode (pageMode "below") is kept as a setting.
  const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, figcaption, dd";
  const SKIP = "script, style, noscript, template, svg, math, canvas, iframe, object, embed, pre, code, kbd, samp, textarea, input, select, option, datalist, head, title, "
    + "[contenteditable]:not([contenteditable='false']), [translate='no'], .notranslate, .lakomics-translation, .lakomics-translation-toggle, #lakomics-translation-controls";
  // "Under the original" cards stay on body text; menus, buttons and forms cannot hold a card.
  const CARD_SKIP = "nav, aside, footer, form, button, menu, dialog, [role='navigation'], [role='complementary'], [role='contentinfo'], [role='search'], [role='banner'], [role='dialog'], [role='button'], [role='menu']";
  const INLINE = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "data", "dfn", "em", "font", "i", "ins", "del", "kbd", "label", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "big", "tt", "strike", "nobr"]);
  const INSIDE = /^(?:LI|TD|DD)$/;
  const HALTING = new Set(["api_key_missing", "http_401", "http_402", "http_403", "disabled"]);
  const MAX_CHARS = 3000, MAX_NODES = 24, MAX_CARD_CHARS = 4000;
  const BATCH_ITEMS = 8, BATCH_CHARS = 3000, CONCURRENCY = 3, READY_MAX = 80;
  const FIRST_LIMIT = 800, LIMIT_STEP = 400, MEMORY_MAX = 3000, MAX_CHURN = 3;
  const DEBOUNCE_MS = 300, SCROLL_MS = 120, HOVER_MS = 400, PRESS_MS = 450, FADE_MS = 110;
  const LETTER = /\p{L}/u, HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
  const LOOSE = /^\s*(?:https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+)\s*$/i;

  // Text worth translating: two characters with letters, not mostly Korean already, not a bare address.
  function translatable(text) {
    if (text.replace(/\s/g, "").length < 2 || LOOSE.test(text)) return false;
    const letters = [...text].filter(char => LETTER.test(char));
    if (!letters.length) return false;
    return letters.filter(char => HANGUL.test(char)).length / letters.length <= 0.5;
  }
  function blockText(el) {
    const raw = typeof el.innerText === "string" ? el.innerText : el.textContent;
    return String(raw || "").replace(/[ \t 　]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // Markers: a block with several text nodes is sent as ⟦1⟧first⟦/1⟧ ⟦2⟧second⟦/2⟧ so the answer
  // can be written back node by node. All markers must come back once, in order, with nothing
  // but whitespace outside them; otherwise the block is written as one piece (see flatten).
  function parseMarked(text, count) {
    const pair = /⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧/g, out = [];
    let next = 1, match;
    while ((match = pair.exec(text))) {
      if (Number(match[1]) !== next) return null;
      const value = match[2].trim();
      if (!value || /[⟦⟧]/.test(value)) return null;
      out.push(value); next += 1;
    }
    if (out.length !== count || text.replace(pair, "").trim()) return null;
    return out;
  }

  function create({ doc = document, win = window, send, surfaces, collector = {}, settings = () => ({}), watchSession = () => ({ watch() {}, stop() {} }) } = {}) {
    // Source text -> Korean (null: needs none). Survives toggling and re-visits within the page.
    const memory = new Map();
    let job = null, sequence = 0;
    const state = () => (job ? (job.hidden ? "hidden" : "on") : "off");
    const own = () => globalThis.LakomicsContextModel?.ownSelector || "";
    const remember = (text, value) => { if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value); memory.set(text, value); };

    // ------------------------------------------------------------------ scanning
    function styleOf(el) { try { return win.getComputedStyle(el); } catch { return null; } }
    function inlineEl(el) {
      const display = styleOf(el)?.display || "";
      return display === "inline" || display === "contents" || (!display && INLINE.has(el.localName));
    }
    // The block container whose run of text `el` belongs to.
    function containerOf(el) {
      while (el.parentElement && inlineEl(el)) el = el.parentElement;
      return el;
    }
    // False when the element or an ancestor is not page text (code, fields, hidden, our own UI).
    function usable(el, cards = false) {
      const ours = own();
      for (let node = el; node && node.nodeType === 1; node = node.parentElement || node.getRootNode?.().host) {
        if (node.matches(SKIP) || (ours && node.matches(ours)) || (cards && node.matches(CARD_SKIP))) return false;
        const style = styleOf(node);
        if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")) return false;
      }
      return true;
    }
    function scanRuns(j, root) {
      const runs = [], ours = own();
      const enter = el => { const run = { el, nodes: [], sep: [], pendingBreak: false, gap: false, pre: /^pre/.test(styleOf(el)?.whiteSpace || "") }; runs.push(run); return run; };
      const walk = (parent, run) => {
        // Links or buttons that follow each other with no text between them are separate
        // labels (a menu), not parts of one sentence.
        let afterLink = false;
        for (let child = parent.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === 3) {
            const data = child.data, known = j.info.get(child);
            if (/\S/.test(data)) afterLink = false;
            if (!data || !LETTER.test(data) || (known && known.ours === data)) { if (data && /\s/.test(data)) run.gap = true; continue; }
            run.nodes.push(child); run.sep.push(run.pendingBreak ? "\n" : run.gap ? " " : ""); run.pendingBreak = false; run.gap = false;
            continue;
          }
          if (child.nodeType !== 1 || child.matches(SKIP) || (ours && child.matches(ours))) continue;
          const style = styleOf(child);
          if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")) continue;
          if (child.localName === "br") { run.pendingBreak = true; continue; }
          const link = child.localName === "a" || child.localName === "button";
          if (link && afterLink) run = enter(run.el);
          afterLink = link;
          if (child.shadowRoot) { observeRoot(j, child.shadowRoot); walk(child.shadowRoot, enter(child)); }
          const display = style?.display || "";
          if (display === "inline" || display === "contents" || (!display && INLINE.has(child.localName))) walk(child, run);
          else walk(child, enter(child));
        }
      };
      walk(root, enter(root));
      return runs;
    }
    function partsOf(node, pre) {
      const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.data);
      const core = match[2].replace(/[⟦⟧]/g, "");
      return { lead: match[1], core: pre ? core : core.replace(/\s+/g, " "), trail: match[3] };
    }
    function joined(unit, mark) {
      let out = "";
      unit.nodes.forEach((_, index) => {
        if (index) out += unit.sep[index] || (unit.parts[index].lead || unit.parts[index - 1].trail ? " " : "");
        out += mark ? `⟦${index + 1}⟧${unit.parts[index].core}⟦/${index + 1}⟧` : unit.parts[index].core;
      });
      return out;
    }
    function unitsOf(j, run) {
      const groups = []; let current = null, chars = 0;
      run.nodes.forEach((node, index) => {
        const length = node.data.length;
        if (length > MAX_CHARS) { j.info.set(node, { original: node.data, ours: node.data, skip: true }); return; }
        if (!current || current.nodes.length >= MAX_NODES || chars + length > MAX_CHARS) { current = { nodes: [], sep: [] }; groups.push(current); chars = 0; }
        current.sep.push(current.nodes.length ? run.sep[index] : ""); current.nodes.push(node); chars += length;
      });
      const units = [];
      for (const group of groups) {
        const unit = { el: run.el, nodes: group.nodes, sep: group.sep, parts: group.nodes.map(node => partsOf(node, run.pre)), status: "idle", seq: ++j.seq, mode: "", text: "", korean: null, shown: false };
        unit.mode = unit.nodes.length > 1 ? "marked" : "plain";
        unit.text = joined(unit, unit.mode === "marked");
        if (!translatable(joined(unit, false))) { for (const node of group.nodes) j.info.set(node, { original: node.data, ours: node.data, skip: true }); continue; }
        units.push(unit);
      }
      return units;
    }
    function discoverCards(j, root) {
      const scope = root.nodeType === 1 ? root : doc.body, found = [];
      const candidates = [...scope.querySelectorAll(BLOCKS)];
      if (scope.matches?.(BLOCKS)) candidates.unshift(scope);
      for (const el of candidates) {
        if (j.elUnits.get(el)?.length || el.querySelector(BLOCKS) || !usable(el, true)) continue;
        const text = blockText(el);
        if (!translatable(text) || text.length > MAX_CARD_CHARS) continue;
        found.push({ el, nodes: [], sep: [], parts: [], status: "idle", seq: ++j.seq, mode: "card", text, korean: null, shown: false, inside: INSIDE.test(el.tagName), card: null });
      }
      return found;
    }
    function add(j, unit) {
      j.units.add(unit); j.idle.add(unit);
      const list = j.elUnits.get(unit.el); if (list) list.push(unit); else j.elUnits.set(unit.el, [unit]);
      for (const node of unit.nodes) j.info.set(node, { original: node.data, ours: node.data, unit });
    }
    // Finds untranslated text under `root`; returns how many units were added.
    function discover(j, root) {
      let added = 0;
      const units = j.mode === "below" ? discoverCards(j, root) : (usable(root) ? scanRuns(j, root).flatMap(run => unitsOf(j, run)) : []);
      for (const unit of units) { add(j, unit); added += 1; }
      return added;
    }
    // Open shadow roots are walked too and need an observer of their own.
    function observeRoot(j, root) {
      if (j.observed.has(root)) return;
      j.observed.add(root);
      if (j.mo) observeOptions(j, root);
    }
    function observeOptions(j, root) {
      j.mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "aria-expanded"] });
    }

    // ------------------------------------------------------------------ writing
    function reduced() { return Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches); }
    // A subtle per-block fade, started once the writes of this moment are done (one layout read
    // for all of them); skipped for big containers and reduced motion.
    function fade(j, unit) {
      if (typeof unit.el.animate !== "function" || j.fades.has(unit.el)) return;
      j.fades.add(unit.el);
      if (j.fadeQueued) return;
      j.fadeQueued = true;
      void Promise.resolve().then(() => {
        j.fadeQueued = false;
        const list = [...j.fades]; j.fades.clear();
        if (j !== job || j.hidden || reduced()) return;
        try {
          const view = win.innerHeight || 800;
          const measured = list.filter(el => el.isConnected && el !== doc.body && el !== doc.documentElement)
            .map(el => ({ el, height: el.getBoundingClientRect().height, opacity: Number.parseFloat(styleOf(el)?.opacity) || 1 }))
            .filter(item => item.height <= view * 0.6);
          for (const { el, opacity } of measured) el.animate([{ opacity: opacity * 0.55 }, { opacity }], { duration: FADE_MS, easing: "ease-out" });
        } catch {}
      });
    }
    function writeUnit(j, unit, animate) {
      if (!unit.korean) return;
      unit.nodes.forEach((node, index) => {
        const info = j.info.get(node);
        if (info?.unit !== unit || node.data !== info.ours || node.data === unit.korean[index]) return;
        info.ours = unit.korean[index]; node.data = unit.korean[index];
      });
      unit.shown = true; j.epoch += 1;
      if (animate) fade(j, unit);
    }
    function restoreUnit(j, unit) {
      for (const node of unit.nodes) {
        const info = j.info.get(node);
        if (info?.unit === unit && node.data === info.ours && node.data !== info.original) { info.ours = info.original; node.data = info.original; }
      }
      unit.shown = false; j.epoch += 1;
    }
    function nodesIntact(j, unit) {
      return unit.nodes.every(node => { const info = j.info.get(node); return node.isConnected && info?.unit === unit && node.data === info.original; });
    }
    // Korean per node, or null when the answer lost its markers.
    function valuesFor(unit, korean) {
      const text = korean.trim();
      if (unit.mode === "marked") {
        const pieces = parseMarked(text, unit.nodes.length);
        return pieces && pieces.map((piece, index) => unit.parts[index].lead + piece + unit.parts[index].trail);
      }
      // One piece: the longest text node holds the translation and the others are emptied.
      let target = 0;
      unit.parts.forEach((part, index) => { if (part.core.length > unit.parts[target].core.length) target = index; });
      return unit.nodes.map((_, index) => index === target ? unit.parts[index].lead + text + unit.parts[index].trail : "");
    }

    // ------------------------------------------------------------------ queue
    function placeOf(unit, view) {
      const rect = unit.el.getBoundingClientRect();
      if (!rect.width && !rect.height && !rect.top && !rect.bottom) {
        return typeof unit.el.checkVisibility === "function" ? null : { group: 1, key: unit.seq };
      }
      if (rect.bottom > 0 && rect.top < view) return { group: 0, key: rect.top };
      if (rect.top >= view && rect.top < view + Math.max(900, view * 1.5)) return { group: 1, key: rect.top };
      if (rect.bottom <= 0 && rect.bottom > -Math.max(300, view * 0.5)) return { group: 2, key: -rect.bottom };
      return null;
    }
    function prune(j) {
      for (const unit of j.units) if (!unit.el.isConnected) { j.units.delete(unit); j.idle.delete(unit); unit.card?.close(); }
    }
    // Picks the idle blocks in or near the viewport, in reading order of importance.
    function refresh(j) {
      if (j !== job) return;
      prune(j);
      if (j.hidden || j.halted) { j.ready = []; return; }
      const view = win.innerHeight || doc.documentElement.clientHeight || 0, sorted = [[], [], []];
      for (const unit of j.idle) {
        if (unit.mode !== "card" && !nodesIntact(j, unit)) { j.idle.delete(unit); j.units.delete(unit); continue; }
        const where = placeOf(unit, view);
        if (where) sorted[where.group].push([where.key, unit.seq, unit]);
      }
      const ordered = sorted.flatMap(list => list.sort((a, b) => a[0] - b[0] || a[1] - b[1])).map(entry => entry[2]);
      const need = [];
      for (const unit of ordered) {
        if (!memory.has(unit.text)) { need.push(unit); continue; }
        j.idle.delete(unit); unit.status = "pending";
        const value = memory.get(unit.text);
        if (value === null) skip(j, unit); else accept(j, unit, value);
      }
      j.ready = need.filter(unit => unit.status === "idle").slice(0, READY_MAX);
    }
    function schedule(j, name, delay, work) {
      if (j[name]) return;
      j[name] = win.setTimeout(() => { j[name] = 0; if (j === job) work(); }, delay);
    }
    function takeBatch(j) {
      const batch = [], texts = new Set(); let chars = 0;
      while (j.ready.length) {
        const unit = j.ready[0];
        if (unit.status !== "idle" || !j.idle.has(unit)) { j.ready.shift(); continue; }
        if (!texts.has(unit.text)) {
          if (texts.size >= BATCH_ITEMS || (texts.size && chars + unit.text.length > BATCH_CHARS)) break;
          if (j.requested + texts.size >= j.limit) { j.capped = true; break; }
          texts.add(unit.text); chars += unit.text.length;
        }
        batch.push(j.ready.shift());
      }
      return { batch, unique: texts.size };
    }
    function pump(j) {
      if (j !== job) return;
      while (!j.halted && !j.hidden && j.active < CONCURRENCY && j.ready.length) {
        const { batch, unique } = takeBatch(j);
        if (!batch.length) break;
        dispatch(j, batch, unique);
      }
      updateStatus(j);
    }
    function dispatch(j, batch, unique) {
      const groups = new Map();
      for (const unit of batch) {
        unit.status = "pending"; j.idle.delete(unit);
        if (groups.has(unit.text)) groups.get(unit.text).push(unit); else groups.set(unit.text, [unit]);
      }
      const texts = [...groups.keys()];
      j.active += 1; j.requested += unique;
      // The whole page run (continuations and scrolled-in content included) is one entry of the usage list.
      const request = () => send({ type: "translation:page", items: texts.map((text, index) => ({ id: String(index), text })), job: j.usageJob });
      let pending;
      try {
        pending = j.mode === "below"
          ? globalThis.LakomicsContextSurfaces.delayed(request, () => { for (const unit of batch) if (j === job && unit.status === "pending") cardOf(unit).show("", { pending: true }); }, { win })
          : request();
      } catch (error) { pending = Promise.reject(error); }
      void Promise.resolve(pending).then(result => result, () => ({ ok: false, code: "worker_failed" })).then(result => finish(j, groups, texts, result));
    }
    function finish(j, groups, texts, result) {
      j.active -= 1;
      if (j !== job) return;
      addSpend(j, result?.usage);
      if (!result?.ok || !Array.isArray(result.items)) {
        if (HALTING.has(result?.code)) { j.halted = true; j.haltCode = result.code; }
        for (const units of groups.values()) for (const unit of units) fail(j, unit);
      } else {
        const byId = new Map(result.items.map(item => [item?.id, item]));
        texts.forEach((text, index) => {
          const item = byId.get(String(index)), units = groups.get(text);
          if (item?.ok === true && typeof item.text === "string" && item.text.trim()) { remember(text, item.text.trim()); for (const unit of units) accept(j, unit, item.text); }
          else if (item?.ok === true && item.text === null) { remember(text, null); for (const unit of units) skip(j, unit); }
          else if (item?.code === "invalid_markers") for (const unit of units) flatten(j, unit);
          else for (const unit of units) fail(j, unit);
        });
      }
      refreshIfDry(j);
      pump(j);
    }
    // What the answers cost so far (the worker sends the usage of each request), for the status line.
    function addSpend(j, usage) {
      if (!usage || !(usage.input || usage.output)) return;
      const spend = j.spend ||= { input: 0, output: 0, costUsd: 0, unknown: 0, requests: 0 };
      for (const field of Object.keys(spend)) if (Number.isFinite(usage[field])) spend[field] += usage[field];
    }
    function spendText(spend) {
      if (!spend) return "";
      if (spend.unknown >= spend.requests) {
        const tokens = spend.input + spend.output;
        return "토큰 " + (tokens < 1000 ? tokens : (tokens / 1000).toFixed(1) + "k");
      }
      return "약 " + (spend.costUsd < 0.0001 ? "<$0.0001" : "$" + spend.costUsd.toFixed(4)) + (spend.unknown ? " 이상" : "");
    }
    function refreshIfDry(j) { if (!j.ready.length) refresh(j); }
    function cardOf(unit) {
      if (!unit.card || unit.card.closed) unit.card = surfaces.inline(unit.el, { inside: unit.inside });
      unit.card.setHidden(job?.hidden === true);
      return unit.card;
    }
    function accept(j, unit, korean) {
      if (unit.mode === "card") { unit.status = "done"; j.done += 1; cardOf(unit).show(korean.trim()); return; }
      if (!nodesIntact(j, unit)) { j.units.delete(unit); unit.status = "stale"; return; }
      const values = valuesFor(unit, korean);
      if (!values) { memory.delete(unit.text); flatten(j, unit); return; }
      unit.korean = values; unit.status = "done"; j.done += 1;
      if (!j.hidden) writeUnit(j, unit, true);
    }
    // The answer lost a marker: ask again for the block as one piece (cheap: cached afterwards).
    function flatten(j, unit) {
      if (unit.mode !== "marked") { fail(j, unit); return; }
      unit.mode = "flat"; unit.text = joined(unit, false); unit.status = "idle"; j.idle.add(unit); j.ready.unshift(unit);
    }
    function skip(j, unit) {
      unit.status = "skipped"; j.done += 1;
      if (unit.mode === "card") unit.card?.close();
    }
    function fail(j, unit) {
      unit.status = "fail"; j.failed += 1;
      if (unit.mode === "card") cardOf(unit).show("", { error: true, retry: () => retry(j, unit) });
    }
    function retry(j, unit) {
      if (j !== job || unit.status !== "fail") return;
      unit.status = "idle"; j.failed -= 1; j.halted = false; j.idle.add(unit); j.ready.unshift(unit); pump(j);
    }
    function retryAll(j) {
      for (const unit of j.units) if (unit.status === "fail") { unit.status = "idle"; j.failed -= 1; j.idle.add(unit); }
      j.halted = false; refresh(j); pump(j);
    }

    // ------------------------------------------------------------------ status
    function label(j) {
      const busy = j.active > 0 || j.ready.length > 0, count = `${j.done}개` + (j.failed ? ` · 실패 ${j.failed}` : "") + (j.spend ? " · " + spendText(j.spend) : "");
      const toggle = { label: j.hidden ? "번역 보기" : "원문만 보기", onClick: () => setHidden(!j.hidden) };
      const actions = [toggle];
      if (j.failed && !j.hidden) actions.unshift({ label: "다시 시도", onClick: () => retryAll(j) });
      if (j.halted) return { text: j.haltCode === "api_key_missing" ? "API 키가 필요해요" : "번역을 멈췄어요", count, actions, finished: true };
      if (j.hidden) return { text: "원문 표시 중", count, actions, finished: true };
      if (j.capped) return { text: "번역 한도에 도달했어요", count, actions: [{ label: "계속 번역", onClick: () => more(j) }, ...actions], finished: true };
      if (busy) return { text: "페이지 번역 중…", count, actions, finished: false, pending: true };
      return { text: j.idle.size ? "번역 완료 · 스크롤하면 이어서 번역해요" : "번역 완료", count, actions, finished: true };
    }
    function more(j) { j.limit += LIMIT_STEP; j.capped = false; refresh(j); pump(j); }
    function updateStatus(j) {
      if (j !== job) return;
      const next = label(j);
      if (next.pending) { if (!j.busySince) j.busySince = Date.now(); } else j.busySince = 0;
      // Busy work shows its label only after ~400 ms so a quick update never blinks.
      if (next.pending && j.status && !j.status.closed && j.finishedShown && Date.now() - j.busySince < 400) {
        win.clearTimeout(j.busyTimer); j.busyTimer = win.setTimeout(() => updateStatus(j), 400 - (Date.now() - j.busySince)); return;
      }
      if (!j.statusShown) { if (!next.finished) return; j.statusShown = true; win.clearTimeout(j.statusTimer); }
      if (j.status?.closed && !j.statusForced) return;
      if (!j.status || j.status.closed) { j.status = surfaces.status(doc.body); j.statusForced = false; }
      j.finishedShown = next.finished;
      j.status.show(next.text, { pending: next.pending === true, count: next.count, actions: next.actions });
    }

    // ------------------------------------------------------------------ dynamic content
    function markDirty(j, node) {
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      if (!el || el === doc.documentElement) return;
      const ours = own();
      if (ours && el.closest?.(ours)) return;
      j.dirty.add(el);
      schedule(j, "flushTimer", DEBOUNCE_MS, () => flush(j));
    }
    function onMutations(j, records) {
      for (const record of records) {
        if (record.type === "childList") { for (const node of record.addedNodes) if (node.nodeType === 1 || node.nodeType === 3) markDirty(j, node); }
        else if (record.type === "attributes") { if (record.target !== doc.body) markDirty(j, record.target); }
        else if (record.type === "characterData") {
          const node = record.target, info = j.info.get(node);
          // Our own write: the node still holds exactly what we put there.
          if (info && node.data === info.ours) continue;
          if (info) {
            // The page replaced text we translated; settle after a few rewrites (tickers, counters).
            const count = (j.churn.get(node) || 0) + 1; j.churn.set(node, count);
            if (count > MAX_CHURN) { j.info.set(node, { original: node.data, ours: node.data, skip: true }); continue; }
            j.info.delete(node);
          }
          markDirty(j, node);
        }
      }
    }
    function flush(j) {
      if (j.hidden) return;
      let roots = [...j.dirty].filter(el => el.isConnected); j.dirty.clear();
      // A storm of changes (animations, big re-renders) is looked at once, from the top.
      if (roots.length > 200) roots = [doc.body || doc.documentElement];
      let added = 0;
      for (const el of roots) {
        if (roots.some(other => other !== el && other.contains(el))) continue;
        if (j.mode === "below") {
          const block = el.closest?.(BLOCKS), list = block && j.elUnits.get(block);
          if (list?.length && blockText(block) !== list[0].text) { for (const unit of list) { unit.card?.close(); j.units.delete(unit); j.idle.delete(unit); } j.elUnits.delete(block); }
          added += discover(j, block || containerOf(el));
        } else added += discover(j, containerOf(el));
      }
      if (added) { refresh(j); pump(j); }
    }
    function onScroll(j) { schedule(j, "refreshTimer", SCROLL_MS, () => { refresh(j); pump(j); }); }

    // ------------------------------------------------------------------ original on demand
    function bindPointer(j) {
      let hoverTimer = 0, pressTimer = 0, hoverUnit = null, point = { x: 0, y: 0 }, start = null, noteUnit = null, quiet = 0;
      const listen = (target, type, fn, options) => { target.addEventListener(type, fn, options); j.listeners.push([target, type, fn, options]); };
      const hideNote = () => { j.note?.close(); j.note = null; noteUnit = null; };
      const cancel = () => { win.clearTimeout(hoverTimer); win.clearTimeout(pressTimer); hoverTimer = pressTimer = 0; hoverUnit = null; start = null; };
      let seen = null;
      const unitFor = target => {
        if (j.hidden || j.mode === "below") return null;
        if (seen && seen.target === target && seen.epoch === j.epoch) return seen.unit;
        const el = target?.nodeType === 1 ? target : target?.parentElement, list = el && doc.contains(el) ? j.elUnits.get(containerOf(el))?.filter(unit => unit.shown) : null;
        const unit = list?.length ? list.find(item => item.nodes.some(node => node.parentElement === el || el.contains(node))) || list[0] : null;
        seen = { target, epoch: j.epoch, unit };
        return unit;
      };
      const originalOf = unit => {
        const text = unit.nodes.map(node => j.info.get(node)?.original ?? "").join(" ").replace(/\s+/g, " ").trim();
        return text.length > 600 ? text.slice(0, 600) + "…" : text;
      };
      const show = (unit, where, touch) => {
        hideNote(); noteUnit = unit;
        j.note = surfaces.note(originalOf(unit), where, unit.el, { touch });
      };
      const far = (a, b, limit) => Math.hypot(a.x - b.x, a.y - b.y) > limit;
      listen(doc, "pointermove", event => {
        const where = { x: event.clientX || 0, y: event.clientY || 0 };
        if (event.pointerType === "touch") { if (start && far(start, where, 10)) { win.clearTimeout(pressTimer); pressTimer = 0; start = null; } return; }
        point = where;
        const unit = unitFor(event.target);
        if (noteUnit) { if (unit !== noteUnit || far(start || where, where, 80)) { hideNote(); start = null; } else return; }
        if (unit === hoverUnit) return;
        win.clearTimeout(hoverTimer); hoverUnit = unit;
        if (unit) hoverTimer = win.setTimeout(() => { hoverTimer = 0; if (j === job && !j.hidden && hoverUnit === unit) { start = { ...point }; show(unit, point, false); } }, HOVER_MS);
      }, { capture: true, passive: true });
      listen(doc, "pointerdown", event => {
        hideNote(); cancel();
        if (event.pointerType !== "touch") return;
        const target = event.composedPath?.()[0] || event.target, unit = unitFor(target);
        // Pictures belong to the collector's own long press; leave them alone.
        if (!unit || collector.findCandidate?.(target)) return;
        start = { x: event.clientX || 0, y: event.clientY || 0 };
        pressTimer = win.setTimeout(() => {
          pressTimer = 0;
          if (j !== job || j.hidden) return;
          quiet = Date.now() + 1200;
          try { win.getSelection?.()?.removeAllRanges?.(); } catch {}
          show(unit, start, true); start = null;
        }, PRESS_MS);
      }, { capture: true, passive: true });
      for (const type of ["pointerup", "pointercancel"]) listen(doc, type, event => { if (event.pointerType === "touch") { win.clearTimeout(pressTimer); pressTimer = 0; start = null; } }, { capture: true, passive: true });
      listen(doc, "scroll", () => { hideNote(); cancel(); }, { capture: true, passive: true });
      listen(doc, "wheel", () => { hideNote(); cancel(); }, { capture: true, passive: true });
      listen(doc, "keydown", () => { hideNote(); cancel(); }, { capture: true, passive: true });
      listen(doc, "contextmenu", event => { if (Date.now() < quiet) event.preventDefault(); }, { capture: true });
      listen(win, "blur", () => { hideNote(); cancel(); });
      j.dismiss = () => { hideNote(); cancel(); };
    }

    // ------------------------------------------------------------------ job
    function setHidden(value, { forceStatus = false } = {}) {
      const j = job; if (!j) return;
      j.hidden = Boolean(value);
      j.dismiss?.();
      for (const unit of j.units) {
        if (unit.mode === "card") { if (unit.card && !unit.card.closed) unit.card.setHidden(j.hidden); }
        else if (j.hidden) restoreUnit(j, unit);
        else if (unit.korean) writeUnit(j, unit, true);
      }
      if (forceStatus) { j.statusShown = true; j.statusForced = true; }
      if (!j.hidden) { flush(j); refresh(j); pump(j); }
      updateStatus(j);
    }
    // Names this run in the usage list: page host and title.
    function usageJobOf() {
      const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      return { id: `page:${random}`, label: [win.location.hostname, doc.title].filter(Boolean).join(" · ").slice(0, 120) };
    }
    function start(context, origin) {
      stop();
      const mode = settings()?.pageMode === "below" ? "below" : "replace";
      const j = job = {
        id: ++sequence, mode, usageJob: usageJobOf(), spend: null, href: win.location.href, info: new WeakMap(), churn: new WeakMap(), elUnits: new WeakMap(), units: new Set(), idle: new Set(), ready: [],
        active: 0, epoch: 0, requested: 0, limit: FIRST_LIMIT, capped: false, done: 0, failed: 0, seq: 0, hidden: false, halted: false, haltCode: "",
        status: null, statusShown: false, statusForced: false, statusTimer: 0, busySince: 0, busyTimer: 0, finishedShown: false,
        flushTimer: 0, refreshTimer: 0, fades: new Set(), fadeQueued: false, dirty: new Set(), observed: new Set(), mo: null, watcher: null, listeners: [], note: null, dismiss: null,
      };
      if (!discover(j, doc.body || doc.documentElement)) {
        job = null;
        surfaces.toast(origin, context.target).show("번역할 본문을 찾지 못했어요", { error: true });
        return;
      }
      const arm = () => {
        j.watcher?.stop(); j.watcher = watchSession();
        j.watcher.watch(() => {
          if (job !== j) return;
          // A route change inside the page keeps translating; leaving the page ends the job.
          if (win.location.href !== j.href) { j.href = win.location.href; arm(); markDirty(j, doc.body); } else stop();
        });
      };
      arm();
      if (typeof win.MutationObserver === "function") {
        j.mo = new win.MutationObserver(records => onMutations(j, records));
        j.observed.add(doc.body || doc.documentElement);
        for (const root of j.observed) observeOptions(j, root);
      }
      for (const type of ["scroll", "resize"]) { const fn = () => onScroll(j); win.addEventListener(type, fn, { capture: true, passive: true }); j.listeners.push([win, type, fn, { capture: true, passive: true }]); }
      // Menus and accordions open without any DOM change we watch; look again after a click.
      const clicked = () => schedule(j, "refreshTimer", 250, () => { refresh(j); pump(j); });
      win.addEventListener("click", clicked, { capture: true, passive: true }); j.listeners.push([win, "click", clicked, { capture: true, passive: true }]);
      bindPointer(j);
      j.statusTimer = win.setTimeout(() => { j.statusShown = true; updateStatus(j); }, 400);
      refresh(j); pump(j);
    }
    function stop() {
      const j = job; if (!j) return; job = null;
      j.watcher?.stop(); j.mo?.disconnect(); j.dismiss?.();
      for (const [target, type, fn, options] of j.listeners) target.removeEventListener(type, fn, options);
      for (const name of ["statusTimer", "flushTimer", "refreshTimer", "busyTimer"]) win.clearTimeout(j[name]);
      for (const unit of j.units) { if (unit.mode === "card") unit.card?.close(); else restoreUnit(j, unit); }
      j.status?.close(0);
    }
    // The menu item: start, then hide and show the translations.
    function activate(context, origin) {
      if (!job) start(context, origin);
      else setHidden(!job.hidden, { forceStatus: true });
    }
    return { activate, stop, state, destroy: stop, get job() { return job; } };
  }
  globalThis.LakomicsContextPage = { create, translatable, blockText, parseMarked };
})();
