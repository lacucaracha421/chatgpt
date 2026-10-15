/* Home + card draw mockup. Demo data only; card art is the gacha prototype's procedural art. */
(async () => {
'use strict';
const C = window.LKCards, RM = C.RM;
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------------------------------------------------------- icons (Heroicons outline) */
const I = {
  home: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  photo: 'm2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Z',
  stack: 'M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122',
  book: 'M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25',
  doc: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
  arrows: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
  search: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  dots: 'M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z',
  right: 'm8.25 4.5 7.5 7.5-7.5 7.5',
  left: 'M15.75 19.5 8.25 12l7.5-7.5',
  download: 'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3',
  bank: 'M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z',
  bolt: 'm3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z',
  clock: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  wrench: 'M21.75 6.75a4.5 4.5 0 0 1-4.884 4.484c-1.076-.091-2.264.071-2.95.904l-7.152 8.684a2.548 2.548 0 1 1-3.586-3.586l8.684-7.152c.833-.686.995-1.874.904-2.95a4.5 4.5 0 0 1 6.336-4.486l-3.276 3.276a3.004 3.004 0 0 0 2.25 2.25l3.276-3.276c.256.565.398 1.192.398 1.852Z',
  signal: 'M9.348 14.652a3.75 3.75 0 0 1 0-5.304m5.304 0a3.75 3.75 0 0 1 0 5.304m-7.425 2.121a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.807-3.808-9.98 0-13.788m13.788 0c3.808 3.807 3.808 9.98 0 13.788M12 12h.008v.008H12V12Z',
  x: 'M6 18 18 6M6 6l12 12',
  check: 'm4.5 12.75 6 6 9-13.5',
  link: 'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244',
  grid: 'M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z',
};
const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${I[n]}"/></svg>`;
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/* ---------------------------------------------------------------- demo data */
const SERIES = [{ id: 's1', name: '별바다 연대기' }, { id: 's2', name: '등불 항구' }, { id: 's3', name: '오로라 기사단' }];
const SN = Object.fromEntries(SERIES.map(s => [s.id, s.name]));
// key, name, series, subject art, background scene, mirrored, card background variant, tint
const CHARS = [
  ['c1', '아즈라', 's1', 0, 0, 0, 'digital', '#3a5ad8', '@yunseul_art', ['용', '수정']],
  ['c2', '루미', 's1', 1, 1, 0, 'aurora', '#1a8fb4', 'NoOne', ['해파리', '등불']],
  ['c3', '세라핀', 's1', 2, 2, 0, 'ornament', '#b0246e', '@dawn_ink', ['천사', '별']],
  ['c4', '키리에', 's1', 3, 3, 0, 'ribbon', '#2f9a7a', '@kiri_paints', ['검', '오로라']],
  ['c5', '노아', 's1', 0, 2, 1, 'aurora', '#6a3aa8', '@yunseul_art', ['용', '별밤']],
  ['c6', '미라', 's1', 2, 0, 1, 'digital', '#c96a2a', '@dawn_ink', ['날개', '노을']],
  ['c7', '하루', 's2', 1, 1, 1, 'ribbon', '#2a6fd0', 'NoOne', ['바다']],
  ['c8', '시온', 's2', 3, 0, 1, 'ornament', '#a3203c', '@kiri_paints', ['검', '노을']],
  ['c9', '레아', 's2', 2, 3, 0, 'digital', '#3aa88a', '@dawn_ink', ['천사']],
  ['c10', '카논', 's2', 0, 1, 0, 'ornament', '#8a2ab8', '@yunseul_art', ['용', '심해']],
  ['c11', '이브', 's2', 1, 2, 0, 'digital', '#d0487a', 'NoOne', ['등불']],
  ['c12', '도나', 's2', 3, 2, 0, 'aurora', '#c4861c', '@kiri_paints', ['검', '별']],
  ['c13', '테오', 's3', 0, 3, 1, 'digital', '#1d6e8a', '@kiri_paints', ['용', '빙산']],
  ['c14', '엘리', 's3', 2, 1, 1, 'ribbon', '#5f4fd0', '@dawn_ink', ['날개', '바다']],
  ['c15', '사야', 's3', 0, 3, 1, 'ribbon', '#2a8a4a', '@yunseul_art', ['용', '오로라']],
  ['c16', '노엘', 's3', 1, 0, 0, 'ornament', '#b8460f', 'NoOne', ['노을']],
  ['c17', '리코', 's3', 2, 1, 0, 'aurora', '#7a3ab0', '@dawn_ink', ['천사', '심해']],
  ['c18', '유나', 's3', 3, 1, 0, 'ornament', '#2a4fb0', '@kiri_paints', ['검', '심해']],
].map(([key, name, series, subj, bg, flip, variant, tint, credit, tags], i) => ({ key, name, series, subj, bg, flip: !!flip, variant, tint, credit, tags, id: 2100 + i * 37, images: [1284, 312, 2046, 96, 418, 57, 233, 704, 41, 166, 88, 129, 615, 74, 23, 391, 12, 208][i] }));
const CH = Object.fromEntries(CHARS.map(c => [c.key, c]));
const TK = C.TIERS.map(t => t.k), TIER = Object.fromEntries(C.TIERS.map(t => [t.k, t]));
const OWNED0 = { c1: { n: 2, ssr: 1 }, c2: { n: 1, r: 1 }, c3: { sr: 2, ur: 1 }, c4: { n: 3 }, c5: { r: 1 }, c7: { n: 1 }, c8: { lr: 1, n: 1 }, c10: { sr: 1 }, c13: { r: 2 }, c14: { n: 1 }, c16: { ssr: 1 } };
const FIRST = { c1: '9.28', c2: '10.2', c3: '10.3', c4: '9.30', c5: '10.6', c7: '10.8', c8: '10.1', c10: '10.11', c13: '10.9', c14: '10.12', c16: '10.14' };
const clone = o => JSON.parse(JSON.stringify(o));
let owned = clone(OWNED0);
const best = key => { const o = owned[key]; if (!o) return null; return TK.slice().reverse().find(k => o[k]) || null; };
const ownedChars = () => Object.keys(owned).length;
const kinds = () => Object.values(owned).reduce((n, o) => n + Object.keys(o).length, 0);
const pieces = () => Object.values(owned).reduce((n, o) => n + Object.values(o).reduce((a, b) => a + b, 0), 0);
// The first live draw is scripted so the walkthrough is repeatable; later draws are random.
const SCRIPT = [['c4', 'n'], ['c6', 'r'], ['c13', 'n'], ['c10', 'ur'], ['c2', 'sr']];
const had0 = (key, k) => (OWNED0[key] && OWNED0[key][k]) || 0;
const SCRIPT_RESULT = SCRIPT.map(([key, k]) => ({ key, k, isNew: !had0(key, k), dup: had0(key, k) + 1 }));

const ASSET = {};
await Promise.all(CHARS.map(async c => {
  ASSET[c.key] = await C.makeAsset({ key: c.key, title: c.name, bg: c.bg, subj: c.subj, flip: c.flip, variant: c.variant, tint: c.tint, credit: c.credit,
    tags: [SN[c.series], ...c.tags], id: c.id, albums: 1 + (c.id % 3), fav: c.id % 2 === 0, attr: 0 });
}));

/* Mount every [data-card] placeholder as a real card. */
function mount(root) {
  $$('[data-card]', root).forEach(h => {
    const d = JSON.parse(h.dataset.card); h.removeAttribute('data-card');
    const el = C.makeCard(ASSET[d.key], d.tier, { live: !!d.live, dup: d.dup || (owned[d.key] && owned[d.key][d.tier]) || 1, serial: d.tier === 'lr' ? 'No. 1 / 1' : d.tier === 'ur' ? 'No. 3 / 10' : undefined });
    if (d.down) el.classList.add('down');
    if (d.cls) el.classList.add(...d.cls.split(' '));
    h.replaceWith(el);
  });
}
const cardSlot = (key, tier, extra = {}) => `<div data-card='${JSON.stringify({ key, tier, ...extra })}'></div>`;

/* ---------------------------------------------------------------- shared bits */
const label = (title, { count, unit = '', actions = '', open = false } = {}) =>
  `<div class="ui-section-label"><span class="ui-section-label__title">${title}</span>${count !== undefined ? ` <span class="ui-section-label__count">${count.toLocaleString()}${unit}</span>` : ''}<span class="ui-section-label__rule" aria-hidden="true"></span>${actions ? `<span class="ui-section-label__actions">${actions}</span>` : ''}${open ? `<button type="button" class="ui-section-label__open" aria-label="${title} 전체">${ic('right', 's')}</button>` : ''}</div>`;
const section = (title, body, opts) => `<section class="home-attention-section" aria-label="${title}">${label(title, opts)}<div>${body}</div></section>`;
const rail = (on = 0) => `<nav class="rail">${['home', 'photo', 'stack', 'book', 'doc', 'arrows'].map((n, i) => `<span class="${i === on ? 'on' : ''}">${ic(n)}${n === 'arrows' ? '<b class="ui-badge ui-badge--corner">3</b>' : ''}</span>`).join('')}<span class="push">${ic('search')}</span><span>${ic('dots')}</span></nav>`;
const win = `<span class="status-chip">상태</span><span class="winctl"><span>—</span><span>☐</span><span>✕</span></span>`;
const topHome = `<header class="topbar"><span class="ttl">홈<small class="num">10.15 목</small></span><span class="grow"></span>${win}</header>`;
const shell = (top, body, railOn = 0) => `<div class="pc">${rail(railOn)}<div class="main">${top}<div class="scroll">${body}</div></div></div>`;

/* ---------------------------------------------------------------- release calendar */
const REL = {
  '10.13': [['유리 정원의 기사', '게임', 200, 1]],
  '10.14': [['달빛 서커스', '7권', 320, 1]],
  '10.15': [['별의 항해자 HD', '게임', 30], ['검은 고양이 탐정', '영화', 260]],
  '10.16': [['시계탑 미궁', '3권', 150]],
  '10.17': [['철의 왕관', '게임', 10], ['모래의 왕국', '게임', 45], ['여름 정거장', '애니', 180]],
  '10.21': [['푸른 등대', '영화', 210]],
  '10.22': [['기계 도시', '게임', 90]],
  '10.23': [['은하 우편', '12권', 280]],
  '10.24': [['얼음 성채', '게임', 190]],
};
const TODAY = 15;
const cover = (t, h, extra = '') => `<span class="cv" style="--h:${h}" data-t="${esc(t)}">${extra}</span>`;
const dday = d => d === 0 ? '<span class="ui-badge ui-badge--accent ui-dday">오늘</span>' : d > 0 ? `<span class="ui-badge ui-dday">D-${d}</span>` : '';
function calendarA() {
  const wd = ['월', '화', '수', '목', '금', '토', '일'];
  let html = `<div class="cal">${wd.map((w, i) => `<span class="cal__wd${i > 4 ? ' we' : ''}">${w}</span>`).join('')}`;
  for (let d = 12; d <= 25; d++) {
    const key = `10.${d}`, items = REL[key] || [], diff = d - TODAY, first = items[0];
    const cls = ['cal__day', diff === 0 ? 'is-today' : '', diff < 0 ? 'is-past' : '', items.length ? 'has' : ''].join(' ');
    html += `<div class="${cls}"><div class="cal__head"><span class="cal__date">${d === 12 ? '10.12' : d}</span>${items.length || diff === 0 ? dday(diff) : ''}</div>`;
    // Several releases on one day stack behind the first cover (up to three), the rest is in the line under it.
    if (first) html += `<button type="button" class="cal__item"><span class="cal__stack">${items.slice(0, 3).map((it, i) => cover(it[0], it[2], i === 0 && it[3] ? '<span class="ui-badge ui-badge--accent">NEW</span>' : '')).join('')}</span><b>${esc(first[0])}</b><small>${first[1]}${items.length > 1 ? ` 외 ${items.length - 1}개` : ''}</small></button>`;
    html += '</div>';
  }
  return html + '</div>';
}
function releaseRow(n = 12) {
  const flat = Object.entries(REL).flatMap(([k, items]) => items.map(it => [k, ...it]));
  return `<div class="home-release-grid is-row">${flat.slice(0, n).map(([k, t, kind, h, isNew]) => {
    const d = +k.split('.')[1] - TODAY;
    return `<button type="button" class="home-release-tile"><span class="home-release-tile__art cv" style="--h:${h}" data-t="${esc(t)}">${isNew ? '<span class="ui-badge ui-badge--accent home-release-tile__new">NEW</span>' : ''}</span><span class="home-release-tile__when"><span>${k} · ${kind}</span>${d >= 0 ? dday(d) : ''}</span><b>${esc(t)}</b></button>`;
  }).join('')}</div>`;
}

/* ---------------------------------------------------------------- 오늘 할 것 (the shared HomeToday rows) */
const TODO = [
  ['○', '구독 이번 달 47,800원', '다음 결제 D-3 · 넷플릭스', '4개'],
  ['○', '넷플릭스 결제', '10.18 · 17,000원', null, 3],
  ['□', '미분류 에셋', '', '12'],
  ['□', '확인', '', '37'],
  ['□', '정리 대기', '게임 232 · 만화 331', '563', null, '설계 중'],
  ['○', '장보기', '남은 항목 2개', '2'],
];
const todoRows = () => TODO.map(([m, l, s, v, d, plan]) => `<div><button type="button" class="home-attention-row"><span class="home-attention-mark" aria-hidden="true">${m}</span><span class="home-attention-copy"><span>${l}${plan ? ` <span class="ui-badge tag-plan">${plan}</span>` : ''}</span>${s ? `<small>${s}</small>` : ''}</span>${d ? `<span class="ui-badge ui-dday">D-${d}</span>` : `<span class="home-attention-value numeric">${v}</span>`}</button></div>`).join('');
const todoSection = () => section('오늘 할 것', todoRows(), { count: TODO.length });

/* ---------------------------------------------------------------- 도구 (user 2026-10-15: 전송 · 빠른 메모 · 링크 보관) */
// 전송 (user 2026-10-15): LocalSend-style direct send on the same network, server elsewhere. Between the user's own
// paired devices a drop or paste sends at once (no accept prompt). Home shows only a short recent status with the route.
const SEND_STATES = {
  direct: { line: '같은 네트워크 · 직접', rows: [['영상 1개', '직접', null, 62], ['사진 4장', '직접', '21:40'], ['링크 1개', '서버', '20:12']] },
  offline: { line: '태블릿 앱이 꺼져 있음 · 서버로 보냄', off: true, rows: [['사진 2장', '서버', '켜지면 받음', null, 1], ['텍스트', '서버', '켜지면 받음', null, 1], ['사진 4장', '직접', '21:40']] },
  over: { line: '놓으면 바로 보냄 · 직접', over: true, rows: [['사진 4장', '직접', '21:40'], ['링크 1개', '서버', '20:12'], ['영상 1개', '직접', '19:05']] },
};
const sentRows = (rows, n = 3) => rows.slice(0, n).map(([what, route, when, pct, wait]) => `<div class="sent__row">${pct != null ? `<span class="sent__meter"><i style="width:${pct}%"></i></span>` : ic(wait ? 'clock' : 'check', 's')}<span>${what}</span><small class="num">${route} · ${pct != null ? `${pct}%` : when}</small></div>`).join('');
const sendTool = ({ rows = 3, to = '태블릿', state = 'direct' } = {}) => { const st = SEND_STATES[state];
  return section('전송', `<div class="drop${st.over ? ' is-dragover' : ''}" data-drop tabindex="0" aria-label="${to}로 보내기">${ic('arrows')}<span>놓거나 붙여넣으면 ${to}로</span><small class="${st.off ? 'is-off' : ''}">${state === 'offline' && to !== '태블릿' ? 'PC 앱이 꺼져 있음 · 서버로 보냄' : st.line}</small></div><div class="sent">${sentRows(st.rows, rows)}</div>`,
    { actions: `<button type="button" class="lbl-link">상세${ic('right')}</button>` }); };
const sendStates = () => `<div class="sendstates">${[['direct', '보내는 중 · 같은 네트워크면 직접'], ['over', '파일을 끌어 올 때'], ['offline', '태블릿 앱이 꺼져 있을 때']].map(([k, cap]) => `<div><p class="cap">${cap}</p>${sendTool({ state: k })}</div>`).join('')}</div>`;
// 빠른 메모: one note that also lives in 메모; typing saves by itself.
const MEMO = '금요일까지 택배 반품\n세라핀 레퍼런스 더 모으기\n토요일 철의 왕관 예약 구매 확인\n태블릿 0.9.92 설치';
const memoTool = (rows = 8) => section('빠른 메모', `<textarea class="qmemo" rows="${rows}" aria-label="빠른 메모" spellcheck="false">${MEMO}</textarea>`);
// 링크 보관: URLs kept apart from assets, with a preview; a link with images can send them to 기타.
const LINKS = [
  ['Pixiv 10월 랭킹 정리', 'pixiv.net', '21:12', 280, 12],
  ['몬스터헌터 와일즈 1.3 패치 노트', 'monsterhunter.com', '19:40', 30, 0],
  ['세라핀 설정화 모음', 'x.com', '어제', 320, 4],
  ['ComfyUI 업스케일 가이드', 'github.com', '10.13', 200, 0],
  ['가을 한정 굿즈 예약', 'animate-onlineshop.jp', '10.12', 18, 6],
  ['아트북 스캔 정리 팁', 'arca.live', '10.11', 150, 9],
];
const linkRow = ([t, d, w, h, imgs], hover = false) => `<div class="lnk${hover ? ' is-hover' : ''}" tabindex="0"><span class="lnk__thumb" style="--h:${h}"></span><span class="lnk__copy"><span>${esc(t)}</span><small>${d} · <span class="num">${w}</span>${imgs ? ` · 이미지 ${imgs}` : ''}</small></span>${imgs ? `<button type="button" class="ui-button ui-button--quiet ui-button--sm lnk__act">${ic('download', 's')}이미지를 에셋으로</button>` : ''}</div>`;
const linkInput = `<div class="urlin">${ic('link', 's')}<span>URL 붙여넣기</span><kbd>Ctrl+V</kbd></div>`;
const linkTool = (n = 4, hover = 0) => section('링크 보관', `${linkInput}<div class="lnks">${LINKS.slice(0, n).map((l, i) => linkRow(l, i === hover)).join('')}</div>`,
  { count: 38, actions: `<button type="button" class="lbl-link" data-links>전체${ic('right')}</button>` });
const toolsA = () => `<div class="tools3">${sendTool()}${memoTool()}${linkTool(4, 0)}</div>`;
const toolsB = () => `<div class="hz-col tools-stack">${sendTool({ rows: 2 })}${memoTool(4)}${linkTool(2, -1)}</div>`;

/* ---------------------------------------------------------------- 오늘의 카드 */
const packHTML = (extra = '', label = '오늘의 팩 뜯기') => `<div class="pack idle ${extra}" role="button" tabindex="0" aria-label="${label}"><div class="pack-body"><div class="tearline"></div>
  <div class="pack-art"><span class="emb"><svg><use href="#mk"/></svg></span><b>LAKOMICS</b><span>캐릭터 카드 팩</span><em>10.15 · 오늘의 팩</em></div><span class="pack-count">5장</span></div><div class="pack-top"></div><div class="pack-leak"></div></div>`;
let lastPull = null;
function dailyBody(state, { tall = false, stacked = false } = {}) {
  if (state === 'sealed') return `<div class="daily${tall ? ' daily--tall' : ''}">
    <div class="daily__pack">${stacked ? packHTML('behind', '') : ''}${packHTML()}</div>
    <div class="daily__info"><b>오늘의 팩</b><small>5장 · S 이상 1장 보장${stacked ? '<br>쌓인 팩 2 · 3개까지' : ''}</small><button type="button" class="ui-button ui-button--primary ui-button--md" data-open-draw>뜯기</button></div></div>`;
  const res = lastPull || SCRIPT_RESULT;
  const top = res.reduce((m, o) => C.TI[o.k] > C.TI[m.k] ? o : m, res[0]);
  const fresh = res.filter(o => o.isNew).length;
  const codes = res.slice().sort((a, b) => C.TI[b.k] - C.TI[a.k]).map(o => `<span class="code" data-t="${o.k}">${TIER[o.k].code}</span>`).join('');
  return `<div class="daily${tall ? ' daily--tall' : ''}"><div class="daily__pack"><div class="daily__card">${cardSlot(top.key, top.k, { live: 1 })}</div></div>
    <div class="daily__info"><b>오늘 뽑은 5장</b><span class="daily__codes">${codes}</span><small>새 카드 ${fresh} · 다음 팩 내일</small><button type="button" class="ui-button ui-button--secondary ui-button--md" data-open-result>결과 보기</button></div></div>`;
}
const albumLink = () => `<button type="button" class="lbl-link" data-album>앨범 <span class="num">${ownedChars()}/${CHARS.length}</span>${ic('right')}</button>`;
const dailySection = (state, opts) => `<section class="home-attention-section" data-daily-section aria-label="오늘의 카드">${label('오늘의 카드', { actions: albumLink() })}<div data-daily data-opts='${JSON.stringify(opts || {})}'>${dailyBody(state, opts)}</div></section>`;

/* ---------------------------------------------------------------- Home variants */
const homeA = state => shell(topHome, `<div class="hz hz--a">
  <div class="hz-col">${section('발매 캘린더', calendarA(), { actions: '<button type="button" class="lbl-link">10.26 이후 3개</button>', open: true })}${toolsA()}</div>
  <div class="hz-col">${dailySection(state)}${todoSection()}</div></div>`);
const homeB = () => shell(topHome, `<div class="hz hz--b">
  ${section('2주 안에 발매', releaseRow(12), { count: 13, open: true })}
  <div class="hz-band">${todoSection()}${dailySection('sealed', { tall: true, stacked: true })}${toolsB()}</div></div>`);

/* ---------------------------------------------------------------- draw overlay */
const ODDS = C.TIERS.map(t => `<b>${t.code}</b> ${t.odds}%`).join(' · ');
function roll() { let r = Math.random() * 100; for (const t of C.TIERS) { if ((r -= t.odds) < 0) return t.k; } return 'n'; }
let scripted = true;
function drawFive() {
  let out;
  if (scripted) { out = SCRIPT.map(([key, k]) => ({ key, k })); scripted = false; }
  else {
    out = Array.from({ length: 5 }, () => ({ key: CHARS[Math.random() * CHARS.length | 0].key, k: roll() }));
    if (!out.some(o => C.TI[o.k] >= C.TI.sr)) out[4].k = 'sr';
  }
  // Record into the album: new when this character + tier was not owned before.
  return out.map(o => { const had = owned[o.key] && owned[o.key][o.k]; owned[o.key] = owned[o.key] || {}; owned[o.key][o.k] = (had || 0) + 1; return { ...o, isNew: !had, dup: owned[o.key][o.k] }; });
}
function burst(stage, el, k) {
  const sr = stage.getBoundingClientRect(), r = el.getBoundingClientRect(), cx = r.left - sr.left + r.width / 2, cy = r.top - sr.top + r.height / 2;
  const pal = k === 'lr' ? ['#ff9cc0', '#ffe7a0', '#a8ffd6', '#a8d4ff', '#d9b8ff'] : k === 'ur' ? ['#ffe08a', '#fff4cc', '#f0b44a'] : ['#fff1b5', '#ffd25a', '#ffffff'];
  const box = $('.st-particles', stage), n = k === 'ssr' ? 34 : 56;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('span'); p.className = 'pt' + (i % 3 === 0 ? ' sq' : '');
    const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * Math.max(160, r.width * 1.4);
    p.style.cssText = `left:${cx}px;top:${cy}px;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d}px;--pc:${pal[i % pal.length]};--dur:${.8 + Math.random() * .7}s`;
    box.appendChild(p); setTimeout(() => p.remove(), 1700);
  }
}
const tagHTML = o => `<span class="code" data-t="${o.k}">${TIER[o.k].code}</span>${o.isNew ? '<span class="ui-badge ui-badge--accent">NEW</span>' : `<span class="num">×${o.dup} · Lv.${Math.min(5, o.dup)}</span>`}`;

function openDraw(frame, { instant = false, result = null, onClose } = {}) {
  const ov = document.createElement('div'); ov.className = 'draw'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', '오늘의 팩');
  ov.innerHTML = `<div class="draw__top"><b>오늘의 팩</b><small class="num">10.15 · 5장</small><span class="grow"></span><button type="button" class="icon-btn" data-close aria-label="닫기">${ic('x')}</button></div>
    <div class="draw__stage stage"><div class="st-rays"></div>${packHTML('', '팩 뜯기')}<div class="draw__cards" hidden></div><div class="st-particles"></div><p class="draw__hint">팩을 누르면 뜯습니다</p></div>
    <div class="draw__bar"><span class="odds">${ODDS} · S 이상 1장 보장</span><span class="grow"></span>
      <button type="button" class="ui-button ui-button--secondary ui-button--md" data-skip hidden>건너뛰기</button>
      <button type="button" class="ui-button ui-button--secondary ui-button--md" data-album hidden>앨범</button>
      <button type="button" class="ui-button ui-button--primary ui-button--md" data-go>뜯기</button>
      <button type="button" class="ui-button ui-button--primary ui-button--md" data-done hidden>닫기</button></div>
    <div class="draw__zoom" hidden></div>`;
  frame.appendChild(ov);
  if (instant) ov.classList.add('on'); else requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('on')));
  const stage = $('.draw__stage', ov), pack = $('.pack', stage), box = $('.draw__cards', ov), hint = $('.draw__hint', ov);
  const btnGo = $('[data-go]', ov), btnSkip = $('[data-skip]', ov), btnDone = $('[data-done]', ov), btnAlbum = $('[data-album]', ov);
  let busy = false, skip = false, waiters = [], res = result;
  const wait = ms => new Promise(r => { if (skip || instant) return r(); const id = setTimeout(r, ms); waiters.push(() => { clearTimeout(id); r(); }); });
  const doSkip = () => { if (!busy || skip) return; skip = true; waiters.splice(0).forEach(f => f()); };
  async function reveal(el, tag, k) {
    const ti = C.TI[k], big = ti >= C.TI.ssr;
    const finish = () => { el.classList.remove('charge', 'big', 'down'); el.classList.add('revealed'); tag.classList.add('on'); };
    if (RM || instant) { finish(); return; }
    if (skip) { el.classList.add('quick'); finish(); return; }
    el.classList.add('charge');
    if (big) {
      const sr = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
      stage.style.setProperty('--cx', (r.left - sr.left + r.width / 2) + 'px'); stage.style.setProperty('--cy', (r.top - sr.top + r.height / 2) + 'px');
      stage.dataset.ray = k === 'lr' ? 'rainbow' : ''; stage.style.setProperty('--ray', C.hexA(k === 'ur' ? '#ffb21e' : '#ffd25a', .55)); stage.classList.add('rays');
    }
    await wait(big ? 1000 : ti >= C.TI.sr ? 420 : 240);
    if (skip) { el.classList.add('quick'); finish(); stage.classList.remove('rays'); return; }
    el.classList.remove('down');
    if (big) setTimeout(() => burst(stage, el, k), 120);
    await wait(big ? 900 : 300);
    finish();
    if (big) { await wait(250); stage.classList.remove('rays'); }
  }
  async function pull() {
    if (busy) return; busy = true; btnGo.hidden = true; btnSkip.hidden = instant; stage.classList.add('busy');
    res = res || drawFive();
    const top = res.reduce((m, o) => Math.max(m, C.TI[o.k]), 0), topK = C.TIERS[top].k;
    hint.textContent = '화면을 누르면 건너뜁니다';
    if (!RM && !instant) {
      pack.className = 'pack'; pack.dataset.leak = topK === 'lr' ? 'rainbow' : ''; pack.style.setProperty('--leak', topK === 'lr' ? '#fff' : C.TIERS[top].glow);
      await wait(120); pack.classList.add('shake'); await wait(top >= 3 ? 1000 : 650);
      pack.classList.remove('shake'); pack.classList.add('torn'); await wait(top >= 3 ? 750 : 480);
      pack.classList.add('out'); await wait(320);
    }
    stage.classList.add('has-cards'); box.hidden = false;
    box.innerHTML = res.map((o, i) => `<div class="draw__slot" style="--i:${i}">${cardSlot(o.key, o.k, { live: 0, dup: o.dup })}<span class="draw__tag">${tagHTML(o)}</span></div>`).join('');
    mount(box);
    const els = $$('.draw__slot', box).map(s => [$('.card', s), $('.draw__tag', s)]);
    // Decode the art while the faces are up (Chromium skips painting art first laid out on a hidden back face),
    // then turn the cards face down without a visible flip; they are still transparent before the deal.
    await Promise.all($$('img', box).map(im => im.decode ? im.decode().catch(() => undefined) : undefined));
    if (!RM && !instant) els.forEach(([c]) => { const f = $('.card__flip', c); f.style.transition = 'none'; c.classList.add('down'); void f.offsetWidth; f.style.transition = ''; });
    void box.offsetWidth; box.classList.add('dealt');
    await wait(RM ? 60 : 420 + 5 * 60);
    for (let i = 0; i < els.length; i++) await reveal(els[i][0], els[i][1], res[i].k);
    stage.classList.remove('rays', 'busy');
    hint.textContent = '카드를 누르면 크게 봅니다';
    btnSkip.hidden = true; btnDone.hidden = false; btnAlbum.hidden = false; busy = false; lastPull = res;
  }
  function zoom(card) {
    const z = $('.draw__zoom', ov), o = res[$$('.draw__slot .card', box).indexOf(card)], c = CH[o.key];
    z.innerHTML = `<button type="button" class="icon-btn" data-zclose aria-label="닫기">${ic('x')}</button>${cardSlot(o.key, o.k, { live: 1, dup: o.dup })}
      <div class="zinfo"><h3>${c.name}</h3><div class="rows"><div><span>시리즈</span><b>${SN[c.series]}</b></div><div><span>등급</span><b><span class="code" data-t="${o.k}">${TIER[o.k].code}</span></b></div>
      <div><span>보유</span><b>${o.dup}장 · Lv.${Math.min(5, o.dup)}</b></div><div><span>처음 뽑음</span><b>${FIRST[o.key] && !o.isNew ? FIRST[o.key] : '10.15'}</b></div><div><span>이 캐릭터 그림</span><b>${c.images.toLocaleString()}장</b></div></div>
      <div class="acts"><button type="button" class="ui-button ui-button--secondary ui-button--md">원본 열기</button><button type="button" class="ui-button ui-button--quiet ui-button--md">앨범에서 보기</button></div></div>`;
    mount(z); z.hidden = false; requestAnimationFrame(() => z.classList.add('on'));
  }
  function close() {
    ov.classList.remove('on'); $$('.card', ov).forEach(C.dispose);
    setTimeout(() => ov.remove(), RM ? 0 : 200); onClose && onClose(res);
  }
  btnGo.addEventListener('click', pull);
  pack.addEventListener('click', e => { e.stopPropagation(); pull(); });
  pack.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pull(); } });
  btnSkip.addEventListener('click', doSkip);
  stage.addEventListener('click', e => { if (busy) { doSkip(); return; } const c = e.target.closest('.card.revealed'); if (c) zoom(c); });
  ov.addEventListener('click', e => {
    if (e.target.closest('[data-zclose]')) { const z = $('.draw__zoom', ov); z.classList.remove('on'); $$('.card', z).forEach(C.dispose); setTimeout(() => { z.hidden = true; z.innerHTML = ''; }, RM ? 0 : 200); }
  });
  $('[data-close]', ov).addEventListener('click', close); btnDone.addEventListener('click', close);
  btnAlbum.addEventListener('click', () => { close(); document.getElementById('c').scrollIntoView({ behavior: RM ? 'auto' : 'smooth' }); });
  if (result || instant) pull();
  return ov;
}

/* ---------------------------------------------------------------- album */
const pips = key => { const o = owned[key] || {}, b = best(key); return `<span class="pips" aria-label="보유 등급">${TK.map(k => `<i class="${o[k] ? 'on' : ''}${k === b ? ' top' : ''}"></i>`).join('')}</span>`; };
const segmented = (cells, active) => `<div class="ui-segmented" role="radiogroup"><span class="ui-segmented__thumb ui-segmented__thumb--initial"></span>${cells.map((c, i) => `<button type="button" class="ui-segmented__cell" ${i === active ? 'data-segmented-active="true"' : ''}><span class="ui-segmented__content"><span class="ui-segmented__label">${c}</span></span></button>`).join('')}</div>`;
function placeThumbs(root) {
  $$('.ui-segmented', root).forEach(seg => { const cell = $('[data-segmented-active]', seg), th = $('.ui-segmented__thumb', seg); if (cell && th) { th.style.left = cell.offsetLeft + 'px'; th.style.width = cell.offsetWidth + 'px'; } });
}
function detailHTML(key) {
  const c = CH[key], o = owned[key] || {}, b = best(key), total = Object.values(o).reduce((a, n) => a + n, 0);
  return `${label(c.name)}<div class="bigcard">${b ? cardSlot(key, b, { live: 1, dup: o[b] }) : cardSlot(key, 'n', { down: 1 })}</div>
    <div class="ladder">${TK.map(k => `<span class="${o[k] ? '' : 'off'}"><span class="code" data-t="${k}">${TIER[k].code}</span>${o[k] ? `×${o[k]}` : '·'}</span>`).join('')}</div>
    <div class="rows"><div><span>시리즈</span><b>${SN[c.series]}</b></div><div><span>보유</span><b>${total}장</b></div><div><span>처음 뽑음</span><b>${FIRST[key] || (b ? '10.15' : '-')}</b></div><div><span>이 캐릭터 그림</span><b>${c.images.toLocaleString()}장</b></div></div>
    <div class="acts"><button type="button" class="ui-button ui-button--secondary ui-button--md">원본 열기</button><button type="button" class="ui-button ui-button--quiet ui-button--md">캐릭터 폴더</button></div>`;
}
function album(sel = 'c3') {
  const idx = [['전체', ownedChars(), CHARS.length, true], ...SERIES.map(s => [s.name, CHARS.filter(c => c.series === s.id && owned[c.key]).length, CHARS.filter(c => c.series === s.id).length])];
  const tierRows = TK.slice().reverse().map(k => [TIER[k].code, CHARS.filter(c => best(c.key) === k).length]);
  const grid = SERIES.map(s => {
    const list = CHARS.filter(c => c.series === s.id);
    return `<div class="alb__series">${label(s.name, { count: list.filter(c => owned[c.key]).length, unit: `/${list.length}명` })}<div class="slots">${list.map(c => {
      const b = best(c.key);
      return `<button type="button" class="slot${b ? '' : ' ghost'}${c.key === sel ? ' is-sel' : ''}" data-key="${c.key}">${b ? cardSlot(c.key, b, { dup: owned[c.key][b] }) : cardSlot(c.key, 'n', { down: 1 })}<span class="slot__meta"><span class="slot__name">${c.name}</span>${pips(c.key)}</span></button>`;
    }).join('')}</div></div>`;
  }).join('');
  const top = `<header class="topbar"><span class="tb-back">${ic('left', 's')}</span><span class="ttl">카드 앨범</span><span class="grow"></span>${win}</header>`;
  return shell(top, `<div class="alb">
    <nav class="alb__index">${label('시리즈')}${idx.map(([n, a, t, on]) => `<button type="button" class="irow${on ? ' on' : ''}"><span>${n}</span><small>${a}/${t}</small></button>`).join('')}
      ${label('가장 높은 등급')}${tierRows.map(([code, n]) => `<button type="button" class="irow"><span>${code}</span><small>${n}</small></button>`).join('')}</nav>
    <div class="alb__main"><div class="alb__bar">${segmented(['시리즈별', '등급별', '최근 뽑은'], 0)}<span class="grow"></span>
      <span class="count" data-alb-count>캐릭터 ${ownedChars()}/${CHARS.length} · 카드 ${kinds()}종 · ${pieces()}장</span>
      <label>못 뽑은 칸<input type="checkbox" class="ui-switch" checked></label></div>
      <div class="alb__grid">${grid}</div></div>
    <aside class="alb__detail" data-detail>${detailHTML(sel)}</aside></div>`);
}

/* ---------------------------------------------------------------- 링크 보관 view (inside Home, back returns) */
function linksView() {
  const more = [...LINKS, ['겨울 신작 애니 라인업', 'anime.eiga.com', '10.10', 240, 0], ['리깅 튜토리얼 모음', 'youtube.com', '10.9', 0, 0], ['X 작가 @dawn_ink 신작', 'x.com', '10.8', 300, 3], ['Switch 2 발매 일정 정리', 'nintendo.co.kr', '10.7', 350, 0]];
  const tile = ([t, d, w, h, imgs], i) => `<div class="ltile" tabindex="0"><span class="ltile__thumb" style="--h:${h}">${imgs ? `<span class="ui-badge ui-badge--scrim">${ic('photo', 's')}${imgs}</span>` : ''}</span>
    <span class="lnk__copy"><span>${esc(t)}</span><small>${d} · <span class="num">${w}</span></small></span>
    <span class="ltile__acts">${imgs ? (i === 2 ? `<span class="ltile__done">${ic('check', 's')}기타에 4장 넣음</span>` : `<button type="button" class="ui-button ui-button--quiet ui-button--sm">${ic('download', 's')}이미지를 에셋으로</button>`) : ''}<span class="grow"></span><button type="button" class="icon-btn" aria-label="더보기">${ic('dots', 's')}</button></span></div>`;
  const top = `<header class="topbar"><span class="tb-back">${ic('left', 's')}</span><span class="ttl">링크 보관<small class="num">38</small></span><span class="grow"></span>${win}</header>`;
  return shell(top, `<div class="lview"><div class="lview__bar">${segmented(['전체 38', '이미지 있음 14'], 0)}<span class="grow"></span><div class="urlin urlin--wide">${ic('link', 's')}<span>URL 붙여넣기 · 끌어 놓기</span><kbd>Ctrl+V</kbd></div></div>
    <div class="lgrid">${more.map(tile).join('')}</div></div>`);
}

/* ---------------------------------------------------------------- key frames */
function keyframes() {
  const k = (n, title, text, pic) => `<div class="key"><div class="key__pic stage${pic.includes('st-rays') ? ' rays' : ''}">${pic}</div><b><span class="n">${n}</span>${title}</b><p>${text}</p></div>`;
  return `<div class="keys">
    ${k(1, '팩', '정지한 채로 놓여 있다. 반복 움직임 없음. 포인터를 올리면 4px 떠오르고 광택이 한 번 지나간다.', packHTML())}
    ${k(2, '흔들림 · 틈새 빛', '0.6–1초 흔들리며 윗선에서 빛이 샌다. 빛의 색이 이번 팩의 최고 등급: 흰색 → 파랑 → 보라 → 금 → 무지개.', packHTML('shake').replace('class="pack', 'style="--leak:#ffb21e" class="pack'))}
    ${k(3, '뜯김', '윗부분이 오른쪽 위로 날아가고 빛이 퍼진다 (0.5–0.75초). 팩은 아래로 빠진다.', packHTML('torn').replace('class="pack', 'style="--leak:#ffb21e" class="pack'))}
    ${k(4, '다섯 장 깔림', '뒷면으로 아래에서 올라오며 60ms 간격으로 깔린다. 뒷면은 모든 등급 공통.', `<div class="key__fan">${SCRIPT.map(([key]) => cardSlot(key, 'n', { down: 1 })).join('')}</div>`)}
    ${k(5, '등급 차오름', '왼쪽부터 한 장씩 테두리에 빛이 차오른다. SR 이상은 0.9초 동안 빛살이 돌고 카드가 커지며 빛난다.', `<div class="st-rays" style="--ray:rgba(255,178,30,.55)"></div><div class="key__one">${cardSlot('c10', 'ur', { down: 1, cls: 'charge' })}</div>`)}
    ${k(6, '공개', '0.6초 뒤집힘. SR 이상은 입자가 터지고, 아래에 NEW 또는 ×4 · Lv.4가 뜬다. 끝나면 눌러서 크게 보기.', `<div class="key__one">${cardSlot('c10', 'ur', { cls: 'revealed' })}</div>`)}
  </div>`;
}

/* ---------------------------------------------------------------- tablet sketch */
function tablet() {
  const wk = `<div class="cal">${['월', '화', '수', '목', '금', '토', '일'].map((w, i) => `<span class="cal__wd${i > 4 ? ' we' : ''}">${w}</span>`).join('')}${Array.from({ length: 7 }, (_, i) => {
    const d = 12 + i, items = REL[`10.${d}`] || [], diff = d - TODAY, f = items[0];
    return `<div class="cal__day${diff === 0 ? ' is-today' : ''}${diff < 0 ? ' is-past' : ''}${items.length ? ' has' : ''}"><div class="cal__head"><span class="cal__date">${d}</span>${items.length || !diff ? dday(diff) : ''}</div>${f ? `<span class="cal__item"><span class="cal__stack">${items.slice(0, 3).map((it, k) => cover(it[0], it[2], k === 0 && it[3] ? '<span class="ui-badge ui-badge--accent">NEW</span>' : '')).join('')}</span><b>${esc(f[0])}</b></span>` : ''}</div>`;
  }).join('')}</div>`;
  return `<div class="tab"><div class="tab__top">홈<small class="num">10.15 목</small></div><div class="tab__body">
    ${section('발매 캘린더', wk, { open: true })}
    <div class="tab__two">${dailySection('sealed', { tall: true })}${todoSection()}</div>
    <div class="tab__two">${memoTool(6)}${linkTool(3, -1)}</div>
    ${sendTool({ rows: 2, to: 'PC' })}
  </div><nav class="tab__nav">${['home', 'photo', 'stack', 'book', 'dots'].map((n, i) => `<span class="${i ? '' : 'on'}">${ic(n)}</span>`).join('')}</nav></div>`;
}

/* ---------------------------------------------------------------- render */
function bindHome(frame) {
  frame.addEventListener('click', e => {
    if (e.target.closest('[data-open-draw]') || e.target.closest('[data-daily] .pack')) {
      openDraw(frame, { onClose: res => { if (res) refreshDaily(frame, 'after'); } });
    } else if (e.target.closest('[data-open-result]')) {
      openDraw(frame, { instant: true, result: lastPull });
    } else if (e.target.closest('[data-links]')) {
      document.getElementById('links').scrollIntoView({ behavior: RM ? 'auto' : 'smooth' });
    } else if (e.target.closest('[data-album]')) {
      document.getElementById('c').scrollIntoView({ behavior: RM ? 'auto' : 'smooth' });
    }
  });
  frame.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-daily] .pack')) { e.preventDefault(); e.target.click(); } });
  // Drop targets light up while files are dragged over them.
  frame.addEventListener('dragover', e => { const t = e.target.closest('[data-drop]'); $$('.tool.is-dragover', frame).forEach(x => x !== t && x.classList.remove('is-dragover')); if (t) { e.preventDefault(); t.classList.add('is-dragover'); } });
  frame.addEventListener('dragleave', e => { const t = e.target.closest('[data-drop]'); if (t && !t.contains(e.relatedTarget)) t.classList.remove('is-dragover'); });
  frame.addEventListener('drop', e => { e.preventDefault(); $$('.tool.is-dragover', frame).forEach(x => x.classList.remove('is-dragover')); });
}
function refreshDaily(frame, state) {
  const host = $('[data-daily]', frame); if (!host) return;
  $$('.card', host).forEach(C.dispose);
  host.innerHTML = dailyBody(state, JSON.parse(host.dataset.opts || '{}')); mount(host);
  const link = $('[data-album]', frame); if (link) link.outerHTML = albumLink();
  const alb = $('#frameC'); if (alb) renderAlbum();
}
function renderAlbum(sel = 'c3') {
  const f = $('#frameC'); $$('.card', f).forEach(C.dispose);
  f.innerHTML = album(sel); mount(f); placeThumbs(f);
}

const fA = $('#frameA'), fB = $('#frameB'), fD = $('#frameDraw'), fT = $('#frameTab');
fA.innerHTML = homeA('sealed'); mount(fA); bindHome(fA);
fB.innerHTML = homeB(); mount(fB); bindHome(fB);
$('#keys').innerHTML = keyframes(); mount($('#keys'));
// The result frame: Home A behind, the overlay finished in front (static, built through the same reveal path).
fD.innerHTML = homeA('after'); mount(fD); bindHome(fD);
openDraw(fD, { instant: true, result: SCRIPT_RESULT });
renderAlbum();
$('#frameC').addEventListener('click', e => {
  const s = e.target.closest('.slot'); if (!s) return;
  $$('.slot.is-sel', $('#frameC')).forEach(x => x.classList.remove('is-sel')); s.classList.add('is-sel');
  const d = $('[data-detail]', $('#frameC')); $$('.card', d).forEach(C.dispose); d.innerHTML = detailHTML(s.dataset.key); mount(d);
});
fT.innerHTML = tablet(); mount(fT);
$('#sendStates').innerHTML = sendStates();
const fL = $('#frameL'); fL.innerHTML = linksView(); placeThumbs(fL);

$('#replayA').addEventListener('click', () => {
  owned = clone(OWNED0); scripted = true; lastPull = null;
  $$('.draw', fA).forEach(o => o.remove());
  $$('.card', fA).forEach(C.dispose); fA.innerHTML = homeA('sealed'); mount(fA); renderAlbum();
  fA.scrollIntoView({ behavior: RM ? 'auto' : 'smooth' });
});
$('#replayDraw').addEventListener('click', () => {
  $$('.draw', fD).forEach(o => { $$('.card', o).forEach(C.dispose); o.remove(); });
  openDraw(fD, { result: SCRIPT_RESULT });
});
// ?only=<id> shows one frame alone (for screenshots); the frame keeps its live handlers.
const only = new URLSearchParams(location.search).get('only');
if (only && document.getElementById(only)) { const t = document.getElementById(only); document.body.prepend(t); document.body.classList.add('only'); }
document.documentElement.dataset.ready = '1';
})();
