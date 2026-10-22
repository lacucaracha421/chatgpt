/* Mockup behaviour for HOME-CAL-001 (2026-10-17). Stand-in data; the rules are the proposal (README.md).
   Used by index.html (PC frames) and tablet.html (one tablet frame, chosen by the URL hash). */
(() => {
'use strict';

/* ---------- Icons (Heroicons outline paths, as the app imports them) ---------- */
const P = {
  photo: 'm2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z',
  chevL: 'M15.75 19.5 8.25 12l7.5-7.5',
  chevR: 'm8.25 4.5 7.5 7.5-7.5 7.5',
  doc: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
  wallet: 'M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3',
  repeat: 'M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3',
  updown: 'M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5',
  check: 'm4.5 12.75 6 6 9-13.5',
  plus: 'M12 4.5v15m7.5-7.5h-15',
  x: 'M6 18 18 6M6 6l12 12',
  home: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  stack: 'M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122',
  book: 'M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25',
  memo: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10',
  swap: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
  search: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  dots: 'M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z',
  cloud: 'M2.25 15a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.332-7.257 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 15Z',
  min: 'M5 12h14', max: 'M5 5h14v14H5z',
};
const svg = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[name]}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => new Intl.NumberFormat('ko-KR').format(n);
const won = (n) => `₩${fmt(n)}`;            // notes/ledger/model.ts won()
const wonText = (n) => `${fmt(n)}원`;        // displayCount(amount, "원"), the calendar's payment label
const MASK = '<span class="home-mask" aria-label="금액 숨김">••••</span>';
const ph = (n) => `<span class="ph p${((n - 1) % 12) + 1}"></span>`;

/* ---------- Dates ---------- */
const TODAY = '2026-10-17';
const utc = (d) => { const [y, m, day] = d.split('-').map(Number); return Date.UTC(y, m - 1, day); };
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(utc(d) + n * 86400000);
const mondayOf = (d) => addDays(d, -((new Date(utc(d)).getUTCDay() + 6) % 7));
const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
const WEEK = ['월', '화', '수', '목', '금', '토', '일'];
const weekday = (d) => WEEK[(new Date(utc(d)).getUTCDay() + 6) % 7];
const dayNum = (d) => Number(d.slice(8));
const monthNum = (d) => Number(d.slice(5, 7));
const longDate = (d) => `${monthNum(d)}월 ${dayNum(d)}일`;
const monthLabel = (m) => (m.slice(0, 4) === TODAY.slice(0, 4) ? `${Number(m.slice(5))}월` : `${Number(m.slice(0, 4))}년 ${Number(m.slice(5))}월`);
const shiftMonth = (m, n) => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5)) - 1 + n; const d = new Date(Date.UTC(y, mo, 1)); return d.toISOString().slice(0, 7); };
const dday = (date) => { const n = daysBetween(TODAY, date); return n < 0 ? null : n === 0 ? '오늘' : `D-${n}`; };

/* ---------- Stand-in data (shapes follow the app's sources; see README "Data") ---------- */
// Saved-image counts: listAssetDateBuckets, past days and today only.
const SAVED = { '2026-09-28': 22, '2026-09-29': 8, '2026-09-30': 41, '2026-10-01': 15, '2026-10-02': 30, '2026-10-03': 64, '2026-10-04': 12,
  '2026-10-05': 9, '2026-10-06': 27, '2026-10-07': 18, '2026-10-08': 33, '2026-10-09': 7, '2026-10-10': 52, '2026-10-11': 140,
  '2026-10-12': 21, '2026-10-13': 16, '2026-10-14': 38, '2026-10-15': 30, '2026-10-16': 25, '2026-10-17': 11 };
// Releases: local manga volumes + wishlist titles with an exact date (homeModel upcomingRows / newlyReleasedRows).
const R = (date, name, kind, cover, extra = {}) => ({ date, name, kind, cover, ...extra });
const RELEASES = [
  R('2026-10-02', '원피스', 'manga', 4, { volume: 112 }),
  R('2026-10-09', '사일런트 힐 f', 'game', 10),
  R('2026-10-15', '체인소 맨', 'manga', 9, { volume: 22, fresh: true }),
  R('2026-10-20', '사이버펑크: 엣지러너 2', 'anime', 7),
  R('2026-10-23', '귀멸의 칼날: 무한성편 2', 'movie', 3),
  R('2026-10-30', '메트로이드 프라임 4', 'game', 5),
  R('2026-10-30', '주술회전', 'manga', 1, { volume: 30 }),
  R('2026-10-30', '스파이 패밀리', 'manga', 6, { volume: 16 }),
  R('2026-10-30', '던전밥 공식 가이드', 'manga', 12),
  R('2026-10-30', '진격의 거인 완결편 극장판', 'movie', 8),
  R('2026-11-05', '듄: 파트 3', 'movie', 2),
  R('2026-11-13', '약사의 혼잣말', 'manga', 11, { volume: 15 }),
  R('2026-11-20', '포켓몬 레전드 Z-A', 'game', 9),
  R('2026-09-30', '나 혼자만 레벨업 2기', 'anime', 1),
];
const KIND = { game: '게임', movie: '영화', anime: '애니', manga: '만화' };
const detailOf = (r) => (r.volume ? `${r.volume}권` : KIND[r.kind]);
// Subscription charges not yet confirmed in the 가계부 (calendarPayments): read-only on Home.
const CHARGES = [
  { date: '2026-10-21', name: '클로드', amount: 159000 },
  { date: '2026-10-25', name: '유튜브 프리미엄', amount: 14900 },
  { date: '2026-10-28', name: '디즈니+', amount: 9900 },
  { date: '2026-11-01', name: 'iCloud+', amount: 4400 },
  { date: '2026-11-05', name: '넷플릭스', amount: 17000 },
];
// 가계부 entries (LedgerEntry in the month notes). `recurring` = a confirmed subscription charge.
let seq = 0;
const E = (date, name, amount, extra = {}) => ({ id: `e${++seq}`, date, name, amount, ...extra });
const ENTRIES = [
  E('2026-10-01', 'iCloud+', 4400, { recurring: true }), E('2026-10-03', '다이소', 6000), E('2026-10-05', '넷플릭스', 17000, { recurring: true }),
  E('2026-10-08', '점심', 9000), E('2026-10-10', '사일런트 힐 f 할인', 32000), E('2026-10-13', '점심', 9500),
  E('2026-10-15', '점심', 8000), E('2026-10-15', '체인소 맨 22권', 5500), E('2026-10-15', '택시', 12300),
  E('2026-10-16', '커피', 4800), E('2026-10-17', '점심', 8500),
];
// Day memos (one short note per day).
const MEMOS = {
  '2026-10-03': '가을 옷 정리. 겨울 이불 꺼내기',
  '2026-10-10': '할인 끝나기 전에 사일런트 힐 f 샀음',
  '2026-10-15': '체인소 맨 22권 서점에서 삼. 23권은 1월 예정',
  '2026-10-17': '엣지러너 2 나오기 전에 1기 다시 보기',
  '2026-10-24': '지민 생일 선물 고르기',
};

const releasesOn = (d) => RELEASES.filter((r) => r.date === d).sort((a, b) => Number(!!b.fresh) - Number(!!a.fresh));
const chargesOn = (d) => CHARGES.filter((c) => c.date === d);
const entriesOn = (d) => ENTRIES.filter((e) => e.date === d);
const spentOn = (d) => entriesOn(d).reduce((s, e) => s + e.amount, 0);
function monthTotals(month) {
  const spent = ENTRIES.filter((e) => e.date.startsWith(month)).reduce((s, e) => s + e.amount, 0);
  const planned = CHARGES.filter((c) => c.date.startsWith(month)).reduce((s, c) => s + c.amount, 0);
  return { spent, planned };
}

/* ---------- Month grid (src/home/HomeCalendar.tsx, month variant) ---------- */
function monthDays(month) {
  const start = mondayOf(`${month}-01`);
  const thisWeek = mondayOf(TODAY);
  return Array.from({ length: 42 }, (_, i) => {
    const date = addDays(start, i);
    const n = daysBetween(TODAY, date);
    return { date, outside: !date.startsWith(month), tense: n < 0 ? 'past' : n === 0 ? 'today' : 'future', currentWeek: mondayOf(date) === thisWeek };
  });
}
function cell(day, st) {
  const { date } = day;
  const rel = releasesOn(date), pays = chargesOn(date), spent = spentOn(date), memo = !!MEMOS[date];
  const saved = day.tense !== 'future' ? SAVED[date] ?? 0 : 0;
  const selected = date === st.selected;
  const head = `<span class="home-cal__head"><span class="home-cal__date numeric">${dayNum(date) === 1 ? `${monthNum(date)}.1` : dayNum(date)}</span>`
    + (saved ? `<span class="home-cal__saved">${svg('photo')}<span class="numeric">${fmt(saved)}</span>장</span>` : '')
    + (day.tense === 'future' && rel.length ? `<span class="ui-badge ui-badge--plain ui-dday">${dday(date)}</span>` : '')
    + '</span>';
  const first = rel[0];
  const line = first ? `<span class="home-cal__line">${first.fresh ? '<span class="ui-badge ui-badge--accent">NEW</span>' : ''}<b>${esc(first.name)}</b>${rel.length === 1 ? `<small>${detailOf(first)}</small>` : `<span class="ui-badge ui-badge--plain numeric">+${rel.length - 1}</span>`}</span>` : '';
  const pay = pays.length ? `<span class="home-cal__pay">${svg('repeat')}<span>${esc(pays[0].name)} ${st.privacy ? MASK : wonText(pays[0].amount)}</span>${pays.length > 1 ? `<span class="ui-badge ui-badge--plain numeric">+${pays.length - 1}</span>` : ''}</span>` : '';
  const foot = (memo || spent) ? `<span class="home-cal__foot">${memo ? `<span aria-label="메모 있음" style="display:inline-flex">${svg('doc')}</span>` : ''}${spent ? `<span class="home-cal__spent">${svg('wallet')}<span class="numeric">${st.privacy ? MASK : wonText(spent)}</span></span>` : ''}</span>` : '';
  const label = [`${longDate(date)} ${weekday(date)}요일`, rel.length ? `발매 ${rel.length}개` : '', saved ? `저장 ${saved}장` : '', memo ? '메모 있음' : '', spent && !st.privacy ? `지출 ${wonText(spent)}` : ''].filter(Boolean).join(', ');
  return `<button type="button" class="home-cal__day" role="gridcell" data-day="${date}" data-tense="${day.tense}" ${rel.length ? 'data-has' : ''} ${day.outside ? 'data-outside' : ''} ${day.currentWeek ? 'data-week="current"' : ''} aria-selected="${selected}" tabindex="${selected ? 0 : -1}" aria-label="${label}">${head}${line}${pay}${foot}</button>`;
}
function monthSection(st) {
  const t = monthTotals(st.month);
  const atToday = st.month === TODAY.slice(0, 7) && st.selected === TODAY;
  const totals = `<dl class="home-month__totals" aria-label="${monthLabel(st.month)} 가계부"><div><dt>쓴 돈</dt><dd class="numeric">${st.privacy ? MASK : won(t.spent)}</dd></div>${t.planned ? `<div><dt>예정</dt><dd class="numeric">${st.privacy ? MASK : won(t.planned)}</dd></div>` : ''}</dl>`;
  return `<section class="home-month" aria-label="달력">
    <div class="home-month__head">
      <h2 class="home-month__title">${monthLabel(st.month)}</h2>
      <span class="home-month__nav">
        <button type="button" class="ui-button ui-button--ghost ui-button--icon ui-icon-button" aria-label="이전 달" data-act="prev">${svg('chevL')}</button>
        <button type="button" class="ui-button ui-button--quiet ui-button--md" data-act="today" ${atToday ? 'disabled' : ''}>오늘</button>
        <button type="button" class="ui-button ui-button--ghost ui-button--icon ui-icon-button" aria-label="다음 달" data-act="next">${svg('chevR')}</button>
      </span>
      <span class="home-month__spacer"></span>
      ${totals}
      <button type="button" class="home-link" data-act="calendar">발매 캘린더${svg('chevR')}</button>
    </div>
    <div class="home-cal home-cal--month" role="grid" aria-label="${monthLabel(st.month)}">
      ${WEEK.map((w, i) => `<span class="home-cal__weekday" ${i > 4 ? 'data-weekend' : ''}>${w}</span>`).join('')}
      ${monthDays(st.month).map((d) => cell(d, st)).join('')}
    </div>
  </section>`;
}

/* ---------- Day panel (src/home/HomeDay.tsx) ---------- */
const sectionLabel = (title, { count, actions } = {}) => `<div class="ui-section-label"><span class="ui-section-label__title">${title}</span>${count !== undefined ? ` <span class="ui-section-label__count">${fmt(count)}</span>` : ''}<span class="ui-section-label__rule" aria-hidden="true"></span>${actions ? `<span class="ui-section-label__actions">${actions}</span>` : ''}</div>`;
function releaseRows(date, st) {
  const rel = releasesOn(date);
  if (!rel.length) return '';
  return `<section class="home-attention-section" aria-label="발매">${sectionLabel('발매', { count: rel.length })}<div>${rel.map((r) => {
    const badge = r.fresh ? '<span class="ui-badge ui-badge--accent">NEW</span>' : dday(r.date) ? `<span class="ui-badge ${dday(r.date) === '오늘' ? 'ui-badge--accent' : 'ui-badge--plain'} ui-dday">${dday(r.date)}</span>` : '';
    return `<button type="button" class="home-arrival-row"><span class="home-arrival-cover">${st.privacy ? '<span class="privacy-mask"></span>' : ph(r.cover)}</span><span class="home-attention-copy"><span>${esc(r.name)}</span><small>${detailOf(r)}</small></span>${badge}</button>`;
  }).join('')}</div></section>`;
}
function savedRow(date) {
  const saved = daysBetween(TODAY, date) <= 0 ? SAVED[date] ?? 0 : 0;
  if (!saved) return '';
  return `<button type="button" class="home-attention-row home-day__saved"><span class="home-attention-mark" aria-hidden="true">${svg('photo')}</span><span class="home-attention-copy"><span>저장한 이미지</span></span><span class="home-attention-value numeric">${fmt(saved)}장</span>${svg('chevR')}</button>`;
}
function memoBlock(date, st) {
  return `<section class="home-attention-section" aria-label="메모">${sectionLabel('메모')}<div><textarea class="ui-text-input home-day__memo" rows="3" spellcheck="false" aria-label="${longDate(date)} 메모" data-memo="${date}">${esc(MEMOS[date] ?? '')}</textarea></div></section>`;
}
function entryRow(e, st) {
  if (st.editing === e.id) {
    return `<li class="ledger-entry"><div class="ledger-entry-form" role="group" aria-label="기록 고치기"><div class="ledger-entry-form__row">
      <input class="ledger-input ledger-entry-form__date" aria-label="날짜" value="${e.date.slice(5)}">
      <span class="ledger-input ledger-amount-input ledger-entry-form__amount"><button type="button" tabindex="-1" class="ledger-kind" aria-pressed="false">나간 돈</button><span aria-hidden="true">₩</span><input aria-label="금액" inputmode="numeric" value="${fmt(e.amount)}"></span>
      <input class="ledger-input ledger-entry-form__name" aria-label="이름" placeholder="이름 (선택)" value="${esc(e.name)}">
      <button type="button" class="ui-button ui-button--primary ui-button--md">저장</button><button type="button" class="ui-button ui-button--ghost ui-button--md" data-act="cancel-edit">취소</button><button type="button" class="ui-button ui-button--ghost ui-button--md">삭제</button>
    </div></div></li>`;
  }
  const amount = st.privacy ? MASK : won(e.amount);
  return `<li class="ledger-entry" ${st.fresh === e.id ? 'data-fresh' : ''}><button type="button" class="ledger-entry__main" data-edit="${e.id}"><span class="ledger-entry__icon" aria-hidden="true">${e.recurring ? svg('repeat') : ''}</span><span class="ledger-entry__name">${esc(e.name)}</span><span class="ledger-entry__tag">${e.recurring ? '고정·구독 확정' : ''}</span><span class="ledger-entry__amount">${amount}</span></button></li>`;
}
function chargeRow(c, st) {
  // Read-only on Home: nothing is entered twice. Confirming stays in 메모 › 가계부.
  return `<li class="ledger-entry is-derived"><span class="ledger-entry__main" role="group" aria-label="${esc(c.name)} 결제 예정"><span class="ledger-entry__icon" aria-hidden="true">${svg('repeat')}</span><span class="ledger-entry__name">${esc(c.name)}</span><span class="ledger-entry__tag">고정·구독 자동</span><span class="ledger-entry__amount">${st.privacy ? MASK : won(c.amount)}</span></span></li>`;
}
function ledgerBlock(date, st, { tablet = false } = {}) {
  const entries = entriesOn(date), charges = chargesOn(date);
  const total = entries.reduce((s, e) => s + e.amount, 0) + charges.reduce((s, c) => s + c.amount, 0);
  const sum = (entries.length || charges.length) ? `<span class="home-day__sum">${st.privacy ? MASK : won(total)}</span>` : '';
  const rows = entries.length || charges.length
    ? `<ul class="ledger-items">${entries.map((e) => entryRow(e, st)).join('')}${charges.map((c) => chargeRow(c, st)).join('')}</ul>`
    : '<p class="ui-empty-state ui-empty-state--inline ledger-empty" style="margin:0">기록 없음</p>';
  const add = tablet
    ? `<button type="button" class="ui-button ui-button--ghost ui-button--md home-day__add">${svg('plus')}기록 추가</button>`
    : `<div class="ledger-quick"><input class="ui-text-input" aria-label="지출 빠른 입력" placeholder="예: 점심 8000" data-quick="${date}"><button type="button" class="ui-button ui-button--quiet ui-button--sm" data-act="quick-add">추가</button></div>`;
  return `<section class="home-attention-section" aria-label="가계부">${sectionLabel('가계부', { actions: sum })}<div>${rows}${add}</div></section>`;
}
function dayPanel(st, { tablet = false } = {}) {
  const d = st.selected;
  const n = daysBetween(TODAY, d);
  const when = n === 0 ? '<span class="ui-badge ui-badge--accent ui-dday">오늘</span>' : '';
  const back = n !== 0 && !tablet ? '<button type="button" class="home-link" data-act="today">오늘로</button>' : '';
  const media = `${releaseRows(d, st)}${savedRow(d)}`;
  const body = tablet
    ? `${media}${memoBlock(d, st)}${ledgerBlock(d, st, { tablet })}`
    : `<div class="home-day__col">${media || '<span hidden></span>'}</div><div class="home-day__col">${memoBlock(d, st)}</div><div class="home-day__col">${ledgerBlock(d, st)}</div>`;
  if (tablet) return body;
  return `<aside class="home-day" aria-label="${longDate(d)} (${weekday(d)})">
    <header class="home-day__head"><h3 class="home-day__title">${longDate(d)} <span>(${weekday(d)})</span></h3>${when}${back}</header>
    <div class="home-day__body">${body}</div>
  </aside>`;
}

/* ---------- Right column (오늘의 카드 → 오늘 할 것 → 전송 → 빠른 메모) ---------- */
function todayRows(st) {
  const rows = [
    { mark: '○', label: `구독 이번 달 ${st.privacy ? MASK : won(205100)}`, secondary: '다음 결제 D-4 · 클로드', value: '5개' },
    { mark: '○', label: '클로드 결제', secondary: `10.21 · ${st.privacy ? MASK : won(159000)}`, dday: 'D-4' },
    { mark: '□', label: '미분류 에셋', value: '128' },
    { mark: '□', label: '유사 이미지 검토', value: '6쌍' },
    { mark: '□', label: '확인', value: '41' },
    { mark: '○', label: '이번 주 할 일', secondary: '남은 항목 3개', value: '3' },
  ];
  return `<section class="home-attention-section" aria-label="오늘 할 것">${sectionLabel('오늘 할 것', { count: rows.length })}<div>${rows.map((r) => `<div><button type="button" class="home-attention-row"><span class="home-attention-mark" aria-hidden="true">${r.mark}</span><span class="home-attention-copy"><span>${r.label}</span>${r.secondary ? `<small>${r.secondary}</small>` : ''}</span>${r.dday ? `<span class="ui-badge ui-badge--plain ui-dday">${r.dday}</span>` : `<span class="home-attention-value numeric">${r.value}</span>`}</button></div>`).join('')}</div></section>`;
}
const dailyCard = () => `<section class="home-attention-section home-daily-card is-compact" aria-label="오늘의 카드">${sectionLabel('오늘의 카드', { actions: '<button type="button" class="ui-button ui-button--quiet ui-button--md">앨범 34/120</button>' })}
  <div class="home-daily-card__body daily-card-stage"><div class="daily-card-stage__art"><span class="stand-pack"></span></div><div class="daily-card-stage__copy"><p>남은 팩 1</p><button type="button" class="ui-button ui-button--primary ui-button--md">뜯기</button><small>05:00에 새 팩</small></div></div></section>`;
const transfer = () => `<section class="home-attention-section home-tool home-transfer" aria-label="전송">${sectionLabel('전송', { actions: `<button type="button" class="home-link">상세${svg('chevR')}</button>` })}
  <div class="home-tool__body"><button type="button" class="home-drop" aria-label="놓으면 Galaxy Tab S9(으)로 보냅니다">${svg('updown')}</button>
  <div class="home-sent">${[['check', '스크린샷 2026-10-17.png', '태블릿으로 · 14:02'], ['check', 'edgerunners_ost.zip', '태블릿에서 · 어제 21:45'], ['check', '영수증_1015.pdf', '태블릿으로 · 10.15']].map(([i, n, m]) => `<div class="home-sent__row">${svg(i)}<span>${n}</span><small class="numeric">${m}</small></div>`).join('')}</div></div></section>`;
const quickMemo = () => `<section class="home-attention-section home-tool home-qmemo" aria-label="빠른 메모">${sectionLabel('빠른 메모')}<div class="home-tool__body"><textarea class="ui-text-input home-qmemo__text" rows="6" spellcheck="false" aria-label="빠른 메모">주말: 엣지러너 1기 정주행
태블릿 캘린더 확인
픽시브 랭킹 정리</textarea></div></section>`;

/* ---------- PC window ---------- */
function pcWindow(st) {
  return `<div class="frame pc" style="width:${st.w}px;height:${st.h}px">
    <div class="workspace-navigation"><nav class="workspace-rail" aria-label="주요 영역">
      <span class="workspace-mark"><span class="mark"></span></span>
      ${[['home', '홈', 1], ['photo', '에셋'], ['stack', '컬렉션'], ['book', '망가'], ['memo', '메모'], ['swap', '전송']].map(([i, l, on]) => `<button type="button" class="workspace-rail__item"${on ? ' aria-current="page"' : ''}>${svg(i)}<span>${l}</span></button>`).join('')}
      <div class="workspace-rail__tail"><button type="button" class="workspace-rail__item">${svg('search')}<span>찾기</span></button><button type="button" class="workspace-rail__item">${svg('dots')}<span>더보기</span></button></div>
    </nav></div>
    <div class="workspace-content">
      <div class="workspace-titlebar"><div class="workspace-titlebar__context"><header class="view-toolbar view-toolbar--context" role="toolbar"><h2 aria-description="홈"><span class="home-title-date"><span class="numeric">10.17</span> 토</span></h2></header></div>
        <span class="status-dot">${svg('cloud')}</span><div class="window-controls"><span>${svg('min')}</span><span>${svg('max')}</span><span>${svg('x')}</span></div></div>
      <div class="home-view${st.privacy ? ' is-private' : ''}"><div class="home-scroll" data-scroll><div class="home-content home-pc-layout">
        <div class="home-media-column"><div class="home-month-layout"><div class="home-month-split">${monthSection(st)}${dayPanel(st)}</div></div></div>
        <div class="home-day-column">${dailyCard()}${todayRows(st)}${transfer()}${quickMemo()}</div>
      </div></div></div>
    </div>
  </div>`;
}

/* ---------- Tablet (portrait 800 × 1280) ---------- */
// mobile-client/cards/TabletDailyCard.tsx and homeTablet/TabletTransfer.tsx markup.
const tabletCard = () => `<section class="home-attention-section" aria-label="오늘의 카드">${sectionLabel('오늘의 카드', { actions: '<button type="button" class="ui-button ui-button--ghost ui-button--sm tablet-cards__album">앨범 34/120</button>' })}<div><div class="tablet-daily-card">
  <button type="button" class="tablet-daily-card__art tablet-daily-card__pack" aria-label="오늘의 카드 팩 열기"><span class="stand-pack"></span></button>
  <div class="tablet-daily-card__copy"><p>남은 팩 1</p><button type="button" class="ui-button ui-button--primary ui-button--md">뜯기</button><small>05:00에 새 팩</small></div></div></div></section>`;
const tabletTransfer = () => `<section class="home-attention-section home-tool home-tab-transfer" aria-label="전송">${sectionLabel('전송', { actions: `<button type="button" class="home-link">상세${svg('chevR')}</button>` })}
  <div class="home-tool__body"><button type="button" class="home-tab-transfer__send">${svg('updown')}<span>데스크톱으로 보내기</span></button>
  <ul class="home-tab-sent" aria-label="최근 보낸 파일"><li><span>스크린샷 2026-10-17.png</span><small>PC로 · 보냄</small></li><li><span>edgerunners_ost.zip</span><small>PC에서 · 받음</small></li><li><span>영수증_1015.pdf</span><small>PC로 · 보냄</small></li></ul></div></section>`;
const NAV = [['홈', 'home'], ['에셋', 'photo'], ['컬렉션', 'stack'], ['카탈로그', 'book'], ['메모', 'memo']];
function tabletScreen(st) {
  const sheet = st.sheet ? `<div class="ui-dialog__overlay" data-state="open" data-act="close-sheet"></div>
    <div class="ui-dialog" role="dialog" data-state="open"><h2 class="ui-dialog__title">${longDate(st.selected)} <span class="muted">(${weekday(st.selected)})</span></h2>
      <div class="library-sheet"><div class="home-day-sheet">${dayPanel(st, { tablet: true })}</div><button type="button" class="ui-button ui-button--ghost ui-button--md" data-act="close-sheet">닫기</button></div></div>` : '';
  return `<div class="mobile-app">
    <div class="t-status"><span>14:32</span><span>87%</span></div>
    <header class="top-bar"><span class="top-bar__brand"><span class="t-mark"></span></span><div class="top-bar__titles"><div class="top-bar__title"><h1>홈</h1><span class="muted t-date numeric">10.17 토</span></div></div><span class="top-bar__space"></span><div class="top-bar__slots"><button type="button" class="ui-button ui-button--ghost ui-button--icon" aria-label="찾기">${svg('search')}</button><button type="button" class="ui-button ui-button--ghost ui-button--icon" aria-label="더보기">${svg('dots')}</button></div></header>
    <div class="t-body"><div class="home-scroll home-attention-mobile${st.privacy ? ' is-private' : ''}" data-scroll><div class="home-tablet-layout">
      ${monthSection(st)}
      <div class="home-tablet-pair"><div class="home-tablet-card">${tabletCard()}</div><div class="home-tablet-today">${todayRows(st)}</div></div>
      <div class="home-tablet-pair">${tabletTransfer()}${quickMemo()}</div>
    </div></div></div>
    <nav class="t-nav" aria-hidden="true">${NAV.map(([l, i]) => `<span class="${l === '홈' ? 'on' : ''}">${svg(i)}${l}</span>`).join('')}</nav>
    ${sheet}
  </div>`;
}

/* ---------- Interaction (both pages) ---------- */
function wire(host, st, render) {
  host.addEventListener('click', (ev) => {
    const dayEl = ev.target.closest('[data-day]');
    const act = ev.target.closest('[data-act]')?.dataset.act;
    const edit = ev.target.closest('[data-edit]')?.dataset.edit;
    if (dayEl) { st.selected = dayEl.dataset.day; st.editing = null; if (st.tabletMode) st.sheet = true; render(); return; }
    if (edit && !st.privacy) { st.editing = edit; render(); return; }
    if (act === 'prev' || act === 'next') { st.month = shiftMonth(st.month, act === 'prev' ? -1 : 1); render(); return; }
    if (act === 'today') { st.month = TODAY.slice(0, 7); st.selected = TODAY; st.editing = null; render(); return; }
    if (act === 'cancel-edit') { st.editing = null; render(); return; }
    if (act === 'close-sheet') { st.sheet = false; render(); return; }
    if (act === 'quick-add') addQuick(host.querySelector('[data-quick]'), st, render);
  });
  host.addEventListener('keydown', (ev) => {
    if (ev.target.matches?.('[data-quick]') && ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); addQuick(ev.target, st, render); return; }
    const dayEl = ev.target.closest?.('[data-day]');
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[ev.key];
    if (dayEl && step) {
      ev.preventDefault();
      const next = addDays(dayEl.dataset.day, step);
      st.selected = next; st.editing = null;
      if (!next.startsWith(st.month) && !host.querySelector(`[data-day="${next}"]`)) st.month = next.slice(0, 7);
      render();
      host.querySelector(`[data-day="${next}"]`)?.focus();
    }
  });
  host.addEventListener('input', (ev) => { const d = ev.target.dataset?.memo; if (d) { if (ev.target.value.trim()) MEMOS[d] = ev.target.value; else delete MEMOS[d]; } });
  host.addEventListener('focusout', (ev) => { if (ev.target.dataset?.memo) render(); });
}
function addQuick(input, st, render) {
  if (!input) return;
  const m = input.value.trim().match(/^(.+?)\s+₩?(\d+|\d{1,3}(?:,\d{3})+)원?$/);  // notes/ledger/presentation.ts parseQuickEntry
  if (!m) { input.setAttribute('aria-invalid', 'true'); return; }
  const e = E(input.dataset.quick, m[1].trim(), Number(m[2].replace(/,/g, '')));
  ENTRIES.push(e); st.fresh = e.id; render();
  setTimeout(() => { if (st.fresh === e.id) { st.fresh = null; render(); } }, 1400);
}

window.HomeCal = { TODAY, pcWindow, tabletScreen, wire };
})();
