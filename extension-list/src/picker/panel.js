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
  const PANEL_WIDTH = 300, MIN_WIDTH = 264, MAX_WIDTH = 480, RAIL_WIDTH = 56, RETRY_MS = 5000, DECODE_CAP_MS = 1500, SKELETON_MS = 300;
  const portrait = win => win.innerWidth < 900 && win.innerHeight > win.innerWidth;
  const sheetHeights = height => [0, 72, Math.round(height * .55), height - 36];
  function snapSheet(height, velocity, viewportHeight) {
    const points = sheetHeights(viewportHeight);
    if (Math.abs(velocity) > .4) return velocity > 0 ? (points.find(point => point > height + 1) ?? points[3]) : ([...points].reverse().find(point => point < height - 1) ?? 0);
    return points.reduce((best, point) => Math.abs(point - height) < Math.abs(best - height) ? point : best);
  }
  const caretScroll = (bottom, height, viewportHeight) => height === viewportHeight - 36 ? 0 : Math.max(0, bottom - (viewportHeight - height - 24));

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
    const thumbs = new Map();
    const s = { panelWidth: PANEL_WIDTH, width: PANEL_WIDTH, columns: 3, folded: false, overlay: false, dragging: false, folders: [], characters: [], folderId: null, scopeKind: null, scopeId: null, include: true, order: "random", nextOffset: null, gridKey: null, batchLoading: false, body: "loading", error: null, batch: [], allSeen: false, popover: false, preview: null, notice: null, inserted: new Set(), focus: 0, jobVisible: false, running: false, hasGrid: false, expanded: new Set(), query: "", cursor: 0, settled: false };
    Object.assign(s, { sheet: false, sheetLevel: "half", sheetHeight: 0, keyboard: false });
    let keyboardRestore = null, keyboardInPanel = false, viewportBaseline = win.innerHeight, viewportWidth = win.innerWidth, sheetDrag = null, suppressClick = false, scrollFrame = null;
    let host = null, root = null, ui = {}, isOpen = false, opening = false, loadToken = 0, retryTimer = null, themeObserver = null, pushed = false, leaveTimer = null, resizeFrame = null, fillFrame = null, filling = false, trayHovered = false, trayTimer = null;
    const reduced = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const message = async payload => { try { return await send(payload); } catch { return { ok: false, kind: "offline" }; } };
    const announce = text => { if (ui.live) ui.live.textContent = text; };
    // The chosen scope: a folder, or a character or group of the PC library. `folderId` stays the
    // folder's id for a folder scope and is null otherwise.
    const scope = () => (s.scopeKind && s.scopeId ? { kind: s.scopeKind, id: s.scopeId } : null);
    const current = () => Model.findScope(s.folders, s.characters, scope());
    let prefetch = null, loadingItems = [];
    const batchKey = () => JSON.stringify([s.scopeKind, s.scopeId, s.include, s.order]);
    function discardPrefetch() { prefetch = null; loadingItems = []; ++loadToken; s.batchLoading = false; busy?.end(); skeleton?.end(); releaseThumbs(keepIds()); }
    function setScope(kind, id) { discardPrefetch(); s.scopeKind = id ? kind : null; s.scopeId = id || null; s.folderId = kind === "folder" ? id : null; }
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
          s.order = stored.order === "newest" ? "newest" : "random";
          s.panelWidth = clampWidth(stored.panelWidth); s.folded = stored.folded === true;
        }
      } catch {}
    }
    function saveView() {
      const view = { folderId: s.folderId, includeDescendants: s.include, order: s.order, panelWidth: s.panelWidth, folded: s.folded };
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
      const reply = typeof item.thumbBase64 === "string" ? { ok: true, base64: item.thumbBase64, mime: item.thumbMime || "image/webp" } : await message({ type: "picker:thumb", assetId: item.assetId });
      if (!reply?.ok) return false;
      if (thumbs.has(item.assetId)) return true;
      try { thumbs.set(item.assetId, win.URL.createObjectURL(new win.Blob([Model.fromBase64(reply.base64)], { type: reply.mime }))); return true; } catch { return false; }
    }
    function releaseThumbs(keep) {
      for (const [id, url] of thumbs) if (!keep.has(id)) { try { win.URL.revokeObjectURL(url); } catch {} thumbs.delete(id); }
    }
    const keepIds = () => new Set([...s.batch.map(item => item.assetId), ...loadingItems.map(item => item.assetId), ...(prefetch?.items || []).map(item => item.assetId), ...selection.ids(), ...jobs.rows().map(row => row.id)]);

    // ---- DOM: build once -----------------------------------------------------------------
    function mount() {
      host = h(doc, "div", { id: "lakomics-arca-picker" });
      host.style.cssText = `position:fixed;top:0;right:0;bottom:0;width:${s.panelWidth}px;z-index:2147483646;contain:layout style;`;
      host.dataset.theme = detectTheme(doc);
      root = host.attachShadow({ mode: "closed" });
      if (win.CSSStyleSheet?.prototype.replaceSync) { const sheet = new win.CSSStyleSheet(); sheet.replaceSync(css); root.adoptedStyleSheets = [sheet]; }
      else root.append(h(doc, "style", {}, css));
      ui.path = h(doc, "span", { class: "path" });
      ui.kindIcon = icon(doc, "folder"); shownKind = "folder";
      ui.folderBtn = h(doc, "button", { type: "button", class: "folder", "aria-haspopup": "tree", "aria-expanded": "false", onclick: () => (s.popover ? closePopover() : openPopover()) }, ui.kindIcon, ui.path, icon(doc, "chevron"));
      ui.fold = h(doc, "button", { type: "button", class: "cbtn sq", "aria-label": "접기", onclick: () => setFolded(true) }, icon(doc, "right"));
      ui.close = h(doc, "button", { type: "button", class: "cbtn sq", "aria-label": "닫기", onclick: () => close() }, icon(doc, "close"));
      ui.scope = h(doc, "button", { type: "button", class: "scope", role: "switch", "aria-checked": "true", onclick: () => setInclude(!s.include) }, h(doc, "span", { class: "sw" }), h(doc, "span", {}, "하위 폴더 포함"));
      ui.order = h(doc, "div", { class: "order", role: "radiogroup", "aria-label": "그림 정렬" },
        ...["random", "newest"].map(order => h(doc, "button", { type: "button", role: "radio", "data-order": order,
          onclick: () => void setOrder(order), onkeydown: event => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const next = s.order === "random" ? "newest" : "random";
            void setOrder(next); ui.order.querySelector(`[data-order="${next}"]`).focus();
          } }, order === "random" ? "랜덤" : "최신순")));
      ui.count = h(doc, "span", { class: "cnt" });
      ui.body = h(doc, "div", { class: "body" });
      ui.job = h(doc, "div", { class: "job", hidden: true, "aria-label": "넣기 진행" });
      ui.tray = h(doc, "div", { class: "tray", hidden: true,
        onpointerenter: () => { trayHovered = true; }, onpointerleave: () => { trayHovered = false; renderTray(); } });
      ui.note = h(doc, "div", { class: "note", role: "status", hidden: true });
      ui.other = h(doc, "button", { type: "button", class: "cbtn", "aria-keyshortcuts": "R", onclick: () => refresh() }, icon(doc, "refresh"), "다른 그림", h(doc, "span", { class: "kb", "aria-hidden": "true" }, "R"));
      ui.busy = h(doc, "span", { class: "busy", hidden: true }, "불러오는 중");
      ui.insert = h(doc, "button", { type: "button", class: "btn primary", onclick: () => void insertSelected() }, "본문에 넣기");
      ui.live = h(doc, "div", { class: "sr", "aria-live": "polite", role: "status" });
      ui.footPicks = h(doc, "div", { class: "foot-picks", "aria-label": "선택한 그림" });
      const foot = h(doc, "div", { class: "foot" }, ui.other, ui.busy, ui.footPicks, h(doc, "span", { class: "sp" }), ui.insert);
      ui.lk = h(doc, "div", { class: "lk", role: "complementary", "aria-label": "Lakomics 그림 넣기" },
        h(doc, "div", { class: "lk-head" }, markIcon(doc), ui.folderBtn, ui.fold, ui.close), h(doc, "div", { class: "lk-sub" }, ui.scope, ui.order, ui.count), ui.body, ui.job, ui.tray, ui.note, foot, ui.live);
      ui.railItems = h(doc, "div", { class: "rail-items", "aria-label": "선택한 그림" });
      ui.railCount = h(doc, "span", { class: "rail-count", "aria-live": "polite" });
      ui.railInsert = h(doc, "button", { type: "button", class: "btn primary", onclick: () => void insertSelected() }, "넣기");
      ui.expand = h(doc, "button", { type: "button", class: "cbtn sq", "aria-label": "펼치기", onclick: () => setFolded(false) }, icon(doc, "left"));
      ui.rail = h(doc, "div", { class: "rail" }, ui.expand, ui.railItems, ui.railCount, ui.railInsert);
      ui.resize = h(doc, "div", { class: "resize", role: "separator", tabindex: "0", "aria-label": "패널 너비", "aria-orientation": "vertical", "aria-valuemin": MIN_WIDTH, "aria-valuemax": MAX_WIDTH,
        ondblclick: () => changeWidth(PANEL_WIDTH, true), onkeydown: event => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation(); changeWidth(s.width + (event.key === "ArrowLeft" ? 16 : -16), true);
        } });
      installResize();
      ui.clip = h(doc, "div", { class: "clip" }, ui.lk, ui.rail);
      ui.dock = h(doc, "div", { class: "dock" }, ui.clip, ui.resize);
      ui.handle = h(doc, "button", { type: "button", class: "sheet-handle", "aria-label": "시트 접기 또는 펼치기", onclick: () => {
        if (!suppressClick) { if (s.folded) expandBar(); else setSheetLevel("bar"); }
      } }, h(doc, "span"));
      ui.scrim = h(doc, "div", { class: "sheet-scrim", onclick: () => setSheetLevel("half") });
      ui.caret = h(doc, "div", { class: "remembered-caret", hidden: true, "aria-hidden": "true" });
      ui.spacer = h(doc, "div", { "aria-hidden": "true", hidden: true });
      doc.body.append(ui.spacer);
      root.append(ui.scrim, ui.dock, ui.caret); ui.dock.append(ui.handle);
      installSheetDrag();
      ui.rail.addEventListener("click", event => { if (s.sheet && !suppressClick && !event.target.closest("button")) expandBar(); });
      ui.railInsert.addEventListener("pointerdown", event => { if (s.sheet) event.preventDefault(); });
      ui.railInsert.addEventListener("mousedown", event => { if (s.sheet) event.preventDefault(); });
      swipeToClose(ui.lk, () => close({ animate: false }));
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
      ui.order.querySelectorAll("button").forEach(button => {
        const selected = button.dataset.order === s.order;
        button.setAttribute("aria-checked", String(selected)); button.tabIndex = selected ? 0 : -1;
      });
      const entry = current();
      ui.count.textContent = entry ? Model.formatCount(Model.scopeCount(entry, s.scopeKind, s.include)) + "장" + (s.order === "newest" ? (s.gridKey === batchKey() && s.nextOffset === null ? " · 끝" : "") : s.allSeen ? " · 모두 봄" : "") : "";
    }
    function renderFooter() {
      const count = selection.size;
      ui.insert.textContent = count ? `본문에 넣기 (${count}장)` : "본문에 넣기";
      ui.insert.disabled = !count || s.running || !s.hasGrid;
      const otherLabel = s.order === "newest" ? "새로고침" : "다른 그림";
      ui.other.setAttribute("aria-label", otherLabel);
      ui.other.replaceChildren(icon(doc, "refresh"), ...(s.sheet && count ? [] : [otherLabel, h(doc, "span", { class: "kb", "aria-hidden": "true" }, "R")]));
      ui.other.classList.toggle("picks-present", s.sheet && count > 0);
      ui.other.disabled = !s.scopeId || s.running;
      renderRail();
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
      renderRail();
      ui.job.hidden = !s.jobVisible || !jobs.rows().length;
      renderJobs();
      if (!showTray && !s.jobVisible && trayHovered) return;
      clearTimer(trayTimer);
      if (showTray) {
        if (ui.tray.hidden) { ui.tray.hidden = false; void ui.tray.offsetHeight; }
        ui.tray.classList.add("visible");
      } else {
        ui.tray.classList.remove("visible");
        if (reduced()) ui.tray.hidden = true;
        else trayTimer = setTimer(() => { ui.tray.hidden = true; }, 140);
        return;
      }
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
        jobs.set(id, state, reason); renderJobs(); renderRail(); decorateTiles();
        if (state === "bad" && s.sheet) setSheetLevel("half");
        else if (state === "bad" && s.folded) setFolded(false, { focus: false });
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
        onclick: event => { if (suppressClick || event.target.closest(".pv")) return; toggle(id); }, onfocus: () => { s.focus = index; } },
        url ? h(doc, "img", { src: url, alt: "", draggable: "false" }) : null, h(doc, "span", { class: "chk", "aria-hidden": "true" }),
        h(doc, "button", { type: "button", class: "pv", "aria-label": "크게 보기", tabindex: "-1", onclick: () => openPreview(index) }, icon(doc, "expand")));
      let press = null, px = 0, py = 0;
      const cancel = () => { clearTimer(press); press = null; };
      tile.addEventListener("pointerdown", event => {
        if (!win.matchMedia?.("(pointer: coarse)").matches || event.target.closest(".pv")) return;
        px = event.clientX; py = event.clientY;
        press = setTimer(() => { suppressClick = true; openPreview(s.batch.findIndex(entry => entry.assetId === id)); }, 400);
      });
      tile.addEventListener("pointermove", event => { if (Math.hypot(event.clientX - px, event.clientY - py) > 8) cancel(); });
      for (const name of ["pointerup", "pointercancel"]) tile.addEventListener(name, () => { cancel(); setTimer(() => { suppressClick = false; }, 0); });
      decorate(tile, item, index); return tile;
    }
    function buildGrid(batch, baseIndex = 0) {
      // The grid is the scroller; in 최신순 nearing its bottom loads the next page.
      const grid = h(doc, "div", { class: "grid", role: "grid", "aria-multiselectable": "true", "aria-label": "그림 목록", onscroll: () => {
        if (s.order !== "newest" || ui.grid !== grid || !grid.clientHeight) return;
        const tile = grid.querySelector(".tile");
        if (grid.scrollHeight - grid.scrollTop - grid.clientHeight <= (tile?.getBoundingClientRect().height || 120)) void loadMore();
      } });
      grid.setAttribute("aria-colcount", s.columns);
      for (let start = 0; start < batch.length; start += s.columns) grid.append(h(doc, "div", { class: "row", role: "row" }, ...batch.slice(start, start + s.columns).map((item, offset) => buildTile(item, baseIndex + start + offset))));
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
      if (s.scopeId && !current()) return { ok: false, kind: s.scopeKind === "folder" ? "folderGone" : "scopeGone" };
      s.expanded = new Set(scopeAncestors());
      return reply;
    }
    function openPopover() {
      if (s.popover) return; s.popover = true; s.query = ""; s.cursor = 0;
      s.expanded = new Set([...s.expanded, ...scopeAncestors()]);
      ui.folderBtn.setAttribute("aria-expanded", "true");
      ui.searchInput = h(doc, "input", { type: "text", placeholder: "폴더·캐릭터 찾기", "aria-label": "폴더·캐릭터 찾기", autocomplete: "off", spellcheck: "false", oninput: () => { s.query = ui.searchInput.value; s.cursor = 0; renderTree({ reveal: true }); } });
      ui.tree = h(doc, "div", { class: "tree", role: "tree", "aria-label": "폴더와 캐릭터" });
      ui.pop = h(doc, "div", { class: "pop", role: "dialog", "aria-label": "폴더·캐릭터 고르기" }, h(doc, "label", { class: "search" }, icon(doc, "search"), ui.searchInput), ui.tree);
      win.addEventListener("keydown", popoverKey, true);
      ui.lk.append(ui.pop); renderTree({ reveal: true }); ui.searchInput.focus();
    }
    function closePopover({ refocus = true } = {}) {
      if (!s.popover) return; s.popover = false; win.removeEventListener("keydown", popoverKey, true); ui.pop?.remove(); ui.pop = null;
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
          row.hasChildren ? h(doc, "button", { type: "button", class: "tw", tabindex: "-1", "aria-label": row.open ? "접기" : "펼치기", onclick: () => toggleBranch(entry.id) }, icon(doc, row.open ? "chevron" : "right")) : s.query.trim() ? null : h(doc, "span", { class: "tw" }),
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
    // Listens on the window in the capture phase so page shortcuts cannot swallow the keys first.
    // During Korean composition the key reads "Process"; arrows still move the result cursor
    // (the IME commits the text itself), other keys are left to the IME.
    function popoverKey(event) {
      if (root.activeElement !== ui.searchInput) return;
      const composing = event.isComposing || event.keyCode === 229;
      const key = composing ? (event.code === "ArrowDown" || event.code === "ArrowUp" ? event.code : null) : event.key;
      if (!key) { event.stopPropagation(); return; }
      const rows = s.rows || [], row = rows[s.cursor];
      const stop = () => { if (!composing) event.preventDefault(); event.stopPropagation(); };
      if (key === "ArrowDown") { stop(); s.cursor = Math.min(rows.length - 1, s.cursor + 1); renderTree({ reveal: true }); }
      else if (key === "ArrowUp") { stop(); s.cursor = Math.max(0, s.cursor - 1); renderTree({ reveal: true }); }
      else if (key === "ArrowRight" && row?.hasChildren && !row.open && !s.query) { stop(); s.expanded.add(row.entry.id); renderTree({ reveal: true }); }
      else if (key === "ArrowLeft" && row && !s.query) {
        stop();
        if (row.open) { s.expanded.delete(row.entry.id); renderTree({ reveal: true }); return; }
        const parent = row.kind === "folder" ? (row.entry.parentId ? ["folder", row.entry.parentId] : null)
          : row.kind === "group" || !rows.some(r => r.kind === "group" && r.entry.id === row.entry.groupId) ? ["folder", row.entry.seriesId] : ["group", row.entry.groupId];
        if (parent) { s.cursor = Math.max(0, rows.findIndex(r => r.section !== "pinned" && r.kind === parent[0] && r.entry.id === parent[1])); renderTree({ reveal: true }); }
      }
      else if (key === "Enter" && row) { stop(); chooseScope(row.kind, row.entry.id); }
      else if (key !== "Escape") event.stopPropagation();
    }
    async function chooseScope(kind, id) {
      closePopover({ refocus: false });
      setScope(kind, id); s.allSeen = false; saveView(); renderPath(); renderScope();
      await loadBatch({ initial: !s.hasGrid });
    }
    async function setInclude(value) {
      if (s.include === value) return;
      discardPrefetch(); s.include = value; saveView(); renderScope();
      if (s.scopeKind === "folder") await loadBatch({ initial: !s.hasGrid });
    }

    async function setOrder(order) {
      if (s.order === order) return;
      discardPrefetch(); s.order = order; s.nextOffset = null; s.allSeen = false;
      saveView(); renderScope(); renderFooter();
      await loadBatch({ initial: !s.hasGrid });
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
    function requestBatch(offset = 0, count = randomCount(), pinned = []) {
      const target = Model.batchTarget(scope(), s.include), order = s.order;
      const exclude = [...new Set([...seen.exclude(), ...pinned])];
      return (async () => {
        const ask = (ids, limit) => message({ type: "picker:batch", ...target, exclude: ids, limit: Math.min(24, limit),
          ...(order === "newest" ? { order, offset } : {}) });
        if (order === "newest") return ask(exclude, Model.BATCH);
        let list = [], filled = false;
        while (list.length < count) {
          const requested = Math.min(24, count - list.length);
          const reply = await ask([...new Set([...exclude, ...list.map(item => item.assetId)])], requested);
          if (!reply.ok) return reply;
          const have = new Set([...pinned, ...list.map(item => item.assetId)]);
          const added = reply.items.filter(item => !have.has(item.assetId));
          list.push(...added.slice(0, count - list.length));
          if (added.length < requested) {
            if (exclude.length) {
              const ids = [...new Set([...seen.fillExclude(list.map(item => item.assetId), count - list.length), ...pinned])];
              const second = await ask(ids, count - list.length);
              if (second.ok) {
                const picked = new Set([...pinned, ...list.map(item => item.assetId)]);
                list.push(...second.items.filter(item => !picked.has(item.assetId)).slice(0, count - list.length)); filled = true;
              }
            }
            break;
          }
        }
        return { ok: true, items: list, filled };
      })();
    }
    function prefetchNext() {
      if (!s.scopeId || (s.order === "newest" && (s.nextOffset === null || s.batch.length >= 240))) return;
      const held = { key: batchKey(), offset: s.nextOffset, items: [] };
      prefetch = held;
      held.promise = (async () => {
        const reply = await requestBatch(held.offset || 0);
        if (prefetch !== held || !reply.ok) return null;
        held.items = reply.items;
        await pool(reply.items, 9, ensureThumb);
        if (prefetch !== held) { releaseThumbs(keepIds()); return null; }
        return reply;
      })().catch(() => null);
    }
    async function loadBatch({ initial = false, append = false, replyPromise = null, topUp = false } = {}) {
      if (!s.scopeId) return;
      const token = ++loadToken, key = batchKey();
      s.batchLoading = true;
      if (ui.grid && !append) ui.grid.inert = true;
      busy.begin(); if (initial) skeleton.begin(); setNotice("");
      const held = !topUp && (append || s.order === "random") ? prefetch : null;
      try {
        let reply = held?.key === key && held.offset === s.nextOffset ? await held.promise : null;
        if (token !== loadToken || key !== batchKey()) return;
        if (!reply) reply = await (replyPromise || requestBatch(append ? s.nextOffset : 0, topUp ? randomCount() - s.batch.length : randomCount(), topUp ? s.batch.map(item => item.assetId) : []));
        if (token !== loadToken || key !== batchKey()) return;
        if (!reply.ok) { failure(reply.kind); return; }
        let list = reply.items;
        if (append) {
          const have = new Set(s.batch.map(item => item.assetId)); list = list.filter(item => !have.has(item.assetId));
          if (s.order === "newest") list = list.slice(0, 240 - s.batch.length);
        }
        loadingItems = list;
        await pool(list, 9, ensureThumb);
        if (token !== loadToken) { releaseThumbs(keepIds()); return; }
        if (!append) s.focus = 0;
        const grid = buildGrid(list, append ? s.batch.length : 0);
        await decodeAll(Array.from(grid.querySelectorAll("img")));
        if (token !== loadToken) { releaseThumbs(keepIds()); return; }
        if (append) {
          // Keep existing tile nodes, focus and selection; fill an incomplete final row first.
          Array.from(grid.querySelectorAll(".tile")).forEach((tile, offset) => {
            const index = s.batch.length + offset;
            if (index % s.columns === 0) ui.grid.append(h(doc, "div", { class: "row", role: "row" }));
            ui.grid.lastElementChild.append(tile);
          });
          s.batch = s.batch.concat(list);
        } else {
          s.batch = list; s.focus = 0;
          if (list.length || (s.order === "newest" && Number.isSafeInteger(reply.nextOffset))) {
            s.hasGrid = true; ui.grid = grid; ui.body.replaceChildren(grid);
            if (Number(grid.getAttribute("aria-colcount")) !== s.columns) regroup();
          }
          else emptyFolder();
        }
        seen.add(list.map(item => item.assetId));
        s.gridKey = key; s.error = null; s.allSeen = reply.filled; s.nextOffset = reply.nextOffset ?? null; s.body = s.batch.length ? "ready" : "empty";
        prefetch = null; releaseThumbs(keepIds());
        renderScope(); renderTray(); renderFooter(); prefetchNext(); if (!topUp) scheduleFill();
      } finally {
        if (token === loadToken) { loadingItems = []; releaseThumbs(keepIds()); s.batchLoading = false; busy.end(); skeleton.end(); if (ui.grid) ui.grid.inert = false; }
      }
    }
    function emptyFolder() {
      const entry = current(), extra = entry && s.scopeKind === "folder" ? entry.imageCountWithDescendants - entry.imageCount : 0;
      s.hasGrid = false; ui.grid = null;
      if (s.scopeKind !== "folder") { showEmpty({ title: s.scopeKind === "group" ? "이 그룹에 그림 없음" : "이 캐릭터에 그림 없음" }); return; }
      const action = !s.include && extra > 0 ? { label: "하위 폴더 포함", run: () => void setInclude(true) } : null;
      showEmpty({ title: "이 폴더에 그림 없음", hint: action ? `하위 폴더에 ${Model.formatCount(extra)}장` : "", action });
    }
    function gridHeight() { return ui.grid?.clientHeight || ui.body?.clientHeight || 0; }
    function rowHeight() { return (ui.grid?.querySelector(".tile")?.getBoundingClientRect().height || (s.width - 2 * (s.columns - 1)) / s.columns) + 2; }
    function randomCount() { const height = s.sheet ? win.innerHeight - 36 - 20 - 56 - 48 - 72 : gridHeight(); return height ? Math.max(18, s.columns * Math.ceil(height / rowHeight())) : 18; }
    function scheduleFill() {
      if (fillFrame != null || !isOpen) return;
      fillFrame = win.requestAnimationFrame(() => { fillFrame = null; void fillGrid(); });
    }
    async function fillGrid() {
      if (filling || !isOpen || s.folded || s.batchLoading || !s.hasGrid || s.gridKey !== batchKey()) return;
      filling = true;
      try {
        while (isOpen && !s.folded && !s.batchLoading && s.hasGrid && s.gridKey === batchKey()) {
          const before = s.batch.length, beforeOffset = s.nextOffset;
          if (s.order === "newest") {
            if (!gridHeight() || ui.grid.scrollHeight >= gridHeight() + rowHeight() || s.nextOffset === null || before >= 240) break;
            await loadMore();
          } else {
            if (before >= randomCount()) break;
            await loadBatch({ append: true, topUp: true });
          }
          if (s.error || (s.order === "newest" ? s.nextOffset === beforeOffset : s.batch.length <= before)) break;
        }
      } finally { filling = false; }
    }
    async function loadMore() {
      if (!s.scopeId || s.running || s.batchLoading || s.order !== "newest" || s.nextOffset === null || s.batch.length >= 240) return;
      await loadBatch({ append: true });
    }
    async function refresh() {
      if (!s.scopeId || s.running || s.batchLoading) return;
      if (s.order === "newest") { discardPrefetch(); if (ui.grid) ui.grid.scrollTop = 0; }
      await loadBatch({ initial: !s.hasGrid });
      if (s.hasGrid && !s.folded) focusTile(0, false);
    }
    async function start({ silent = false } = {}) {
      if (!silent) { s.body = "loading"; if (!s.hasGrid) { skeleton.begin(); } }
      const earlyKey = batchKey(), early = s.scopeId ? requestBatch() : null;
      const folders = await loadFolders();
      skeleton.end();
      if (!folders.ok) { failure(folders.kind); return; }
      if (!isOpen) return;
      renderPath(); renderScope();
      if (!s.scopeId) { s.body = "empty"; showEmpty({ title: "폴더를 골라 주세요", hint: "위의 폴더 버튼에서 그림을 가져올 폴더나 캐릭터를 고르세요" }); openPopover(); return; }
      await loadBatch({ initial: !s.hasGrid, replyPromise: earlyKey === batchKey() ? early : null });
      if (!silent && isOpen && s.hasGrid && !s.popover && !s.folded) focusTile(0, false);
    }

    // ---- selection -----------------------------------------------------------------------
    function toggle(id) { selection.toggle(id); afterSelection(); announce(selection.has(id) ? `${selection.numberOf(id)}번 선택` : "선택 해제"); }
    function removeFromSelection(id) { selection.remove(id); afterSelection(); }

    // ---- insertion -----------------------------------------------------------------------
    async function insertSelected(ids = selection.ids(), reset = true) {
      if (s.running || !ids.length) return;
      if (!editor.available()) { if (s.folded) setFolded(false, { focus: false }); setNotice("본문 편집기를 찾지 못함", () => void insertSelected(ids, reset)); return; }
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
      if (isOpen && s.sheet) {
        const complete = outcome.length === ids.length && outcome.every(result => result.ok);
        setSheetLevel(complete ? "bar" : "half");
        if (complete) revealCaret();
      }
      if (outcome.length && outcome.every(result => result.ok) && outcome.length === ids.length) announce("모두 넣음");
      renderTray(); renderFooter(); decorateTiles();
      if (isOpen && doc.activeElement === host) {
        const target = s.folded ? (ui.railInsert.disabled ? ui.expand : ui.railInsert) : (ui.insert.disabled ? ui.other : ui.insert);
        target.focus?.();
      }
    }

    // ---- preview -------------------------------------------------------------------------
    function openPreview(index) {
      const item = s.batch[index]; if (!item) return;
      if (s.folded) setFolded(false, { focus: false });
      if (s.sheet && s.sheetLevel === "full") setSheetLevel("half");
      // Moving to another picture keeps the same surface (no re-entry animation, no flash).
      const reuse = ui.prev && s.preview != null;
      if (!reuse) closePreview({ refocus: false });
      s.preview = index;
      const id = item.assetId, number = selection.numberOf(id);
      const selBtn = h(doc, "button", { type: "button", class: "selbtn", onclick: () => { toggle(id); openPreview(s.preview); } }, number ? h(doc, "span", { class: "num" }, String(number)) : h(doc, "span", { class: "box" }), h(doc, "span", { class: "lbl" }, number ? "선택됨" : "선택"));
      const parts = [
        h(doc, "div", { class: "ph" }, h(doc, "span", { class: "pos" }, `${index + 1} / ${s.batch.length}`), h(doc, "span", { class: "sp" }), selBtn, h(doc, "button", { type: "button", class: "cbtn sq pclose", "aria-label": "크게 보기 닫기", onclick: () => closePreview() }, icon(doc, "close"))),
        h(doc, "div", { class: "stage" }, thumbs.get(id) ? h(doc, "img", { src: thumbs.get(id), alt: "" }) : null,
          index > 0 ? h(doc, "button", { type: "button", class: "pnav l", "aria-label": "이전", onclick: () => openPreview(index - 1) }, icon(doc, "left")) : null,
          index < s.batch.length - 1 ? h(doc, "button", { type: "button", class: "pnav r", "aria-label": "다음", onclick: () => openPreview(index + 1) }, icon(doc, "right")) : null),
        h(doc, "div", { class: "pf" }, `${Model.formatCount(item.width)}×${Model.formatCount(item.height)} · ${Model.formatBytes(item.byteSize)}`)];
      if (reuse) ui.prev.replaceChildren(...parts);
      else {
        ui.prev = h(doc, "div", { class: "prev", role: "dialog", "aria-label": "크게 보기" }, ...parts);
        swipeToClose(ui.prev, () => closePreview());
        root.append(ui.prev);
      }
      selBtn.focus({ preventScroll: true });
    }
    // Touch: drag right to close (the preview, or the whole panel). The surface follows the
    // finger; past a third of its width (or a quick flick) it slides out, otherwise it eases back.
    function swipeToClose(el, onClose) {
      let x0 = 0, y0 = 0, t0 = 0, dx = 0, tracking = false, decided = false;
      el.addEventListener("touchstart", event => {
        if (s.sheet && el === ui.lk) return;
        if (event.touches.length !== 1) { tracking = false; return; }
        const t = event.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); dx = 0; tracking = true; decided = false; el.dataset.swipeY = "0";
      }, { passive: true });
      el.addEventListener("touchmove", event => {
        if (!tracking) return;
        const t = event.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
        if (s.sheet && el === ui.prev) {
          dx = mx; el.style.transform = Math.abs(mx) > Math.abs(my) ? `translateX(${mx}px)` : `translateY(${Math.max(0, my)}px)`;
          el.dataset.swipeY = String(my); if (event.cancelable) event.preventDefault(); return;
        }
        if (!decided) { if (Math.abs(mx) < 10 && Math.abs(my) < 10) return; decided = true; if (mx <= 0 || Math.abs(my) > Math.abs(mx)) { tracking = false; return; } }
        dx = Math.max(0, mx); el.style.transition = "none"; el.style.transform = `translateX(${dx}px)`;
        if (event.cancelable) event.preventDefault();
      }, { passive: false });
      const end = () => {
        if (!tracking) return; tracking = false;
        if (s.sheet && el === ui.prev) {
          const dy = Number(el.dataset.swipeY) || 0;
          el.style.transform = "";
          if (dy > 60 && dy > Math.abs(dx)) onClose();
          else if (Math.abs(dx) > 44) openPreview(Math.max(0, Math.min(s.batch.length - 1, s.preview + (dx < 0 ? 1 : -1))));
          return;
        }
        const fast = dx > 60 && Date.now() - t0 < 300, far = dx > el.getBoundingClientRect().width / 3;
        el.style.transition = reduced() ? "none" : "transform 160ms cubic-bezier(.2,0,0,1)";
        if (fast || far) {
          el.style.transform = `translateX(${el.getBoundingClientRect().width + 24}px)`;
          // Close first (the surface is already off-screen), then clear the drag offset unseen.
          const done = () => { onClose(); setTimer(() => { el.style.transition = ""; el.style.transform = ""; }, 200); };
          if (reduced()) done(); else setTimer(done, 160);
        } else el.style.transform = "";
      };
      el.addEventListener("touchend", end); el.addEventListener("touchcancel", end);
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
      if (s.preview == null && /^[rR]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey && !target.closest?.("input")) { stop(); void refresh(); return; }
      const railThumb = target.closest?.(".rail-thumb");
      if (railThumb && /^[pP]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const index = s.batch.findIndex(item => item.assetId === railThumb.dataset.id);
        if (index >= 0) { stop(); openPreview(index); }
        return;
      }
      if (s.preview != null) {
        if (event.key === "ArrowLeft" && s.preview > 0) { stop(); openPreview(s.preview - 1); }
        else if (event.key === "ArrowRight" && s.preview < s.batch.length - 1) { stop(); openPreview(s.preview + 1); }
        else if (event.key === " " && !target.closest?.("button")) { stop(); const item = s.batch[s.preview]; if (item) { toggle(item.assetId); openPreview(s.preview); } }
        return;
      }
      const tile = target.closest?.(".tile");
      if (tile) {
        const index = tiles().indexOf(tile), action = Model.gridKey(event, { index, count: s.batch.length, columns: s.columns });
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
    function clampWidth(value) { return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(Number(value) || PANEL_WIDTH))); }
    function renderRail() {
      if (!ui.rail) return;
      const ids = selection.ids(), counts = jobs.counts();
      ui.railCount.textContent = s.running ? `${counts.done}/${counts.total}` : `${ids.length}장`;
      ui.railInsert.disabled = !ids.length || s.running;
      // Reserve the expand button and footer, and one slot for overflow when needed.
      const slots = s.sheet ? Math.max(0, Math.floor((win.innerWidth - 240) / 56)) : Math.max(0, Math.floor((win.innerHeight - 152) / 48));
      const shown = ids.length > slots ? Math.max(0, slots - 1) : slots;
      ui.railItems.replaceChildren(...ids.slice(0, shown).map((id, index) => h(doc, "button", {
        type: "button", class: "rail-thumb", "data-id": id, "aria-label": `${index + 1}번째 그림 펼치기`, onclick: () => {
          setFolded(false, { focus: false }); const at = s.batch.findIndex(item => item.assetId === id);
          if (at >= 0) focusTile(at); else focusTile(s.focus);
        } }, thumbs.has(id) ? h(doc, "img", { src: thumbs.get(id), alt: "" }) : null, h(doc, "span", { class: "num" }, String(index + 1)))));
      if (ids.length > shown) ui.railItems.append(h(doc, "span", { class: "rail-more" }, `+${ids.length - shown}`));
      ui.footPicks.replaceChildren(...ids.map((id, index) => h(doc, "button", { type: "button", class: "foot-thumb", "aria-label": `${index + 1}번째 그림 선택 해제`, onclick: () => removeFromSelection(id) },
        thumbs.has(id) ? h(doc, "img", { src: thumbs.get(id), alt: "" }) : null, h(doc, "span", { class: "num" }, String(index + 1)))));
    }
    function setFolded(value, { focus = true } = {}) {
      if (s.sheet) { if (!value && s.keyboard) expandBar(); else setSheetLevel(value ? "bar" : "half"); return; }
      s.folded = value; saveView(); closePopover({ refocus: false }); closePreview({ refocus: false });
      place(); renderRail();
      if (focus) { if (value) ui.expand.focus(); else focusTile(s.focus); }
      scheduleFill();
    }
    function changeWidth(value, save = false) {
      s.panelWidth = clampWidth(value); place();
      if (save) saveView();
      scheduleFill();
    }
    function installResize() {
      let pointer = null, startX = 0, startWidth = 0;
      const end = event => {
        if (event.pointerId !== pointer) return;
        const released = pointer; pointer = null;
        if (ui.resize.hasPointerCapture?.(released)) ui.resize.releasePointerCapture(released);
        s.dragging = false; host.removeAttribute("data-dragging");
        doc.documentElement.classList.remove("lakomics-arca-picker-dragging");
        if (isOpen) place(); saveView(); scheduleFill();
      };
      ui.resize.addEventListener("pointerdown", event => {
        if (event.button !== 0 || s.folded) return;
        pointer = event.pointerId; startX = event.clientX; startWidth = s.width;
        ui.resize.setPointerCapture?.(pointer); event.preventDefault(); s.dragging = true;
        host.setAttribute("data-dragging", ""); doc.documentElement.classList.add("lakomics-arca-picker-dragging");
      });
      ui.resize.addEventListener("pointermove", event => {
        if (isOpen && event.pointerId === pointer) changeWidth(startWidth + startX - event.clientX);
      });
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) ui.resize.addEventListener(name, end);
    }
    function regroup() {
      if (!ui.grid) return;
      const list = tiles(), active = root.activeElement, scroll = ui.grid.scrollTop;
      ui.grid.replaceChildren();
      for (let i = 0; i < list.length; i += s.columns) ui.grid.append(h(doc, "div", { class: "row", role: "row" }, ...list.slice(i, i + s.columns)));
      ui.grid.setAttribute("aria-colcount", s.columns);
      if (list.includes(active)) active.focus({ preventScroll: true });
      ui.grid.scrollTop = scroll;
    }
    // Portrait uses the same panel and selection, with only its placement and gestures changed.
    function setSheetLevel(level, { keyboard = false } = {}) {
      if (!isOpen) return;
      if (!keyboard) keyboardRestore = null;
      s.sheetLevel = level; s.folded = level === "bar";
      if (!keyboard) saveView();
      closePopover({ refocus: false });
      placeSheet(); renderRail(); renderFooter(); scheduleFill(); revealCaret();
    }
    function expandBar() {
      if (s.keyboard) { editor.remember(); editor.find?.()?.blur(); }
      setSheetLevel("half");
    }
    function placeSheet(height = null) {
      unplace({ keepSheet: true });
      const oldCols = s.columns;
      s.width = win.innerWidth; s.columns = Math.max(4, Math.min(6, Math.floor(s.width / 128)));
      const vv = win.visualViewport, panelKeyboard = s.keyboard && keyboardInPanel;
      const viewportHeight = panelKeyboard ? viewportBaseline : win.innerHeight;
      s.sheetHeight = height ?? (s.sheetLevel === "bar" ? 72 : s.sheetLevel === "full" ? viewportHeight - 36 : Math.round(viewportHeight * .55));
      if (panelKeyboard && vv) s.sheetHeight = Math.min(s.sheetHeight, vv.height);
      host.dataset.panelKeyboard = String(panelKeyboard);
      host.style.top = "auto"; host.style.width = "100%"; host.style.height = `${s.sheetHeight}px`;
      host.style.bottom = `${s.keyboard && vv ? Math.max(0, win.innerHeight - (vv.offsetTop + vv.height)) : 0}px`;
      host.style.setProperty("--panel-width", `${s.width}px`); host.style.setProperty("--columns", s.columns);
      host.style.setProperty("--sheet-height", `${s.sheetHeight}px`);
      host.dataset.folded = String(s.folded); host.dataset.full = String(s.sheetLevel === "full"); host.dataset.overlay = "false";
      ui.fold.replaceChildren(icon(doc, "chevron"));
      ui.lk.inert = s.folded; ui.lk.setAttribute("aria-hidden", String(s.folded));
      ui.rail.inert = !s.folded; ui.rail.setAttribute("aria-hidden", String(!s.folded));
      ui.resize.hidden = true;
      ui.spacer.hidden = false;
      ui.spacer.style.transition = reduced() || host.hasAttribute("data-dragging") ? "none" : "height 200ms cubic-bezier(.2,0,0,1)";
      ui.spacer.style.height = `${s.sheetHeight}px`; ui.spacer.style.pointerEvents = "none"; ui.spacer.style.flex = "none";
      if (oldCols !== s.columns) regroup();
      drawCaret();
    }
    function onViewport() {
      if (!isOpen || !s.sheet) return;
      const vv = win.visualViewport; if (!vv) return;
      if (viewportWidth !== win.innerWidth) {
        viewportWidth = win.innerWidth; viewportBaseline = win.innerHeight; keyboardRestore = null;
      }
      if (!s.keyboard) viewportBaseline = Math.max(viewportBaseline, win.innerHeight, vv.height);
      const keyboard = viewportBaseline - vv.height > 150;
      if (keyboard && !s.keyboard) {
        s.keyboard = true;
        // Shadow-root focus identifies our search; keep its input mounted throughout the keyboard session.
        keyboardInPanel = s.popover && root.activeElement === ui.searchInput;
        if (!keyboardInPanel && !s.folded) { keyboardRestore = s.sheetLevel; setSheetLevel("bar", { keyboard: true }); }
      } else if (!keyboard && s.keyboard) {
        s.keyboard = false; keyboardInPanel = false;
        const restore = keyboardRestore; keyboardRestore = null;
        if (restore) setSheetLevel(restore, { keyboard: true });
      }
      placeSheet();
    }
    function drawCaret() {
      if (!ui.caret) return;
      const rect = editor.caretRect?.(), field = editor.find?.();
      const bottom = Number.parseFloat(host.style.bottom) || 0;
      ui.caret.hidden = !isOpen || !s.sheet || !rect || doc.activeElement === field || rect.top < 0 || rect.bottom > win.innerHeight - s.sheetHeight - bottom;
      if (ui.caret.hidden) return;
      ui.caret.style.left = `${rect.left}px`; ui.caret.style.top = `${rect.top}px`; ui.caret.style.height = `${rect.height || 20}px`;
    }
    function onFocusOut() { setTimer(drawCaret, 0); }
    function revealCaret() {
      if (!isOpen || !s.sheet) return;
      win.cancelAnimationFrame(scrollFrame);
      const rect = editor.caretRect?.(); if (!rect) return;
      const keyboardOffset = Number.parseFloat(host.style.bottom) || 0;
      const amount = s.sheetLevel === "full" ? 0 : caretScroll(rect.bottom, s.sheetHeight, win.innerHeight - keyboardOffset);
      if (!amount) { drawCaret(); return; }
      const start = win.scrollY, began = win.performance.now();
      const tick = now => {
        if (!isOpen || !s.sheet) return;
        const progress = reduced() ? 1 : Math.min(1, (now - began) / 200);
        // The sheet's easing is cubic-bezier(.2,0,0,1); solve x(t) for the same scroll timing.
        let lo = 0, hi = 1;
        for (let i = 0; i < 12; i++) { const t = (lo + hi) / 2, x = .6 * (1 - t) ** 2 * t + t ** 3; if (x < progress) lo = t; else hi = t; }
        const t = (lo + hi) / 2, eased = progress === 1 ? 1 : 3 * (1 - t) * t * t + t ** 3;
        win.scrollTo({ top: start + amount * eased, behavior: "instant" }); drawCaret();
        scrollFrame = progress < 1 ? win.requestAnimationFrame(tick) : null;
      };
      scrollFrame = win.requestAnimationFrame(tick);
    }
    function detachSheet() {
      win.visualViewport?.removeEventListener("resize", onViewport); win.visualViewport?.removeEventListener("scroll", onViewport);
      win.removeEventListener("scroll", drawCaret); doc.removeEventListener("focusin", drawCaret); doc.removeEventListener("focusout", onFocusOut);
      win.cancelAnimationFrame(scrollFrame); scrollFrame = null; sheetDrag = null;
      if (keyboardRestore) { s.folded = false; s.sheetLevel = keyboardRestore; }
      keyboardRestore = null; keyboardInPanel = false; s.keyboard = false;
    }
    function installSheetDrag() {
      // Touch events let a scrollable grid keep native scrolling until it reaches its top.
      ui.dock.addEventListener("touchstart", event => {
        if (!s.sheet || event.touches.length !== 1 || s.preview != null) return;
        const target = event.target, grid = target.closest(".grid");
        const handle = target.closest(".sheet-handle"), bar = target.closest(".rail"), header = target.closest(".lk-head");
        if (target.closest("button") && !handle && !bar) return;
        if (!handle && !bar && !header && !(grid && grid.scrollTop <= 0)) return;
        const touch = event.touches[0];
        sheetDrag = { y: touch.clientY, x: touch.clientX, height: s.sheetHeight, lastY: touch.clientY, time: event.timeStamp, velocity: 0, grid: Boolean(grid), moved: false };
      }, { passive: true });
      ui.dock.addEventListener("touchmove", event => {
        const drag = sheetDrag; if (!drag || event.touches.length !== 1) return;
        const touch = event.touches[0], delta = drag.y - touch.clientY;
        if (!drag.moved) {
          if (Math.max(Math.abs(delta), Math.abs(touch.clientX - drag.x)) < 8) return;
          if (Math.abs(touch.clientX - drag.x) > Math.abs(delta) || drag.grid && delta >= 0) { sheetDrag = null; return; }
          drag.moved = true;
        }
        drag.velocity = (drag.lastY - touch.clientY) / Math.max(1, event.timeStamp - drag.time); drag.lastY = touch.clientY; drag.time = event.timeStamp;
        host.setAttribute("data-dragging", ""); ui.dock.style.animation = "none"; suppressClick = true;
        placeSheet(Math.max(0, Math.min(win.innerHeight - 36, drag.height + delta)));
        if (event.cancelable) event.preventDefault();
      }, { passive: false });
      const end = event => {
        const drag = sheetDrag; sheetDrag = null; if (!drag?.moved) return;
        void host.offsetHeight; void ui.spacer.offsetHeight;
        host.removeAttribute("data-dragging");
        const velocity = event.type === "touchcancel" || event.timeStamp - drag.time > 100 ? 0 : drag.velocity;
        const target = event.type === "touchcancel" ? drag.height : snapSheet(s.sheetHeight, velocity, win.innerHeight);
        if (!target) close(); else setSheetLevel(target === 72 ? "bar" : target === win.innerHeight - 36 ? "full" : "half");
        setTimer(() => { suppressClick = false; }, 0);
      };
      ui.dock.addEventListener("touchend", end); ui.dock.addEventListener("touchcancel", end);
    }
    function place() {
      const wasSheet = s.sheet;
      // A keyboard can shrink innerHeight past the portrait breakpoint without a rotation.
      const keyboardResize = wasSheet && viewportWidth === win.innerWidth && win.visualViewport && viewportBaseline - win.visualViewport.height > 150;
      const viewportHeight = keyboardResize ? Math.max(win.innerHeight, viewportBaseline) : win.innerHeight;
      s.sheet = portrait({ innerWidth: win.innerWidth, innerHeight: viewportHeight }); host.dataset.sheet = String(s.sheet);
      host.style.contain = s.sheet ? "style" : "layout style";
      if (wasSheet !== s.sheet) {
        keyboardRestore = null; keyboardInPanel = false; s.keyboard = false;
        s.sheetLevel = s.folded ? "bar" : "half";
        if (!s.sheet) { ui.spacer.hidden = true; host.style.top = "0"; host.style.bottom = "0"; host.style.height = ""; ui.caret.hidden = true; }
      }
      if (s.sheet) { placeSheet(); return; }
      ui.fold.replaceChildren(icon(doc, "right"));
      const html = doc.documentElement, form = doc.querySelector("form#article_write_form"), wide = win.innerWidth >= 1024;
      const startingMargin = Number.parseFloat(win.getComputedStyle(html).marginRight) || 0;
      // Measure the final layout without an in-flight margin transition, then restore its
      // starting position before committing the animated destination in the same frame.
      html.classList.add("lakomics-arca-picker-fitting");
      html.classList.remove("lakomics-arca-picker-push");
      let width = Math.max(MIN_WIDTH, Math.min(s.panelWidth, win.innerWidth));
      const free = form ? win.innerWidth - form.getBoundingClientRect().right : 0;
      pushed = wide && form != null && free < (s.folded ? RAIL_WIDTH : width) + 16;
      const apply = value => { html.style.setProperty("--lakomics-picker-width", `${value}px`); html.classList.toggle("lakomics-arca-picker-push", pushed); };
      s.overlay = !wide;
      apply(s.folded ? RAIL_WIDTH : width);
      if (pushed && !s.folded) {
        const overflow = form.getBoundingClientRect().right - (win.innerWidth - width);
        if (overflow > 0) { width = Math.max(MIN_WIDTH, Math.floor(width - overflow)); apply(width); }
        if (form.getBoundingClientRect().right > win.innerWidth - width + 1) { width = MIN_WIDTH; s.overlay = true; pushed = false; apply(width); }
      }
      const oldCols = s.columns;
      s.width = width; s.columns = width < 288 ? 2 : width < 420 ? 3 : 4;
      host.style.setProperty("--panel-width", `${width}px`); host.style.setProperty("--columns", s.columns);
      host.dataset.folded = String(s.folded); host.dataset.overlay = String(s.overlay);
      ui.lk.inert = s.folded; ui.lk.setAttribute("aria-hidden", String(s.folded));
      ui.rail.inert = !s.folded; ui.rail.setAttribute("aria-hidden", String(!s.folded));
      ui.resize.hidden = s.folded; ui.resize.setAttribute("aria-valuenow", width);
      const destination = s.folded ? RAIL_WIDTH : width;
      html.classList.toggle("lakomics-arca-picker-push", startingMargin > 0); html.style.setProperty("--lakomics-picker-width", `${startingMargin}px`);
      void html.offsetWidth; html.classList.remove("lakomics-arca-picker-fitting");
      apply(destination); host.style.width = `${destination}px`;
      html.classList.toggle("lakomics-arca-picker-folded", s.folded);
      if (oldCols !== s.columns) regroup();
    }
    function onResize() {
      if (resizeFrame != null) return;
      resizeFrame = win.requestAnimationFrame(() => {
        resizeFrame = null;
        if (isOpen) {
          const previousHeight = s.sheetHeight, wasSheet = s.sheet;
          place(); onViewport(); renderRail(); renderFooter(); scheduleFill();
          if (s.sheet && (!wasSheet || previousHeight !== s.sheetHeight)) revealCaret();
        }
      });
    }
    function unplace({ keepSheet = false } = {}) {
      doc.documentElement.classList.remove("lakomics-arca-picker-push", "lakomics-arca-picker-dragging", "lakomics-arca-picker-folded"); pushed = false;
      if (!keepSheet) { if (ui.spacer) ui.spacer.hidden = true; if (ui.caret) ui.caret.hidden = true; }
    }
    function syncTheme() { if (host) host.dataset.theme = detectTheme(doc); }
    function onSelectionChange() { if (isOpen) { editor.remember(); drawCaret(); } }
    async function open({ focus = true } = {}) {
      if (isOpen || opening) return;
      opening = true;
      editor.remember();
      try { if (!host) { await loadView(); mount(); } } finally { opening = false; }
      clearTimer(leaveTimer); leaveTimer = null;
      suppressClick = false;
      s.sheetLevel = s.folded ? "bar" : "half";
      isOpen = true; win.addEventListener("resize", onResize); win.visualViewport?.addEventListener("resize", onViewport); win.visualViewport?.addEventListener("scroll", onViewport);
      win.addEventListener("scroll", drawCaret); doc.addEventListener("focusin", drawCaret); doc.addEventListener("focusout", onFocusOut);
      host.style.display = ""; ui.dock.style.animation = ""; ui.dock.classList.remove("leaving"); syncTheme(); place(); onViewport();
      if (s.sheet) revealCaret();
      doc.addEventListener("selectionchange", onSelectionChange);
      themeObserver = new win.MutationObserver(syncTheme);
      for (const node of [doc.documentElement, doc.body]) if (node) themeObserver.observe(node, { attributes: true, attributeFilter: ["class"], subtree: node === doc.body });
      if (!editor.available()) setNotice("본문 편집기를 찾지 못함", () => { if (editor.available()) setNotice(""); else setNotice("본문 편집기를 찾지 못함"); });
      onOpenChange(true);
      renderPath(); renderScope(); renderTray(); renderFooter();
      if (s.hasGrid) { if (focus && !s.folded) focusTile(s.focus, false); scheduleFill(); } else await start({ silent: !focus });
      if (s.folded && focus && !s.sheet) ui.expand.focus();
    }
    function close({ animate = true } = {}) {
      if (!isOpen) return;
      isOpen = false; win.removeEventListener("resize", onResize); closePopover({ refocus: false }); closePreview({ refocus: false });
      detachSheet();
      s.dragging = false; host.removeAttribute("data-dragging");
      clearTimer(retryTimer); retryTimer = null;
      doc.removeEventListener("selectionchange", onSelectionChange); themeObserver?.disconnect(); themeObserver = null;
      ui.dock.style.animation = "";
      if (animate) ui.dock.classList.add("leaving");
      const finish = () => { leaveTimer = null; if (!isOpen && host) host.style.display = "none"; };
      if (reduced() || !animate) finish(); else leaveTimer = setTimer(finish, 140);
      unplace(); onOpenChange(false);
      editor.restore();
    }
    function toggleOpen() { return isOpen ? setFolded(!s.folded, { focus: Boolean(root.activeElement) }) : open({ focus: false }); }
    function destroy() {
      isOpen = false; win.removeEventListener("resize", onResize); win.removeEventListener("keydown", popoverKey, true); win.cancelAnimationFrame(resizeFrame); win.cancelAnimationFrame(fillFrame); clearTimer(trayTimer); discardPrefetch(); clearTimer(retryTimer); clearTimer(leaveTimer); themeObserver?.disconnect();
      detachSheet(); ui.spacer?.remove();
      doc.removeEventListener("selectionchange", onSelectionChange); unplace(); host?.remove(); host = null;
      for (const url of thumbs.values()) { try { win.URL.revokeObjectURL(url); } catch {} }
      thumbs.clear();
    }

    return {
      open, close, toggle: toggleOpen, destroy, refresh, insert: insertSelected, selection, seen, jobs, state: s,
      get isOpen() { return isOpen; }, get root() { return root; }, get host() { return host; },
    };
  }

  globalThis.LakomicsPickerPanel = { createPanel, h, icon, portrait, snapSheet, caretScroll };
})();
