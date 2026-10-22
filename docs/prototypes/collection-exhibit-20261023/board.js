/* Concept board: builds the frames and specimens from exhibit.js. Mockup code only. */
(() => {
'use strict';
const X = window.EX;
const $ = (s, r = document) => r.querySelector(s);
const params = new URLSearchParams(location.hash.slice(1));
const only = params.get('only');
window.EX_STILL = params.has('still');

// ---------- 0. the wall ----------
X.BUILD.hero('f-hero', 1700, 1000, { start: params.get('walk') || 'all' });
document.querySelectorAll('[data-walk]').forEach(b => b.addEventListener('click', () => X.walk($('#f-hero .fr-in'), b.dataset.walk)));

// ---------- 1. manga bookcase ----------
let mangaPC = X.BUILD.mangaPC('f-manga', 1700, 1040, { boxsets: params.get('box') === '1' });
X.BUILD.mangaPC('f-manga960', 960, 640);
function demoPull(frameId, title, n) {
  const inn = $(`#${frameId} .fr-in`); if (!inn) return;
  const se = X.manga.find(m => m.title === title);
  const sp = inn.querySelector(`.sp[data-s="${se.id}"][data-v="${n}"]`);
  if (sp) sp.click();
}
document.querySelectorAll('[data-manga-box]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('[data-manga-box]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  const scroll = $('#f-manga .room-near')?.scrollTop || 0;
  mangaPC = X.BUILD.mangaPC('f-manga', 1700, 1040, { boxsets: b.dataset.mangaBox === '1' });
  X.fitFrames(); const n = $('#f-manga .room-near'); if (n) n.scrollTop = scroll;
}));
$('[data-demo-pull]')?.addEventListener('click', () => demoPull('f-manga', '등대지기의 딸', 3));

// Spine anatomy: three ways to make a manga spine, at true size.
function spineSpecimen() {
  const host = $('#spec-spines'); if (!host) return;
  const se = X.manga.find(m => m.title === '밤의 미술관') || X.manga[0];
  const cells = [];
  for (const s of [1.1, 1.45]) {
    const f = X.FMT[se.fmt], H = X.px(f.h * s), W = X.px(f.w * s);
    const vols = se.vols.filter(v => v.st === 'own').slice(0, 6);
    // a) current: a slice of the front cover.
    const slice = vols.map(v => { const T = X.px(v.t * s); return `<i class="sp" style="width:${T}px;height:${H}px;box-shadow:inset -1px 0 rgba(0,0,0,.4)"><span style="position:absolute;top:0;left:${-W * .3}px">${X.coverHTML(X.mangaVolArt(se, v.n), W, H, { no: v.n })}</span></i>`; }).join('');
    // b) proposed: synthesised from the cover's edge colour, number, title, publisher.
    const synth = vols.map(v => X.spineManga(se, v, s, 'near')).join('');
    // c) photographed spine (new data): a designed spine, drawn here as a stand-in.
    const photo = vols.map(v => { const T = X.px(v.t * s), c = X.volColor(se, v.n); return `<i class="sp" style="width:${T}px;height:${H}px;background:linear-gradient(${c.base} 0 8%, #f1ede3 8% 9%, ${c.base} 9%)"><i style="position:absolute;left:12%;right:12%;top:11%;aspect-ratio:1;border-radius:50%;background:${c.art}"></i><b style="position:absolute;left:0;right:0;top:${X.px(T * 1.25 + H * .11)}px;text-align:center;color:#fff;font:800 ${X.px(T * .7)}px/1 var(--font-ui)">${v.n}</b><span style="position:absolute;left:0;right:0;top:34%;bottom:16%;display:flex;justify-content:center;writing-mode:vertical-rl;text-orientation:upright;color:#fff;font:900 ${X.px(Math.min(T * .66, 14))}px/1 var(--font-spine);letter-spacing:.06em">${se.title}</span><i style="position:absolute;left:0;right:0;bottom:0;height:9%;background:#15181a"></i><em style="position:absolute;left:0;right:0;bottom:2.5%;text-align:center;color:#f1ede3;font:700 ${X.px(T * .42)}px/1 var(--font-ui);font-style:normal">${se.pub[1]}</em></i>`; }).join('');
    cells.push(`<div class="cardx" style="background:transparent;border:0;padding:0"><div class="caption" style="margin:0 0 6px">${s === 1.1 ? '보통 1.1 px/mm' : '크게 1.45 px/mm'}</div><div style="display:flex;gap:48px;align-items:flex-end">
      <div><div style="display:flex;align-items:flex-end">${slice}</div><div class="caption">A 표지 조각 (지금)</div></div>
      <div><div style="display:flex;align-items:flex-end">${synth}</div><div class="caption">B 합성 책등 (추천)</div></div>
      <div><div style="display:flex;align-items:flex-end">${photo}</div><div class="caption">C 실물 책등 사진 (새 데이터)</div></div></div></div>`);
  }
  host.innerHTML = `<div style="display:flex;gap:64px;flex-wrap:wrap;padding:24px;background:linear-gradient(var(--bk-light),transparent 40%),var(--bk-back)">${cells.join('')}</div>`;
}
spineSpecimen();

// One scale: every format at the same px/mm.
function scaleLineup() {
  const host = $('#spec-scale'); if (!host) return;
  const s = 1.1, items = [];
  const book = (fmt, label, t) => { const se = { ...X.manga[4], fmt }; return { html: X.spineManga(se, { n: 1, t }, s, 'near'), label }; };
  items.push(book('bunko', '문고 148', 11), book('b6', 'B6 182', 14), book('a5', 'A5 210', 17));
  const aizo = { ...X.manga[9], fmt: 'a5' }; items.push({ html: X.spineManga(aizo, { n: 2, t: 26 }, s, 'near'), label: '애장판 210' });
  const g = p => ({ html: X.spineGame(X.games.find(x => x.p === p), s, 'near'), label: `${X.PLAT[p].name} ${X.PLAT[p].mm.h}` });
  items.push(g('sw'), g('ps5'), g('pc'));
  items.push({ html: X.spineFilm(X.films[2], s, 'near'), label: `포스터 판 ${X.filmMM(X.films[2]).h}` });
  items.push({ html: X.spineAV(X.avs[3], s, 'near'), label: 'DVD 190' });
  host.innerHTML = `<div style="display:flex;gap:72px;align-items:flex-end;padding:24px 48px 0;background:linear-gradient(var(--bk-light),transparent 40%),var(--bk-back);border-bottom:18px solid var(--bk-lip)">${items.map(i => `<div style="position:relative;display:flex">${i.html}<span class="caption" style="position:absolute;top:calc(100% + 26px);left:50%;transform:translateX(-50%);margin:0;white-space:nowrap">${i.label}</span></div>`).join('')}</div><div style="height:40px"></div>`;
}
scaleLineup();

// ---------- 2. storyboards ----------
function storyboards() {
  const host = $('#story'); if (!host) return;
  const s = 1.0, temp = document.createElement('div');
  const se = X.manga.find(m => m.title === '조용한 숲의 마녀');
  const kinds = [
    { k: 'manga', name: '만화', how: '머리를 손끝으로 당겨 기울여 빼고, 표지가 보이게 돌린다. 클릭하면 표지가 열려 첫 장이 보인다.', spine: X.spineManga(se, se.vols[1], s, 'near'), neigh: i => X.spineManga(se, se.vols[(i + 3) % se.vols.length] || se.vols[0], s, 'near'), last: 'open' },
    { k: 'game', name: '게임', how: '케이스를 똑바로 밀어 빼고 앞면으로 돌린다. 클릭하면 뚜껑이 열려 디스크/카트리지 자리가 보인다.', spine: X.spineGame(X.games.find(g => g.p === 'ps5'), s, 'near'), neigh: i => X.spineGame(X.games.filter(g => g.p === 'ps5')[i + 2], s, 'near'), last: 'open' },
    { k: 'film', name: '영화', how: '포스터 판을 빼서 앞면으로. 클릭하면 판이 뒤집혀 뒷면(배경 이미지·연도·감독)이 보인다.', spine: X.spineFilm(X.films[5], s, 'near'), neigh: i => X.spineFilm(X.films[i + 8], s, 'near'), last: 'flip' },
    { k: 'av', name: 'AV', how: 'DVD 케이스를 빼서 앞면으로. 끌면 앞·뒤 재킷을 돌려 본다(뒷면은 이미 저장된 재킷).', spine: X.spineAV(X.avs[2], s, 'near'), neigh: i => X.spineAV(X.avs[i + 5], s, 'near'), last: 'flip' },
  ];
  const steps = ['1 꽂혀 있음', '2 당김', '3 앞면', '4 마지막 손짓'];
  let html = '';
  for (const kd of kinds) {
    temp.innerHTML = kd.spine; const sp = temp.firstElementChild;
    const o = X.objectFor(sp, s);
    html += `<div class="h"><b>${kd.name}</b>${kd.how}</div>`;
    steps.forEach((label, i) => {
      const cx = 150;
      const neigh = [-3, -2, -1, 1, 2, 3].map(d => { const t = document.createElement('div'); t.innerHTML = kd.neigh(d + 3); const e = t.firstElementChild; const w = parseFloat(e.style.width); return { d, w, html: kd.neigh(d + 3) }; });
      let left = cx - o.T / 2, parts = '';
      let xx = left; for (const n of neigh.filter(n => n.d < 0).reverse()) { xx -= n.w; parts += `<span class="neigh" style="left:${xx}px">${n.html}</span>`; }
      xx = left + o.T; for (const n of neigh.filter(n => n.d > 0)) { parts += `<span class="neigh" style="left:${xx}px">${n.html}</span>`; xx += n.w; }
      let obj = '';
      if (i === 0) parts += `<span class="neigh" style="left:${left}px">${kd.spine}</span>`;
      else {
        const t = i === 1 ? (kd.k === 'manga' ? X.tf(0, -16, 46 - o.W / 2, -20, o.angle, 1) : X.tf(0, -8, 80 - o.W / 2, 0, o.angle, 1))
          : i === 2 ? X.tf(0, -6, 30, 0, -14 * Math.sign(o.angle), 1) : X.tf(0, -6, 30, 0, kd.last === 'flip' ? 180 - 16 : -14 * Math.sign(o.angle), 1);
        let inner = X.o3HTML(o);
        if (i === 3 && kd.last === 'open') inner = inner.replace(/(<div class="cover" style="[^"]*transform:translateZ\([^)]*\))/, `$1 rotateY(${o.hinge === 'right' ? 140 : -140}deg)`);
        obj = `<div class="o3wrap" style="left:${cx - o.W / 2}px;width:${o.W}px;height:${o.H}px;transform:${t}">${inner}</div>`;
      }
      html += `<div><div class="row3d" style="perspective-origin:${cx}px 40%">${parts}${obj}</div><i class="st"></i></div>`;
    });
  }
  host.innerHTML = `<div class="h" style="border-bottom:1px solid var(--color-border)"></div>${steps.map(s => `<div class="h" style="border-left:1px solid var(--color-border);border-bottom:1px solid var(--color-border)"><b>${s}</b></div>`).join('')}${html}`;
}
storyboards();

// ---------- 3. face-out, stacks, boxes ----------
(() => {
  const w = 1700, h = 880, s = 1.1;
  const body = `<div class="room-near on" data-scale="${s}"><div style="padding:16px 16px 32px">${X.gameBay(w - 56 - 32, s, 'near', { maxRows: 1 })}</div></div>`;
  const inn = X.frame('f-game', w, h, X.winHTML({ title: '컬렉션 · 게임', active: 'game', body }));
  if (inn) { requestAnimationFrame(() => X.placeThumbs(inn)); X.attachShelf(inn.querySelector('.room-near'), { s }); }
})();
function boxSpecimen() {
  const host = $('#spec-box'); if (!host) return;
  const s = 1.1, se = X.manga.filter(m => m.state === 'complete' && m.vols.length >= 8)[0];
  const loose = se.vols.map(v => X.spineManga(se, v, s, 'near')).join('');
  host.innerHTML = `<div style="display:flex;gap:64px;align-items:flex-end;padding:24px 24px 0;background:linear-gradient(var(--bk-light),transparent 40%),var(--bk-back);border-bottom:18px solid var(--bk-lip)">
    <div style="display:flex;align-items:flex-end">${loose}</div><div style="display:flex;align-items:flex-end">${X.boxManga(se, s, 'near')}</div></div>
    <div style="display:flex;gap:64px;padding:6px 24px 0"><span class="caption" style="margin:0">낱권 (${se.vols.length}권)</span><span class="caption" style="margin:0 0 0 auto">박스 세트 · 보기에서 켜면 다 모은 시리즈만 한 칸으로</span></div>`;
}
boxSpecimen();

// ---------- 4. sorting and filtering on the shelf ----------
function sortDemo() {
  const host = $('#spec-sort'); if (!host) return;
  const s = 1.2, list = X.games.filter(g => g.p === 'sw' || g.p === 'ps5' || g.p === 'ps4');
  const items = list.map(g => X.spineGame(g, s, 'near').replace('class="sp g"', `class="sp g" data-title="${g.title}" data-year="${g.year}" data-score="${g.score}" data-status="${g.status}"`));
  const width = Math.min(host.clientWidth || 1600, 1640);
  host.innerHTML = X.bookcaseHTML({ width, rows: [X.rowHTML({ items, labels: [`<span class="lh">게임 · 고른 순서 <span class="n">${list.length}</span></span>`], height: 30 + X.px(190 * s) + 22, board: 22 })], up: 14, cap: 12, plinth: 18 });
  const row = host.querySelector('.bk-items');
  const flip = order => {
    const els = [...row.children], before = new Map(els.map(e => [e, e.getBoundingClientRect().left]));
    order(els).forEach(e => row.appendChild(e));
    els.forEach(e => { const d = before.get(e) - e.getBoundingClientRect().left; if (!d) return; e.style.transition = 'none'; e.style.transform = `translateX(${d}px)`; });
    row.offsetWidth;
    els.forEach((e, i) => { e.style.transition = X.RM ? 'none' : `transform 380ms cubic-bezier(.2,0,0,1) ${Math.min(i, 30) * 4}ms`; e.style.transform = ''; });
    setTimeout(() => els.forEach(e => { e.style.transition = ''; }), 700);
  };
  const mark = test => row.querySelectorAll('.sp').forEach(e => { const hit = test ? test(e.dataset) : null; e.classList.toggle('is-hit', hit === true); e.classList.toggle('is-dim', hit === false); });
  const lh = host.querySelector('.lh');
  const acts = {
    name: () => { mark(null); flip(els => els.sort((a, b) => a.dataset.title.localeCompare(b.dataset.title, 'ko'))); lh.innerHTML = `게임 · 이름순 <span class="n">${list.length}</span>`; },
    year: () => { mark(null); flip(els => els.sort((a, b) => b.dataset.year - a.dataset.year)); lh.innerHTML = `게임 · 발매일순 <span class="n">${list.length}</span>`; },
    score: () => mark(d => d.score === '5'),
    playing: () => mark(d => d.status === 'playing'),
    find: () => mark(d => d.title.includes('바다')),
    clear: () => mark(null),
  };
  document.querySelectorAll('[data-sort]').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('[data-sort]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); acts[b.dataset.sort](); }));
}
sortDemo();

// ---------- 5. materials ----------
function materials() {
  const host = $('#spec-mat'); if (!host) return;
  const mats = [['ex-mat-ink', '먹색 목재 (기본 제안)'], ['ex-mat-lacquer', '흑단 래커'], ['ex-mat-oak', '밝은 오크 (종이 테마용)']];
  host.innerHTML = mats.map(([cls, name]) => {
    const rows = X.mangaRows(1.0, 420, 'near', { labels: false });
    return `<div class="${cls}"><div style="padding:24px;background:var(--wall)">${X.bookcaseHTML({ width: 470, rows: [rows[0]], up: 14, cap: 12, plinth: 24 })}</div><div class="caption">${name}</div></div>`;
  }).join('');
}
materials();

// ---------- 6. tablet ----------
X.BUILD.tabletManga('f-tab-manga');
X.BUILD.tabletWall('f-tab-wall');

// ---------- layout ----------
if (only) {
  const el = document.getElementById(only);
  if (el) { document.body.classList.add('only'); document.body.prepend(el); }
}
X.fitFrames();
addEventListener('resize', () => X.fitFrames());
requestAnimationFrame(() => { document.querySelectorAll(".fr-in").forEach(i => X.placeThumbs(i)); document.querySelectorAll(".menu").forEach(m => X.placeThumbs(m)); });
if (params.get('pull')) setTimeout(() => {
  const [frameId, title, n] = params.get('pull').split(':');
  demoPull(frameId, decodeURIComponent(title), +n);
}, 300);
if (params.get('act')) setTimeout(() => document.querySelector(`[data-sort="${params.get('act')}"]`)?.click(), 200);
if (params.get('tabpull')) setTimeout(() => demoPull('f-tab-manga', '등대지기의 딸', 2), 300);
})();
