/* Mockup frames and small scripted interactions for the tablet structure proposals (2026-10-17).
   Stand-in data; the rules are in README.md. Markup uses the app's class names (mobile-client and shared). */
(() => {
'use strict';

/* ---------- Icons (Heroicons outline paths, as the app imports them) ---------- */
const P = {
  folder: 'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',
  folderPlus: 'M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',
  chevR: 'm8.25 4.5 7.5 7.5-7.5 7.5',
  chevD: 'm19.5 8.25-7.5 7.5-7.5-7.5',
  group: 'M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z',
  user: 'M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z',
  search: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  dots: 'M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z',
  stack: 'M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122',
  home: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  photo: 'm2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z',
  book: 'M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25',
  pencil: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10',
  swatch: 'M4.098 19.902a3.75 3.75 0 0 0 5.304 0l6.401-6.402M6.75 21A3.75 3.75 0 0 1 3 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 0 0 3.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008Z',
  trash: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0',
  link: 'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244',
  info: 'm11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z',
  minus: 'M15 12H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  eyeSlash: 'M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88',
  star: 'M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z',
  heart: 'M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z',
  check: 'm4.5 12.75 6 6 9-13.5',
  back: 'M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18',
  x: 'M6 18 18 6M6 6l12 12',
  inbox: 'M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z',
  drawer: 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12',
  pin: 'M8.4 3.6h7.2l-1.2 6 3.6 3.6H6l3.6-3.6-1.2-6zM12 13.2v7.2',
  memo: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
  arrowsUpDown: 'M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5',
};
const svg = (name, extra = '') => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}><path d="${P[name]}"/></svg>`;
const solid = (name) => `<svg class="i" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="${P[name]}"/></svg>`;
const fmt = (n) => n.toLocaleString('ko-KR');
const ph = (n) => `<span class="ph p${((n - 1) % 12) + 1}"></span>`;
const COLORS = { red: '#ef6b73', orange: '#f28c52', amber: '#dba84b', yellow: '#c9b94d', lime: '#8fbd52', green: '#58b67a', teal: '#47b6a7', cyan: '#4fabc9', blue: '#5b8def', indigo: '#7c7ee8', purple: '#aa75df', pink: '#df6fa7' };
const color = (key) => (key ? COLORS[key] : 'currentColor');

/* ---------- Stand-in library ---------- */
const FOLDERS = [
  { name: '캐릭터', color: 'pink', count: 9214, sub: '하위 폴더 8', p: [3, 9, 1] },
  { name: '게임 스크린샷', color: 'blue', count: 4812, sub: '하위 폴더 6', p: [2, 5, 8] },
  { name: '작가별', color: 'amber', count: 3150, sub: '하위 폴더 4', p: [7, 1, 4] },
  { name: '배경화면', color: 'teal', count: 1284, sub: '하위 폴더 4', p: [5, 8, 10] },
  { name: '레퍼런스', color: 'purple', count: 932, sub: '하위 폴더 5', p: [6, 12, 4] },
  { name: '코스프레', color: 'red', count: 611, p: [9, 7, 3] },
  { name: '오리지널', count: 388, p: [11, 6, 2] },
  { name: '밈', color: 'yellow', count: 214, p: [12, 4, 7] },
];
const ALBUMS = [
  { name: '마음에 들어요', count: 2140, p: [9, 3, 1] },
  { name: '배경 후보', count: 486, sub: '하위 앨범 2', p: [5, 2, 8] },
  { name: '프로필 사진', count: 73, p: [6, 9, 12] },
  { name: '레퍼런스 모음', count: 902, sub: '하위 앨범 3', p: [12, 4, 6] },
  { name: '2026 여름', count: 158, p: [2, 11, 5] },
  { name: '스케치 참고', count: 64, p: [4, 12, 7] },
];
const GAMES = [['엘든 링', 'PS5 · 2022', 5], ['젤다의 전설 티어스 오브 더 킹덤', 'Switch · 2023', 2], ['파이널 판타지 XVI', 'PS5 · 2023', 10], ['몬스터 헌터 와일즈', 'PS5 · 2025', 4],
  ['스트리트 파이터 6', 'PS5 · 2023', 7], ['페르소나 3 리로드', 'PS5 · 2024', 3], ['메타포: 리판타지오', 'PS5 · 2024', 11], ['스텔라 블레이드', 'PS5 · 2024', 9],
  ['데스 스트랜딩 2', 'PS5 · 2025', 8], ['드래곤 퀘스트 III', 'Switch · 2024', 6], ['이스 X', 'Switch · 2024', 12], ['젠레스 존 제로', 'PS5 · 2024', 1]];
const ARTISTS = [['Kuroboshi', 412, [3, 9, 1]], ['하나무라 렌', 388, [7, 2, 5]], ['mizuiro', 251, [6, 8, 12]], ['토마토소스', 203, [4, 11, 9]], ['aster', 177, [1, 5, 10]],
  ['니시나', 150, [9, 3, 7]], ['Hoshino K.', 122, [2, 6, 11]], ['유키카제', 98, [8, 12, 4]], ['pale_blue', 87, [10, 1, 3]], ['소라마치', 71, [5, 7, 2]], ['eno', 64, [11, 4, 8]], ['카나리아', 52, [12, 6, 9]]];
const RECENT = [
  { id: 'housing', name: '하우징', path: '게임 스크린샷 › 파이널 판타지 XIV', color: 'blue', count: 1284 },
  { id: 'gehenna', name: '게헨나', path: '캐릭터 › 블루 아카이브', color: 'pink', icon: 'group', count: 642 },
  { id: 'hand', name: '쥐는 손', path: '레퍼런스 › 인체 › 손', color: 'purple', count: 86 },
  { id: 'elden-scenery', name: '풍경', parent: '엘든 링', path: '게임 스크린샷 › 엘든 링', color: 'blue', dup: true, count: 233 },
  { id: 'desktop', name: '데스크톱 16:9', path: '배경화면', color: 'teal', count: 419 },
  { id: 'ff-scenery', name: '풍경', parent: '파이널 판타지 XIV', path: '게임 스크린샷 › 파이널 판타지 XIV', color: 'blue', dup: true, count: 175 },
];
const RECENT_ALBUMS = [
  { id: 'a-bg', name: '배경 후보', color: 'teal', icon: 'stack' },
  { id: 'a-like', name: '마음에 들어요', color: 'red', icon: 'stack' },
  { id: 'a-ref', name: '레퍼런스 모음', color: 'purple', icon: 'stack' },
  { id: 'a-summer', name: '2026 여름', color: 'orange', icon: 'stack' },
];

/* ---------- Pieces with the app's markup ---------- */
const iconBtn = (name, label, cls = '', attrs = '') => `<button type="button" class="ui-button ui-button--ghost ui-button--icon ui-icon-button ${cls}" aria-label="${label}" ${attrs}>${svg(name)}</button>`;
const sectionLabel = (title, count) => `<div class="ui-section-label"><span class="ui-section-label__title">${title}</span>${count !== undefined ? ` <span class="ui-section-label__count">${fmt(count)}</span>` : ''}<span class="ui-section-label__rule" aria-hidden="true"></span></div>`;
const statusBar = () => '<div class="t-status"><span>14:32</span><span>87%</span></div>';
const NAV = [['홈', 'home'], ['에셋', 'photo'], ['컬렉션', 'stack'], ['카탈로그', 'book'], ['메모', 'memo']];
const navBar = (active = '에셋') => `<nav class="t-nav" aria-hidden="true">${NAV.map(([l, i]) => `<span class="${l === active ? 'on' : ''}">${svg(i)}${l}</span>`).join('')}</nav>`;
function topBar({ title, count, crumbs, back = false, drawer = false, anno = '' }) {
  const lead = `${back ? iconBtn('back', '뒤로') : ''}${drawer ? iconBtn('drawer', '폴더 서랍', 't-drawer-btn', anno === 'drawer' ? 'data-anno="tap"' : '') : ''}${!back && !drawer ? '<span class="top-bar__brand"><span class="t-mark"></span></span>' : ''}`;
  const crumbHtml = crumbs ? `<div class="top-bar__parent"><span class="library-breadcrumb">${crumbs.map((c, i) => `<span><button type="button">${c}</button>${i < crumbs.length - 1 ? '<span>›</span>' : ''}</span>`).join('')}</span></div>` : '';
  return `<header class="top-bar asset-topbar">${lead}<div class="top-bar__titles">${crumbHtml}<div class="top-bar__title"><h1>${title}</h1>${count !== undefined ? `<span class="numeric muted top-bar__count">${fmt(count)}</span>` : ''}</div></div><span class="top-bar__space"></span><div class="top-bar__slots">${iconBtn('search', '찾기')}${iconBtn('dots', '더보기')}</div></header>`;
}
const segmented = (labels, active) => `<div class="ui-segmented ui-segmented--full-width library-segments" role="radiogroup"><span class="ui-segmented__thumb" style="left:calc(4px + ${active} * (100% - 8px) / ${labels.length});width:calc((100% - 8px) / ${labels.length})"></span>${labels.map((l, i) => `<button type="button" class="ui-segmented__cell" ${i === active ? 'data-segmented-active="true"' : ''}><span class="ui-segmented__content"><span class="ui-segmented__label">${l}</span></span></button>`).join('')}</div>`;
const coverGroup = (p) => `<span class="home-cover-group">${p.map((n) => `<span class="home-cover">${ph(n)}</span>`).join('')}</span>`;
const folderCard = (f, attrs = '') => `<button type="button" class="library-folder" ${attrs}><span class="folder-thumbnail">${coverGroup(f.p)}<span class="ui-badge ui-badge--scrim folder-thumbnail__count">${fmt(f.count)}</span></span><span class="folder-caption"><strong>${f.name}</strong></span>${f.sub ? `<small>${f.sub}</small>` : ''}</button>`;
function chip(r, { current = false, cls = '', disabled = false, attrs = '' } = {}) {
  return `<button type="button" class="ui-button ui-button--quiet ui-button--md recent-folders__chip ${cls}" style="--folder-color:${color(r.color)}" ${current ? 'aria-current="page"' : ''} ${disabled ? 'aria-disabled="true"' : ''} data-id="${r.id}" ${attrs}>${svg(r.icon || 'folder')}<span>${r.dup && r.parent ? `<span class="recent-folders__parent">${r.parent} › </span>` : ''}${r.name}</span></button>`;
}
const recentRow = (chips, heading = true) => `<section class="recent-section">${heading ? sectionLabel('최근') : ''}<div class="recent-row" role="group" aria-label="최근 폴더">${chips}</div></section>`;

function rootBody({ segment = 0, pressFolder = -1, pressChip = -1, pressAlbum = -1, pressArtist = -1 } = {}) {
  let inner = '';
  if (segment === 0) {
    inner = `<button type="button" class="library-all"><span class="all-covers">${[1, 5, 9, 2].map((n) => `<span class="home-cover">${ph(n)}</span>`).join('')}</span><span class="result-name"><strong>모든 자산</strong><small>최근 저장한 순서</small></span><span class="numeric muted">21,486</span>${svg('chevR')}</button>
      ${recentRow(RECENT.slice(0, 5).map((r, i) => chip(r, { attrs: i === pressChip ? 'data-anno="hold"' : '' })).join(''))}
      <section class="library-root-folders">${sectionLabel('분류', FOLDERS.length)}<div class="library-folder-grid">${FOLDERS.map((f, i) => folderCard(f, i === pressFolder ? 'data-anno="hold"' : '')).join('')}</div></section>`;
  } else if (segment === 1) {
    inner = `<div style="height:16px"></div>${sectionLabel('앨범', ALBUMS.length)}<div class="library-folder-grid" style="margin-top:12px">${ALBUMS.map((a, i) => `<div class="album-card-management">${folderCard(a, i === pressAlbum ? 'data-anno="hold"' : '')}</div>`).join('')}</div>`;
  } else {
    inner = `<div class="t-artists">${ARTISTS.map(([n, c, p], i) => `<div class="t-artist" ${i === pressArtist ? 'data-anno="hold"' : ''}><span>${p.map((k) => ph(k)).join('')}</span><strong>${n}<small>${fmt(c)}</small></strong></div>`).join('')}</div>`;
  }
  return `<div class="library-root-scroll">${segmented(['분류', '앨범', '작가'], segment)}${inner}</div>`;
}
const shell = ({ bar, body, nav = '에셋', overlay = '' }) => `<div class="mobile-app">${statusBar()}${bar}<div class="t-body">${body}</div>${navBar(nav)}${overlay}</div>`;

/* Gallery tiles: justified-looking rows of stand-ins. */
const WIDTHS = [150, 220, 180, 260, 140, 200, 240, 170, 210, 160, 230, 190];
function tiles(from, n, { selected = new Set(), viewerTile = -1 } = {}) {
  let out = '';
  for (let k = from; k < from + n; k++) {
    const sel = selected.has(k);
    out += `<div class="media-tile-shell" style="flex-basis:${WIDTHS[k % WIDTHS.length]}px"><button type="button" class="media-tile ui-selectable-media" data-tile="${k}" ${sel ? 'aria-selected="true"' : ''} ${k === viewerTile ? 'data-viewer-tile' : ''}>${ph(k * 5 + 3)}${sel ? '<span class="tile-select" data-selected="true"><span class="ui-selection-check"></span></span>' : ''}</button></div>`;
  }
  return `<div class="t-tiles">${out}</div>`;
}
function gallery({ selected, viewerTile, shelf = '', first = 0 } = {}) {
  return `<div class="t-scroll">${shelf}<div class="t-date">10월 16일 (목)</div>${tiles(first, 11, { selected, viewerTile })}<div class="t-date">10월 15일 (수)</div>${tiles(first + 11, 13, { selected, viewerTile })}<div class="t-date">10월 12일 (일)</div>${tiles(first + 24, 12, { selected, viewerTile })}</div>`;
}
function selectionBar({ count, all = false, pressedAll = false, more = false, anno = '' }) {
  return `<div class="asset-selection-bar" role="toolbar" aria-label="선택 작업"><strong>${typeof count === 'number' ? fmt(count) : count}개 선택</strong><span class="view-toolbar__divider" aria-hidden="true"></span>`
    + (all ? `<button type="button" class="ui-button ui-button--ghost ui-button--sm asset-selection-bar__all" aria-pressed="${pressedAll}" ${anno === 'all' ? 'data-anno="tap"' : ''}>전체 선택</button>` : '')
    + `<button type="button" class="ui-button ui-button--primary ui-button--sm">${svg('stack')}앨범에 추가</button>`
    + `<div class="asset-selection-bar__character"><button type="button" class="ui-button ui-button--ghost ui-button--sm" aria-label="분류 지정">${svg('user')}<span class="asset-selection-bar__label">분류</span></button></div>`
    + `<button type="button" class="ui-button ui-button--ghost ui-button--icon" aria-label="좋아요 켜기">${solid('heart')}</button><button type="button" class="ui-button ui-button--ghost ui-button--icon" aria-label="좋아요 끄기">${svg('heart')}</button>`
    + `<button type="button" class="ui-button ui-button--danger ui-button--icon" aria-label="휴지통으로">${svg('trash')}</button>`
    + (more ? `<button type="button" class="ui-button ui-button--ghost ui-button--icon" aria-label="선택 항목 메뉴" ${anno === 'more' ? 'data-anno="tap"' : ''}>${svg('dots')}</button>` : '')
    + `<button type="button" class="ui-button ui-button--ghost ui-button--icon" aria-label="선택 해제">${svg('x')}</button></div>`;
}

/* ---------- A. Action sheet ---------- */
const item = ([icon, label, state]) => `<button type="button" class="workspace-index-link"><span class="more-panel__icon">${svg(icon)}</span><span class="more-panel__label">${label}</span>${state ? `<span class="more-panel__state">${state}</span>` : ''}</button>`;
const dangerItem = ([icon, label]) => `<button type="button" class="workspace-index-link is-danger"><span class="more-panel__icon">${svg(icon)}</span><span class="more-panel__label">${label}</span></button>`;
const target = (thumb, name, meta) => `${thumb}<span class="action-sheet__text"><span class="action-sheet__name">${name}</span><span class="action-sheet__meta">${meta}</span></span>`;
const thumbPh = (n, round = false) => `<span class="action-sheet__thumb" ${round ? 'style="border-radius:50%"' : ''}>${ph(n)}</span>`;
const thumbIcon = (icon, c) => `<span class="action-sheet__thumb action-sheet__thumb--icon" style="--folder-color:${color(c)}">${svg(icon)}</span>`;
function actionSheet({ head, items, danger = [] }) {
  return `<div class="ui-dialog__overlay" data-motion="scrim" data-state="open"></div>
  <div class="ui-dialog" role="dialog" data-motion="dialog" data-state="open"><h2 class="ui-dialog__title action-sheet__target">${head}</h2>
    <div class="library-sheet"><div class="tablet-more"><nav class="more-panel__navigation">${items.map(item).join('')}</nav>${danger.length ? `<nav class="more-panel__navigation more-panel__navigation--danger">${danger.map(dangerItem).join('')}</nav>` : ''}</div><button type="button" class="ui-button ui-button--ghost ui-button--md">닫기</button></div></div>`;
}

/* ---------- C. Destination sheets ---------- */
const assignRow = (name, { c, depth = 0, kids = false, current = false, icon = 'folder' } = {}) => `<div class="tree-row${current ? ' is-current' : ''}" ${depth ? `style="padding-left:${depth * 16}px"` : ''}>${kids ? `<button type="button" class="tree-expander" aria-label="${name} 펼치기">${svg('chevR')}</button>` : '<span class="tree-leaf"></span>'}<button type="button" class="tree-select" role="radio" aria-checked="${current}"><span class="classification-assignment-mark" aria-hidden="true">${current ? '●' : '○'}</span><span style="color:${color(c)};display:flex">${svg(icon)}</span><span class="classification-assignment-name">${name}</span></button></div>`;
const assignTree = (current) => `<div class="classification-tree" role="radiogroup" aria-label="분류 선택">${assignRow('미분류', { icon: 'inbox' })}${FOLDERS.map((f) => assignRow(f.name, { c: f.color, kids: !!f.sub })).join('')}${current ? '' : ''}</div>`;
function destRow(list, { heading = '최근', disabledId = '', doneId = '', status = '' } = {}) {
  return `<section class="recent-destinations" data-dest>${sectionLabel(heading)}<div class="recent-row" role="group" aria-label="${heading}">${list.map((r) => chip(r, { disabled: r.id === disabledId, cls: r.id === doneId ? 'is-done' : '' }).replace(r.id === doneId ? svg(r.icon || 'folder') : '\u0000', svg('check'))).join('')}</div><p class="recent-destinations__status" role="status">${status}</p></section>`;
}
const DEST_FOLDERS = RECENT.filter((r) => r.icon !== 'group');
function classSheet({ done = false } = {}) {
  return `<div class="ui-dialog__overlay" data-motion="scrim" data-state="open"></div>
  <div class="ui-dialog" role="dialog" data-motion="dialog" data-state="open"><h2 class="ui-dialog__title">분류 변경 (12개)</h2>
    <div class="library-sheet"><div class="classification-batch-sheet classification-assignment-editor">
      ${destRow(DEST_FOLDERS, { disabledId: 'ff-scenery', doneId: done ? 'housing' : '', status: done ? '12/12개 분류 변경 · 하우징' : '' })}
      <label class="classification-search">${svg('search')}<input type="search" placeholder="분류 검색" aria-label="분류 검색" tabindex="-1"></label>
      ${assignTree()}
      <button type="button" class="ui-button ui-button--primary ui-button--md" disabled style="width:100%;margin-top:12px">적용</button>
    </div><button type="button" class="ui-button ui-button--ghost ui-button--md">닫기</button></div></div>`;
}
function albumSheet() {
  const entries = [['마음에 들어요', 0], ['배경 후보', 0], ['세로', 1], ['가로', 1], ['프로필 사진', 0], ['레퍼런스 모음', 0], ['포즈', 1], ['색감', 1], ['2026 여름', 0], ['스케치 참고', 0]];
  return `<div class="ui-dialog__overlay" data-motion="scrim" data-state="open"></div>
  <div class="ui-dialog" role="dialog" data-motion="dialog" data-state="open"><h2 class="ui-dialog__title">앨범에 추가</h2>
    <div class="library-sheet">${destRow(RECENT_ALBUMS, { heading: '최근' })}<div class="album-batch-list">${entries.map(([n, d]) => `<button type="button" class="album-batch-entry" style="padding-left:${12 + d * 20}px">${svg('stack')}<span>${n}</span></button>`).join('')}</div>
    <button type="button" class="ui-button ui-button--ghost ui-button--md">닫기</button></div></div>`;
}
function viewerLayer({ editor = '', imgStyle = '', backdropStyle = '', bars = true, anno = '' } = {}) {
  return `<div class="t-viewer" data-viewer><div class="t-viewer__backdrop" style="${backdropStyle}"></div>
    <div class="t-viewer__img" data-viewer-img style="${imgStyle}">${ph(18)}</div>
    ${bars ? `<header class="t-viewer__bar">${iconBtn('back', '뒤로')}<span class="numeric">37 / 1,284</span><strong style="color:#e7e9ec;margin-left:8px">mizuiro</strong><span class="t-vspace"></span><span class="t-vbtn">${svg('stack')}앨범</span><span class="t-vbtn ${editor ? 'is-on' : ''}">${svg('folder')}분류</span><span class="t-vbtn">${svg('heart')}</span><span class="t-vbtn">${svg('info')}정보</span><span class="t-vbtn" style="color:#e26767">${svg('trash')}</span></header>
    <div class="t-viewer__strip">${[3, 7, 11, 4, 18, 9, 2, 6, 10].map((n, i) => `<span class="ph p${((n - 1) % 12) + 1}${i === 4 ? ' on' : ''}"></span>`).join('')}</div>` : ''}${anno}</div>${editor}`;
}
function viewerEditor() {
  const rows = assignRow('미분류', { icon: 'inbox' }) + assignRow('캐릭터', { c: 'pink', kids: true }) + assignRow('게임 스크린샷', { c: 'blue', kids: true })
    + assignRow('파이널 판타지 XIV', { c: 'blue', depth: 1, kids: true }) + assignRow('하우징', { c: 'blue', depth: 2, kids: true }) + assignRow('글래머', { c: 'blue', depth: 2, current: true })
    + assignRow('레이드', { c: 'blue', depth: 2, kids: true }) + assignRow('풍경', { c: 'blue', depth: 2 }) + assignRow('엘든 링', { c: 'blue', depth: 1, kids: true })
    + assignRow('작가별', { c: 'amber', kids: true }) + assignRow('배경화면', { c: 'teal', kids: true }) + assignRow('레퍼런스', { c: 'purple', kids: true });
  return `<div class="ui-dialog__overlay" data-motion="scrim" data-state="open"></div>
  <div class="ui-dialog" role="dialog" data-motion="dialog" data-state="open"><h2 class="ui-dialog__title">분류</h2>
    <div class="classification-index classification-assignment-editor"><div class="dialog-header"><span>분류 변경</span>${iconBtn('x', '분류 선택 닫기')}</div>
      ${destRow(DEST_FOLDERS)}
      <label class="classification-search">${svg('search')}<input type="search" placeholder="분류 검색" aria-label="분류 검색" tabindex="-1"></label>
      <div class="classification-tree" role="radiogroup">${rows}</div></div></div>`;
}

/* ---------- B. Folder drawer ---------- */
const g = (name) => [name, { group: true }];
const TREE = [
  ['캐릭터', { color: 'pink' }, [['블루 아카이브', {}, [g('게헨나'), g('트리니티'), g('밀레니엄'), g('아비도스')]], ['원신', {}, [g('몬드'), g('리월'), g('이나즈마')]], ['붕괴: 스타레일'], ['우마무스메']]],
  ['게임 스크린샷', { color: 'blue' }, [['파이널 판타지 XIV', {}, [['하우징', {}, [['개인 집'], ['FC 하우스'], ['아파트']]], ['글래머'], ['레이드', {}, [['절 알렉산더'], ['절 오메가']]], ['풍경']]],
    ['엘든 링', {}, [['보스전'], ['풍경'], ['포토 모드']]], ['젤다의 전설 티어스 오브 더 킹덤'], ['몬스터 헌터 와일즈', {}, [['장비 세트'], ['오토모']]], ['스트리트 파이터 6']]],
  ['작가별', { color: 'amber' }, [['픽시브', {}, [['랭킹 저장'], ['북마크 정리']]], ['X'], ['스케브 의뢰']]],
  ['배경화면', { color: 'teal' }, [['데스크톱 16:9'], ['세로 9:16'], ['듀얼 모니터']]],
  ['레퍼런스', { color: 'purple' }, [['인체', {}, [['손', {}, [['쥐는 손'], ['펼친 손']]], ['포즈']]], ['옷 주름'], ['배경 원근']]],
  ['코스프레', { color: 'red' }], ['오리지널', {}], ['밈', { color: 'yellow' }],
];
const ALBUM_TREE = [['마음에 들어요', { color: 'red' }], ['배경 후보', { color: 'teal' }, [['세로'], ['가로']]], ['프로필 사진', {}], ['레퍼런스 모음', { color: 'purple' }, [['포즈'], ['색감'], ['손']]], ['2026 여름', { color: 'orange' }]];
function buildNodes(list, prefix) {
  const nodes = new Map(); let seq = 0;
  (function walk(items, parent, inherited, depth) {
    for (const [name, meta = {}, kids = []] of items) {
      const id = `${prefix}${++seq}`;
      const node = { id, name, parent, depth, group: !!meta.group, color: meta.color || inherited, kids: [], count: 30 + ((name.length * 977 + seq * 131) % 1900) };
      nodes.set(id, node);
      if (parent) nodes.get(parent).kids.push(id);
      walk(kids, id, node.color, depth + 1);
    }
  })(list, null, null, 0);
  return nodes;
}
function drawerTree(nodes, open, current, album = false) {
  const row = (n) => {
    const kids = n.kids.length > 0, isOpen = open.has(n.id);
    return `<div class="tree-row${n.id === current ? ' selected' : ''}" style="padding-left:${n.depth * 16}px">${kids ? `<button type="button" class="tree-expander" aria-expanded="${isOpen}" aria-label="${n.name} ${isOpen ? '접기' : '펼치기'}" data-toggle="${n.id}">${svg('chevR')}</button>` : '<span class="tree-leaf"></span>'}<button type="button" class="tree-select" data-open-id="${n.id}" style="--folder-color:${color(n.color)}">${svg(album ? 'stack' : n.group ? 'group' : 'folder')}<span>${n.name}</span><span class="numeric">${fmt(n.count)}</span></button></div>${kids ? `<div class="folder-drawer__branch" data-branch="${n.id}" data-open="${isOpen}"><div>${n.kids.map((k) => row(nodes.get(k))).join('')}</div></div>` : ''}`;
  };
  return `<div class="classification-tree" role="tree">${[...nodes.values()].filter((n) => !n.parent).map(row).join('')}</div>`;
}
const ancestorsOf = (nodes, id) => { const out = []; let n = nodes.get(id); while (n && n.parent) { out.unshift(n.parent); n = nodes.get(n.parent); } return out; };
const pathNames = (nodes, id) => ancestorsOf(nodes, id).map((a) => nodes.get(a).name);
const findByPath = (nodes, path) => { let parent = null, found = null; for (const name of path) { found = [...nodes.values()].find((n) => n.parent === parent && n.name === name); parent = found.id; } return found.id; };
const followSet = (nodes, id) => new Set([...ancestorsOf(nodes, id), ...(nodes.get(id).kids.length ? [id] : [])]);
function drawer({ nodes, albums, current, open, quick = '' }) {
  return `<div class="ui-dialog__overlay" data-motion="scrim" data-state="open" data-drawer-scrim></div>
  <div class="ui-dialog" role="dialog" data-motion="dialog" data-state="open" data-drawer><h2 class="ui-dialog__title" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">폴더 서랍</h2>
    <div class="classification-index folder-drawer"><div class="dialog-header"><span>에셋</span>${iconBtn('x', '서랍 닫기', '', 'data-drawer-close')}</div>
      <div class="folder-drawer__scroll">
        ${sectionLabel('빠른 보기')}<nav class="folder-drawer__quick">
          <button type="button" class="folder-drawer__link" ${quick === 'all' ? 'aria-current="page"' : ''}>${svg('photo')}<span>모든 자산</span><small>21,486</small></button>
          <button type="button" class="folder-drawer__link">${svg('inbox')}<span>미분류</span><small>312</small></button>
          <button type="button" class="folder-drawer__link">${svg('user')}<span>작가</span><small>1,047</small></button></nav>
        ${sectionLabel('고정')}<div class="folder-drawer__pins">${['블루 아카이브', '레퍼런스', '데스크톱 16:9'].map((n) => `<button type="button" class="folder-drawer__pin">${solid('pin')}<span>${n}</span></button>`).join('')}</div>
        ${sectionLabel('최근')}<div class="recent-row" role="group" aria-label="최근 폴더">${RECENT.slice(0, 5).map((r) => chip(r, { current: r.id === 'housing' && current === findByPath(nodes, ['게임 스크린샷', '파이널 판타지 XIV', '하우징']) })).join('')}</div>
        ${sectionLabel('폴더', [...nodes.values()].filter((n) => !n.parent).length)}<div data-tree>${drawerTree(nodes, open, current)}</div>
        ${sectionLabel('앨범', ALBUM_TREE.length)}${drawerTree(albums, new Set(), null, true)}
      </div></div></div>`;
}

/* ---------- Frames ---------- */
const NOSEL = new Set();
const range = (a, b) => new Set(Array.from({ length: b - a + 1 }, (_, i) => a + i));
const housingBar = (opts = {}) => topBar({ title: '하우징', count: 1284, crumbs: ['게임 스크린샷', '파이널 판타지 XIV'], back: true, ...opts });
const FRAMES = {
  'a-folder': () => shell({ bar: topBar({ title: '에셋' }), body: rootBody({ pressFolder: 1 }),
    overlay: actionSheet({ head: target(`<span class="action-sheet__thumb">${ph(2)}</span>`, '게임 스크린샷', '분류 · 4,812장 · 하위 폴더 6'),
      items: [['pin', '고정'], ['folderPlus', '하위 폴더 만들기'], ['pencil', '이름 바꾸기'], ['swatch', '아이콘 및 색상']] }) }),
  'a-album': () => shell({ bar: topBar({ title: '에셋' }), body: rootBody({ segment: 1, pressAlbum: 1 }),
    overlay: actionSheet({ head: target(thumbPh(5), '배경 후보', '앨범 · 486장 · 하위 앨범 2'),
      items: [['folderPlus', '하위 앨범 만들기'], ['pencil', '이름 바꾸기'], ['swatch', '아이콘 및 색상']], danger: [['trash', '삭제']] }) }),
  'a-collection': () => shell({ nav: '컬렉션', bar: topBar({ title: '컬렉션' }),
    body: `<div class="library-root-scroll">${segmented(['게임', '영화', '만화', 'AV'], 0)}<div class="t-covers">${GAMES.map(([n, m, p], i) => `<button type="button" class="t-cover" ${i === 0 ? 'data-anno="hold"' : ''}>${ph(p)}<strong>${n}</strong><small>${m}</small></button>`).join('')}</div></div>`,
    overlay: actionSheet({ head: target(thumbPh(5), '엘든 링', '게임 · PS5 · 2022'),
      items: [['pencil', '편집'], ['star', '쇼케이스에 추가']], danger: [['trash', '휴지통으로']] }) }),
  'a-artist': () => shell({ bar: topBar({ title: '에셋' }), body: rootBody({ segment: 2, pressArtist: 2 }),
    overlay: actionSheet({ head: target(thumbPh(6), 'mizuiro', '작가 · 251장'),
      items: [['pin', '고정'], ['pencil', '이름 바꾸기'], ['eyeSlash', '숨기기']] }) }),
  'a-chip': () => shell({ bar: topBar({ title: '에셋' }), body: rootBody({ pressChip: 2 }),
    overlay: actionSheet({ head: target(thumbIcon('folder', 'purple'), '쥐는 손', '레퍼런스 › 인체 › 손'),
      items: [['minus', '최근에서 빼기']] }) }),
  'a-images': () => shell({ bar: housingBar(), body: gallery({ selected: range(2, 13) }) + selectionBar({ count: 12, all: true, more: true, anno: 'more' }),
    overlay: actionSheet({ head: target(`<span class="action-sheet__thumb action-sheet__thumb--stack">${ph(13)}${ph(18)}</span>`, '12개 선택', '하우징'),
      items: [['link', '출처 복사'], ['stack', '앨범에 추가'], ['info', '정보 열기']], danger: [['trash', '휴지통으로']] }) }),

  'c-class': () => shell({ bar: housingBar(), body: gallery({ selected: range(2, 13) }) + selectionBar({ count: 12, all: true, more: true }), overlay: classSheet() }),
  'c-class-done': () => shell({ bar: housingBar(), body: gallery({ selected: range(2, 13) }) + selectionBar({ count: 12, all: true, more: true }), overlay: classSheet({ done: true }) }),
  'c-album': () => shell({ bar: housingBar(), body: gallery({ selected: range(2, 13) }) + selectionBar({ count: 12, all: true, more: true }), overlay: albumSheet() }),
  'c-viewer': () => shell({ bar: housingBar(), body: gallery(), overlay: viewerLayer({ editor: viewerEditor() }) }),

  'b-button': () => shell({ bar: housingBar({ drawer: true, anno: 'drawer' }), body: gallery() }),
  'b-drawer': () => '',  // built by initDrawer

  'd-all': () => shell({ bar: housingBar(), body: gallery({ selected: range(2, 13) }) + selectionBar({ count: 12, all: true, more: true, anno: 'all' }) }),
  'd-range': () => '',   // built by initRange

  'e-rest': () => '',    // built by initSwipe
  'e-drag': () => shell({ bar: housingBar(), body: gallery({ viewerTile: 6 }),
    overlay: viewerLayer({ bars: false, imgStyle: 'transform:translate(18px, 230px) scale(.8)', backdropStyle: 'opacity:.42',
      anno: '<div class="anno anno-finger" style="left:420px;top:870px"></div><div class="anno anno-tag" style="left:470px;top:960px">손가락을 따라 내려오고 뒤 화면이 비친다</div>' }) }),
  'e-close': () => shell({ bar: housingBar(), body: gallery({ viewerTile: 6 }), overlay: '<div class="t-viewer" data-closing><div class="t-viewer__backdrop" style="opacity:.12"></div><div class="t-viewer__img" data-closing-img>' + ph(18) + '</div></div>' }),

  'f-start': () => shell({ bar: housingBar(), body: gallery({ first: 3 }) }),
  'f-now': () => shell({ bar: topBar({ title: '파이널 판타지 XIV', count: 2210, crumbs: ['게임 스크린샷'], back: true }),
    body: gallery({ first: 14, shelf: `<div style="height:12px"></div>${sectionLabel('폴더', 4)}<div class="t-shelf-row" style="margin-top:12px">${[['하우징', [2, 5, 8], 1284], ['글래머', [9, 3, 1], 402], ['레이드', [10, 5, 11], 349], ['풍경', [2, 8, 12], 175]].map(([n, p, c]) => folderCard({ name: n, p, count: c })).join('')}</div>` }) }),
  'f-proposed': () => shell({ bar: topBar({ title: '게헨나', count: 642, crumbs: ['캐릭터', '블루 아카이브'], back: true }), body: gallery({ first: 26 }) }),
};

/* ---------- Building, scaling and annotations ---------- */
function placeAnnotations(tablet) {
  tablet.querySelectorAll('.anno[data-auto]').forEach((el) => el.remove());
  const s = parseFloat(tablet.style.getPropertyValue('--s')) || 0.5;
  const base = tablet.getBoundingClientRect();
  tablet.querySelectorAll('[data-anno]').forEach((el) => {
    const r = el.getBoundingClientRect();
    const x = (r.left + r.width / 2 - base.left) / s, y = (r.top + r.height / 2 - base.top) / s;
    const dot = document.createElement('div');
    dot.className = `anno anno-finger${el.dataset.anno === 'hold' ? ' is-hold' : ''}`;
    dot.dataset.auto = '';
    dot.style.left = `${x}px`; dot.style.top = `${y}px`;
    tablet.append(dot);
  });
}
const tablets = [];
function scaleAll() {
  for (const { frame, tablet } of tablets) tablet.style.setProperty('--s', String(frame.clientWidth / 800));
}
function build() {
  document.querySelectorAll('[data-frame]').forEach((frame) => {
    const key = frame.dataset.frame;
    const tablet = document.createElement('div');
    tablet.className = 'tablet';
    tablet.innerHTML = FRAMES[key] ? FRAMES[key]() : '';
    frame.append(tablet);
    tablets.push({ frame, tablet, key });
    const fig = frame.closest('.shot');
    if (fig && !fig.querySelector('.shot__zoom')) {
      const zoom = document.createElement('button');
      zoom.type = 'button'; zoom.className = 'shot__zoom'; zoom.textContent = '크게';
      zoom.addEventListener('click', () => { const wide = fig.classList.toggle('is-wide'); zoom.textContent = wide ? '작게' : '크게'; requestAnimationFrame(() => { scaleAll(); refresh(); }); });
      fig.insertBefore(zoom, fig.querySelector('figcaption'));
    }
    INIT[key]?.(tablet, frame);
  });
  scaleAll();
  new ResizeObserver(() => { scaleAll(); }).observe(document.body);
}
function refresh() { for (const { tablet } of tablets) { placeAnnotations(tablet); AFTER.get(tablet)?.(); } }
const AFTER = new Map();

/* ---------- Interactions ---------- */
const INIT = {};
const readout = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* C: one tap on a recent destination applies it; done in place, then the sheet closes itself. */
INIT['c-class'] = (tablet) => {
  const sheet = tablet.querySelector('.ui-dialog'), scrim = tablet.querySelector('.ui-dialog__overlay');
  const status = tablet.querySelector('.recent-destinations__status');
  let timer = 0;
  const reset = () => {
    clearTimeout(timer);
    sheet.dataset.state = 'open'; scrim.dataset.state = 'open';
    tablet.querySelectorAll('.recent-folders__chip.is-done').forEach((c) => { c.classList.remove('is-done'); c.querySelector('svg').outerHTML = svg(DEST_FOLDERS.find((r) => r.id === c.dataset.id).icon || 'folder'); });
    status.textContent = '';
    readout('c-readout', '최근 칩 하나를 눌러 보세요. 흐린 칩(<b>파이널 판타지 XIV › 풍경</b>)은 선택한 12개가 모두 이미 들어 있는 곳이라 누를 수 없습니다.');
  };
  tablet.addEventListener('click', (event) => {
    const c = event.target.closest('.recent-folders__chip');
    if (!c || c.getAttribute('aria-disabled') === 'true' || sheet.dataset.state !== 'open' || tablet.querySelector('.is-done')) return;
    const dest = DEST_FOLDERS.find((r) => r.id === c.dataset.id);
    c.classList.add('is-done'); c.querySelector('svg').outerHTML = svg('check');
    status.textContent = `12/12개 분류 변경 · ${dest.name}`;
    readout('c-readout', `<b>${dest.name}</b>(으)로 옮겼습니다. 0.9초 뒤 시트가 저절로 닫힙니다.`);
    timer = setTimeout(() => {
      sheet.dataset.state = 'closed'; scrim.dataset.state = 'closed';
      readout('c-readout', `시트가 닫히고 선택은 그대로 남습니다(다른 곳에도 넣을 수 있게). <button type="button" class="theme-reset" id="c-again">다시</button>`);
      document.getElementById('c-again')?.addEventListener('click', reset);
    }, 900);
  });
  reset();
};

/* B: the drawer. Chevrons follow FOLDER-NAV-001 (one open path); a row opens its place and closes the drawer. */
INIT['b-drawer'] = (tablet) => {
  const nodes = buildNodes(TREE, 'f'), albums = buildNodes(ALBUM_TREE, 'al');
  let current = findByPath(nodes, ['게임 스크린샷', '파이널 판타지 XIV', '하우징']);
  const open = followSet(nodes, current);
  const screen = (id) => { const n = nodes.get(id); const names = pathNames(nodes, id); return topBar({ title: n.name, count: n.count, crumbs: names.length ? names : undefined, back: true, drawer: true }); };
  tablet.innerHTML = shell({ bar: screen(current), body: gallery(), overlay: drawer({ nodes, albums, current, open }) });
  const sheet = tablet.querySelector('[data-drawer]'), scrim = tablet.querySelector('[data-drawer-scrim]');
  const setOpen = (on) => { sheet.dataset.state = on ? 'open' : 'closed'; scrim.dataset.state = on ? 'open' : 'closed'; };
  const sync = () => tablet.querySelectorAll('[data-branch]').forEach((b) => {
    const on = open.has(b.dataset.branch); b.dataset.open = String(on);
    const t = tablet.querySelector(`[data-toggle="${b.dataset.branch}"]`); if (t) t.setAttribute('aria-expanded', String(on));
  });
  tablet.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const id = toggle.dataset.toggle, n = nodes.get(id);
      if (open.has(id)) { open.delete(id); for (const d of [...open]) if (ancestorsOf(nodes, d).includes(id)) open.delete(d); }
      else {
        const sibs = [...nodes.values()].filter((x) => x.parent === n.parent && x.id !== id);
        for (const s of sibs) { open.delete(s.id); for (const d of [...open]) if (ancestorsOf(nodes, d).includes(s.id)) open.delete(d); }
        open.add(id);
      }
      sync();
      readout('b-readout', `<b>${n.name}</b> ${open.has(id) ? '펼침 · 같은 단계의 다른 갈래는 접힘' : '접음'}`);
      return;
    }
    const row = event.target.closest('[data-open-id]');
    if (row && nodes.has(row.dataset.openId)) {
      current = row.dataset.openId;
      tablet.querySelectorAll('[data-tree] .tree-row.selected').forEach((r) => r.classList.remove('selected'));
      row.closest('.tree-row').classList.add('selected');
      for (const id of [...open]) open.delete(id);
      for (const id of followSet(nodes, current)) open.add(id);
      sync();
      tablet.querySelector('.top-bar').outerHTML = screen(current);
      setOpen(false);
      readout('b-readout', `<b>${[...pathNames(nodes, current), nodes.get(current).name].join(' › ')}</b>(으)로 이동하고 서랍이 닫혔습니다. 왼쪽 위 ☰ 버튼으로 다시 엽니다.`);
      return;
    }
    if (event.target.closest('[data-drawer-close]') || event.target.closest('[data-drawer-scrim]')) { setOpen(false); readout('b-readout', '서랍을 닫았습니다. ☰ 버튼으로 다시 엽니다.'); return; }
    if (event.target.closest('.t-drawer-btn')) { setOpen(true); readout('b-readout', '서랍이 열렸습니다. 지금 위치의 경로만 펼쳐져 있습니다.'); }
  });
  readout('b-readout', '▸를 누르면 그 갈래가 펼쳐지고 같은 단계의 다른 갈래는 접힙니다. 폴더 이름을 누르면 그곳으로 가고 서랍이 닫힙니다.');
};

/* D: hold a tile (450 ms), then drag to select the run between the first tile and the finger; edges scroll. */
INIT['d-range'] = (tablet) => {
  let selected = range(4, 14);
  const body = () => `<div class="t-scroll" data-range-scroll style="overflow-y:auto;scrollbar-width:none;touch-action:pan-y">${['10월 16일 (목)', '10월 15일 (수)', '10월 12일 (일)', '10월 9일 (목)', '10월 3일 (금)'].map((d, i) => `<div class="t-date">${d}</div>${tiles(i * 12, 12, { selected })}`).join('')}<div style="height:120px"></div></div>`;
  tablet.innerHTML = shell({ bar: housingBar(), body: body() + selectionBar({ count: selected.size, all: true, more: true }) }) +
    '<div class="anno anno-band" style="top:1124px;height:96px" data-band></div><div class="anno anno-tag" style="left:24px;top:1078px" data-band>가장자리 96px에 닿으면 자동 스크롤</div>';
  const scroller = tablet.querySelector('[data-range-scroll]');
  const count = () => { tablet.querySelector('.asset-selection-bar > strong').textContent = `${selected.size}개 선택`; };
  const paint = () => {
    tablet.querySelectorAll('.media-tile').forEach((t) => {
      const k = Number(t.dataset.tile), on = selected.has(k);
      if (on && !t.hasAttribute('aria-selected')) { t.setAttribute('aria-selected', 'true'); t.insertAdjacentHTML('beforeend', '<span class="tile-select" data-selected="true"><span class="ui-selection-check"></span></span>'); }
      if (!on && t.hasAttribute('aria-selected')) { t.removeAttribute('aria-selected'); t.querySelector('.tile-select')?.remove(); }
    });
    count();
  };
  // Static illustration of the drag (finger path from tile 4 to 15), removed on first use.
  AFTER.set(tablet, () => {
    tablet.querySelectorAll('[data-path]').forEach((e) => e.remove());
    if (tablet.dataset.used) return;
    const s = parseFloat(tablet.style.getPropertyValue('--s')) || 0.5, base = tablet.getBoundingClientRect();
    const at = (k) => { const r = tablet.querySelector(`[data-tile="${k}"]`).getBoundingClientRect(); return [(r.left + r.width / 2 - base.left) / s, (r.top + r.height / 2 - base.top) / s]; };
    const [x1, y1] = at(4), [x2, y2] = at(14);
    tablet.insertAdjacentHTML('beforeend', `<svg class="anno" data-path style="left:0;top:0;width:800px;height:1280px" viewBox="0 0 800 1280"><path class="anno-line" d="M${x1} ${y1} C ${x1 + 160} ${y1 + 20}, ${x2 - 220} ${y2 - 60}, ${x2} ${y2}"/></svg><div class="anno anno-finger is-hold" data-path style="left:${x1}px;top:${y1}px"></div><div class="anno anno-finger" data-path style="left:${x2}px;top:${y2}px"></div><div class="anno anno-tag" data-path style="left:${Math.min(x1, 560)}px;top:${y1 - 70}px">길게 누른 뒤 손을 떼지 않고 끌기</div>`);
  });
  let press = null, timer = 0, raf = 0;
  const tileAt = (x, y) => document.elementFromPoint(x, y)?.closest('.media-tile');
  const applyRange = (k) => {
    const [a, b] = press.anchor < k ? [press.anchor, k] : [k, press.anchor];
    selected = new Set(press.before);
    for (let i = a; i <= b; i++) press.adding ? selected.add(i) : selected.delete(i);
    paint();
  };
  const edge = () => {
    if (!press?.active) return;
    const s = parseFloat(tablet.style.getPropertyValue('--s')) || 0.5, r = scroller.getBoundingClientRect(), zone = 96 * s;
    let v = 0;
    if (press.y > r.bottom - zone) v = Math.min(1, (press.y - (r.bottom - zone)) / zone) * 14;
    else if (press.y < r.top + zone) v = -Math.min(1, ((r.top + zone) - press.y) / zone) * 14;
    if (v) { scroller.scrollTop += v; const t = tileAt(press.x, press.y); if (t) applyRange(Number(t.dataset.tile)); }
    raf = requestAnimationFrame(edge);
  };
  scroller.addEventListener('pointerdown', (event) => {
    const t = event.target.closest('.media-tile'); if (!t || event.button > 0) return;
    const k = Number(t.dataset.tile);
    press = { anchor: k, x: event.clientX, y: event.clientY, sx: event.clientX, sy: event.clientY, active: false, before: new Set(selected), adding: !selected.has(k), id: event.pointerId };
    t.classList.add('is-pressing');
    timer = setTimeout(() => {
      if (!press) return;
      press.active = true; tablet.dataset.used = '1'; tablet.querySelectorAll('[data-path]').forEach((e) => e.remove());
      scroller.setPointerCapture?.(press.id); applyRange(k); raf = requestAnimationFrame(edge);
      readout('d-readout', `<b>${press.adding ? '고르는 중' : '빼는 중'}</b> · 손가락을 끌면 처음 타일부터 지금 타일까지 ${press.adding ? '선택됩니다' : '선택에서 빠집니다'}.`);
    }, 450);
  });
  scroller.addEventListener('pointermove', (event) => {
    if (!press) return;
    press.x = event.clientX; press.y = event.clientY;
    if (!press.active) { if (Math.hypot(press.x - press.sx, press.y - press.sy) > 10) { clearTimeout(timer); tablet.querySelector('.is-pressing')?.classList.remove('is-pressing'); press = null; } return; }
    event.preventDefault();
    const t = tileAt(event.clientX, event.clientY); if (t) applyRange(Number(t.dataset.tile));
  });
  const end = () => {
    clearTimeout(timer); cancelAnimationFrame(raf);
    tablet.querySelector('.is-pressing')?.classList.remove('is-pressing');
    if (press?.active) readout('d-readout', `<b>${selected.size}개 선택</b>. 다시 길게 눌러 끌면 이어서 고르고, 고른 타일에서 시작하면 빼기가 됩니다.`);
    press = null;
  };
  scroller.addEventListener('pointerup', end); scroller.addEventListener('pointercancel', end);
  readout('d-readout', '마우스로 타일을 0.45초 누른 채 끌어 보세요. 아래 가장자리로 가면 목록이 스스로 내려갑니다.');
};

/* E: drag the unzoomed image down from below the top bar; past the threshold it shrinks into its tile. */
INIT['e-rest'] = (tablet) => {
  const render = () => {
    tablet.innerHTML = shell({ bar: housingBar(), body: gallery({ viewerTile: 6 }), overlay: viewerLayer() }) +
      '<div class="anno anno-band" style="top:28px;height:56px"></div><div class="anno anno-tag" style="left:24px;top:94px">상단바에서 시작하면 닫기 아님</div>' +
      '<div class="anno anno-tag" style="left:24px;top:640px">사진 위에서 아래로 끌면 닫힘</div>';
  };
  render();
  const s = () => parseFloat(tablet.style.getPropertyValue('--s')) || 0.5;
  let drag = null;
  tablet.addEventListener('pointerdown', (event) => {
    const img = event.target.closest('[data-viewer-img]'); if (!img || event.button > 0) return;
    drag = { x: event.clientX, y: event.clientY, img, back: tablet.querySelector('.t-viewer__backdrop'), bars: tablet.querySelectorAll('.t-viewer__bar, .t-viewer__strip'), id: event.pointerId, t: performance.now() };
    img.setPointerCapture?.(event.pointerId); img.style.transition = 'none';
  });
  tablet.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = (event.clientX - drag.x) / s(), dy = Math.max(0, (event.clientY - drag.y) / s());
    const scale = 1 - Math.min(0.3, dy / 1400);
    drag.dy = dy; drag.dx = dx;
    drag.img.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    drag.back.style.opacity = String(Math.max(0.2, 1 - dy / 500));
    drag.bars.forEach((b) => { b.style.opacity = dy > 8 ? '0' : '1'; b.style.transition = 'opacity 120ms'; });
  });
  const release = () => {
    if (!drag) return;
    const { img, back, dy = 0, dx = 0 } = drag; drag = null;
    if (dy > 120) {
      const tile = tablet.querySelector('[data-viewer-tile]');
      const k = s(), tr = tile.getBoundingClientRect(), ir = img.getBoundingClientRect(), base = tablet.getBoundingClientRect();
      // Shrink from where the finger left it into the tile (the existing close zoom, ~320 ms).
      const from = { x: (ir.left - base.left) / k, y: (ir.top - base.top) / k, w: ir.width / k, h: ir.height / k };
      const to = { x: (tr.left - base.left) / k, y: (tr.top - base.top) / k, w: tr.width / k, h: tr.height / k };
      img.style.transition = 'none'; img.style.transform = 'none'; img.style.left = `${from.x}px`; img.style.top = `${from.y}px`; img.style.width = `${from.w}px`; img.style.height = `${from.h}px`; img.style.right = 'auto'; img.style.margin = '0';
      img.firstElementChild.style.inset = '0';
      img.getBoundingClientRect();
      const ms = reduced() ? 0 : 320;
      img.style.transition = `left ${ms}ms var(--ease-sheet), top ${ms}ms var(--ease-sheet), width ${ms}ms var(--ease-sheet), height ${ms}ms var(--ease-sheet)`;
      img.style.left = `${to.x}px`; img.style.top = `${to.y}px`; img.style.width = `${to.w}px`; img.style.height = `${to.h}px`;
      back.style.transition = `opacity ${ms}ms var(--ease-sheet)`; back.style.opacity = '0';
      setTimeout(() => {
        tablet.querySelector('[data-viewer]').style.display = 'none';
        readout('e-readout', `닫혔습니다. 사진이 원래 타일로 들어갔습니다. <button type="button" class="theme-reset" id="e-again">다시</button>`);
        document.getElementById('e-again')?.addEventListener('click', () => { render(); placeAnnotations(tablet); readout('e-readout', '사진을 마우스로 아래로 끌어 보세요. 120px 넘게 내리고 놓으면 닫히고, 덜 내리면 제자리로 돌아갑니다.'); });
      }, ms + 60);
    } else {
      const ms = reduced() ? 0 : 300;
      img.style.transition = `transform ${ms}ms var(--ease-spring)`; img.style.transform = 'none';
      back.style.transition = `opacity ${ms}ms var(--ease-spring)`; back.style.opacity = '1';
      tablet.querySelectorAll('.t-viewer__bar, .t-viewer__strip').forEach((b) => { b.style.opacity = '1'; });
      readout('e-readout', `${Math.round(dy)}px 내렸다 놓음 · 기준(120px)보다 짧아 제자리로 돌아갔습니다.`);
    }
  };
  tablet.addEventListener('pointerup', release); tablet.addEventListener('pointercancel', release);
  readout('e-readout', '사진을 마우스로 아래로 끌어 보세요. 120px 넘게 내리고 놓으면 닫히고, 덜 내리면 제자리로 돌아갑니다.');
};

/* E (static): the closing frame halfway between the full image and its tile. */
INIT['e-close'] = (tablet) => {
  AFTER.set(tablet, () => {
    const img = tablet.querySelector('[data-closing-img]'), tile = tablet.querySelector('[data-viewer-tile]');
    if (!img || !tile) return;
    const k = parseFloat(tablet.style.getPropertyValue('--s')) || 0.5, base = tablet.getBoundingClientRect(), tr = tile.getBoundingClientRect();
    const to = { x: (tr.left - base.left) / k, y: (tr.top - base.top) / k, w: tr.width / k, h: tr.height / k };
    const from = { x: 120, y: 420, w: 560, h: 700 };
    const m = (a, b) => a + (b - a) * 0.62;
    Object.assign(img.style, { left: `${m(from.x, to.x)}px`, top: `${m(from.y, to.y)}px`, width: `${m(from.w, to.w)}px`, height: `${m(from.h, to.h)}px`, right: 'auto', margin: '0', transform: 'none' });
    img.firstElementChild.style.inset = '0';
    tablet.querySelectorAll('[data-closing-anno]').forEach((e) => e.remove());
    tablet.insertAdjacentHTML('beforeend', `<div class="anno anno-box" data-closing-anno style="left:${to.x - 6}px;top:${to.y - 6}px;width:${to.w + 12}px;height:${to.h + 12}px"></div><div class="anno anno-tag" data-closing-anno style="left:${Math.min(to.x, 520)}px;top:${to.y + to.h + 14}px">본 사진의 타일로 줄어든다</div>`);
  });
};

/* F: tags on the three frames. */
const tag = (text, x, y) => `<div class="anno anno-tag" style="left:${x}px;top:${y}px">${text}</div>`;
INIT['f-start'] = (t) => t.insertAdjacentHTML('beforeend', tag('게헨나에서 최근 칩으로 왔다', 24, 96) + tag('여기서 뒤로', 600, 1176));
INIT['f-now'] = (t) => t.insertAdjacentHTML('beforeend', tag('지금: 상위 폴더로 올라감', 24, 96));
INIT['f-proposed'] = (t) => t.insertAdjacentHTML('beforeend', tag('제안: 온 곳으로 돌아감 · 스크롤 위치 그대로', 24, 96) + tag('상위 폴더는 상단 경로를 누른다', 24, 136));
INIT['b-button'] = (t) => t.insertAdjacentHTML('beforeend', tag('☰ 상단바 버튼으로만 연다', 100, 96) + tag('가장자리 밀기 = 안드로이드 뒤로', 24, 560));

/* ---------- Theme switch (per-viewer convenience only) ---------- */
function theme() {
  const root = document.documentElement, buttons = document.querySelectorAll('[data-theme-set]');
  const apply = (value) => {
    if (value === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', value);
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === value)));
  };
  let saved = 'auto';
  try { saved = localStorage.getItem('tablet-structure-theme') || 'auto'; } catch { /* storage unavailable */ }
  apply(saved);
  buttons.forEach((b) => b.addEventListener('click', () => { apply(b.dataset.themeSet); try { localStorage.setItem('tablet-structure-theme', b.dataset.themeSet); } catch { /* ignore */ } }));
}

theme();
build();
const settle = () => requestAnimationFrame(() => { scaleAll(); refresh(); });
(document.fonts?.ready ?? Promise.resolve()).then(settle);
window.addEventListener('resize', () => { clearTimeout(window.__tsResize); window.__tsResize = setTimeout(settle, 120); });
})();
