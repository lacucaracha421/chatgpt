// Mockup only: stand-in data for October 2026 (today = 2026-10-18, a Sunday) and the light interactions
// (select a day, privacy mode, holidays on/off, saved-image display). Markup uses the proposed cc-* classes.
(() => {
  const TODAY = "2026-10-18";
  const MONTH = "2026-10";
  const KIND = { manga: "망가", game: "게임", movie: "영화", anime: "애니" };
  const WEEK = "일월화수목금토";

  // Releases: kind, title, detail (volume), fresh = NEW since the last visit.
  const releases = {
    "2026-09-29": [{ kind: "manga", name: "던전밥", detail: "15권" }],
    "2026-10-02": [{ kind: "manga", name: "원피스", detail: "112권" }],
    "2026-10-07": [{ kind: "manga", name: "체인소 맨", detail: "23권" }],
    "2026-10-09": [{ kind: "manga", name: "약사의 혼잣말", detail: "15권" }],
    "2026-10-14": [{ kind: "game", name: "스플래툰 레이더스" }],
    "2026-10-15": [{ kind: "manga", name: "블루 록", detail: "34권", fresh: true }],
    "2026-10-16": [{ kind: "anime", name: "사카모토 데이즈 2쿨" }],
    "2026-10-18": [{ kind: "manga", name: "스파이 패밀리", detail: "16권", fresh: true }, { kind: "anime", name: "장송의 프리렌 2기" }],
    "2026-10-22": [{ kind: "game", name: "포켓몬 챔피언스" }],
    "2026-10-23": [{ kind: "movie", name: "극장판 주술회전 회옥·옥절" }],
    "2026-10-27": [{ kind: "manga", name: "단다단", detail: "23권" }],
    "2026-10-29": [{ kind: "movie", name: "하이큐!! 극장판 결전" }],
    "2026-10-30": [
      { kind: "game", name: "메트로이드 프라임 4" }, { kind: "manga", name: "원펀맨", detail: "33권" },
      { kind: "anime", name: "나 혼자만 레벨업 2기" }, { kind: "movie", name: "귀멸의 칼날 무한성편 2장" }, { kind: "manga", name: "던전밥", detail: "16권" },
    ],
    "2026-11-05": [{ kind: "game", name: "커비 에어 라이더스" }],
  };
  // Unconfirmed subscription charges (read-only).
  const payments = {
    "2026-10-21": [{ name: "클로드", amount: 159000 }],
    "2026-10-24": [{ name: "디즈니+", trial: true }],
    "2026-10-25": [{ name: "유튜브 프리미엄", amount: 14900 }],
    "2026-10-28": [{ name: "넷플릭스", amount: 17000 }],
    "2026-10-30": [{ name: "ChatGPT Plus", amount: 29000 }],
    "2026-11-01": [{ name: "쿠팡 와우", amount: 7890 }],
  };
  // Ledger entries (money out).
  const entries = {
    "2026-10-02": [{ name: "원피스 112권", amount: 5400 }],
    "2026-10-03": [{ name: "친구 점심", amount: 12000 }],
    "2026-10-05": [{ name: "웹툰 쿠키", amount: 9900 }],
    "2026-10-10": [{ name: "책 주문", amount: 48500 }],
    "2026-10-11": [{ name: "영화", amount: 15000 }, { name: "저녁", amount: 17000 }],
    "2026-10-15": [{ name: "점심", amount: 9800 }, { name: "커피", amount: 4500 }, { name: "택시", amount: 11500 }],
    "2026-10-17": [{ name: "편의점", amount: 9000 }],
    "2026-10-18": [{ name: "점심", amount: 8000 }],
  };
  const memos = {
    "2026-10-09": "도서관 반납",
    "2026-10-15": "치과 오후 2시",
    "2026-10-18": "택배 찾기 · 편의점",
    "2026-10-24": "엄마 생일",
    "2026-10-31": "할로윈 모임 7시",
  };
  const saved = {
    "2026-09-28": 8, "2026-09-30": 15, "2026-10-01": 4, "2026-10-02": 12, "2026-10-04": 30, "2026-10-05": 2, "2026-10-08": 7,
    "2026-10-10": 55, "2026-10-11": 18, "2026-10-13": 3, "2026-10-14": 9, "2026-10-15": 30, "2026-10-16": 21, "2026-10-17": 11, "2026-10-18": 6,
  };
  // Korean public holidays in this grid (the app has no holiday data yet; open question 1).
  const holidays = { "2026-10-03": "개천절", "2026-10-05": "대체공휴일", "2026-10-09": "한글날" };

  const won = n => `${n.toLocaleString("ko-KR")}원`;
  const money = (n, hide, symbol) => hide ? `<span class="cc-mask" aria-label="금액 숨김">••••</span>` : (symbol ? `₩${n.toLocaleString("ko-KR")}` : won(n));
  const addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dow = date => new Date(`${date}T12:00:00Z`).getUTCDay();
  const spentOf = date => (entries[date] || []).reduce((s, e) => s + e.amount, 0);

  // 42 days from the Sunday on or before the 1st.
  const first = `${MONTH}-01`;
  const start = addDays(first, -dow(first));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));

  // Rank-based eight-step heat (the app's savedHeat).
  const counts = days.map(d => (d <= TODAY ? saved[d] || 0 : 0)).filter(c => c > 0).sort((a, b) => a - b);
  const heat = c => c <= 0 ? 0 : 1 + Math.min(7, Math.floor(8 * counts.filter(v => v < c).length / counts.length));

  const ICON_MEMO = `<svg class="cc-memo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>`;
  const ICON_REPEAT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>`;
  const ICON_WALLET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3"/></svg>`;
  const ICON_PHOTO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Z"/></svg>`;
  const ICON_LEFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15.75 19.5 8.25 12l7.5-7.5"/></svg>`;
  const ICON_RIGHT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>`;
  const ICON_CHEVRON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>`;

  const state = { selected: TODAY, privacy: false, sheetDay: "2026-10-30" };

  // A cell shows at most three lines of entries: all of them when they fit, else two and "+N".
  const MAX_LINES = 3;
  function chips(date, hide) {
    const items = [
      ...[...(releases[date] || [])].sort((a, b) => Number(!!b.fresh) - Number(!!a.fresh)).map(r =>
        `<span class="cc-chip" data-kind="${r.kind}"${r.fresh ? " data-new" : ""}><span class="cc-chip__title">${r.name}</span>${r.detail ? `<span class="cc-chip__detail">${r.detail}</span>` : ""}</span>`),
      ...(payments[date] || []).map(p =>
        `<span class="cc-chip cc-chip--pay"${p.trial ? " data-trial" : ""}>${ICON_REPEAT}<span class="cc-chip__title">${p.name}</span><span class="cc-chip__detail">${p.trial ? "무료 끝남" : money(p.amount, hide)}</span></span>`),
    ];
    if (items.length <= MAX_LINES) return items.join("");
    return items.slice(0, MAX_LINES - 1).join("") + `<span class="cc-more">+${items.length - (MAX_LINES - 1)}</span>`;
  }

  function cell(date) {
    const d = Number(date.slice(8));
    const inMonth = date.startsWith(MONTH);
    const head = d === 1 ? `${Number(date.slice(5, 7))}.1` : d;
    const s = date <= TODAY ? saved[date] || 0 : 0;
    const spent = spentOf(date);
    const hide = state.privacy;
    const attrs = [
      `data-day="${date}"`, `data-dow="${dow(date)}"`, inMonth ? "" : "data-outside", date === TODAY ? "data-today" : "",
      holidays[date] ? "data-holiday" : "", heat(s) ? `data-heat="${heat(s)}"` : "", `aria-selected="${date === state.selected}"`,
    ].filter(Boolean).join(" ");
    const foot = (s || spent) ? `<span class="cc-foot">${s ? `<span class="cc-saved">${ICON_PHOTO}${s}</span>` : ""}${spent ? `<span class="cc-spent">${ICON_WALLET}${money(spent, hide)}</span>` : ""}</span>` : "";
    return `<button type="button" class="cc-day" ${attrs}>
      <span class="cc-top"><span class="cc-date">${head}</span>${holidays[date] ? `<span class="cc-holiday">${holidays[date]}</span>` : ""}${memos[date] ? ICON_MEMO : ""}</span>
      <span class="cc-chips">${chips(date, hide)}</span>${foot}</button>`;
  }

  function month(tablet) {
    const hide = state.privacy;
    const spent = Object.entries(entries).filter(([d]) => d.startsWith(MONTH)).reduce((s, [, list]) => s + list.reduce((t, e) => t + e.amount, 0), 0);
    const planned = Object.entries(payments).filter(([d]) => d.startsWith(MONTH) && d > TODAY).reduce((s, [, list]) => s + list.reduce((t, p) => t + (p.amount || 0), 0), 0);
    return `<section class="cc-month" aria-label="달력">
      <div class="cc-head">
        <h2 class="cc-title">10월</h2>
        <span class="cc-nav"><button type="button" class="cc-icon-button" aria-label="이전 달">${ICON_LEFT}</button><button type="button" class="cc-text-button" ${state.selected === TODAY ? "disabled" : ""} data-today-button>오늘</button><button type="button" class="cc-icon-button" aria-label="다음 달">${ICON_RIGHT}</button></span>
        <span class="cc-spacer"></span>
        <dl class="cc-totals"><div><dt>쓴 돈</dt><dd>${money(spent, hide, true)}</dd></div><div><dt>예정</dt><dd>${money(planned, hide, true)}</dd></div></dl>
        ${tablet ? "" : `<button type="button" class="cc-link">발매 캘린더${ICON_CHEVRON}</button>`}
      </div>
      <div class="cc-grid" role="grid" aria-label="10월">
        ${[...WEEK].map((w, i) => `<span class="cc-weekday" data-dow="${i}" role="columnheader">${w}</span>`).join("")}
        ${days.map(cell).join("")}
      </div>
    </section>`;
  }

  function panel(date) {
    const hide = state.privacy;
    const [, m, d] = date.split("-").map(Number);
    const rel = [...(releases[date] || [])].sort((a, b) => Number(!!b.fresh) - Number(!!a.fresh));
    const ent = entries[date] || [];
    const pay = (payments[date] || []).filter(p => !p.trial);
    const total = ent.reduce((s, e) => s + e.amount, 0) + pay.reduce((s, p) => s + p.amount, 0);
    const daysLeft = Math.round((Date.parse(date) - Date.parse(TODAY)) / 86400000);
    const s = date <= TODAY ? saved[date] || 0 : 0;
    
    return `<div class="day__head"><h3 class="day__title">${m}월 ${d}일 <span>(${WEEK[dow(date)]})</span></h3>${date === TODAY ? `<span class="badge badge--accent">오늘</span>` : `<button type="button" class="cc-link" data-today-button>오늘로</button>`}</div>
      ${holidays[date] ? `<div class="empty-line" style="color:var(--cal-sun)">${holidays[date]}</div>` : ""}
      ${rel.length ? `<div class="sec"><div class="sec__label">발매 ${rel.length}</div>${rel.map(r => `<div class="row"><span class="row__cover" data-kind="${r.kind}"></span><span class="row__copy"><span>${r.name}</span><small>${KIND[r.kind]}${r.detail ? ` · ${r.detail}` : ""}</small></span>${r.fresh ? `<span class="badge badge--accent">NEW</span>` : daysLeft > 0 ? `<span class="badge">D-${daysLeft}</span>` : ""}</div>`).join("")}</div>` : ""}
      ${s ? `<div class="sec"><div class="sec__label">저장한 이미지</div><div class="row">${ICON_PHOTO}<span class="row__copy"><span>${s}장</span></span>${ICON_CHEVRON}</div></div>` : ""}
      <div class="sec"><div class="sec__label">메모</div><div class="memo">${memos[date] || ""}</div></div>
      <div class="sec"><div class="sec__label">가계부${total ? `<b>${money(total, hide, true)}</b>` : ""}</div>
        ${ent.length || pay.length ? [...ent.map(e => `<div class="row"><span class="row__copy"><span>${e.name}</span></span><span class="row__amount">${money(e.amount, hide, true)}</span></div>`),
          ...pay.map(p => `<div class="row row--derived">${ICON_REPEAT}<span class="row__copy"><span>${p.name}</span><small>고정·구독 자동</small></span><span class="row__amount">${money(p.amount, hide, true)}</span></div>`)].join("") : `<div class="empty-line">기록 없음</div>`}
        <div class="quick"><span>예: 점심 8000</span><b>추가</b></div>
      </div>`;
  }

  function render() {
    document.querySelectorAll("[data-cal]").forEach(host => { host.innerHTML = month(host.dataset.cal === "tablet"); });
    document.querySelectorAll("[data-panel]").forEach(host => { host.innerHTML = panel(host.dataset.panel === "sheet" ? state.sheetDay : state.selected); });
    // The sheet frame shows the busy day selected beneath it.
    document.querySelectorAll("[data-cal-selected]").forEach(host => {
      host.querySelectorAll(".cc-day").forEach(cell => cell.setAttribute("aria-selected", String(cell.dataset.day === host.dataset.calSelected)));
    });
  }

  document.addEventListener("click", event => {
    const t = event.target.closest("button");
    if (!t) return;
    if (t.matches(".cc-day") && !t.closest("[data-cal-selected]")) { state.selected = t.dataset.day; render(); }
    else if (t.matches("[data-today-button]")) { state.selected = TODAY; render(); }
    else if (t.dataset.set) {
      const [key, value] = t.dataset.set.split(":");
      if (key === "privacy") state.privacy = value === "on"; else document.documentElement.dataset[key] = value;
      document.querySelectorAll(`[data-set^="${key}:"]`).forEach(b => b.setAttribute("aria-pressed", String(b === t)));
      render();
    }
  });
  // Arrow keys move the selection (the grid's roving focus is the app's; here only the selection moves).
  document.addEventListener("keydown", event => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (!step || !event.target.closest(".cc-day")) return;
    event.preventDefault();
    const next = addDays(state.selected, step);
    if (!days.includes(next)) return;
    state.selected = next; render();
    document.querySelector(`[data-cal="pc"] [data-day="${next}"]`)?.focus();
  });

  const params = new URLSearchParams(location.search);
  if (params.get("day")) state.selected = params.get("day");
  if (params.get("privacy") === "on") state.privacy = true;
  if (params.get("saved")) document.documentElement.dataset.savedMode = params.get("saved");
  if (params.get("tabletzoom")) document.documentElement.style.setProperty("--tablet-zoom", params.get("tabletzoom"));
  if (params.get("chips")) document.documentElement.dataset.chipMode = params.get("chips");
  if (params.get("holidays")) document.documentElement.dataset.holidays = params.get("holidays");
  document.querySelectorAll("[data-set]").forEach(b => {
    const [key, value] = b.dataset.set.split(":");
    const current = key === "privacy" ? (state.privacy ? "on" : "off") : document.documentElement.dataset[key];
    b.setAttribute("aria-pressed", String(current === value));
  });
  render();
})();
