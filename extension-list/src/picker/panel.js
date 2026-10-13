(() => {
  "use strict";
  // The Arca Live picker panel: a docked panel in a closed shadow root. It browses the PC
  // library through the extension's service worker (never a direct page request), collects an
  // ordered selection and hands pictures to the post body one at a time.
  const Model = globalThis.LakomicsPickerModel;
  const SVG = "http://www.w3.org/2000/svg";
  const ICONS = {
    folder: "M3 6h6l2 2h10v11H3z", chevron: "M6 9l6 6 6-6", close: "M6 6l12 12M18 6L6 18", refresh: "M20 11a8 8 0 1 0-2 7M20 3v8h-8",
    expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7", check: "M5 12l4 4L19 6", alert: "M12 8v5M12 17h.01M3 20L12 4l9 16z",
    search: "M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM15.5 15.5L21 21", right: "M9 6l6 6-6 6", left: "M15 6l-6 6 6 6",
    image: "M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M16 7h.01", plug: "M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5",
    character: "M8.5 7.5a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0zM5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1z",
    group: "M10 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM2 20v-.5A4.5 4.5 0 0 1 6.5 15h1a4.5 4.5 0 0 1 4.5 4.5V20zM15 5.2a3 3 0 0 1 0 5.6M16.5 15a4.5 4.5 0 0 1 4.5 4.5V20h-5",
  };
  const MARK = "M2 2h8v2H4v16h14v-6h2v8H2zM8 8h12v4H8z";
  const PANEL_WIDTH = 360, RETRY_MS = 5000, DECODE_CAP_MS = 1500, SKELETON_MS = 300;

  function h(doc, tag, attrs = {}, ...kids) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "style") node.style.cssText = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    node.append(...kids.flat().filter(kid => kid != null && kid !== false));
    return node;
  }
  function icon(doc, name, cls = "ic") {
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", cls); svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS(SVG, "path"); path.setAttribute("d", ICONS[name]); svg.append(path); return svg;
  }
  function markIcon(doc) {
    const svg = doc.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 22 24"); svg.setAttribute("class", "lk-mark"); svg.setAttribute("aria-hidden", "true");
    const path = doc.createElementNS(SVG, "path"); path.setAttribute("d", MARK); path.setAttribute("fill", "currentColor"); svg.append(path); return svg;
  }

  function createPanel({ doc = document, win = window, css = globalThis.LakomicsPickerCss || "", send, storage = null, editor, inserter, detectTheme = () => "light", onOpenChange = () => {}, timers = {} } = {}) {
    const setTimer = timers.set || ((fn, ms) => win.setTimeout(fn, ms)), clearTimer = timers.clear || (id => win.clearTimeout(id));
    const selection = Model.createSelection(), seen = Model.createSeen(), jobs = Model.createJobs();
    const items = new Map(), thumbs = new Map();
    const s = { folders: [], characters: [], folderId: null, scopeKind: null, scopeId: null, include: true, body: "loading", error: null, batch: [], allSeen: false, popover: false, preview: null, notice: null, inserted: new Set(), focus: 0, jobVisible: false, running: false, hasGrid: false, expanded: new Set(), query: "", cursor: 0, settled: false };
    let host = null, root = null, ui = {}, isOpen = false, opening = false, loadToken = 0, retryTimer = null, themeObserver = null, pushed = false, leaveTimer = null;
    const reduced = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const message = async payload => { try { return await send(payload); } catch { return { ok: false, kind: "offline" }; } };
    const announce = text => { if (ui.live) ui.live.textContent = text; };
    // The chosen scope: a folder, or a character or group of the PC library. `folderId` stays the
    // folder's id for a folder scope and is null otherwise.
    const scope = () => (s.scopeKind && s.scopeId ? { kind: s.scopeKind, id: s.scopeId } : null);
    const current = () => Model.findScope(s.folders, s.characters, scope());
    function setScope(kind, id) { s.scopeKind = id ? kind : null; s.scopeId = id || null; s.folderId = kind === "folder" ? id : null; }
    function scopeAncestors() {
      const entry = current();
      if (!entry) return [];
      if (s.scopeKind === "folder") return Model.ancestorIds(s.folders, s.scopeId);
      return [entry.seriesId, ...Model.ancestorIds(s.folders, entry.seriesId), ...(entry.groupId ? [entry.groupId] : [])];
    }

    // ---- persistence ---------------------------------------------------------------------
    async function loadView() {
      try {
        const stored = (await storage?.get([Model.VIEW_KEY]))?.[Model.VIEW_KEY];
        if (stored && typeof stored === "object") {
          const remembered = Model.cleanScope(stored.scope);
          if (remembered && remembered.kind !== "folder") setScope(remembered.kind, remembered.id);
          else setScope("folder", Model.validId(stored.folderId) ? stored.folderId : null);
          s.include = stored.includeDescendants !== false;
        }
      } catch {}
    }
    function saveView() {
      const view = { folderId: s.folderId, includeDescendants: s.include };
      if (s.scopeKind && s.scopeKind !== "folder") view.scope = { kind: s.scopeKind, id: s.scopeId };
      try { void storage?.set({ [Model.VIEW_KEY]: view }); } catch {}
    }

    // ---- thumbnails ----------------------------------------------------------------------
    async function pool(list, size, work) {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => { while (next < list.length) { const item = list[next++]; await work(item); } }));
    }
    async function ensureThumb(item) {
      if (thumbs.has(item.assetId)) return true;
      const reply = await message({ type: "picker:thumb", assetId: item.assetId });
      if (!reply?.ok) return false;
      try { thumbs.set(item.assetId, win.URL.createObjectURL(new win.Blob([Model.fromBase64(reply.base64)], { type: reply.mime }))); return true; } catch { return false; }
    }
    function releaseThumbs(keep) {
      for (const [id, url] of thumbs) if (!keep.has(id)) { try { win.URL.revokeObjectURL(url); } catch {} thumbs.delete(id); }
    }
    const keepIds = () => new Set([...s.batch.map(item => item.assetId), ...selection.ids(), ...jobs.rows().map(row => row.id)]);

    // ---- DOM: build once -----------------------------------------------------------------
    function mount() {
      host = h(doc, "div", { id: "lakomics-arca-picker" });
      host.style.cssText = `all:initial;position:fixed;top:0;right:0;bottom:0;width:${PANEL_WIDTH}px;z-index:2147483646;contain:layout style;`;
      host.dataset.theme = detectTheme(doc);
      root = host.attachShadow({ mode: "closed" });
      if (win.CSSStyleSheet?.prototype.replaceSync) { const sheet = new win.CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; }
      else root.append(h(doc, "style", {}, css));
      ui.path = h(doc, "span", { class: "path" });
      ui.kindIcon = icon(doc, "folder"); shownKind = "folder";
      ui.folderBtn = h(doc, "button", { type: "button", class: "folder", "aria-haspopup": "tree", "aria-expanded": "false", onclick: () => (s.popover ? closePopover() : openPopover()) }, ui.kindIcon, ui.path, icon(doc, "chevron"));
      ui.close = h(doc, "button", { type: "button", class: "cbtn sq", "aria-label": "닫기", onclick: () => close() }, icon(doc, "close"));
      ui.scope = h(doc, "button", { type: "button", class: "scope", role: "switch", "aria-checked": "true", onclick: () => setInclude(!s.include) }, h(doc, "span", { class: "sw" }), h(doc, "span", {}, "하위 폴더 포함"));
      ui.count = h(doc, "span", { class: "cnt" });
      ui.body = h(doc, "div", { class: "body" });
      ui.job = h(doc, "div", { class: "job", hidden: true, "aria-label": "넣기 진행" });
      ui.tray = h(doc, "div", { class: "tray", hidden: true });
      ui.note = h(doc, "div", { class: "note", role: "status", hidden: true });
      ui.other = h(doc, "button", { type: "button", class: "cbtn", "aria-keyshortcuts": "R", onclick: () => refresh() }, icon(doc, "refresh"), "다른 그림", h(doc, "span", { class: "kb", "aria-hidden": "true" }, "R"));
      ui.busy = h(doc, "span", { class: "busy", hidden: true }, "불러오는 중");
      ui.insert = h(doc, "button", { type: "button", class: "btn primary", onclick: () => void insertSelected() }, "본문에 넣기");
      ui.live = h(doc, "div", { class: "sr", "aria-live": "polite", role: "status" });
      const foot = h(doc, "div", { class: "foot" }, ui.other, ui.busy, h(doc, "span", { class: "sp" }), ui.insert);
      ui.lk = h(doc, "div", { class: "lk", role: "complementary", "aria-label": "Lakomics 그림 넣기" },
        h(doc, "div", { class: "lk-head" }, markIcon(doc), ui.folderBtn, ui.close), h(doc, "div", { class: "lk-sub" }, ui.scope, ui.count), ui.body, ui.job, ui.tray, ui.note, foot, ui.live);
      root.append(ui.lk);
      root.addEventListener("keydown", onKey);
      busy = Model.createDelayedBusy({ show: () => { ui.busy.hidden = false; }, hide: () => { ui.busy.hidden = true; }, setTimer, clearTimer });
      skeleton = Model.createDelayedBusy({ delay: SKELETON_MS, minShow: 0, show: () => { if (!s.hasGrid) showSkeleton(); }, hide: () => {}, setTimer, clearTimer });
      doc.documentElement.append(host);
    }
    let busy = null, skeleton = null, shownKind = "folder";

    // ---- rendering of small parts --------------------------------------------------------
    function renderPath() {
      const parts = Model.scopeParts(s.folders, s.characters, scope());
      const kind = s.scopeKind === "character" || s.scopeKind === "group" ? s.scopeKind : "folder";
      if (kind !== shownKind) { const next = icon(doc, kind); ui.kindIcon.replaceWith(next); ui.kindIcon = next; shownKind = kind; }
      ui.path.replaceChildren();
      if (!parts.length) { ui.path.append(h(doc, "span", { class: "none" }, "폴더·캐릭터 선택")); return; }
      if (parts.length > 1) ui.path.append(h(doc, "span", { class: "par" }, parts.slice(0, -1).join(" › ") + " › "));
      ui.path.append(h(doc, "span", { class: "leaf" }, parts[parts.length - 1]));
    }
    function renderScope() {
      ui.scope.setAttribute("aria-checked", String(s.include)); ui.scope.firstChild.classList.toggle("on", s.include);
      // The sub-folder switch only means something for folders; it is hidden (the count keeps its place) otherwise.
      ui.scope.hidden = s.scopeKind === "character" || s.scopeKind === "group";
      const entry = current();
      ui.count.textContent = entry ? Model.formatCount(Model.scopeCount(entry, s.scopeKind, s.include)) + "장" + (s.allSeen ? " · 모두 봄" : "") : "";
    }
    function renderFooter() {
      const count = selection.size;
      ui.insert.textContent = count ? `본문에 넣기 (${count}장)` : "본문에 넣기";
      ui.insert.disabled = !count || s.running || !s.hasGrid;
      ui.other.disabled = !s.scopeId || s.running;
    }
    function renderNotice() {
      ui.note.hidden = !s.notice; ui.note.replaceChildren();
      if (!s.notice) return;
      ui.note.append(icon(doc, "alert"), h(doc, "span", {}, s.notice.text));
      if (s.notice.retry) ui.note.append(h(doc, "button", { type: "button", class: "cbtn", onclick: () => { const retry = s.notice.retry; s.notice = null; renderNotice(); retry(); } }, "다시 시도"));
    }
    function setNotice(text, retry = null) { s.notice = text ? { text, retry } : null; renderNotice(); }
    function renderTray() {
      const showTray = !s.jobVisible && selection.size > 0;
      ui.tray.hidden = !showTray; ui.job.hidden = !s.jobVisible || !jobs.rows().length;
      ui.tray.replaceChildren();
      if (showTray) {
        const strip = h(doc, "div", { class: "strip", role: "list", "aria-label": "선택한 그림" });
        selection.ids().forEach((id, index) => {
          const thumb = thumbs.get(id);
          const cell = h(doc, "div", { class: "t", role: "listitem", tabindex: index === 0 ? "0" : "-1", "data-id": id, "aria-label": `${index + 1}번째 그림`, onclick: event => { if (event.target.closest(".x")) removeFromSelection(id); } },
            thumb ? h(doc, "img", { src: thumb, alt: "" }) : null, h(doc, "span", { class: "num" }, String(index + 1)),
            h(doc, "button", { type: "button", class: "x", "aria-label": "선택 해제", tabindex: "-1" }, icon(doc, "close")));
          strip.append(cell);
        });
        ui.tray.append(strip, h(doc, "button", { type: "button", class: "cbtn", onclick: () => { selection.clear(); afterSelection(); } }, "선택 해제"));
      }
      renderJobs();
    }
    function renderJobs() {
      const rows = jobs.rows();
      ui.job.hidden = !s.jobVisible || !rows.length; ui.job.replaceChildren();
      if (ui.job.hidden) return;
      const counts = jobs.counts();
      const head = h(doc, "div", { class: "slab" }, h(doc, "span", { class: "c" }, `본문에 넣기 ${counts.done}/${counts.total}`), h(doc, "span", { class: "rule" }));
      if (s.running) head.append(h(doc, "button", { type: "button", class: "cbtn", onclick: () => { jobs.stop(); } }, "중지"));
      ui.job.append(head);
      rows.forEach((row, index) => {
        const thumb = thumbs.get(row.id);
        const label = row.state === "ok" ? [icon(doc, "check"), "넣음"] : row.state === "bad" ? ["실패", h(doc, "small", {}, Model.jobReason(row.reason))] : row.state === "up" ? [upShown.has(row.id) ? "올리는 중" : null] : ["대기"];
        const line = h(doc, "div", { class: "jr " + row.state, "data-id": row.id },
          h(doc, "span", { class: "num" + (row.state === "bad" ? " bad" : "") }, String(index + 1)),
          h(doc, "span", { class: "th" }, thumb ? h(doc, "img", { src: thumb, alt: "" }) : null),
          h(doc, "span", { class: "st" }, ...label));
        if (row.state === "bad" && !s.running) line.append(h(doc, "button", { type: "button", class: "cbtn", onclick: () => void insertSelected([row.id], false) }, "다시 시도"));
        ui.job.append(line);
      });
    }
    // "올리는 중" appears only after 400 ms and then stays at least 300 ms, like every busy label.
    const upTimers = new Map(), upShown = new Map();
    function setJobState(id, state, reason, order) {
      if (state === "up") {
        jobs.set(id, "up", ""); clearTimer(upTimers.get(id));
        upTimers.set(id, setTimer(() => { upTimers.delete(id); upShown.set(id, Date.now()); renderJobs(); }, 400));
        renderJobs(); return;
      }
      clearTimer(upTimers.get(id)); upTimers.delete(id);
      const shownAt = upShown.get(id); upShown.delete(id);
      const apply = () => {
        jobs.set(id, state, reason); renderJobs(); decorateTiles();
        if (state === "ok") announce("1장 넣음"); else if (state === "bad") announce(`${order}번 실패`);
      };
      const wait = shownAt ? Math.max(0, 300 - (Date.now() - shownAt)) : 0;
      if (wait) setTimer(apply, wait); else apply();
    }
    function afterSelection() { s.jobVisible = false; renderTray(); renderFooter(); decorateTiles(); }

    // ---- body: skeleton, grid, empty -----------------------------------------------------
    function showSkeleton() { ui.body.replaceChildren(h(doc, "div", { class: "skel", "aria-hidden": "true" }, ...Array.from({ length: 9 }, () => h(doc, "i")))); }
    function showEmpty({ title, hint = "", action = null }) {
      s.hasGrid = false; ui.grid = null;
      const box = h(doc, "div", { class: "empty", role: "status" }, icon(doc, "plug", "ic big"), h(doc, "b", {}, title), hint ? h(doc, "small", {}, hint) : null);
      for (const button of Array.isArray(action) ? action : action ? [action] : []) box.append(h(doc, "button", { type: "button", class: "btn", onclick: button.run }, button.label));
      ui.body.replaceChildren(box); renderFooter();
    }
    function decorate(tile, item, index) {
      const id = item.assetId, number = selection.numberOf(id), state = jobs.get(id);
      tile.classList.toggle("sel", number > 0);
      tile.setAttribute("aria-selected", String(number > 0));
      if (number) tile.setAttribute("aria-description", `${number}번째`); else tile.removeAttribute("aria-description");
      tile.querySelector(".num")?.remove(); tile.querySelector(".done")?.remove();
      if (number) tile.prepend(h(doc, "span", { class: "num" + (state === "bad" ? " bad" : "") }, String(number)));
      if (s.inserted.has(id)) tile.append(h(doc, "span", { class: "done" }, icon(doc, "check"), "넣음"));
    }
    function buildTile(item, index) {
      const id = item.assetId, url = thumbs.get(id);
      const tile = h(doc, "div", { class: "tile", role: "gridcell", tabindex: index === s.focus ? "0" : "-1", "aria-label": `그림 ${index + 1}`, "data-id": id,
        onclick: event => { if (event.target.closest(".pv")) return; toggle(id); }, onfocus: () => { s.focus = index; } },
        url ? h(doc, "img", { src: url, alt: "", draggable: "false" }) : null, h(doc, "span", { class: "chk", "aria-hidden": "true" }),
        h(doc, "button", { type: "button", class: "pv", "aria-label": "크게 보기", tabindex: "-1", onclick: () => openPreview(index) }, icon(doc, "expand")));
      decorate(tile, item, index); return tile;
    }
    function buildGrid(batch) {
      const grid = h(doc, "div", { class: "grid", role: "grid", "aria-multiselectable": "true", "aria-label": "그림 목록" });
      for (let start = 0; start < batch.length; start += 3) grid.append(h(doc, "div", { class: "row", role: "row" }, ...batch.slice(start, start + 3).map((item, offset) => buildTile(item, start + offset))));
      return grid;
    }
    function decorateTiles() { ui.grid?.querySelectorAll(".tile").forEach((tile, index) => { const item = s.batch[index]; if (item) decorate(tile, item, index); }); }
    const tiles = () => Array.from(ui.grid?.querySelectorAll(".tile") || []);
    function focusTile(index, scroll = true) {
      const list = tiles(); if (!list.length) return;
      s.focus = Math.max(0, Math.min(list.length - 1, index));
      list.forEach((tile, i) => tile.setAttribute("tabindex", i === s.focus ? "0" : "-1"));
      list[s.focus].focus({ preventScroll: !scroll });
    }

    // ---- folders -------------------------------------------------------------------------
    async function loadFolders() {
      const reply = await message({ type: "picker:folders" });
      if (!reply?.ok) return reply || { ok: false, kind: "offline" };
      s.folders = reply.entries; s.characters = reply.characters || [];
      if (s.scopeId && !current()) setScope(null, null);
      s.expanded = new Set(scopeAncestors());
      return reply;
    }
    function openPopover() {
      if (s.popover) return; s.popover = true; s.query = ""; s.cursor = 0;
      s.expanded = new Set([...s.expanded, ...scopeAncestors()]);
      ui.folderBtn.setAttribute("aria-expanded", "true");
      ui.searchInput = h(doc, "input", { type: "text", placeholder: "폴더·캐릭터 찾기", "aria-label": "폴더·캐릭터 찾기", autocomplete: "off", spellcheck: "false", oninput: () => { s.query = ui.searchInput.value; s.cursor = 0; renderTree(); }, onkeydown: popoverKey });
      ui.tree = h(doc, "div", { class: "tree", role: "tree", "aria-label": "폴더와 캐릭터" });
      ui.pop = h(doc, "div", { class: "pop", role: "dialog", "aria-label": "폴더·캐릭터 고르기" }, h(doc, "label", { class: "search" }, icon(doc, "search"), ui.searchInput), ui.tree);
      ui.lk.append(ui.pop); renderTree({ reveal: true }); ui.searchInput.focus();
    }
    function closePopover({ refocus = true } = {}) {
      if (!s.popover) return; s.popover = false; ui.pop?.remove(); ui.pop = null;
      ui.folderBtn.setAttribute("aria-expanded", "false"); if (refocus) ui.folderBtn.focus();
    }
    // `reveal`: keyboard moves bring the cursor row into view; a mouse expand/collapse keeps the
    // list where it was (rebuilding the rows would otherwise jump it to the top).
    function renderTree({ reveal = false } = {}) {
      const rows = Model.treeRows(s.folders, s.characters, { expanded: s.expanded, query: s.query });
      s.cursor = Math.max(0, Math.min(rows.length - 1, s.cursor)); s.rows = rows;
      const top = ui.tree.scrollTop;
      ui.tree.replaceChildren();
      if (!rows.length) { ui.tree.append(h(doc, "div", { class: "none" }, s.folders.length ? "찾는 폴더·캐릭터가 없음" : "폴더 없음")); return; }
      rows.forEach((row, index) => {
        if (row.section === "pinned" && (index === 0 || rows[index - 1].section !== "pinned"))
          ui.tree.append(h(doc, "div", { class: "tree-section", role: "presentation" }, "고정"));
        if (index > 0 && rows[index - 1].section === "pinned" && row.section !== "pinned")
          ui.tree.append(h(doc, "div", { class: "tree-section", role: "presentation" }, "폴더"));
        const entry = row.entry, name = entry.name, label = h(doc, "span", { class: "nmt" });
        if (row.match) label.append(name.slice(0, row.match[0]), h(doc, "mark", {}, name.slice(row.match[0], row.match[1])), name.slice(row.match[1])); else label.append(name);
        const mine = row.kind === s.scopeKind && entry.id === s.scopeId;
        const count = row.kind === "folder" ? entry.imageCountWithDescendants : entry.imageCount;
        const line = h(doc, "div", { class: "trow " + row.kind + (mine ? " me" : "") + (index === s.cursor ? " kf" : "") + (row.ancestorOnly ? " anc" : ""), role: "treeitem", "aria-level": String(row.depth + 1), "aria-selected": String(mine), "aria-expanded": row.hasChildren ? String(row.open) : null, "data-id": entry.id, "data-kind": row.kind, "data-section": row.section || "tree", style: `padding-left:${8 + row.depth * 16}px`, onclick: event => { if (event.target.closest(".tw")) return; chooseScope(row.kind, entry.id); } },
          row.hasChildren ? h(doc, "button", { type: "button", class: "tw", tabindex: "-1", "aria-label": row.open ? "접기" : "펼치기", onclick: () => toggleBranch(entry.id) }, icon(doc, row.open ? "chevron" : "right")) : h(doc, "span", { class: "tw" }),
          icon(doc, row.kind, "ic ki"),
          h(doc, "span", { class: "nm" + (row.secondary ? " two" : "") }, label, row.secondary ? h(doc, "small", { class: "sec" }, row.secondary) : null),
          h(doc, "span", { class: "n" }, Model.formatCount(count)), mine ? h(doc, "span", { class: "cur", "aria-hidden": "true" }) : null);
        ui.tree.append(line);
      });
      ui.tree.scrollTop = top;
      if (reveal) ui.tree.querySelector(".kf")?.scrollIntoView?.({ block: "nearest" });
    }
    function toggleBranch(id) {
      if (s.expanded.has(id)) s.expanded.delete(id); else s.expanded.add(id);
      const index = (s.rows || []).findIndex(row => row.section !== "pinned" && row.entry.id === id);
      if (index >= 0) s.cursor = index;
      renderTree();
    }
    function popoverKey(event) {
      const rows = s.rows || [], row = rows[s.cursor];
      const stop = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.key === "ArrowDown") { stop(); s.cursor = Math.min(rows.length - 1, s.cursor + 1); renderTree({ reveal: true }); }
      else if (event.key === "ArrowUp") { stop(); s.cursor = Math.max(0, s.cursor - 1); renderTree({ reveal: true }); }
      else if (event.key === "ArrowRight" && row?.hasChildren && !row.open && !s.query) { stop(); s.expanded.add(row.entry.id); renderTree({ reveal: true }); }
      else if (event.key === "ArrowLeft" && row && !s.query) {
        stop();
        if (row.open) { s.expanded.delete(row.entry.id); renderTree({ reveal: true }); return; }
        const parent = row.kind === "folder" ? (row.entry.parentId ? ["folder", row.entry.parentId] : null)
          : row.kind === "group" || !rows.some(r => r.kind === "group" && r.entry.id === row.entry.groupId) ? ["folder", row.entry.seriesId] : ["group", row.entry.groupId];
        if (parent) { s.cursor = Math.max(0, rows.findIndex(r => r.section !== "pinned" && r.kind === parent[0] && r.entry.id === parent[1])); renderTree({ reveal: true }); }
      }
      else if (event.key === "Enter" && row) { stop(); chooseScope(row.kind, row.entry.id); }
      else if (event.key !== "Escape") event.stopPropagation();
    }
    async function chooseScope(kind, id) {
      closePopover({ refocus: false });
      setScope(kind, id); s.allSeen = false; saveView(); renderPath(); renderScope();
      await loadBatch({ initial: !s.hasGrid });
    }
    async function setInclude(value) {
      if (s.include === value) return;
      s.include = value; saveView(); renderScope();
      if (s.scopeKind === "folder") await loadBatch({ initial: !s.hasGrid });
    }

    // ---- batches (no flash: the old grid stays until the new one is ready) ----------------
    async function decodeAll(images) {
      const waits = images.filter(img => typeof img.decode === "function").map(img => img.decode().catch(() => {}));
      if (!waits.length) return;
      await Promise.race([Promise.all(waits), new Promise(resolve => setTimer(resolve, DECODE_CAP_MS))]);
    }
    function failure(kind) {
      s.error = kind;
      if (kind === "folderGone" || kind === "scopeGone") {
        // The remembered folder, character or group no longer exists on the PC: choose again.
        const folder = s.scopeKind === "folder";
        setScope(null, null); s.hasGrid = false; ui.grid = null; saveView(); renderPath(); renderScope();
        showEmpty({ title: "폴더를 골라 주세요", hint: folder ? "이 폴더는 PC에서 없어졌습니다" : "이 캐릭터·그룹은 PC에서 없어졌거나 꺼져 있습니다" }); openPopover(); return;
      }
      if (s.hasGrid) { setNotice("그림을 불러오지 못함", () => void refresh()); return; }
      s.body = "error";
      const info = Model.stateFor(kind);
      showEmpty({ title: info.title, hint: info.hint, action: info.action === "settings" ? { label: "연결 설정", run: () => void message({ type: "picker:settings" }) } : { label: "다시 시도", run: () => void start() } });
      scheduleRetry(kind);
    }
    function scheduleRetry(kind) {
      clearTimer(retryTimer); retryTimer = null;
      if (!isOpen || ["unpaired", "forbidden"].includes(kind)) return;
      retryTimer = setTimer(() => { retryTimer = null; if (isOpen && s.body === "error" && !s.hasGrid) void start({ silent: true }); }, RETRY_MS);
    }
    async function loadBatch({ initial = false } = {}) {
      if (!s.scopeId) return;
      const token = ++loadToken, target = Model.batchTarget(scope(), s.include);
      if (ui.grid) ui.grid.inert = true;
      busy.begin(); if (initial) skeleton.begin(); setNotice("");
      try {
        const ask = exclude => message({ type: "picker:batch", ...target, exclude, limit: Model.BATCH });
        const first = await ask(seen.exclude());
        if (token !== loadToken) return;
        if (!first.ok) { failure(first.kind); return; }
        let list = first.items, filled = false;
        if (list.length < Model.BATCH && seen.size > 0) {
          const second = await ask(seen.fillExclude(list.map(item => item.assetId), Model.BATCH - list.length));
          if (token !== loadToken) return;
          if (second.ok) { const have = new Set(list.map(item => item.assetId)); list = list.concat(second.items.filter(item => !have.has(item.assetId))).slice(0, Model.BATCH); filled = true; }
        }
        for (const item of list) items.set(item.assetId, item);
        await pool(list, 6, ensureThumb);
        if (token !== loadToken) return;
        const grid = buildGrid(list);
        await decodeAll(Array.from(grid.querySelectorAll("img")));
        if (token !== loadToken) return;
        seen.add(list.map(item => item.assetId));
        s.error = null; s.batch = list; s.allSeen = filled; s.focus = 0; s.body = list.length ? "ready" : "empty";
        if (list.length) { s.hasGrid = true; ui.grid = grid; ui.body.replaceChildren(grid); }
        else emptyFolder();
        releaseThumbs(keepIds());
        renderScope(); renderTray(); renderFooter();
      } finally {
        if (token === loadToken) { busy.end(); skeleton.end(); if (ui.grid) ui.grid.inert = false; }
      }
    }
    function emptyFolder() {
      const entry = current(), extra = entry && s.scopeKind === "folder" ? entry.imageCountWithDescendants - entry.imageCount : 0;
      s.hasGrid = false; ui.grid = null;
      if (s.scopeKind !== "folder") { showEmpty({ title: s.scopeKind === "group" ? "이 그룹에 그림 없음" : "이 캐릭터에 그림 없음" }); return; }
      const action = !s.include && extra > 0 ? { label: "하위 폴더 포함", run: () => void setInclude(true) } : null;
      showEmpty({ title: "이 폴더에 그림 없음", hint: action ? `하위 폴더에 ${Model.formatCount(extra)}장` : "", action });
    }
    async function refresh() { if (!s.scopeId || s.running) return; await loadBatch({ initial: !s.hasGrid }); if (s.hasGrid) focusTile(0, false); }
    async function start({ silent = false } = {}) {
      if (!silent) { s.body = "loading"; if (!s.hasGrid) { skeleton.begin(); } }
      const folders = await loadFolders();
      skeleton.end();
      if (!folders.ok) { failure(folders.kind); return; }
      if (!isOpen) return;
      renderPath(); renderScope();
      if (!s.scopeId) { s.body = "empty"; showEmpty({ title: "폴더를 골라 주세요", hint: "위의 폴더 버튼에서 그림을 가져올 폴더나 캐릭터를 고르세요" }); openPopover(); return; }
      await loadBatch({ initial: !s.hasGrid });
      if (!silent && isOpen && s.hasGrid && !s.popover) focusTile(0, false);
    }

    // ---- selection -----------------------------------------------------------------------
    function toggle(id) { selection.toggle(id); afterSelection(); announce(selection.has(id) ? `${selection.numberOf(id)}번 선택` : "선택 해제"); }
    function removeFromSelection(id) { selection.remove(id); afterSelection(); }

    // ---- insertion -----------------------------------------------------------------------
    async function insertSelected(ids = selection.ids(), reset = true) {
      if (s.running || !ids.length) return;
      if (!editor.available()) { setNotice("본문 편집기를 찾지 못함", () => void insertSelected(ids, reset)); return; }
      setNotice("");
      if (reset) jobs.start(ids); else for (const id of ids) jobs.set(id, "wait");
      s.running = true; s.jobVisible = true; renderTray(); renderFooter();
      const runner = globalThis.LakomicsPickerInsert.createJobRunner({
        inserter, shouldStop: () => jobs.stopped, ...(timers.pause ? { pause: timers.pause } : {}),
        fetchOriginal: async id => { const reply = await message({ type: "picker:original", assetId: id }); return reply.ok ? { ok: true, mime: reply.mime, bytes: Model.fromBase64(reply.base64) } : { ok: false, kind: reply.kind || "offline" }; },
        onState: (id, state, reason) => setJobState(id, state, reason, ids.indexOf(id) + 1),
      });
      let outcome = [];
      try { outcome = await runner.run(ids); } finally { s.running = false; }
      for (const result of outcome) if (result.ok) { selection.remove(result.id); s.inserted.add(result.id); }
      if (outcome.length && outcome.every(result => result.ok) && outcome.length === ids.length) announce("모두 넣음");
      renderTray(); renderFooter(); decorateTiles();
      if (isOpen && doc.activeElement === host) (ui.insert.disabled ? ui.other : ui.insert).focus?.();
    }

    // ---- preview -------------------------------------------------------------------------
    function openPreview(index) {
      const item = s.batch[index]; if (!item) return;
      closePreview({ refocus: false });
      s.preview = index;
      const id = item.assetId, number = selection.numberOf(id);
      const selBtn = h(doc, "button", { type: "button", class: "selbtn", onclick: () => { toggle(id); openPreview(s.preview); } }, number ? h(doc, "span", { class: "num" }, String(number)) : h(doc, "span", { class: "box" }), number ? "선택됨" : "선택");
      ui.prev = h(doc, "div", { class: "prev", role: "dialog", "aria-label": "크게 보기" },
        h(doc, "div", { class: "ph" }, h(doc, "span", { class: "pos" }, `${index + 1} / ${s.batch.length}`), h(doc, "span", { class: "sp" }), selBtn, h(doc, "button", { type: "button", class: "cbtn sq", "aria-label": "닫기", onclick: () => closePreview() }, icon(doc, "close"))),
        h(doc, "div", { class: "stage" }, thumbs.get(id) ? h(doc, "img", { src: thumbs.get(id), alt: "" }) : null,
          index > 0 ? h(doc, "button", { type: "button", class: "pnav l", "aria-label": "이전", onclick: () => openPreview(index - 1) }, icon(doc, "left")) : null,
          index < s.batch.length - 1 ? h(doc, "button", { type: "button", class: "pnav r", "aria-label": "다음", onclick: () => openPreview(index + 1) }, icon(doc, "right")) : null),
        h(doc, "div", { class: "pf" }, `${Model.formatCount(item.width)}×${Model.formatCount(item.height)} · ${Model.formatBytes(item.byteSize)}`));
      root.append(ui.prev); selBtn.focus();
    }
    function closePreview({ refocus = true } = {}) {
      if (s.preview == null) return;
      const index = s.preview; s.preview = null; ui.prev?.remove(); ui.prev = null;
      if (refocus) focusTile(index);
    }

    // ---- keyboard ------------------------------------------------------------------------
    function onKey(event) {
      const stop = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.key === "Escape") { stop(); if (s.popover) closePopover(); else if (s.preview != null) closePreview(); else close(); return; }
      if (s.popover) return;
      const target = event.composedPath?.()[0] || event.target;
      if (s.preview != null) {
        if (event.key === "ArrowLeft" && s.preview > 0) { stop(); openPreview(s.preview - 1); }
        else if (event.key === "ArrowRight" && s.preview < s.batch.length - 1) { stop(); openPreview(s.preview + 1); }
        else if (event.key === " " && !target.closest?.("button")) { stop(); const item = s.batch[s.preview]; if (item) { toggle(item.assetId); openPreview(s.preview); } }
        return;
      }
      const tile = target.closest?.(".tile");
      if (tile) {
        const index = tiles().indexOf(tile), action = Model.gridKey(event, { index, count: s.batch.length });
        if (!action) return;
        stop();
        if (action.type === "move") focusTile(action.index);
        else if (action.type === "toggle") toggle(s.batch[index].assetId);
        else if (action.type === "insert") void insertSelected();
        else if (action.type === "preview") openPreview(index);
        else if (action.type === "refresh") void refresh();
        return;
      }
      const cell = target.closest?.(".tray .t");
      if (cell) {
        const cells = Array.from(ui.tray.querySelectorAll(".t")), index = cells.indexOf(cell), action = Model.trayKey(event, { index, count: cells.length });
        if (!action) return;
        stop();
        if (action.type === "move") { cells.forEach((c, i) => c.setAttribute("tabindex", i === action.index ? "0" : "-1")); cells[action.index].focus(); }
        else if (action.type === "remove") { removeFromSelection(cell.dataset.id); const next = ui.tray.querySelectorAll(".t"); next[Math.min(index, next.length - 1)]?.focus(); }
      }
    }

    // ---- open / close --------------------------------------------------------------------
    function place() {
      const form = doc.querySelector("form#article_write_form"), wide = win.innerWidth >= 1024;
      const free = form ? win.innerWidth - form.getBoundingClientRect().right : 0;
      pushed = wide && form != null && free < PANEL_WIDTH + 16;
      doc.documentElement.classList.toggle("lakomics-arca-picker-push", pushed);
    }
    function unplace() { doc.documentElement.classList.remove("lakomics-arca-picker-push"); pushed = false; }
    function syncTheme() { if (host) host.dataset.theme = detectTheme(doc); }
    function onSelectionChange() { if (isOpen) editor.remember(); }
    async function open() {
      if (isOpen || opening) return;
      opening = true;
      editor.remember();
      try { if (!host) { await loadView(); mount(); } } finally { opening = false; }
      clearTimer(leaveTimer); leaveTimer = null;
      isOpen = true; host.style.display = ""; ui.lk.classList.remove("leaving"); syncTheme(); place();
      doc.addEventListener("selectionchange", onSelectionChange);
      themeObserver = new win.MutationObserver(syncTheme);
      for (const node of [doc.documentElement, doc.body]) if (node) themeObserver.observe(node, { attributes: true, attributeFilter: ["class"], subtree: node === doc.body });
      if (!editor.available()) setNotice("본문 편집기를 찾지 못함", () => { if (editor.available()) setNotice(""); else setNotice("본문 편집기를 찾지 못함"); });
      onOpenChange(true);
      renderPath(); renderScope(); renderTray(); renderFooter();
      if (s.hasGrid) focusTile(s.focus, false); else await start();
    }
    function close() {
      if (!isOpen) return;
      isOpen = false; closePopover({ refocus: false }); closePreview({ refocus: false });
      clearTimer(retryTimer); retryTimer = null;
      doc.removeEventListener("selectionchange", onSelectionChange); themeObserver?.disconnect(); themeObserver = null;
      ui.lk.classList.add("leaving");
      const finish = () => { leaveTimer = null; if (!isOpen && host) host.style.display = "none"; };
      if (reduced()) finish(); else leaveTimer = setTimer(finish, 140);
      unplace(); onOpenChange(false);
      editor.restore();
    }
    function toggleOpen() { return isOpen ? close() : open(); }
    function destroy() {
      isOpen = false; clearTimer(retryTimer); clearTimer(leaveTimer); themeObserver?.disconnect();
      doc.removeEventListener("selectionchange", onSelectionChange); unplace(); host?.remove(); host = null;
      for (const url of thumbs.values()) { try { win.URL.revokeObjectURL(url); } catch {} }
      thumbs.clear();
    }

    return {
      open, close, toggle: toggleOpen, destroy, refresh, insert: insertSelected, selection, seen, jobs, state: s,
      get isOpen() { return isOpen; }, get root() { return root; }, get host() { return host; },
    };
  }

  globalThis.LakomicsPickerPanel = { createPanel, h, icon };
})();
