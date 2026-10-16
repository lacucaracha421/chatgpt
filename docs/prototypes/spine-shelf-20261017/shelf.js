/* Mockup behaviour for the spine shelf. Stand-in data; the packing, windowing, pick/put-down,
   open and keyboard rules are the ones the README specifies for the app. */
(function () {
  // Real package sizes in mm: [height, spine thickness, front width]. Approximate retail keep cases.
  const DIM = { pc: [190, 14, 135], other: [190, 14, 135], av: [190, 14, 135], ps5: [172, 13, 135], ps4: [172, 13, 135], sw: [170, 11, 105], sw2: [170, 11, 105] };
  // CASE_PLASTIC from CollectionCase.tsx.
  const PLASTIC = { sw2: "rgba(206,44,54,.9)", sw: "rgba(214,222,230,.24)", ps5: "rgba(214,222,230,.24)", ps4: "rgba(30,78,176,.62)", pc: "rgba(16,18,22,.9)", other: "rgba(120,128,136,.38)", av: "rgba(10,10,11,.94)" };
  const TEMPLATES = ["sw2", "sw", "ps5", "ps4", "pc"];
  const PLATFORM_NAME = { sw: "Switch", sw2: "Switch 2", ps5: "PS5", ps4: "PS4", pc: "PC", other: "기타" };
  const TALLEST = 190, ROW_TOP = 16, PLANK = 6, ROW_GAP = 24, LABEL_H = 40, GUTTER = 24;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const pickOf = (r, list) => list[Math.floor(r() * list.length)];

  const KO_A = ["별의", "어둠의", "철의", "바람의", "마지막", "푸른", "시계탑", "모래의", "여름", "붉은", "기계", "은하", "고요한", "검은", "얼음", "달빛", "잊힌", "황금", "유리", "안개"];
  const KO_B = ["항해자", "정원", "왕관", "노래", "기사", "등대", "미궁", "왕국", "정거장", "숲", "도시", "우편", "섬", "탐정", "성채", "서커스", "연대기", "여행", "전설", "방랑자"];
  const EN_A = ["Iron", "Hollow", "Neon", "Crimson", "Silent", "Paper", "Echo", "Lunar", "Rust", "Velvet", "Signal", "Ember"];
  const EN_B = ["Harbor", "Knight", "Drift", "Garden", "Protocol", "Tides", "Frontier", "Requiem", "Circuit", "Lantern", "Saga", "Rift"];
  const DEVS = ["Studio Hanbit", "Northwind", "Blue Lantern", "Kite Games", "Moonfall", "Pixel Ferry", "Tanuki Works", "Grey Owl"];
  const MAKERS = [["MOONRISE", "MNR"], ["PASTEL ROOM", "PSR"], ["NOVA", "NVA"], ["LUMEN", "LMN"], ["SAKURA LANE", "SKL"]];
  const AV_A = ["여름 휴가", "비 오는 오후", "첫 출근", "온천 여행", "도시의 밤", "주말 산책", "졸업 기념", "봄날의 기록"];

  function makeGames(n, seed = 7) {
    const r = rng(seed), out = [];
    const weights = [["sw", 30], ["sw2", 6], ["ps5", 18], ["ps4", 14], ["pc", 28], ["other", 4]];
    const total = weights.reduce((a, [, w]) => a + w, 0);
    for (let i = 0; i < n; i++) {
      let x = r() * total, p = "pc";
      for (const [k, w] of weights) { if ((x -= w) < 0) { p = k; break; } }
      const english = r() < .4;
      const title = english ? `${pickOf(r, EN_A)} ${pickOf(r, EN_B)}${r() < .25 ? " " + (2 + Math.floor(r() * 3)) : ""}` : `${pickOf(r, KO_A)} ${pickOf(r, KO_B)}${r() < .2 ? " 리마스터" : ""}`;
      out.push({ id: `g${i}`, type: "game", p, title, credit: pickOf(r, DEVS), art: r() < .45 ? Math.floor(r() * 5) : null, hue: Math.floor(r() * 360), year: 2026 - Math.floor(i / 22), score: r() < .5 ? (6 + Math.floor(r() * 9)) / 2 : null });
    }
    return out;
  }
  function makeAv(n, seed = 11) {
    const r = rng(seed), out = [];
    for (let i = 0; i < n; i++) {
      const [maker, prefix] = pickOf(r, MAKERS);
      const code = `${prefix}-${String(1 + Math.floor(r() * 400)).padStart(3, "0")}`;
      out.push({ id: `a${i}`, type: "av", p: "av", title: `${pickOf(r, AV_A)} ${String(1 + Math.floor(r() * 12)).padStart(2, "0")}`, credit: maker, code, art: r() < .7 ? Math.floor(r() * 4) : null, hue: Math.floor(r() * 360), year: 2026 - Math.floor(i / 30), score: null });
    }
    return out;
  }

  const LB = [
    h => `--lb-bg:linear-gradient(hsl(${h} 60% 18%),hsl(${h} 50% 8%));--lb-head:hsl(${h} 70% 45%);--lb-ink:#fff;--lb-mark:hsl(${h + 30} 80% 70%)`,
    h => `--lb-bg:#f2efe8;--lb-head:hsl(${h} 65% 42%);--lb-ink:hsl(${h} 50% 22%);--lb-mark:hsl(${h} 65% 42%);--lb-case:uppercase;--lb-track:.12em`,
    h => `--lb-bg:linear-gradient(90deg,hsl(${h} 70% 40%),hsl(${h + 20} 70% 30%));--lb-head:#111;--lb-ink:#fff;--lb-mark:#fff;--lb-mark-radius:2px`,
    h => `--lb-bg:#0c0c0d;--lb-head:linear-gradient(hsl(${h} 80% 60%),hsl(${h + 40} 80% 40%));--lb-ink:hsl(${h} 90% 75%);--lb-mark:hsl(${h} 80% 60%)`,
    h => `--lb-bg:hsl(${h} 40% 85%);--lb-head:hsl(${h + 180} 50% 30%);--lb-ink:#16171a;--lb-mark:hsl(${h + 180} 50% 30%);--lb-mark-radius:0`,
  ];
  const AVS = [
    h => `--av-bg:#fff;--av-maker:hsl(${h} 75% 55%);--av-ink:#1a1a1a;--av-code:hsl(${h} 60% 40%)`,
    h => `--av-bg:hsl(${h} 70% 92%);--av-maker:#111;--av-ink:hsl(${h} 50% 25%);--av-code:#111`,
    h => `--av-bg:#111;--av-maker:hsl(${h} 80% 60%);--av-ink:#fff;--av-code:hsl(${h} 80% 70%)`,
    h => `--av-bg:linear-gradient(hsl(${h} 60% 70%),hsl(${h + 30} 60% 80%));--av-maker:#fff;--av-ink:#222;--av-code:#222`,
  ];

  /** The printed insert of one spine: spine art, else the platform template, else a bare spine with the title. */
  function spineInner(item, privacy, { loading = false } = {}) {
    if (privacy) return `<span class="ins"><span class="case-mask"></span></span>`;
    if (loading) return `<span class="ins"></span>`; // plastic only until the batched shelf read settles
    if (item.art !== null) return item.type === "av"
      ? `<span class="ins"><span class="case-spine-art"><span class="avs" style="${AVS[item.art](item.hue)}"><b>${esc(item.title)}</b><i>${esc(item.code)}</i></span></span></span>`
      : `<span class="ins"><span class="case-spine-art"><span class="lb" style="${LB[item.art](item.hue)}"><b>${esc(item.title)}</b><i></i></span></span></span>`;
    const title = `<span class="spine-title">${esc(item.title)}</span>`;
    if (TEMPLATES.includes(item.p)) {
      const foot = item.p === "sw" || item.p === "sw2" ? `<span class="t-mark" aria-hidden="true"></span>` : `<span class="t-pub">${esc(item.credit)}</span>`;
      return `<span class="ins full"><span class="case-spine-art"><span class="tpl ${item.p}"><span class="t-head"></span><span class="t-band">${title}</span><span class="t-foot">${foot}</span></span></span></span>`;
    }
    return `<span class="ins bare"><span class="case-spine-art">${title}</span></span>`;
  }
  const coverHTML = (item, privacy) => privacy ? `<span class="case-mask" style="display:block;width:100%;height:100%;background:var(--color-surface)"></span>`
    : `<span class="mock-cover${item.type === "av" ? " is-av" : ""}" style="--hue:${item.hue}" data-code="${esc(item.code ?? "")}"><b>${esc(item.title)}</b><i>${esc(item.credit)}</i></span>`;
  const label = item => `${item.title} · ${item.credit}`;

  function groupsFor(items, grouping) {
    if (items[0]?.type !== "game" || grouping === "sort") return [{ label: "", items }];
    if (grouping === "year") { const years = new Map(); for (const i of items) { const g = years.get(i.year) ?? []; g.push(i); years.set(i.year, g); } return [...years].map(([y, list]) => ({ label: String(y), items: list })); }
    const nintendo = items.filter(i => i.p === "sw" || i.p === "sw2");
    return [{ label: "닌텐도", items: nintendo }, { label: "PS · Xbox · PC", items: items.filter(i => !nintendo.includes(i)) }].filter(g => g.items.length);
  }

  class SpineShelf {
    constructor({ scroll, host, scale, touch = false, privacy = false, onOpen, onRendered }) {
      Object.assign(this, { scroll, host, scale, touch, privacy, onOpen, onRendered });
      this.nodes = new Map(); this.picked = null; this.focusId = null; this.first = true; this.loadingIds = new Set();
      host.classList.add("spine-shelf");
      host.setAttribute("role", "group");
      scroll.addEventListener("scroll", () => { this.render(); host.dataset.scrolling = ""; clearTimeout(this.scrollTimer); this.scrollTimer = setTimeout(() => delete host.dataset.scrolling, 150); }, { passive: true });
      new ResizeObserver(() => { if (this.items && this.host.clientWidth !== this.width) this.relayout(); }).observe(host);
      host.addEventListener("click", e => this.onClick(e));
      host.addEventListener("dblclick", e => { const s = e.target.closest(".spine"); if (s && !this.touch) this.open(s.dataset.id); });
      host.addEventListener("keydown", e => this.onKey(e));
    }
    set({ items, groups, label: aria, first = false }) {
      this.items = items; this.groups = groups; this.byId = new Map(items.map(i => [i.id, i]));
      this.host.setAttribute("aria-label", aria);
      if (!this.byId.has(this.picked)) this.picked = null;
      if (!this.byId.has(this.focusId)) this.focusId = items[0]?.id ?? null;
      this.first = first; this.relayout();
    }
    setScale(scale) { this.scale = scale; this.host.style.setProperty("--spine-scale", scale); this.relayout(); }
    setPrivacy(privacy) { this.privacy = privacy; this.clear(); this.render(); }
    clear() { for (const node of this.nodes.values()) node.remove(); this.nodes.clear(); }
    relayout() {
      const s = this.scale, avail = this.host.clientWidth - GUTTER * 2;
      this.width = this.host.clientWidth;
      this.entries = []; this.rows = []; this.cellOf = new Map(); this.order = [];
      let top = 8;
      for (const group of this.groups) {
        if (group.label) { this.entries.push({ kind: "label", top, height: LABEL_H, group }); top += LABEL_H; }
        // Pack left to right; a row is as tall as its tallest case (a Nintendo row is lower than a DVD row).
        const rows = []; let row = null, x = 0;
        for (const item of group.items) {
          const [hmm, tmm, cmm] = DIM[item.p];
          const w = Math.round(tmm * s), h = Math.round(hmm * s), cw = Math.round(cmm * s);
          if (!row || x + w > avail) { row = { kind: "row", cells: [] }; rows.push(row); x = 0; }
          row.cells.push({ item, w, h, cw, x, col: row.cells.length });
          x += w + 1;
        }
        for (const r of rows) {
          r.index = this.rows.length; r.board = Math.max(...r.cells.map(c => c.h)); r.top = top; r.height = ROW_TOP + r.board + PLANK + ROW_GAP;
          for (const cell of r.cells) { cell.row = r.index; this.cellOf.set(cell.item.id, cell); this.order.push(cell.item.id); }
          this.entries.push(r); this.rows.push(r); top += r.height;
        }
      }
      this.host.style.height = `${top + 32}px`;
      this.clear(); this.render();
    }
    offset() { return this.host.getBoundingClientRect().top - this.scroll.getBoundingClientRect().top + this.scroll.scrollTop; }
    render() {
      if (!this.entries) return;
      const top = this.scroll.scrollTop - this.offset(), height = this.scroll.clientHeight;
      // Half a viewport above and below, like CollectionList's SHELF_OVERSCAN_VIEWPORTS; the picked and focused rows stay.
      const lo = top - height * .5, hi = top + height * 1.5;
      const pinned = new Set([this.cellOf.get(this.picked)?.row, this.cellOf.get(this.focusId)?.row]);
      const want = new Set();
      this.entries.forEach((entry, index) => { if ((entry.top + entry.height >= lo && entry.top <= hi) || (entry.kind === "row" && pinned.has(entry.index))) want.add(index); });
      for (const [index, node] of this.nodes) if (!want.has(index)) { node.remove(); this.nodes.delete(index); }
      let stagger = 0;
      for (const index of want) {
        if (this.nodes.has(index)) continue;
        const node = this.build(this.entries[index]);
        if (this.first && this.entries[index].kind === "row" && !reduced()) { node.classList.add("is-entering"); node.style.setProperty("--i", Math.min(17, stagger++)); node.addEventListener("animationend", () => node.classList.remove("is-entering"), { once: true }); }
        this.host.appendChild(node); this.nodes.set(index, node);
      }
      this.first = false;
      this.onRendered?.({ rows: [...want].filter(i => this.entries[i].kind === "row").length, totalRows: this.rows.length, spines: this.host.querySelectorAll(".spine").length, total: this.items.length });
    }
    build(entry) {
      const node = document.createElement("div");
      if (entry.kind === "label") {
        node.className = "shelf-label"; node.style.cssText = `top:${entry.top}px;height:${entry.height}px`;
        node.innerHTML = `<div class="ui-section-label" style="flex:1"><span class="ui-section-label__title">${esc(entry.group.label)}</span><span class="ui-section-label__count">${entry.group.items.length.toLocaleString()}</span><span class="ui-section-label__rule" aria-hidden="true"></span></div>`;
        return node;
      }
      node.className = "spine-shelf__row"; node.style.cssText = `top:${entry.top}px;height:${entry.height}px;--board-height:${entry.board}px`;
      node.innerHTML = `<div class="spine-shelf__board"><div class="spine-shelf__spines">${entry.cells.map(cell => {
        const { item } = cell;
        return `<button type="button" class="spine" data-id="${item.id}" tabindex="${item.id === this.focusId ? 0 : -1}" aria-label="${esc(label(item))}" aria-pressed="${item.id === this.picked}" style="--w:${cell.w}px;--h:${cell.h}px;--plastic:${PLASTIC[item.p]}"><span class="spine__case">${spineInner(item, this.privacy, { loading: this.loadingIds.has(item.id) })}</span></button>`;
      }).join("")}</div></div>`;
      if (this.picked && this.cellOf.get(this.picked)?.row === entry.index) requestAnimationFrame(() => this.makeOut(this.picked, false));
      return node;
    }
    spineEl(id) { return this.host.querySelector(`.spine[data-id="${id}"]`); }
    makeOut(id, animate) {
      const button = this.spineEl(id); if (!button || this.host.querySelector(`.spine-shelf__out[data-id="${id}"]`)) return;
      const board = button.closest(".spine-shelf__board"), cell = this.cellOf.get(id), item = cell.item;
      const center = button.offsetLeft + cell.w / 2;
      const left = Math.max(0, Math.min(board.clientWidth - cell.cw, center - cell.cw / 2));
      const out = document.createElement("button");
      out.type = "button"; out.className = "spine-shelf__out"; out.dataset.id = id; out.tabIndex = -1;
      out.setAttribute("aria-label", `${item.title} 열기`);
      out.style.cssText = `left:${left}px;--cover-w:${cell.cw}px;--h:${cell.h}px;--plastic:${PLASTIC[item.p]}`;
      out.innerHTML = `<span class="face">${coverHTML(item, this.privacy)}</span>`;
      out.dataset.from = `translateX(${center - (left + cell.cw / 2)}px) scaleX(${cell.w / cell.cw})`;
      if (animate && !reduced()) {
        out.style.transform = out.dataset.from; board.appendChild(out); out.getBoundingClientRect();
        out.style.transform = ""; out.classList.add("is-out");
      } else { out.classList.add("is-out"); board.appendChild(out); }
    }
    pick(id) {
      if (this.picked === id) return;
      this.putDown();
      this.picked = id;
      this.spineEl(id)?.setAttribute("aria-pressed", "true");
      this.makeOut(id, true);
    }
    putDown() {
      const id = this.picked; if (!id) return;
      this.picked = null;
      this.spineEl(id)?.setAttribute("aria-pressed", "false");
      const out = this.host.querySelector(`.spine-shelf__out[data-id="${id}"]`); if (!out) return;
      if (reduced()) { out.remove(); return; }
      out.classList.remove("is-out"); out.style.transform = out.dataset.from; out.style.opacity = "0";
      out.addEventListener("transitionend", e => { if (e.propertyName === "transform") out.remove(); });
      setTimeout(() => out.remove(), 500);
    }
    open(id) { const item = this.byId.get(id); if (item) { this.pick(id); this.onOpen?.(item); } }
    focus(id, pick = true) {
      const cell = this.cellOf.get(id); if (!cell) return;
      const row = this.rows[cell.row], base = this.offset(), view = this.scroll;
      if (base + row.top < view.scrollTop) view.scrollTop = base + row.top - 8;
      else if (base + row.top + row.height > view.scrollTop + view.clientHeight) view.scrollTop = base + row.top + row.height - view.clientHeight + 8;
      this.focusId = id; this.render();
      this.host.querySelectorAll('.spine[tabindex="0"]').forEach(s => { s.tabIndex = -1; });
      const button = this.spineEl(id); if (!button) return;
      button.tabIndex = 0; button.focus({ preventScroll: true });
      if (pick) this.pick(id);
    }
    nearest(rowIndex, x) {
      const row = this.rows[rowIndex]; if (!row) return null;
      let best = null, distance = Infinity;
      for (const cell of row.cells) { const d = Math.abs(cell.x + cell.w / 2 - x); if (d < distance) { distance = d; best = cell; } }
      return best?.item.id ?? null;
    }
    onClick(event) {
      const out = event.target.closest(".spine-shelf__out");
      if (out) { this.open(out.dataset.id); return; }
      let spine = event.target.closest(".spine");
      // Tablet: a tap anywhere in a row's band picks the nearest case (spines are thinner than 44px).
      if (!spine && this.touch) {
        const board = event.target.closest(".spine-shelf__row")?.querySelector(".spine-shelf__board");
        if (board) { const x = event.clientX - board.getBoundingClientRect().left; const rowIndex = this.rows.findIndex(r => r.top === parseFloat(board.parentElement.style.top)); const id = this.nearest(rowIndex, x); spine = id && this.spineEl(id); }
      }
      if (!spine) { this.putDown(); return; }
      const id = spine.dataset.id;
      if (this.picked === id) { this.open(id); return; }
      this.focusId = id; this.host.querySelectorAll('.spine[tabindex="0"]').forEach(s => { s.tabIndex = -1; }); spine.tabIndex = 0;
      if (!this.touch) spine.focus({ preventScroll: true });
      this.pick(id);
    }
    onKey(event) {
      const target = event.target.closest(".spine, .spine-shelf__out"); if (!target || event.altKey || event.ctrlKey || event.metaKey) return;
      const id = target.dataset.id, cell = this.cellOf.get(id), index = this.order.indexOf(id), row = this.rows[cell.row];
      let next = null;
      switch (event.key) {
        case "ArrowRight": next = this.order[Math.min(this.order.length - 1, index + 1)]; break;
        case "ArrowLeft": next = this.order[Math.max(0, index - 1)]; break;
        case "ArrowDown": next = this.nearest(cell.row + 1, cell.x + cell.w / 2) ?? id; break;
        case "ArrowUp": next = this.nearest(cell.row - 1, cell.x + cell.w / 2) ?? id; break;
        case "Home": next = row.cells[0].item.id; break;
        case "End": next = row.cells.at(-1).item.id; break;
        case "Enter": event.preventDefault(); if (this.picked === id) this.open(id); else this.pick(id); return;
        case " ": event.preventDefault(); if (this.picked === id) this.putDown(); else this.pick(id); return;
        case "Escape": if (this.picked) { event.preventDefault(); event.stopPropagation(); this.putDown(); } return;
        default: return;
      }
      event.preventDefault();
      if (next) this.focus(next, true);
    }
  }

  function renderGrid(host, items, { columns, privacy, onOpen }) {
    host.className = "cover-grid"; host.style.setProperty("--columns", columns);
    host.innerHTML = items.map(item => {
      const [hmm, , cmm] = DIM[item.p];
      const meta = [item.year, item.score != null ? `★ ${item.score.toFixed(1)}` : ""].filter(Boolean).join(" · ");
      return `<button type="button" class="cover-grid__card" data-id="${item.id}" aria-label="${esc(label(item))}"><span class="cover-grid__frame"><span class="cover-grid__cover" style="--ratio:${cmm} / ${hmm}">${coverHTML(item, privacy)}</span></span><span class="cover-grid__name">${esc(item.title)}</span><span class="cover-grid__meta">${esc(item.type === "av" ? item.code : item.credit)}${meta ? ` · ${meta}` : ""}</span></button>`;
    }).join("");
    host.onclick = e => { const card = e.target.closest(".cover-grid__card"); if (!card) return; host.querySelectorAll('[aria-selected="true"]').forEach(c => c.removeAttribute("aria-selected")); card.setAttribute("aria-selected", "true"); };
    host.ondblclick = e => { const card = e.target.closest(".cover-grid__card"); if (card) onOpen(items.find(i => i.id === card.dataset.id)); };
  }

  window.SpineShelfMock = { DIM, PLASTIC, PLATFORM_NAME, makeGames, makeAv, spineInner, coverHTML, groupsFor, SpineShelf, renderGrid, esc };
})();
