/* Collection exhibit concept board: stand-in data, shelf packing at any px-per-mm, and the mockup interactions.
   Everything here is mockup code. Titles, authors, publishers and art are invented; no real covers or library data. */
(() => {
'use strict';
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- seeded random ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const R = mulberry32(20261023);
const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
const pick = a => a[Math.floor(R() * a.length)];
const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360} ${s}% ${l}%)`;
const px = v => Math.max(1, Math.round(v));

// ---------- icons (Heroicons outline paths) ----------
const ICON = {
  home: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  photo: 'm2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Z',
  box: 'm20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z',
  book: 'M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25',
  doc: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
  swap: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
  search: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  more: 'M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z',
  spark: 'M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09Z',
  users: 'M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z',
  cal: 'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5',
  grid: 'M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z',
  plus: 'M12 4.5v15m7.5-7.5h-15',
};
const svg = k => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[k]}"/></svg>`;

// ---------- stand-in data ----------
const TODAY = new Date(2026, 9, 23);
const addDays = n => new Date(TODAY.getTime() + n * 864e5);
const md = d => `${d.getMonth() + 1}.${d.getDate()}`;
const dday = d => { const n = Math.round((d - TODAY) / 864e5); return n === 0 ? '오늘' : `D-${n}`; };

const MANGA_TITLES = ['바다의 서재', '달빛 우체국', '소금과 별', '유리 정원', '겨울 항구 이야기', '검은 고양이 탐정단', '하늘 도서관', '철의 정원사', '여름빛 레시피', '조용한 숲의 마녀',
  '붉은 실 연대기', '모래시계 학원', '등대지기의 딸', '은빛 기사단', '나비 정거장', '별을 줍는 소년', '잿빛 도시', '푸른 불꽃', '고양이 식당', '시간 수선공', '백야의 노래', '종이비행기 클럽',
  '황금 사과', '안개 속 열차', '작은 용의 하루', '밤의 미술관', '눈꽃 검객', '해변의 탐정', '우주 택배', '비밀의 서고', '산호초 학교', '노을 편의점', '거울 나라 일기', '유령 하숙집',
  '북쪽 마을 의사', '천 개의 열쇠', '무지개 공방', '해적 요리사', '구름 목장', '마지막 열차'];
const AUTHORS = ['한서윤', '오카모토 레이', '이도현', '미즈키 하루', '강은채', '타카노 소라', '박지후', '아오이 렌', '윤가람', '사쿠라이 유'];
const PUBS = [['파랑새코믹스', '파'], ['은하문고', '은'], ['둥지북스', '둥'], ['하늘연', '하'], ['소라출판', '소']];
const FMT = { bunko: { h: 148, w: 105, t: [9, 12], name: '문고' }, b6: { h: 182, w: 128, t: [12, 16], name: 'B6' }, a5: { h: 210, w: 148, t: [14, 19], name: 'A5' } };

const manga = MANGA_TITLES.map((title, i) => {
  const r = R();
  const n = r < .18 ? ri(1, 3) : r < .78 ? ri(4, 13) : ri(14, 28);
  const fr = R();
  const fmt = fr < .7 ? 'b6' : fr < .9 ? 'a5' : 'bunko';
  const light = R() < .22 ? ri(64, 74) : ri(24, 46);
  const se = { id: 'm' + i, title, author: pick(AUTHORS), pub: pick(PUBS), fmt, hue: ri(0, 359), sat: ri(22, 58), light, style: pick(['same', 'same', 'step', 'alt']),
    k: ri(0, 3), state: R() < .42 ? 'complete' : 'collecting', vols: [], isNew: false, showcase: false };
  const base = ri(FMT[fmt].t[0], FMT[fmt].t[1]);
  for (let v = 1; v <= n; v++) se.vols.push({ n: v, t: base + (R() < .3 ? ri(-1, 1) : 0), st: 'own' });
  if (se.state === 'collecting') {
    const tail = R() < .5 ? 0 : ri(1, 2);
    for (let k = 0; k < tail && k < n - 1; k++) se.vols[n - 1 - k].st = 'miss';
    if (n > 6 && R() < .2) se.vols[ri(2, n - 3)].st = 'miss';
    if (R() < .55) se.vols.push({ n: n + 1, t: base, st: 'soon', date: addDays(ri(0, 38)) });
  }
  return se;
});
['나비 정거장', '종이비행기 클럽', '천 개의 열쇠'].forEach(t => { const s = manga.find(m => m.title === t); s.isNew = true; s.state = 'collecting'; });
['밤의 미술관', '바다의 서재', '조용한 숲의 마녀'].forEach(t => { manga.find(m => m.title === t).showcase = true; });
// One guaranteed release today, for the accent D-day tag.
{ const s = manga.find(m => m.title === '하늘 도서관'); s.state = 'collecting'; s.vols = s.vols.filter(v => v.st !== 'soon'); s.vols.push({ n: s.vols.length + 1, t: s.vols[0].t, st: 'soon', date: TODAY }); }
manga.sort((a, b) => a.title.localeCompare(b.title, 'ko'));

const CHO = ['ㄱ', 'ㄱ', 'ㄴ', 'ㄷ', 'ㄷ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅂ', 'ㅅ', 'ㅅ', 'ㅇ', 'ㅈ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const cho = s => { const c = s.charCodeAt(0); return c >= 0xAC00 && c <= 0xD7A3 ? CHO[Math.floor((c - 0xAC00) / 588)] : 'A'; };
function volColor(se, n) {
  let h = se.hue; if (se.style === 'step') h += n * 13; if (se.style === 'alt') h += (n % 2) * 150;
  const lightBg = se.light > 60;
  return { h, base: hsl(h, se.sat, se.light), art: `linear-gradient(${150 + n * 9}deg, ${hsl(h + 35, 60, 66)}, ${hsl(h - 25, 50, 30)})`,
    ink: lightBg ? '#15181a' : '#fff', nobg: lightBg ? '#15181a' : '#f2efe6', noink: lightBg ? '#f2efe6' : '#15181a' };
}

const PLAT = {
  sw2: { mm: { h: 170, w: 105, t: 11 }, plastic: '#a5141c', hd: '#151515', hdink: '#ff4b55', label: '2', name: '스위치 2' },
  sw: { mm: { h: 170, w: 105, t: 11 }, plastic: '#c8242b', hd: '#efefef', hdink: '#c8242b', label: 'S', name: '스위치' },
  ps5: { mm: { h: 172, w: 135, t: 13 }, plastic: '#24418f', hd: '#f2f2f2', hdink: '#111', label: 'P5', name: 'PS5' },
  ps4: { mm: { h: 172, w: 135, t: 13 }, plastic: '#101215', hd: '#0b3a8c', hdink: '#fff', label: 'P4', name: 'PS4' },
  pc: { mm: { h: 190, w: 135, t: 14 }, plastic: '#0d0e10', hd: '#0d0e10', hdink: '#d8d8d8', label: 'PC', name: 'PC' },
};
const GA = ['별', '강철', '바다', '하늘', '그림자', '유리', '숲', '달', '불꽃', '얼음', '모래', '바람', '새벽', '심연', '태엽'];
const GB = ['전설', '기사', '여정', '왕국', '탐험', '연대기', '항해', '정원', '도시', '미궁', '사냥꾼', '수호자'];
const GE = ['LUNAR SAGA', 'IRON TIDES', 'ECHO DRIFT', 'HOLLOW LANTERN', 'NEON HARBOR', 'PAPER KNIGHT', 'VELVET CIRCUIT', 'SILENT ORBIT', 'CRIMSON GARDEN', 'EMBER ROAD'];
const PLAT_MIX = [['sw2', 10], ['sw', 46], ['ps5', 30], ['ps4', 24], ['pc', 16]];
const games = [];
for (const [p, count] of PLAT_MIX) for (let i = 0; i < count; i++) {
  const title = R() < .25 ? pick(GE) + (R() < .3 ? ' ' + ri(2, 4) : '') : `${pick(GA)}의 ${pick(GB)}${R() < .25 ? ' ' + ri(2, 3) : ''}`;
  games.push({ id: `g${games.length}`, kind: 'game', p, title, hue: ri(0, 359), sat: ri(30, 70), light: ri(22, 52), year: ri(2014, 2026), k: ri(0, 3),
    status: pick(['done', 'done', 'playing', 'unplayed', 'unplayed']), score: R() < .2 ? 5 : ri(2, 4), isNew: false, showcase: false });
}
games.forEach(g => { g.title = g.title.trim(); });
games[3].isNew = games[60].isNew = true; games[12].showcase = games[70].showcase = games[110].showcase = true;
games.find(g => g.p === 'sw').title = '바다의 정원';
games.filter(g => g.p === 'ps5')[4].title = '바다 건너 왕국';

const FT = ['겨울의 끝', '푸른 방', '열두 번째 밤', '빛의 지도', '고요한 강', '여름 정류장', '두 개의 달', '마지막 상영', '안개 도시', '바람이 지나간 자리', '유리 심장', '느린 오후',
  '먼 바다', '은하 철도의 밤', '붉은 우산', '그해 봄', '창문 너머', '조용한 추격', '별빛 극장', '하얀 길', '새벽 세 시', '모래의 여자들', '작은 혁명', '검은 호수', '편지', '귀향',
  '소년의 시간', '여름의 문', '파도 위의 집', '마음의 지도', '유령 열차', '오래된 미래'];
const DIRS = ['정하윤', '사토 미오', '김태오', 'L. 마르탱', '나카무라 켄', '오서진'];
const films = FT.map((title, i) => ({ id: 'f' + i, kind: 'film', title, year: ri(1984, 2026), dir: pick(DIRS), hue: ri(0, 359), sat: ri(30, 70), light: ri(20, 45), k: ri(0, 3), ratio: R() < .8 ? 2 / 3 : .706, showcase: i === 7 || i === 13 }));
films.sort((a, b) => b.year - a.year);
const avs = Array.from({ length: 18 }, (_, i) => ({ id: 'a' + i, kind: 'av', title: `LKA-${String(101 + i * 7).padStart(3, '0')}`, hue: ri(300, 400), sat: ri(20, 45), light: ri(30, 50), k: ri(0, 3) }));

// ---------- artwork ----------
function coverHTML(o, w, h, { no = null, text = true } = {}) {
  const h0 = o.hue;
  const st = `--a:${hsl(h0 + 25, Math.min(80, o.sat + 15), Math.min(70, o.light + 22))};--b:${hsl(h0 - 30, o.sat, Math.max(12, o.light - 12))};--ang:${150 + (h0 % 60)}deg;--fig:${hsl(h0 + 180, 30, 10)}cc;--fx:${14 + (h0 % 30)}%;--tf:${px(w * .11)}px;--nf:${px(w * .12)}px;--sf:${px(w * .065)}px;--sun:${hsl(h0 + 60, 80, 85)}88`;
  return `<div class="art-cover k${o.k}" style="width:${w}px;height:${h}px;${st}"><i class="fig"></i>${text && w > 40 ? `<span class="ttl">${o.title}</span>` : ''}${no != null && w > 30 ? `<span class="vno">${no}</span>` : ''}${text && w > 60 && o.author ? `<span class="sub">${o.author}</span>` : ''}</div>`;
}
const mangaVolArt = (se, n) => { const c = volColor(se, n); return { ...se, hue: c.h, sat: Math.max(35, se.sat), light: Math.min(48, se.light) }; };

// ---------- spines ----------
function spineManga(se, v, s, lod) {
  const f = FMT[se.fmt], T = px(v.t * s), H = px(f.h * s), c = volColor(se, v.n);
  if (lod === 'far') return `<i class="sp far" data-s="${se.id}" style="width:${T}px;height:${H}px;background:linear-gradient(${c.base.replace(')', ' / .0)')}, transparent),linear-gradient(${hsl(c.h + 30, 50, 55)} 0 20%, ${c.base} 20%)"></i>`;
  const nob = px(Math.min(T - 2, 18)), nof = px(Math.min(T * .62, 12)), ttf = px(Math.max(7, Math.min(T * .6, 13)));
  return `<button class="sp m" data-k="manga" data-s="${se.id}" data-v="${v.n}" aria-label="${se.title} ${v.n}권" style="width:${T}px;height:${H}px;--c:${c.base};--art:${c.art};--ink:${c.ink};--nobg:${c.nobg};--noink:${c.noink};--nob:${nob}px;--nof:${nof}px;--ttf:${ttf}px">`
    + `<i class="art"></i><b class="no">${v.n}</b>${T >= 9 ? `<span class="tt">${se.title}</span><em class="pub">${se.pub[1]}</em>` : ''}</button>`;
}
function slotManga(se, v, s, lod) {
  const f = FMT[se.fmt], T = px(v.t * s), H = px(f.h * s * .96);
  if (lod === 'far') return `<i class="slot${v.st === 'soon' ? ' soon' : ''}" style="width:${T}px;height:${H}px;border-width:${v.st === 'soon' ? 0 : 1}px"></i>`;
  return `<i class="slot${v.st === 'soon' ? ' soon' : ''}" data-s="${se.id}" aria-label="${se.title} ${v.n}권 ${v.st === 'soon' ? '출간 예정' : '없음'}" style="width:${T}px;height:${H}px"><b>${v.n}</b></i>`;
}
function boxManga(se, s, lod) {
  const f = FMT[se.fmt], owned = se.vols.filter(v => v.st === 'own');
  const T = px(owned.reduce((a, v) => a + v.t, 0) * s + 4 * s), H = px((f.h + 4) * s), c = volColor(se, 1);
  if (lod === 'far') return `<i class="sp far" style="width:${T}px;height:${H}px;background:${hsl(c.h, se.sat, Math.max(16, se.light - 10))}"></i>`;
  return `<button class="sp box" data-k="mangabox" data-s="${se.id}" aria-label="${se.title} 박스 세트" style="width:${T}px;height:${H}px;--c:${hsl(c.h, se.sat, Math.max(16, Math.min(40, se.light - 6)))};--art:${c.art}">`
    + `<i class="art"></i><span class="tt">${se.title}</span><span class="rg">1–${owned.length}</span></button>`;
}
function spineGame(g, s, lod) {
  const P = PLAT[g.p], T = px(P.mm.t * s), H = px(P.mm.h * s), rim = px(2.5 * s), base = hsl(g.hue, g.sat, g.light);
  if (lod === 'far') return `<i class="sp far" data-id="${g.id}" style="width:${T}px;height:${H}px;background:linear-gradient(${P.plastic} 0 ${rim}px, ${P.hd} ${rim}px ${rim + px(H * .12)}px, ${base} 0 calc(100% - ${rim}px), ${P.plastic} 0)"></i>`;
  const art = `linear-gradient(${140 + g.hue % 80}deg, ${hsl(g.hue + 30, 70, 62)}, ${hsl(g.hue - 20, 55, 28)})`;
  return `<button class="sp g" data-k="game" data-id="${g.id}" aria-label="${g.title}" style="width:${T}px;height:${H}px;--plastic:${P.plastic};--rim:${rim}px;--c:${base};--hd:${P.hd};--hdink:${P.hdink};--art:${art};--w:${T}px;--ttf:${px(Math.max(7, Math.min(T * .56, 13)))}px">`
    + `<span class="ins"><i class="hd">${T >= 10 ? P.label : ''}</i><i class="art"></i>${T >= 9 ? `<span class="tt">${g.title}</span>` : ''}</span></button>`;
}
const filmMM = f => ({ h: Math.round(125 / f.ratio), w: 125, t: 14 });
function spineFilm(f, s, lod) {
  const mm = filmMM(f), T = px(mm.t * s), H = px(mm.h * s);
  const art = `linear-gradient(${150 + f.hue % 60}deg, ${hsl(f.hue + 25, 70, 64)}, ${hsl(f.hue - 30, 55, 22)})`;
  if (lod === 'far') return `<i class="sp far" data-id="${f.id}" style="width:${T}px;height:${H}px;background:linear-gradient(${hsl(f.hue + 10, 60, 50)} 0 41%, #121314 41%)"></i>`;
  return `<button class="sp f" data-k="film" data-id="${f.id}" aria-label="${f.title}" style="width:${T}px;height:${H}px;--art:${art};--ttf:${px(Math.max(7, Math.min(T * .56, 13)))}px">`
    + `<i class="art"></i>${T >= 9 ? `<span class="tt">${f.title}</span><span class="yr">${f.year}</span>` : ''}</button>`;
}
function spineAV(a, s, lod) {
  const T = px(14 * s), H = px(190 * s), rim = px(2.5 * s), base = hsl(a.hue, a.sat, a.light);
  if (lod === 'far') return `<i class="sp far" data-id="${a.id}" style="width:${T}px;height:${H}px;background:linear-gradient(#0f1011 0 ${rim}px, ${hsl(a.hue + 40, 50, 60)} 0 15%, ${base} 0)"></i>`;
  const art = `linear-gradient(${160}deg, ${hsl(a.hue + 20, 45, 66)}, ${hsl(a.hue - 20, 35, 32)})`;
  return `<button class="sp a" data-k="av" data-id="${a.id}" aria-label="${a.title}" style="width:${T}px;height:${H}px;--rim:${rim}px;--c:${base};--hd:${hsl(a.hue + 40, 50, 60)};--art:${art};--ttf:${px(Math.max(7, Math.min(T * .5, 12)))}px">`
    + `<span class="ins"><i class="hd"></i><i class="art"></i>${T >= 9 ? `<span class="tt">${a.title}</span>` : ''}</span></button>`;
}

// ---------- packing ----------
/* stream items: { w, h, html, newRow?, label?: html at the item's x (on the lip), ghost?: label for hover } */
function pack(stream, inner) {
  const rows = []; let row = null, x = 0;
  for (const it of stream) {
    if (it.softBreak && row && x > inner * .55) it.newRow = true;
    if (!row || it.newRow || (x + it.w > inner && row.items.length)) { if (it.skipAtRowStart && row && x + it.w > inner) continue; row = { items: [], labels: [], maxH: 0 }; rows.push(row); x = 0; if (it.skipAtRowStart) continue; }
    if (it.label) row.labels.push(`<span class="lh${it.ghost ? ' ghost' : ''}"${it.sid ? ` data-s="${it.sid}"` : ''} style="left:${Math.max(0, Math.min(x + (it.labelDx || 0), inner - 120))}px">${it.label}</span>`);
    if (it.ddayTag) { const today = +it.ddayTag === +TODAY; row.labels.push(`<span class="lh dday${today ? ' today' : ''}" style="left:${Math.max(0, x + it.w / 2 - 17)}px">${dday(it.ddayTag)}</span>`); }
    row.items.push(it.html); row.maxH = Math.max(row.maxH, it.h); x += it.w;
  }
  return rows;
}
const gapItem = (w, skip = true) => ({ w, h: 0, html: `<i class="gap" style="width:${w}px"></i>`, skipAtRowStart: skip });

function mangaStream(s, lod, { boxsets = false, labels = true } = {}) {
  const out = []; let lastCho = null;
  for (const se of manga) {
    const c = cho(se.title), H = px(FMT[se.fmt].h * s);
    if (c !== lastCho) {
      lastCho = c;
      if (lod === 'far') out.push(gapItem(px(6 * s) + 2));
      else out.push({ w: 9, h: H, html: `<i class="dv" style="height:${H}px"><b>${c}</b></i>` });
    } else out.push(gapItem(px(5 * s)));
    const owned = se.vols.filter(v => v.st === 'own').length;
    if (boxsets && se.state === 'complete' && owned >= 6) {
      const html = boxManga(se, s, lod), w = px(se.vols.reduce((a, v) => a + v.t, 0) * s + 4 * s);
      out.push({ w, h: px((FMT[se.fmt].h + 4) * s), html, label: labels && lod !== 'far' ? `${se.title} <span class="n">${owned}권</span>` : null, ghost: true, sid: se.id });
      continue;
    }
    se.vols.forEach((v, i) => {
      const w = px(v.t * s);
      const html = v.st === 'own' ? spineManga(se, v, s, lod) : slotManga(se, v, s, lod);
      const item = { w, h: H, html, sid: se.id };
      if (i === 0 && labels && lod !== 'far') { item.label = `${se.title} <span class="n">${owned} / ${se.vols.filter(x => x.st !== 'soon').length}권</span>`; item.ghost = true; }
      out.push(item);
      if (v.st === 'soon' && lod !== 'far') out[out.length - 1].ddayTag = v.date;
    });
  }
  return out;
}

// ---------- bookcase ----------
function rowHTML({ items, labels, height, board, extra = '', cls = '' }) {
  return `<div class="bk-row ${cls}" style="height:${height}px;--board:${board}px"><div class="bk-items">${items.join('')}</div>${extra}<div class="bk-board"></div><div class="bk-labels">${labels.join('')}</div></div>`;
}
function bookcaseHTML({ width, rows, up = 14, cap = 12, plinth = 40, pad = 8, cls = '' }) {
  return `<div class="bk ${cls}" style="width:${width}px;--up:${up}px;--cap:${cap}px;--plinth:${plinth}px;--pad:${pad}px"><div class="bk-cap"></div>${rows.join('')}<div class="bk-plinth"></div></div>`;
}
function ledgeHTML({ objs, s, height, board, gap, lod, inner = Infinity }) {
  // A short shelf shows the face-out covers smaller (0.72) and only as many as fit.
  const k = inner < 1000 ? .72 : 1; let used = 0;
  if (k !== 1) height = px((height - board) * k + board);
  objs = objs.filter(o => { const w = px(o.mm.w * s * k); if (used + w > inner) return false; used += w + gap; return true; });
  const items = objs.map(o => {
    const w = px(o.mm.w * s * k), h = px(o.mm.h * s * k);
    const tag = lod === 'far' ? '' : `<span class="fo-tag">${o.isNew ? '<span class="ui-badge ui-badge--accent">NEW</span>' : ''}</span>`;
    return `<div class="fo" data-k="${o.k2}" data-id="${o.id}" style="width:${w}px;height:${h}px">${coverHTML(o.art, w, h, { no: o.no, text: lod !== 'far' })}${tag}</div>`;
  });
  return `<div class="ledge" style="height:${height}px;--board:${board}px;--fo-gap:${gap}px"><div class="ledge-items">${items.join('')}</div><div class="bk-board"></div></div>`;
}

// Per-kind bays. `s` = px per mm, `inner` = usable shelf width in px.
function mangaRows(s, inner, lod, opts = {}) {
  const board = lod === 'far' ? 5 : 22, head = lod === 'far' ? 6 : 30;
  const rows = pack(mangaStream(s, lod, opts), inner);
  return rows.map(r => rowHTML({ items: r.items, labels: r.labels, height: head + r.maxH + board, board }));
}
function mangaFaceOut() {
  const out = [];
  for (const se of manga.filter(m => m.isNew || m.showcase)) {
    const last = se.vols.filter(v => v.st === 'own').slice(-1)[0] || se.vols[0];
    out.push({ id: se.id, k2: 'manga-fo', mm: FMT[se.fmt], art: { ...mangaVolArt(se, last.n), author: se.author }, no: last.n, isNew: se.isNew });
  }
  return out;
}
function mangaBay(width, s, lod, opts = {}) {
  const up = lod === 'far' ? 6 : 14, pad = lod === 'far' ? 4 : 8, inner = width - 2 * up - 2 * pad;
  const fo = mangaFaceOut();
  const foH = Math.max(...fo.map(o => o.mm.h)) * s;
  const ledge = opts.ledge === false ? '' : ledgeHTML({ objs: fo, s, height: px(foH + (lod === 'far' ? 10 : 40)), board: lod === 'far' ? 5 : 22, gap: px(lod === 'far' ? 6 : 28), lod, inner });
  const rows = mangaRows(s, inner, lod, opts);
  const bottom = opts.bottom === false ? [] : [bottomRow('manga', s, lod)];
  return bookcaseHTML({ width, rows: [ledge, ...(opts.maxRows ? rows.slice(0, opts.maxRows) : rows), ...bottom], up, pad, cap: lod === 'far' ? 5 : 12, plinth: lod === 'far' ? 10 : 40, cls: 'bay-manga' });
}
function gameBay(width, s, lod, opts = {}) {
  const up = lod === 'far' ? 6 : 14, pad = lod === 'far' ? 4 : 8, inner = width - 2 * up - 2 * pad, board = lod === 'far' ? 5 : 22, head = lod === 'far' ? 6 : 30;
  const stream = [];
  for (const p of ['sw2', 'sw', 'ps5', 'ps4', 'pc']) {
    const list = games.filter(g => g.p === p);
    if (lod === 'far') stream.push(gapItem(4));
    list.forEach((g, i) => stream.push({ w: px(PLAT[p].mm.t * s), h: px(PLAT[p].mm.h * s), html: spineGame(g, s, lod), softBreak: i === 0 && lod !== 'far',
      label: i === 0 && lod !== 'far' ? `${PLAT[p].name} <span class="n">${list.length}</span>` : null }));
    if (lod !== 'far') stream.push({ w: 13, h: px(PLAT[p].mm.h * s * .55), html: `<i class="be" style="height:${px(PLAT[p].mm.h * s * .55)}px"></i>` });
  }
  const rows = pack(stream, inner).map(r => rowHTML({ items: r.items, labels: r.labels, height: head + r.maxH + board, board }));
  const fo = games.filter(g => g.isNew || g.showcase).map(g => ({ id: g.id, k2: 'game-fo', mm: PLAT[g.p].mm, art: g, isNew: g.isNew }));
  const foH = Math.max(...fo.map(o => o.mm.h)) * s;
  const ledge = opts.ledge === false ? '' : ledgeHTML({ objs: fo, s, height: px(foH + (lod === 'far' ? 10 : 40)), board, gap: px(lod === 'far' ? 6 : 28), lod, inner });
  const bottom = opts.bottom === false ? [] : [bottomRow('game', s, lod)];
  return bookcaseHTML({ width, rows: [ledge, ...(opts.maxRows ? rows.slice(0, opts.maxRows) : rows), ...bottom], up, pad, cap: lod === 'far' ? 5 : 12, plinth: lod === 'far' ? 10 : 40, cls: 'bay-game' });
}
function filmBay(width, s, lod) {
  const up = lod === 'far' ? 6 : 14, pad = lod === 'far' ? 4 : 8, inner = width - 2 * up - 2 * pad, board = lod === 'far' ? 5 : 22, head = lod === 'far' ? 6 : 30;
  const stream = []; let dec = null;
  for (const f of films) {
    const d = Math.floor(f.year / 10) * 10, mm = filmMM(f);
    if (d !== dec) { dec = d; stream.push(lod === 'far' ? gapItem(4) : { w: 9, h: px(mm.h * s), html: `<i class="dv" style="height:${px(187 * s)}px"><b>${d}년대</b></i>` }); }
    stream.push({ w: px(mm.t * s), h: px(mm.h * s), html: spineFilm(f, s, lod) });
  }
  const rows = pack(stream, inner).map(r => rowHTML({ items: r.items, labels: r.labels, height: head + r.maxH + board, board }));
  const fo = films.filter(f => f.showcase).map(f => ({ id: f.id, k2: 'film-fo', mm: filmMM(f), art: { ...f, author: f.dir } }));
  const ledge = ledgeHTML({ objs: fo, s, height: px(190 * s + (lod === 'far' ? 10 : 40)), board, gap: px(lod === 'far' ? 6 : 28), lod, inner });
  return bookcaseHTML({ width, rows: [ledge, ...rows], up, pad, cap: lod === 'far' ? 5 : 12, plinth: lod === 'far' ? 10 : 40, cls: 'bay-film' });
}
function avBay(width, s, lod, { door = 'half' } = {}) {
  const up = lod === 'far' ? 6 : 14, pad = lod === 'far' ? 4 : 8, inner = width - 2 * up - 2 * pad, board = lod === 'far' ? 5 : 22, head = lod === 'far' ? 6 : 30;
  const stream = avs.map(a => ({ w: px(14 * s), h: px(190 * s), html: spineAV(a, s, lod) }));
  const rows = pack(stream, inner).map(r => rowHTML({ items: r.items, labels: r.labels, height: head + r.maxH + board, board }));
  return `<div style="position:relative">${bookcaseHTML({ width, rows, up, pad, cap: lod === 'far' ? 5 : 12, plinth: lod === 'far' ? 10 : 40, cls: 'bay-av' })}${door ? `<i class="av-door${door === 'closed' ? ' closed' : ''}" style="top:${lod === 'far' ? 5 : 12}px;bottom:${lod === 'far' ? 10 : 40}px;right:${up}px;${door === 'closed' ? `left:${up}px;width:auto` : ''}"></i>` : ''}</div>`;
}
function bottomRow(kind, s, lod) {
  const board = lod === 'far' ? 5 : 22, far = lod === 'far';
  const items = [];
  let h = 0;
  if (kind === 'game') {
    // 쌓아 둔 게임: unplayed cases lying flat, spines facing out (titles read horizontally).
    const pile = games.filter(g => g.status === 'unplayed').slice(0, 7);
    const bars = pile.map(g => { const P = PLAT[g.p]; const bh = px(P.mm.t * s), bw = px(P.mm.h * s); return `<i style="width:${bw}px;height:${bh}px;--c:${hsl(g.hue, g.sat, g.light)};--hd:${P.hd};--h:${bh}px">${far ? '' : `<em></em><span>${g.title}</span>`}</i>`; });
    h = pile.reduce((a, g) => a + px(PLAT[g.p].mm.t * s), 0);
    items.push(`<div class="stk" data-k="stack">${bars.join('')}</div>`, `<i class="gap" style="width:${px(40 * s)}px"></i>`);
  }
  const bw = px(230 * s), bh = px(150 * s);
  const soon = kind === 'manga' ? manga.flatMap(se => se.vols.filter(v => v.st === 'soon').map(v => ({ se, v }))).sort((a, b) => a.v.date - b.v.date) : [];
  const n = kind === 'manga' ? soon.length : 2, next = kind === 'manga' ? soon[0]?.v.date : addDays(9);
  const peek = kind === 'manga' && !far ? soon.slice(0, 3).map(({ se, v }, i) => { const c = volColor(se, v.n); return `<i class="peek" style="left:${14 + i * 22}%;width:${px(FMT[se.fmt].w * s * .35)}px;background:${c.art}"></i>`; }).join('') : '';
  items.push(`<div class="kraft" data-k="box" style="width:${bw}px;height:${bh}px">${peek}${far ? '' : `<span class="lbl">${kind === 'manga' ? '신간' : '발매 예정'} ${n}${kind === 'manga' ? '권' : '개'}<span class="n">다음 ${md(next)} · ${dday(next)}</span></span>`}</div>`);
  h = Math.max(h, bh);
  return rowHTML({ items, labels: [], height: (far ? 6 : 30) + h + board, board, cls: 'bk-row--bottom' });
}
function showcaseBay(width, s, lod) {
  const cols = 2, rows = 3, gap = lod === 'far' ? 6 : 16, cw = (width - gap * (cols + 1)) / cols, ch = 260 * s;
  const picks = [manga.find(m => m.title === '밤의 미술관'), games[12], films[7], manga.find(m => m.title === '바다의 서재'), games[70], films[13]];
  const cells = picks.map((o, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const mm = o.kind === 'game' ? PLAT[o.p].mm : o.kind === 'film' ? filmMM(o) : FMT[o.fmt];
    const art = o.vols ? mangaVolArt(o, 1) : o;
    const w = px(mm.w * s), h = px(mm.h * s);
    return `<div class="niche" style="left:${gap + c * (cw + gap)}px;top:${gap + r * (ch + gap)}px;width:${cw}px;height:${ch}px"><div class="obj" style="width:${w}px;height:${h}px">${coverHTML(art, w, h, { text: lod !== 'far' })}</div></div>`;
  }).join('');
  return `<div class="bk bay-show" style="width:${width}px;height:${gap + rows * (ch + gap)}px;--up:0px;padding:0">${cells}</div>`;
}

// ---------- mock chrome ----------
function seg(items, active, attrs = '') {
  return `<div class="ui-segmented" role="tablist" ${attrs}>${items.map(([k, l]) => `<button class="ui-segmented__cell" role="tab" data-key="${k}" data-segmented-active="${k === active}"><span class="ui-segmented__content"><span class="ui-segmented__label">${l}</span></span></button>`).join('')}<span class="ui-segmented__thumb"></span></div>`;
}
function placeThumbs(root) {
  root.querySelectorAll('.ui-segmented').forEach(sg => {
    const a = sg.querySelector('[data-segmented-active="true"]'), t = sg.querySelector('.ui-segmented__thumb');
    if (!a || !t) { if (t) t.style.width = '0'; return; }
    t.style.left = a.offsetLeft + 'px'; t.style.width = a.offsetWidth + 'px';
  });
}
const TYPES = [['all', '전체'], ['game', '게임'], ['manga', '만화'], ['film', '영화'], ['av', 'AV']];
const TYPE_NAME = Object.fromEntries(TYPES);
function winHTML({ title, count, active, body, extraBar = '' }) {
  return `<div class="win"><nav class="win-rail">${['home', 'photo', 'box', 'book', 'doc', 'swap'].map(k => `<i class="${k === 'box' ? 'on' : ''}">${svg(k)}</i>`).join('')}<i class="sp-r">${svg('search')}</i><i>${svg('more')}</i></nav>`
    + `<div class="win-main"><div class="win-title"><span class="wt">${title}</span><span class="n">${count ?? ''}</span><span class="wc"><i>—</i><i>☐</i><i>✕</i></span></div>`
    + `<div class="ui-section-bar">${seg(TYPES, active)}<div class="ui-section-bar__trailing"><button class="qb">${svg('spark')}쇼케이스</button><button class="qb">${svg('users')}캐릭터</button><button class="qb">${svg('cal')}발매 캘린더 <span class="n">3</span></button><i class="sepv"></i><button class="qb">${svg('grid')}보기</button></div>${extraBar}</div>`
    + `<div class="win-body">${body}</div></div></div>`;
}
function tabHTML({ active, body }) {
  return `<div class="tab"><div class="tb">컬렉션<span class="sp-x"><i>${svg('search')}</i><i>${svg('plus')}</i><i>${svg('more')}</i></span></div>`
    + `<div class="ui-section-bar">${seg(TYPES, active)}<div class="ui-section-bar__trailing"><button class="qb" aria-label="보기" style="width:44px;height:44px;justify-content:center">${svg('grid')}</button></div></div>`
    + `<div class="tab-body">${body}</div>`
    + `<nav class="tnav">${[['home', '홈'], ['photo', '에셋'], ['box', '컬렉션'], ['book', '카탈로그'], ['doc', '메모']].map(([k, l]) => `<i class="${k === 'box' ? 'on' : ''}">${svg(k)}${l}</i>`).join('')}</nav></div>`;
}

// ---------- the wall (overview) ----------
const WALL_S = .3;
function wallHTML(W, H, { s = WALL_S, scaleUp = 1, avDoor = 'half' } = {}) {
  const floorH = Math.round(H * .17), floorY = H - floorH;
  const bays = [
    { k: 'show', w: 200 * scaleUp, html: w => showcaseBay(w, s, 'far'), plq: `쇼케이스 <span class="n">6</span>` },
    { k: 'game', w: 270 * scaleUp, html: w => gameBay(w, s, 'far'), plq: `게임 <span class="n">${games.length}</span>` },
    { k: 'manga', w: 400 * scaleUp, html: w => mangaBay(w, s, 'far'), plq: `만화 <span class="n">${manga.reduce((a, m) => a + m.vols.filter(v => v.st === 'own').length, 0)}권</span>` },
    { k: 'film', w: 210 * scaleUp, html: w => filmBay(w, s, 'far'), plq: `영화 <span class="n">${films.length}</span>` },
    { k: 'av', w: 150 * scaleUp, html: w => avBay(w, s, 'far', { door: avDoor }), plq: `AV <span class="n">${avs.length}</span>` },
  ];
  const gap = 44 * scaleUp, total = bays.reduce((a, b) => a + b.w, 0) + gap * (bays.length - 1);
  let x = Math.max(24, (W - total) / 2);
  const parts = bays.map(b => { const h = `<div class="bay" tabindex="0" role="button" aria-label="${b.k === 'show' ? '쇼케이스' : TYPE_NAME[b.k]} 칸으로" data-bay="${b.k}" style="left:${x}px;width:${b.w}px"><i class="bay-lamp"></i>${b.html(b.w)}<span class="plq" style="top:calc(100% + 18px)">${b.plq}</span></div>`; x += b.w + gap; return h; });
  // Boxes on the floor beside the manga bay.
  return `<div class="wall"><div class="wall-floor" style="height:${floorH}px"></div><div class="wall-stage" style="width:${W}px;height:${H}px" data-floor="${floorY}">${parts.join('')}</div></div>`;
}
function settleWall(root) {
  const stage = root.querySelector('.wall-stage'); if (!stage) return;
  const floor = +stage.dataset.floor;
  stage.querySelectorAll('.bay').forEach(b => { b.style.top = (floor - b.offsetHeight) + 'px'; });
}

// ---------- pull out ----------
function objectFor(spine, s) {
  const k = spine.dataset.k;
  if (k === 'manga') {
    const se = manga.find(m => m.id === spine.dataset.s), v = se.vols.find(x => x.n === +spine.dataset.v), f = FMT[se.fmt];
    return { kind: 'manga', W: px(f.w * s), H: px(f.h * s), T: px(v.t * s), angle: -90, hinge: 'right', front: coverHTML({ ...mangaVolArt(se, v.n), author: se.author }, px(f.w * s), px(f.h * s), { no: v.n }),
      back: `<div style="position:absolute;inset:0;background:${volColor(se, v.n).base}"><i class="back-lines"></i><i class="barcode"></i></div>`, spine: spine.outerHTML.replace('class="sp m', 'class="sp m o3sp'),
      other: '<i class="pages"></i>', top: '<i class="pages h"></i>', inside: '<i class="panel-grid"><i></i><i></i><i></i><i></i><i></i></i>' };
  }
  if (k === 'game') {
    const g = games.find(x => x.id === spine.dataset.id), P = PLAT[g.p];
    return { kind: 'game', W: px(P.mm.w * s), H: px(P.mm.h * s), T: px(P.mm.t * s), angle: 90, hinge: 'left', front: coverHTML(g, px(P.mm.w * s), px(P.mm.h * s)),
      back: `<div style="position:absolute;inset:0;background:${hsl(g.hue, g.sat, Math.max(10, g.light - 14))}"><i style="position:absolute;left:10%;top:8%;width:80%;height:30%;background:${hsl(g.hue + 30, 50, 55)}"></i><i class="back-lines"></i><i class="barcode"></i></div>`,
      spine: spine.outerHTML, other: `<i class="plastic" style="--plastic:${P.plastic}"></i>`, top: `<i class="plastic" style="--plastic:${P.plastic}"></i>`, inside: `<i class="disc" style="left:12%;top:${(P.mm.h * s - P.mm.w * s * .76) / 2}px;width:76%;aspect-ratio:1"></i>` };
  }
  if (k === 'film') {
    const f = films.find(x => x.id === spine.dataset.id), mm = filmMM(f);
    return { kind: 'film', W: px(mm.w * s), H: px(mm.h * s), T: px(mm.t * s), angle: 90, hinge: null, front: coverHTML({ ...f, author: f.dir }, px(mm.w * s), px(mm.h * s)),
      back: `<div style="position:absolute;inset:0;background:#121314"><i style="position:absolute;left:0;right:0;top:0;height:42%;background:linear-gradient(120deg, ${hsl(f.hue + 40, 50, 50)}, ${hsl(f.hue - 30, 40, 20)})"></i><span style="position:absolute;left:8%;top:47%;color:#fff;font:700 12px/1.3 var(--font-ui)">${f.title}<br><span style="font-weight:400;color:#bbb">${f.year} · ${f.dir}</span></span><i class="back-lines"></i></div>`,
      spine: spine.outerHTML, other: '<i class="plastic" style="--plastic:#1a1b1c"></i>', top: '<i class="plastic" style="--plastic:#1a1b1c"></i>', inside: '' };
  }
  if (k === 'av') {
    const a = avs.find(x => x.id === spine.dataset.id);
    return { kind: 'av', W: px(135 * s), H: px(190 * s), T: px(14 * s), angle: 90, hinge: 'left', front: coverHTML(a, px(135 * s), px(190 * s)),
      back: `<div style="position:absolute;inset:0;background:${hsl(a.hue, a.sat, a.light - 10)}"><i style="position:absolute;left:8%;top:6%;width:40%;height:40%;background:${hsl(a.hue + 20, 40, 60)}"></i><i style="position:absolute;right:8%;top:6%;width:40%;height:40%;background:${hsl(a.hue - 20, 40, 50)}"></i><i class="back-lines"></i><i class="barcode"></i></div>`,
      spine: spine.outerHTML, other: '<i class="plastic" style="--plastic:#0f1011"></i>', top: '<i class="plastic" style="--plastic:#0f1011"></i>', inside: `<i class="disc" style="left:12%;top:28%;width:76%;aspect-ratio:1"></i>` };
  }
  return null;
}
function o3HTML(o) {
  const { W, H, T } = o;
  const spineSide = o.angle < 0 ? 'right' : 'left';
  const side = (which, html) => `<div class="face side" style="width:${T}px;height:${H}px;left:${(W - T) / 2}px;transform:rotateY(${which === 'right' ? 90 : -90}deg) translateZ(${W / 2}px)">${html}</div>`;
  const spineFace = `<div style="position:absolute;inset:0;display:flex">${o.spine.replace(/<button/, '<span').replace(/<\/button>$/, '</span>').replace(/class="sp /, 'class="sp ').replace(/style="width:\d+px;height:\d+px;/, `style="width:${T}px;height:${H}px;`)}</div>`;
  const hingeOrigin = o.hinge === 'right' ? '100% 50%' : '0 50%';
  return `<div class="o3 k-${o.kind}" style="width:${W}px;height:${H}px">`
    + `<div class="face inner" style="width:${W}px;height:${H}px;transform:translateZ(${T / 2 - 1}px)">${o.inside}</div>`
    + `<div class="cover" style="width:${W}px;height:${H}px;transform-origin:${hingeOrigin};transform:translateZ(${T / 2}px)"><div class="face front" style="width:${W}px;height:${H}px">${o.front}</div><div class="face inside" style="width:${W}px;height:${H}px"></div></div>`
    + `<div class="face back" style="width:${W}px;height:${H}px;transform:rotateY(180deg) translateZ(${T / 2}px)">${o.back}</div>`
    + side(spineSide, spineFace) + side(spineSide === 'right' ? 'left' : 'right', o.other)
    + `<div class="face side top" style="width:${W}px;height:${T}px;top:${(H - T) / 2}px;transform:rotateX(90deg) translateZ(${H / 2}px)">${o.top}</div>`
    + `</div>`;
}
const tf = (x, y, z, rx, ry, sc) => `translate3d(${x}px, ${y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) scale(${sc})`;

function attachShelf(root, { s, onOpen } = {}) {
  let out = null;
  const rowsOf = el => el.closest('.bk-items, .row3d');
  function putBack(instant = false) {
    if (!out) return;
    const o = out; out = null;
    root.querySelectorAll('.sp.is-run').forEach(e => e.classList.remove('is-run'));
    const done = () => { o.wrap.remove(); o.spine.classList.remove('is-out'); o.wrap.closest('.bk-row')?.classList.remove('is-holding'); };
    if (instant || RM) return done();
    o.wrap.querySelector('.cover').style.transform = `translateZ(${o.o.T / 2}px)`;
    const a = o.wrap.animate([{ transform: o.wrap.style.transform }, { transform: tf(0, -6, 18 - o.o.W / 2, o.o.kind === 'manga' ? -10 : 0, o.o.angle, 1), offset: .7 }, { transform: tf(0, 0, -o.o.W / 2, 0, o.o.angle, 1) }], { duration: 440, easing: 'cubic-bezier(.2,0,0,1)' });
    a.onfinish = done;
  }
  function pullOut(spine) {
    const scale = +(spine.closest('[data-scale]')?.dataset.scale || s || 1.1);
    const o = objectFor(spine, scale); if (!o) return;
    const items = rowsOf(spine);
    const sr = spine.getBoundingClientRect(), ir = items.getBoundingClientRect();
    const k = +(spine.closest('.fr-in')?.dataset.zoom || 1); // frames are scaled; convert screen px to layout px
    const cx = (sr.left - ir.left + sr.width / 2) / k;
    const wrap = document.createElement('div');
    wrap.className = 'o3wrap'; wrap.innerHTML = o3HTML(o);
    wrap.style.left = (cx - o.W / 2) + 'px'; wrap.style.width = o.W + 'px'; wrap.style.height = o.H + 'px';
    items.appendChild(wrap); items.closest('.bk-row')?.classList.add('is-holding');
    spine.classList.add('is-out');
    if (spine.dataset.s) root.querySelectorAll(`.sp[data-s="${spine.dataset.s}"]`).forEach(e => { if (e !== spine) e.classList.add('is-run'); });
    const rowW = items.clientWidth, grow = 1.28;
    const half = o.W * grow / 2 + 8, target = Math.min(Math.max(cx, half), rowW - half), dx = target - cx;
    const end = tf(dx, -12, 40, 0, 0, grow);
    out = { wrap, spine, o, rot: 0, dx, grow };
    wrap.style.transform = end;
    if (!RM && !window.EX_STILL) {
      const mid = o.kind === 'manga' ? tf(0, -10, 26 - o.W / 2, -13, o.angle, 1) : tf(0, -4, 34 - o.W / 2, 0, o.angle, 1);
      wrap.animate([{ transform: tf(0, 0, -o.W / 2, 0, o.angle, 1) }, { transform: mid, offset: .32 }, { transform: end }], { duration: 620, easing: 'cubic-bezier(.2,0,0,1)' });
    }
    // Drag turns the object; a click opens it (book cover, case lid) or flips a poster board to its back.
    let start = null, moved = false;
    wrap.addEventListener('pointerdown', e => { e.stopPropagation(); start = { x: e.clientX, r: out.rot }; moved = false; wrap.setPointerCapture(e.pointerId); });
    wrap.addEventListener('pointermove', e => { if (!start || !out) return; const d = e.clientX - start.x; if (Math.abs(d) > 4) moved = true; if (!moved) return; out.rot = start.r + d * .7; wrap.style.transform = tf(out.dx, -12, 40, 0, out.rot, out.grow); });
    wrap.addEventListener('pointerup', e => {
      e.stopPropagation(); const was = moved; start = null; if (!out || was) return;
      const cov = wrap.querySelector('.cover');
      if (o.kind === 'film') { out.rot = Math.abs(out.rot % 360) > 90 ? 0 : 180; wrap.style.transition = RM ? '' : 'transform 520ms cubic-bezier(.2,0,0,1)'; wrap.style.transform = tf(out.dx, -12, 40, 0, out.rot, out.grow); return; }
      const open = cov.dataset.open === '1'; cov.dataset.open = open ? '0' : '1';
      cov.style.transform = `translateZ(${o.T / 2}px) rotateY(${open ? 0 : (o.hinge === 'right' ? 155 : -155)}deg)`;
      onOpen?.(o, !open);
    });
    wrap.addEventListener('click', e => e.stopPropagation());
  }
  root.addEventListener('click', e => {
    const sp = e.target.closest('.sp:not(.far)');
    if (sp && root.contains(sp)) { e.stopPropagation(); if (out && out.spine === sp) return; putBack(true); pullOut(sp); return; }
    if (e.target.closest('.o3wrap')) return;
    putBack();
  });
  root.addEventListener('pointerover', e => {
    const sp = e.target.closest('[data-s]'); const sid = sp?.dataset.s;
    root.querySelectorAll('.lh.ghost.on').forEach(l => { if (l.dataset.s !== sid) l.classList.remove('on'); });
    if (sid) root.querySelectorAll(`.lh.ghost[data-s="${sid}"]`).forEach(l => l.classList.add('on'));
  });
  root.addEventListener('keydown', e => { if (e.key === 'Escape') putBack(); });
  return { pullOut, putBack, get out() { return out; } };
}

// ---------- frames ----------
function fitFrames() {
  const only = document.body.classList.contains('only');
  document.querySelectorAll('.fr').forEach(fr => {
    const w = +fr.dataset.w, h = +fr.dataset.h, inn = fr.querySelector('.fr-in');
    const avail = only ? w : Math.min(+fr.dataset.max || Infinity, fr.parentElement.clientWidth);
    const k = Math.min(1, avail / w);
    fr.style.width = w * k + 'px'; fr.style.height = h * k + 'px';
    inn.style.width = w + 'px'; inn.style.height = h + 'px'; inn.style.transform = `scale(${k})`;
    inn.dataset.zoom = k;
  });
}
function frame(id, w, h, html) {
  const fr = document.getElementById(id); if (!fr) return null;
  fr.dataset.w = w; fr.dataset.h = h;
  fr.innerHTML = `<div class="fr-in">${html}</div>`;
  return fr.querySelector('.fr-in');
}

// ---------- builders ----------
const BUILD = {};
// Hero: the wall, walk up to a bay.
BUILD.hero = (id, w = 1700, h = 1000, { start = 'all' } = {}) => {
  const bodyW = w - 56, bodyH = h - 40 - 41;
  const nearOf = k => {
    const bw = bodyW - 32;
    const body = k === 'manga' ? mangaBay(bw, 1.1, 'near') : k === 'game' ? gameBay(bw, 1.1, 'near') : k === 'film' ? filmBay(bw, 1.3, 'near') : k === 'av' ? avBay(bw, 1.3, 'near', { door: null }) : showcaseBay(bw, 1.2, 'near');
    const scale = k === 'film' || k === 'av' ? 1.3 : k === 'show' ? 1.2 : 1.1;
    return `<div class="room-near" data-near="${k}" data-scale="${scale}"><div style="padding:16px 16px 32px">${body}</div></div>`;
  };
  const html = winHTML({ title: '컬렉션', count: '', active: start, body: `<div class="room" style="position:absolute;inset:0">${wallHTML(bodyW, bodyH)}${['show', 'game', 'manga', 'film', 'av'].map(nearOf).join('')}</div>` });
  const inn = frame(id, w, h, html); if (!inn) return;
  requestAnimationFrame(() => { settleWall(inn); placeThumbs(inn); if (start !== 'all') walk(inn, start, true); });
  const room = inn.querySelector('.room');
  inn.querySelectorAll('.room-near').forEach(n => attachShelf(n, { s: +n.dataset.scale }));
  room.addEventListener('click', e => { const b = e.target.closest('.bay'); if (b && !inn.querySelector('.room-near.on')) walk(inn, b.dataset.bay); });
  room.addEventListener('keydown', e => { const b = e.target.closest('.bay'); if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); walk(inn, b.dataset.bay); } if (e.key === 'Escape') walk(inn, 'all'); });
  inn.querySelector('.ui-segmented').addEventListener('click', e => { const c = e.target.closest('[data-key]'); if (c) walk(inn, c.dataset.key); });
};
function walk(inn, key, instant = false) {
  const stage = inn.querySelector('.wall-stage'), nears = inn.querySelectorAll('.room-near');
  inn.querySelectorAll('.ui-section-bar .ui-segmented__cell').forEach(c => c.dataset.segmentedActive = String(c.dataset.key === key || (key === 'show' && c.dataset.key === 'all')));
  const thumb = inn.querySelector('.ui-section-bar .ui-segmented__thumb'); thumb.style.transition = instant || RM ? 'none' : 'left 240ms cubic-bezier(.2,0,0,1), width 240ms cubic-bezier(.2,0,0,1)';
  placeThumbs(inn.querySelector('.ui-section-bar'));
  inn.querySelector('.win-title .wt').textContent = key === 'all' ? '컬렉션' : key === 'show' ? '컬렉션 · 쇼케이스' : `컬렉션 · ${TYPE_NAME[key]}`;
  nears.forEach(n => n.classList.remove('on'));
  const dur = instant || RM ? 0 : 520;
  stage.style.transition = dur ? `transform ${dur}ms cubic-bezier(.3,0,.1,1)` : 'none';
  if (key === 'all') { stage.style.transform = 'none'; return; }
  const bay = stage.querySelector(`[data-bay="${key}"]`); if (!bay) return;
  const room = inn.querySelector('.room'), W = room.clientWidth, H = room.clientHeight;
  const bx = bay.offsetLeft, by = bay.offsetTop, bw = bay.offsetWidth;
  const z = (W - 32) / bw; // the bay's width fills the view, as in the near view
  stage.style.transform = `translate(${16 - bx * z}px, ${16 - by * z}px) scale(${z})`;
  const near = inn.querySelector(`.room-near[data-near="${key}"]`);
  setTimeout(() => near.classList.add('on'), Math.max(0, dur - 140));
}

// Manga bay, PC.
BUILD.mangaPC = (id, w, h, { boxsets = false } = {}) => {
  const bodyW = w - 56, s = 1.1;
  const body = `<div class="room-near on" data-scale="${s}" tabindex="-1"><div style="padding:16px 16px 32px">${mangaBay(bodyW - 32, s, 'near', { boxsets })}</div></div>`;
  const inn = frame(id, w, h, winHTML({ title: '컬렉션 · 만화', count: '', active: 'manga', body })); if (!inn) return;
  requestAnimationFrame(() => placeThumbs(inn));
  const near = inn.querySelector('.room-near');
  const api = attachShelf(near, { s });
  return { inn, api };
};
// Tablet portrait.
BUILD.tabletManga = (id, w = 800, h = 1280) => {
  const s = 1.2, bodyW = w - 48;
  const body = `<div class="room-near on" data-scale="${s}"><div style="padding:16px 24px 32px">${mangaBay(bodyW, s, 'near', { boxsets: false })}</div></div>`;
  const inn = frame(id, w, h, tabHTML({ active: 'manga', body })); if (!inn) return;
  inn.querySelector('.tab').style.setProperty('--x', 1);
  requestAnimationFrame(() => placeThumbs(inn));
  const api = attachShelf(inn.querySelector('.room-near'), { s });
  return { inn, api };
};
BUILD.tabletWall = (id, w = 800, h = 1280) => {
  const bodyH = h - 64 - 61 - 64;
  const W = 1900, s = .44;
  const body = `<div class="room" style="position:absolute;inset:0;overflow:hidden">${wallHTML(W, bodyH, { s, scaleUp: s / WALL_S })}</div>`;
  const inn = frame(id, w, h, tabHTML({ active: 'manga', body })); if (!inn) return;
  requestAnimationFrame(() => {
    placeThumbs(inn); settleWall(inn);
    const stage = inn.querySelector('.wall-stage'), bay = stage.querySelector('[data-bay="manga"]');
    stage.style.transform = `translateX(${w / 2 - (bay.offsetLeft + bay.offsetWidth / 2)}px)`;
    inn.querySelector('.wall').style.width = W + 'px';
  });
};

// Expose for the inline page script.
window.EX = { BUILD, walk, manga, games, films, avs, FMT, PLAT, filmMM, coverHTML, spineManga, spineGame, spineFilm, spineAV, slotManga, boxManga, volColor, mangaVolArt, mangaBay, gameBay, filmBay, avBay, rowHTML, bookcaseHTML, ledgeHTML, pack, mangaRows, attachShelf, objectFor, o3HTML, tf, frame, fitFrames, placeThumbs, winHTML, tabHTML, seg, svg, hsl, px, R, ri, TODAY, addDays, dday, md, RM, cho };
})();
