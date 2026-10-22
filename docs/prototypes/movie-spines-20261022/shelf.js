/* Mockup behaviour for the 영화 책장 options. Stand-in data and posters; the packing, size table and pull-out
   follow the app's SpineShelf (spineShelfLayout.ts, SpineShelf.tsx), simplified for a static page. */
(function () {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const EASE = "cubic-bezier(.32,.72,0,1)";
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Poster aspect ratios (width / height): TMDB 2:3, US one-sheet 27:40, Japanese B2, Korean poster.
  const RATIO = { "23": 2 / 3, "2740": 27 / 40, b2: 1 / 1.414, kr: 1 / 1.43 };
  // [title, year, director, studio, ratio, composition, hue1, hue2, focus x %, series]
  const RAW = [
    ["오디세이", 2026, "크리스토퍼 놀란", "Syncopy", "2740", "sun", 22, 12, 46],
    ["극장판 체인소 맨: 레제편", 2025, "요시하라 타츠야", "MAPPA", "b2", "duo", 350, 330, 44],
    ["룩 백", 2024, "오시야마 키요타카", "Studio Durian", "b2", "face", 30, 220, 50],
    ["듄: 파트 2", 2024, "드니 빌뇌브", "Legendary", "2740", "sun", 32, 18, 50],
    ["오펜하이머", 2023, "크리스토퍼 놀란", "Syncopy", "2740", "face", 18, 8, 50],
    ["그대들은 어떻게 살 것인가", 2023, "미야자키 하야오", "Studio Ghibli", "b2", "sun", 200, 160, 52],
    ["스즈메의 문단속", 2022, "신카이 마코토", "CoMix Wave Films", "b2", "city", 205, 240, 50],
    ["더 퍼스트 슬램덩크", 2022, "이노우에 다케히코", "Toei Animation", "b2", "duo", 0, 230, 50],
    ["헤어질 결심", 2022, "박찬욱", "모호필름", "kr", "split", 190, 200, 50],
    ["체인소 맨", 2022, "나카야마 류", "MAPPA", "23", "city", 10, 0, 50, true],
    ["극장판 주술회전 0", 2021, "박성후", "MAPPA", "b2", "duo", 230, 260, 48],
    ["신 에반게리온 극장판", 2021, "안노 히데아키", "khara", "b2", "split", 280, 300, 56],
    ["극장판 마크로스 Δ 절대LIVE!!!!!!", 2021, "야스다 켄지", "Satelight", "b2", "duo", 320, 270, 50],
    ["극장판 귀멸의 칼날: 무한열차편", 2020, "소토자키 하루오", "ufotable", "b2", "sun", 8, 250, 50],
    ["조커", 2019, "토드 필립스", "Warner Bros.", "2740", "city", 20, 10, 50],
    ["기생충", 2019, "봉준호", "바른손이앤에이", "kr", "split", 90, 220, 50],
    ["날씨의 아이", 2019, "신카이 마코토", "CoMix Wave Films", "b2", "sun", 195, 220, 46],
    ["블레이드 러너 2049", 2017, "드니 빌뇌브", "Alcon Entertainment", "2740", "city", 28, 190, 50],
    ["너의 이름은.", 2016, "신카이 마코토", "CoMix Wave Films", "b2", "duo", 230, 260, 50],
    ["이 멋진 세계에 축복을!", 2016, "카나자키 타카오미", "Studio Deen", "23", "duo", 200, 40, 50, true],
    ["라라랜드", 2016, "데이미언 셔젤", "Lionsgate", "2740", "duo", 250, 280, 50],
    ["매드 맥스: 분노의 도로", 2015, "조지 밀러", "Kennedy Miller Mitchell", "2740", "sun", 28, 20, 50],
    ["인터스텔라", 2014, "크리스토퍼 놀란", "Syncopy", "2740", "face", 210, 220, 50],
    ["에반게리온: Q", 2012, "안노 히데아키", "khara", "b2", "split", 0, 260, 52],
    ["늑대아이", 2012, "호소다 마모루", "Studio Chizu", "b2", "sun", 110, 200, 46],
    ["슈타인즈 게이트", 2011, "하마사키 히로시", "White Fox", "23", "city", 40, 210, 50, true],
    ["에반게리온: 파", 2009, "안노 히데아키", "khara", "b2", "duo", 140, 270, 50],
    ["극장판 마크로스 프론티어: 거짓의 가희", 2009, "키쿠치 쇼지", "Satelight", "b2", "duo", 50, 230, 52],
    ["모노가타리", 2009, "신보 아키유키", "SHAFT", "23", "face", 275, 300, 50, true],
    ["에반게리온: 서", 2007, "안노 히데아키", "khara", "b2", "face", 215, 250, 50],
    ["시간을 달리는 소녀", 2006, "호소다 마모루", "Madhouse", "b2", "sun", 195, 210, 50],
    ["파프리카", 2006, "콘 사토시", "Madhouse", "b2", "duo", 340, 280, 50],
    ["하울의 움직이는 성", 2004, "미야자키 하야오", "Studio Ghibli", "b2", "sun", 100, 210, 50],
    ["올드보이", 2003, "박찬욱", "쇼이스트", "kr", "face", 140, 20, 50],
    ["살인의 추억", 2003, "봉준호", "싸이더스", "kr", "city", 70, 40, 50],
    ["센과 치히로의 행방불명", 2001, "미야자키 하야오", "Studio Ghibli", "b2", "sun", 15, 200, 50],
    ["퍼펙트 블루", 1997, "콘 사토시", "Madhouse", "b2", "split", 340, 210, 50],
    ["엔드 오브 에반게리온", 1997, "안노 히데아키", "Production I.G", "b2", "face", 0, 250, 50],
    ["공각기동대", 1995, "오시이 마모루", "Production I.G", "b2", "city", 160, 200, 50],
    ["마크로스 7: 은하가 나를 부른다!", 1995, "아미노 테츠로", "Ashi Productions", "b2", "duo", 280, 230, 50],
    ["아키라", 1988, "오토모 가쓰히로", "TMS", "b2", "sun", 0, 0, 50],
  ];
  // The collection number (option C) follows the order the films were added; a fixed shuffle stands in for createdAt.
  const FILMS = RAW.map(([t, y, dir, studio, r, comp, h1, h2, fx, series], i) => ({ id: `m${i}`, t, y, dir, studio, ratio: RATIO[r], rk: r, comp, h1, h2, fx: fx !== 50 ? fx : 36 + (i * 11) % 28, series: Boolean(series), no: ((i * 17) % RAW.length) + 1 }));

  /* ---------- Sizes ---------- */
  // 책등 크기 for movies: the AV table (SPINE_SCALE_AV), because a movie library is small (14 works today) and each spine
  // carries art or a long Korean title. px per mm.
  const SCALE = { pc: { small: 1, normal: 1.3, large: 1.8, huge: 3.15 }, tablet: { small: 1.15, normal: 1.5, large: 2.05, huge: 2.8 } };
  const SIZE_LABEL = { small: "작게", normal: "보통", large: "크게", huge: "아주 크게" };
  const ROW_TOP = 16, PLANK = 6, ROW_GAP = 24, LABEL_H = 40, TOP = 8, BOTTOM = 32, GROW = 1.28, LIFT = 12;

  /* ---------- The three options ---------- */
  const OPTIONS = {
    A: { // 킵 케이스: Blu-ray-size keep case, the case front follows the poster.
      plastic: "rgba(30,86,176,.78)", lip: 2.5,
      mm: f => ({ h: 172, s: 12, w: 172 * f.ratio }), tallest: 172,
      print: (f, px) => `<span class="ins full"><span class="case-spine-art"><span class="tpl film"><span class="t-head"><span class="t-year">${f.y}</span></span><span class="t-band"><span class="spine-title">${esc(f.t)}</span></span><span class="t-foot"><span class="t-pub">${esc(f.studio)}</span></span></span></span></span>`,
    },
    B: { // 포스터 책등: a thick poster board, height from the poster's own ratio.
      plastic: "#0b0c0e", lip: 0, board: true,
      mm: f => ({ h: 125 / f.ratio, s: 14, w: 125 }), tallest: 125 / RATIO["23"],
      print: (f, px, { settled = true } = {}) => {
        const left = Math.min(0, Math.max(px.s - px.w, px.s / 2 - px.w * f.fx / 100));
        return `<span class="ins"><span class="case-spine-art"><span class="pspine"><span class="ps-art" data-settled="${settled}">${posterHTML(f, `width:${px.w}px;height:${px.h}px;left:${left.toFixed(1)}px`)}</span><span class="ps-band"><span class="spine-title">${esc(f.t)}</span></span><span class="ps-foot"><span>${f.y}</span></span></span></span></span>`;
      },
    },
    C: { // 번호 전집: one uniform DVD-size spine series, clear case.
      plastic: "rgba(214,222,230,.24)", lip: 2.5,
      mm: f => ({ h: 190, s: 14, w: 190 * f.ratio }), tallest: 190,
      print: f => `<span class="ins full"><span class="case-spine-art"><span class="tpl numbered" style="--ink:${inkOf(f)}"><span class="t-no">${f.no}</span><span class="t-band"><span class="spine-title">${esc(f.t)}</span></span><span class="t-foot"><span class="t-pub">${esc(f.dir)}</span></span></span></span></span>`,
    },
  };
  // Option C: the poster's dominant colour, held to a calm band (lightness 26–34%, saturation ≤ 38%) so white print always reads.
  const inkOf = f => `hsl(${(f.h1 + 20) % 360} ${f.comp === "split" ? 34 : 30}% ${28 + (f.h1 % 3) * 3}%)`;

  function posterHTML(f, style = "") {
    return `<span class="poster c-${f.comp}" style="--h1:${f.h1};--h2:${f.h2};--fx:${f.fx}%;--sx:${(f.h1 % 40) + 40}%;${style}"><span class="p-sun"></span><span class="p-fig"></span><span class="p-ground"></span><span class="p-ttl"><b>${esc(f.t)}</b><i>${esc(f.dir)}</i></span></span>`;
  }
  const px = (opt, f, scale) => { const mm = OPTIONS[opt].mm(f); return { h: Math.round(mm.h * scale), s: Math.max(1, Math.round(mm.s * scale)), w: Math.round(mm.w * scale) }; };
  function spineInner(opt, f, size, state = {}) {
    if (state.privacy) return `<span class="ins"><span class="case-mask"></span></span>`;
    if (state.pending) return `<span class="ins"></span>`;
    return OPTIONS[opt].print(f, size, state);
  }
  function spineButton(opt, f, size, extra = "", state = {}) {
    const o = OPTIONS[opt];
    return `<button type="button" class="spine${o.board ? " spine--board" : ""} ${extra}" data-id="${f.id}" aria-label="${esc(f.t)} · ${f.y}" tabindex="-1"
      style="--w:${size.s}px;--h:${size.h}px;--plastic:${o.plastic}"><span class="spine__case">${spineInner(opt, f, size, state)}</span></button>`;
  }

  /* ---------- Grouping and packing (spineShelfLayout.packSpineShelf) ---------- */
  function groupsFor(grouping) {
    const films = [...FILMS].sort((a, b) => b.y - a.y);
    if (grouping === "decade") {
      const map = new Map();
      for (const f of films) { const k = `${Math.floor(f.y / 10) * 10}년대`; if (!map.has(k)) map.set(k, []); map.get(k).push(f); }
      return [...map].map(([label, works]) => ({ label, works }));
    }
    if (grouping === "director") {
      const map = new Map();
      for (const f of films) { if (!map.has(f.dir)) map.set(f.dir, []); map.get(f.dir).push(f); }
      const many = [...map].filter(([, w]) => w.length > 1).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "ko"));
      const rest = films.filter(f => map.get(f.dir).length === 1);
      return [...many.map(([label, works]) => ({ label, works })), { label: "그 밖의 감독", works: rest }];
    }
    return [{ label: "전체", works: films }];
  }
  function pack(opt, groups, available, scale) {
    const entries = [], rows = [];
    let top = TOP;
    for (const g of groups) {
      entries.push({ kind: "label", top, label: g.label, count: g.works.length }); top += LABEL_H;
      const groupRows = []; let row = null, x = 0;
      for (const f of g.works) {
        const size = px(opt, f, scale);
        if (!row || x + size.s > available) { row = { kind: "row", index: rows.length + groupRows.length, cells: [] }; groupRows.push(row); x = 0; }
        row.cells.push({ f, x, ...size }); x += size.s + 1;
      }
      for (const r of groupRows) {
        r.board = Math.max(...r.cells.map(c => c.h)); r.top = top; r.height = ROW_TOP + r.board + PLANK + ROW_GAP; top += r.height;
        entries.push(r); rows.push(r);
      }
    }
    return { entries, rows, height: top + BOTTOM };
  }
  /** spineShelfLayout.spineScaleForView: a size too large for the window is drawn smaller so the pulled-out case fits. */
  function scaleForView(opt, chosen, viewHeight) {
    const room = viewHeight - PLANK - ROW_GAP - LIFT;
    const fit = Math.floor(room / (OPTIONS[opt].tallest * GROW) * 100) / 100;
    return Math.min(chosen, Math.max(.8, fit));
  }

  const sectionLabel = (title, count) => `<div class="ui-section-label"><span class="ui-section-label__title">${esc(title)}</span> <span class="ui-section-label__count">${count}</span><span class="ui-section-label__rule" aria-hidden="true"></span></div>`;

  /* ---------- One shelf ---------- */
  function mountShelf(host, { opt, scale, grouping, gutter = 24, touch = false, picked = null, onRead }) {
    const available = Math.max(1, host.clientWidth - gutter * 2);
    const packed = pack(opt, groupsFor(grouping), available, scale);
    const o = OPTIONS[opt];
    host.innerHTML = `<div class="spine-shelf" role="group" aria-label="영화 책장" style="height:${packed.height}px;--spine-scale:${scale};--spine-gutter:${gutter}px">${packed.entries.map(e => e.kind === "label"
      ? `<div class="spine-shelf__label" style="top:${e.top}px;height:${LABEL_H}px">${sectionLabel(e.label, e.count)}</div>`
      : `<div class="spine-shelf__row" data-shelf-row="${e.index}" style="top:${e.top}px;height:${e.height}px;--board-height:${e.board}px"><div class="spine-shelf__board"><div class="spine-shelf__spines">${e.cells.map(c => spineButton(opt, c.f, c)).join("")}</div></div></div>`).join("")}</div>`;
    const root = host.firstElementChild;
    const cellOf = id => { for (const r of packed.rows) { const c = r.cells.find(x => x.f.id === id); if (c) return [r, c]; } return [null, null]; };
    let current = null; // { id, el }

    function pose(row, cell) {
      const H = Math.round(cell.h * GROW), W = Math.round(cell.w * GROW), D = Math.max(1, Math.round(cell.s * GROW));
      const center = cell.x + cell.s / 2;
      const left = Math.max(0, Math.min(available - W, center - W / 2));
      const top = row.top + ROW_TOP + row.board - LIFT - H;
      const lift = LIFT + Math.min(0, top);
      const s0 = cell.h / H, dx = center - (left + W / 2);
      return { H, W, D, left, lift, from: `translate(${dx.toFixed(1)}px, ${lift}px) scale(${s0.toFixed(4)})` };
    }
    function pull(id, animate) {
      const [row, cell] = cellOf(id); if (!row) return;
      const p = pose(row, cell), f = cell.f;
      const rowEl = root.querySelector(`[data-shelf-row="${row.index}"]`), board = rowEl.querySelector(".spine-shelf__board");
      const lip = o.lip ? Math.max(2, Math.round(o.lip * scale * GROW * .8)) : 0;
      const el = document.createElement("div");
      el.className = "mo"; el.dataset.id = id;
      el.style.cssText = `left:${p.left}px;bottom:${p.lift}px;width:${p.W}px;height:${p.H}px;--w:${p.W}px;--d:${p.D}px;--plastic:${o.plastic};--lip:${lip}px ${lip}px ${lip}px 0;--rim:${o.lip ? Math.round(o.lip * scale * GROW) : 0}px;${o.board ? "--front-radius:1px;" : ""}`;
      el.innerHTML = `<span class="mo-shadow"></span><div class="mo-obj"><span class="mo-face mo-back"></span><span class="mo-face mo-spine">${OPTIONS[opt].print(f, { s: p.D, h: p.H - (o.lip ? 2 * Math.round(o.lip * scale * GROW) : 0), w: p.W })}</span><span class="mo-face mo-front"><span class="mo-print">${posterHTML(f)}</span></span></div>`;
      board.appendChild(el); rowEl.classList.add("is-holding");
      root.querySelector(`.spine[data-id="${id}"]`).setAttribute("data-out", "");
      if (animate && !reduced()) {
        el.animate([{ transform: p.from }, { transform: "none" }], { duration: 520, easing: EASE, fill: "backwards" });
        el.querySelector(".mo-obj").animate([{ transform: "rotateY(90deg)" }, { transform: "rotateY(16deg)" }], { duration: 460, delay: 60, easing: EASE, fill: "backwards" });
        el.querySelector(".mo-shadow").animate([{ opacity: 0, transform: `translateY(${-p.lift}px) scaleX(.12)` }, { opacity: 1, transform: "none" }], { duration: 460, delay: 60, easing: EASE, fill: "backwards" });
      }
      current = { id, el, from: p.from, lift: p.lift, rowEl };
      onRead?.(`꺼냄: ${f.t} · ${f.y}`);
    }
    function putBack() {
      if (!current) return;
      const { id, el, from, lift, rowEl } = current; current = null;
      const done = () => { root.querySelector(`.spine[data-id="${id}"]`)?.removeAttribute("data-out"); requestAnimationFrame(() => { el.remove(); if (!rowEl.querySelector(".mo")) rowEl.classList.remove("is-holding"); }); };
      if (reduced()) { done(); return; }
      el.style.pointerEvents = "none";
      el.animate([{ transform: "none" }, { transform: from }], { duration: 440, easing: EASE, fill: "forwards" }).onfinish = done;
      el.querySelector(".mo-obj").animate([{ transform: "rotateY(16deg)" }, { transform: "rotateY(90deg)" }], { duration: 360, easing: EASE, fill: "forwards" });
      el.querySelector(".mo-shadow").animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${-lift}px) scaleX(.12)` }], { duration: 360, easing: EASE, fill: "forwards" });
    }
    function activate(id) {
      if (current?.id === id) { onRead?.(`열기: ${cellOf(id)[1].f.t} → 작품 화면 (지금과 같은 이동)`); return; }
      putBack(); pull(id, true);
    }
    root.addEventListener("click", event => {
      const t = event.target;
      const out = t.closest(".mo"); if (out) { activate(out.dataset.id); return; }
      const spine = t.closest(".spine"); if (spine) { activate(spine.dataset.id); return; }
      const rowEl = touch ? t.closest("[data-shelf-row]") : null;
      if (rowEl) {
        const row = packed.rows[Number(rowEl.dataset.shelfRow)], x = event.clientX - rowEl.getBoundingClientRect().left;
        const k = rowEl.getBoundingClientRect().width / rowEl.offsetWidth || 1;
        let best = null, dist = Infinity;
        for (const c of row.cells) { if (x / k < c.x - 2 || x / k > c.x + c.s + 2) continue; const d = Math.abs(c.x + c.s / 2 - x / k); if (d < dist) { dist = d; best = c; } }
        if (best) { activate(best.f.id); return; }
      }
      putBack(); onRead?.("");
    });
    if (picked) { const f = FILMS.find(x => x.t === picked); if (f) pull(f.id, false); }
    return { packed, scale, perRow: packed.rows[0]?.cells.length ?? 0 };
  }

  /* ---------- Fake shells ---------- */
  const P = {
    home: "m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25",
    photo: "m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Z",
    stack: "M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122",
    book: "M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25",
    doc: "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z",
    send: "M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5",
    search: "m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z",
    dots: "M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z",
    spark: "M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z",
    users: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z",
    cal: "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5",
    grid: "M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z",
    plus: "M12 4.5v15m7.5-7.5h-15",
    chart: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z",
  };
  const ic = (n, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[n]}"/></svg>`;
  function segmented(cells, active, extra = "") {
    return `<div class="ui-segmented ${extra}" role="radiogroup"><span class="ui-segmented__thumb"></span>${cells.map(([value, text]) =>
      `<button type="button" class="ui-segmented__cell" role="radio" aria-checked="${value === active}" ${value === active ? 'data-segmented-active="true"' : ""}><span class="ui-segmented__content"><span class="ui-segmented__label">${text}</span></span></button>`).join("")}</div>`;
  }
  function placeThumbs(root) {
    root.querySelectorAll(".ui-segmented").forEach(seg => {
      const cell = seg.querySelector("[data-segmented-active]"), th = seg.querySelector(".ui-segmented__thumb");
      if (!cell || !th) return;
      th.style.left = cell.offsetLeft + "px"; th.style.width = cell.offsetWidth + "px"; th.style.top = cell.offsetTop + "px"; th.style.height = cell.offsetHeight + "px";
    });
  }
  const TYPES = [["game", "게임"], ["manga", "만화"], ["movie", "영화"], ["av", "AV"]];

  function pcFrame(host, { opt, w, h, size, grouping, picked, fitTo }) {
    host.innerHTML = `<div class="frame" style="width:${w}px;height:${h}px"><div class="pc">
      <nav class="rail">${["home", "photo", "stack", "book", "doc", "send"].map((n, i) => `<span class="${i === 2 ? "on" : ""}">${ic(n)}</span>`).join("")}<span class="push">${ic("search")}</span><span>${ic("dots")}</span></nav>
      <div class="main">
        <header class="topbar"><span class="ttl">영화 <span class="count">${FILMS.length}</span></span><span class="grow"></span>
          <span class="ibtn">${ic("search")}</span><span class="ibtn">${ic("plus")}</span><span class="quiet">${ic("chart", "s")}상태</span><span class="winctl"><span>—</span><span>☐</span><span>✕</span></span></header>
        <div class="secbar">${segmented(TYPES, "movie")}<span class="grow"></span>
          <span class="quiet">${ic("spark", "s")}쇼케이스</span><span class="quiet">${ic("users", "s")}캐릭터</span><span class="quiet">${ic("cal", "s")}발매 캘린더</span><span class="vsep"></span><span class="quiet">${ic("grid", "s")}보기</span></div>
        <div class="scroll"><div class="shelf-host"></div></div>
      </div></div></div>`;
    const frame = host.firstElementChild;
    if (fitTo) { const k = fitTo / w; host.classList.add("frame-fit"); host.style.width = `${fitTo}px`; host.style.height = `${Math.round(h * k)}px`; frame.style.transform = `scale(${k})`; }
    placeThumbs(frame);
    const scroll = frame.querySelector(".scroll"), shelfHost = frame.querySelector(".shelf-host");
    const scale = scaleForView(opt, SCALE.pc[size], scroll.clientHeight);
    return { frame, info: mountShelf(shelfHost, { opt, scale, grouping, picked, onRead: host._onRead }), scale };
  }

  function tabletFrame(host, { opt, size, grouping, picked, fitTo }) {
    const w = 800, h = 1280;
    host.innerHTML = `<div class="frame" style="width:${w}px;height:${h}px;--control-height:44px;--control-height-compact:44px;--type-body:17px;--type-meta:13px;--type-title:22px"><div class="tab">
      <div class="tab-top"><span>컬렉션</span><span class="grow"></span>${ic("search")}${ic("dots")}</div>
      <div class="tab-sec">${segmented(TYPES, "movie")}${ic("spark")}${ic("users")}${ic("cal")}<span class="grow"></span>${ic("grid")}${ic("plus")}</div>
      <div class="scroll"><div class="shelf-host"></div></div>
      <nav class="tab-nav"><span>${ic("home")}홈</span><span>${ic("photo")}에셋</span><span class="on">${ic("stack")}컬렉션</span><span>${ic("book")}카탈로그</span><span>${ic("doc")}메모</span></nav>
    </div></div>`;
    const frame = host.firstElementChild, k = fitTo / w;
    host.classList.add("frame-fit"); host.style.width = `${fitTo}px`; host.style.height = `${Math.round(h * k)}px`; frame.style.transform = `scale(${k})`;
    placeThumbs(frame);
    const scroll = frame.querySelector(".scroll"), shelfHost = frame.querySelector(".shelf-host");
    const scale = scaleForView(opt, SCALE.tablet[size], scroll.clientHeight);
    return { frame, info: mountShelf(shelfHost, { opt, scale, grouping, picked, touch: true, onRead: host._onRead }), scale };
  }

  /* ---------- Anatomy strip ---------- */
  function anatomy(host, opt) {
    const scale = SCALE.pc.normal, pick = t => FILMS.find(f => f.t === t);
    const one = (f, cap, state = {}, extra = "", sc = scale) => { const size = px(opt, f, sc); return `<figure><div class="stand">${spineButton(opt, f, size, extra, state)}</div><figcaption>${cap}</figcaption></figure>`; };
    const notes = {
      A: `<p><b>머리</b> 개봉 연도(시리즈는 첫 방영 연도), 흰 인쇄 위 검정 숫자.</p><p><b>띠</b> 제목. 긴 제목은 끝을 줄임표로 자른다.</p><p><b>발</b> 제작사(<code>productionCompany</code>). 없으면 감독, 둘 다 없으면 비워 둔다.</p><p><b>케이스</b> 블루레이 크기(172 × 12mm), 위아래 립만 파란 플라스틱. 로고나 BD 표시는 넣지 않는다.</p>`,
      B: `<p><b>그림 창(위 41%)</b> 작품에 고른 포스터를 판 크기로 깔고, 초점 위치(기본 가운데)에서 책등 폭만큼 잘라 보인다. 만화 책장의 표지 조각과 같은 방법이다.</p><p><b>띠</b> 검정 위 흰 제목, <b>발</b> 개봉 연도.</p><p><b>높이</b> 포스터 비율 그대로: 2:3 포스터가 가장 크고, 일본 B2 비율은 조금 낮다.</p><p><b>포스터를 읽는 중</b> 그림 창만 무채색으로 두고 140ms에 그림이 들어온다. 제목 띠는 처음부터 제자리다.</p>`,
      C: `<p><b>번호</b> 영화를 컬렉션에 넣은 순서(1부터). 지운 번호는 다시 쓰지 않는다.</p><p><b>색</b> 포스터의 대표색을 어둡고 차분한 범위로 맞춘 한 가지 색. 흰 인쇄가 늘 읽힌다.</p><p><b>발</b> 감독.</p><p><b>케이스</b> 모두 같은 DVD 크기(190 × 14mm), 투명 플라스틱.</p>`,
    }[opt];
    host.innerHTML = `
      ${one(pick("조커"), "보통 · 짧은 제목")}
      ${one(pick("극장판 마크로스 프론티어: 거짓의 가희"), "긴 제목")}
      ${one(pick("이 멋진 세계에 축복을!"), "시리즈(TV)")}
      ${one(pick("하울의 움직이는 성"), opt === "B" ? "B2 포스터 · 낮다" : "B2 포스터")}
      ${one(pick("블레이드 러너 2049"), "올림(hover) 4px", {}, "force-hover")}
      ${one(pick("기생충"), opt === "B" ? "포스터 읽는 중 · 없음" : "읽는 중 · 플라스틱만", opt === "B" ? { settled: false } : { pending: true })}
      ${one(pick("올드보이"), "비공개 모드", { privacy: true })}
      ${one(pick("너의 이름은."), "크게 1.8", {}, "", SCALE.pc.large)}
      <div class="rules">${notes}</div>`;
    host.querySelectorAll(".force-hover .spine__case").forEach(c => { c.style.transform = "translateY(-4px)"; });
  }

  window.MovieSpines = { FILMS, OPTIONS, SCALE, SIZE_LABEL, pcFrame, tabletFrame, anatomy, segmented, placeThumbs, posterHTML, px, spineButton };
})();
