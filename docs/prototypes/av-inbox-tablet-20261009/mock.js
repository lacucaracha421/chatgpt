/* Tablet AV inbox mockup (2026-10-09). Renders the frames of one screen file (body[data-screen]).
   All imagery is generated: abstract SVG jackets and covers, fictional codes, titles and names. */
'use strict';

const IC = {
  InboxArrowDown: 'M9 3.75H6.912a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H15M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859M12 3v8.25m0 0-3-3m3 3 3-3',
  ChevronRight: 'm8.25 4.5 7.5 7.5-7.5 7.5',
  ChevronDown: 'm19.5 8.25-7.5 7.5-7.5-7.5',
  XMark: 'M6 18 18 6M6 6l12 12',
  ArrowPath: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',
  MagnifyingGlass: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  Clock: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  ExclamationTriangle: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  ArrowsUpDown: 'M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5',
  Star: 'M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z',
  Squares2X2: 'M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z',
  Plus: 'M12 4.5v15m7.5-7.5h-15',
  ArrowTopRightOnSquare: 'M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25',
  PauseCircle: 'M14.25 9v6m-4.5 0V9M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  Check: 'm4.5 12.75 6 6 9-13.5',
  Home: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  RectangleStack: 'M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122',
  BookOpen: 'M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25',
  Photo: 'm2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z',
  PencilSquare: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10',
  ArrowRight: 'M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3',
  Wifi: 'M8.288 15.038a5.25 5.25 0 0 1 7.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 0 1 1.06 0Z',
};
const I = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${IC[name]}"/></svg>`;

/* ---------- Placeholder jacket: 800 × 538 wrap, back | spine | front. The server's default split for
   this size is face = round(538 × 0.703) = 378, so x1 = 378, x2 = 422 (spine 44 px, 5.5 %). ---------- */
const JW = 800, JH = 538, X1 = 378, X2 = 422;
const PAL = [['#a9c1bd', '#6f8f8a', '#e4e2cf', '#3f5a57'], ['#b9b3c8', '#8f88a6', '#e7e0d4', '#5f5874'], ['#c9b2a2', '#9c7f6d', '#efe1cc', '#5e4a3f'], ['#b4bccb', '#7d889e', '#e3dccf', '#48526a'], ['#c4bca0', '#958c6a', '#ece4c9', '#5a543a'], ['#c6aab8', '#97798a', '#f0dfe4', '#5d4552']];
const svgUrl = svg => `url('data:image/svg+xml,${encodeURIComponent(svg)}')`;
function jacket(code, p = 0) {
  const c = PAL[p % PAL.length];
  const grid = [0, 1, 2, 3, 4, 5].map(k => `<rect x="${34 + (k % 3) * 104}" y="${236 + Math.floor(k / 3) * 104}" width="92" height="90" fill="${c[1]}" opacity=".55"/>`).join('');
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${JW}" height="${JH}" viewBox="0 0 ${JW} ${JH}">
  <rect width="${X1}" height="${JH}" fill="${c[2]}"/>
  <rect x="34" y="34" width="210" height="16" fill="${c[3]}" opacity=".7"/><rect x="34" y="62" width="300" height="8" fill="${c[1]}" opacity=".7"/><rect x="34" y="78" width="270" height="8" fill="${c[1]}" opacity=".7"/><rect x="34" y="94" width="286" height="8" fill="${c[1]}" opacity=".7"/>
  <rect x="34" y="124" width="310" height="90" fill="${c[0]}"/>${grid}
  <rect x="34" y="476" width="120" height="24" fill="${c[3]}" opacity=".5"/>
  <rect x="${X1}" width="${X2 - X1}" height="${JH}" fill="${c[3]}"/>
  <text transform="translate(${(X1 + X2) / 2 + 6} 30) rotate(90)" font-family="sans-serif" font-size="17" font-weight="700" fill="${c[2]}" letter-spacing="1">${code}</text>
  <rect x="${X1 + 12}" y="250" width="${X2 - X1 - 24}" height="200" fill="${c[1]}" opacity=".8"/>
  <rect x="${X2}" width="${JW - X2}" height="${JH}" fill="${c[0]}"/>
  <circle cx="${X2 + 240}" cy="180" r="96" fill="${c[2]}" opacity=".85"/>
  <path d="M${X2} 380 L${X2 + 140} 300 L${X2 + 260} 370 L${JW} 310 V${JH} H${X2} Z" fill="${c[1]}"/>
  <rect x="${X2 + 26}" y="28" width="200" height="32" fill="${c[3]}"/><rect x="${X2 + 26}" y="70" width="150" height="10" fill="${c[3]}" opacity=".6"/>
  <rect x="${JW - 110}" y="${JH - 44}" width="84" height="18" fill="${c[3]}" opacity=".7"/></svg>`);
}
function cover(i) {
  const c = PAL[i % PAL.length], k = i % 3;
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="285" viewBox="0 0 200 285"><rect width="200" height="285" fill="${c[0]}"/><circle cx="${70 + k * 30}" cy="${100 + k * 10}" r="${48 + k * 6}" fill="${c[2]}" opacity=".85"/><path d="M0 205 L70 165 L130 205 L200 175 V285 H0 Z" fill="${c[1]}"/><rect x="14" y="14" width="${110 - k * 14}" height="16" fill="${c[3]}"/><rect x="14" y="36" width="80" height="6" fill="${c[3]}" opacity=".6"/></svg>`);
}

/* ---------- App chrome ---------- */
const NAV = [['Home', '홈'], ['Photo', '에셋'], ['RectangleStack', '컬렉션'], ['BookOpen', '카탈로그'], ['PencilSquare', '메모']];
const nav = () => `<nav class="nav">${NAV.map(([icon, label]) => `<span class="${label === '컬렉션' ? 'on' : ''}">${I(icon)}${label}</span>`).join('')}</nav>`;
function shade({ shortcut = false } = {}) {
  return `<div class="shade"><div class="seg"><span>게임</span><span>만화</span><span>영화</span><span class="on">AV</span></div>
    <div class="trail">${shortcut ? `<button class="quiet" aria-label="받은 품번 8">${I('InboxArrowDown')}<span class="ui-badge ui-badge--corner numeric">8</span></button>` : ''}
    <button class="quiet" aria-label="정렬">${I('ArrowsUpDown')}</button><button class="quiet" aria-label="내 별점">${I('Star')}</button><button class="quiet" aria-label="보기">${I('Squares2X2')}</button></div></div>`;
}
const WORKS = [['ABP-310', '2025.6.13'], ['CDE-044', '2025.3.7'], ['FGH-512', '2024.11.22'], ['IJK-207', '2024.8.9'], ['LMN-066', '2024.4.19'], ['OPQ-118', '2023.12.1'], ['RST-731', '2023.7.14'], ['UVW-025', '2023.2.3']];
function avScreen({ entry = 'row', pressed = false } = {}) {
  const entryRow = entry === 'row' ? `<button class="av-inbox-entry${pressed ? ' is-pressed' : ''}">
      <span class="av-inbox-entry__icon">${I('InboxArrowDown')}</span>
      <span class="av-inbox-entry__text"><b>받은 품번 <span class="ui-badge ui-badge--count numeric is-strong">8</span></b>
        <small>후보 있음 <span class="numeric">3</span> · 찾는 중 <span class="numeric">1</span> · 보내는 중 <span class="numeric">1</span> · <em>멈춤 <span class="numeric">1</span></em> · 못 찾음 <span class="numeric">1</span> · 오류 <span class="numeric">1</span></small></span>
      <span></span>${I('ChevronRight')}</button>` : '';
  return `<header class="tb"><h1>컬렉션</h1><span class="sp"></span><button class="ui-button ui-button--icon" aria-label="새 작품">${I('Plus')}</button></header>
  ${shade({ shortcut: entry === 'shortcut' })}
  <div class="scroll">
    ${entryRow}
    <section class="sender"><h2>품번 보내기</h2><div class="row"><span class="text-input is-empty">예: SSIS-001</span><button class="ui-button ui-button--primary" disabled>보내기</button></div></section>
    <div class="tabs"><span class="on">작품</span><span>배우별</span></div>
    <div class="shelf">${WORKS.map(([code, date], i) => `<div class="case"><i style="background-image:${cover(i + 1)}"></i><b>${code}</b><small class="numeric">${date}</small></div>`).join('')}</div>
  </div>${nav()}`;
}

/* ---------- 받은 품번 list ---------- */
const BADGE = {
  found: ['후보 있음', 'is-strong'], fetching: ['찾는 중', ''], applying: ['보내는 중', 'is-strong'], waiting: ['확인 기다리는 중', 'is-strong'],
  stopped: ['멈춤', 'ui-badge--danger'], not_found: ['못 찾음', ''], error: ['오류', 'ui-badge--danger'], done: ['적용됨', 'is-strong'],
};
const ICON = { found: 'MagnifyingGlass', fetching: 'Clock', applying: 'ArrowPath', waiting: 'ArrowPath', stopped: 'PauseCircle', not_found: 'ExclamationTriangle', error: 'ExclamationTriangle', done: 'Check' };
const ROWS = {
  a: { code: 'ABC-001', state: 'found', meta: '기존 컬렉션에 후보 추가 · <b lang="ja">サンプルタイトル 〜長い副題〜</b>', actions: [['후보 보기']] },
  d: { code: 'DEF-120', state: 'found', meta: '같은 품번 컬렉션 <span class="numeric">2</span>개 · 넣을 곳 고르기', actions: [['후보 보기']] },
  g: { code: 'GHJ-033', state: 'found', meta: '새 AV 컬렉션 · <span lang="ja">サンプル作品 その2</span>', actions: [['후보 보기']] },
  k: { code: 'KLM-208', state: 'applying', step: '3/6', meta: '<span class="numeric">21:52</span> 적용 · 표지 보내는 중', actions: [] },
  n: { code: 'NOP-077', state: 'stopped', meta: '다른 기기의 변경과 겹침 · 표지 <span class="numeric">2</span>면은 적용됨', actions: [['다시 확인']] },
  q: { code: 'QRS-512', state: 'fetching', meta: '<span class="numeric">21:50</span> 받음 · LibreDMM', actions: [] },
  t: { code: 'TUV-9999', state: 'not_found', meta: 'LibreDMM에 없는 품번 · 어제 <span class="numeric">22:10</span>', actions: [['다시 시도', 'ArrowPath'], ['품번 고치기']] },
  w: { code: 'WXY-01', state: 'error', meta: '가져오지 못함 · 응답 시간 초과', actions: [['다시 시도', 'ArrowPath'], ['품번 고치기']] },
};
function row(r, { disabled = false } = {}) {
  const [label, cls] = BADGE[r.state];
  const spinning = r.state === 'fetching' || r.state === 'applying' || r.state === 'waiting';
  const busy = r.state === 'applying' || r.state === 'waiting' || r.state === 'done';
  const badge = `<span class="ui-badge ${cls}">${spinning ? '<span class="spin" aria-hidden="true"></span>' : ''}${label}${r.step ? ` <span class="numeric">${r.step}</span>` : ''}</span>`;
  return `<div class="inbox-row${r.state === 'done' ? ' is-done' : ''}" data-state="${r.state === 'fetching' ? 'busy' : r.state}">
    <span class="inbox-row__icon">${I(ICON[r.state])}</span>
    <span class="inbox-row__text"><span class="inbox-row__line"><span class="inbox-row__code">${r.code}</span>${badge}</span><span class="inbox-row__meta">${r.meta}</span></span>
    <span class="inbox-row__actions">${r.actions.map(([text, icon]) => `<button class="ui-button"${disabled ? ' disabled' : ''}>${icon ? I(icon) : ''}${text}</button>`).join('')}</span>
    ${busy ? '<span></span>' : `<button class="ui-button ui-button--icon" aria-label="${r.code} 버리기"${disabled ? ' disabled' : ''}>${I('XMark')}</button>`}
  </div>`;
}
function listSheet(rowsHtml, { note = '', count = 8, found = 3, offline = false } = {}) {
  return `<div class="sheet-scrim"></div><section class="sheet" aria-label="받은 품번">
    <div class="sheet__head"><div class="sheet__grab"></div><div class="sheet__title"><h2>받은 품번 <small class="numeric">${count}</small></h2><span class="sp"></span>
      <button class="ui-button ui-button--ghost"${offline ? ' disabled' : ''}>후보 차례로 보기 <span class="numeric">${found}</span></button>
      <button class="ui-button ui-button--icon" aria-label="닫기">${I('XMark')}</button></div></div>
    <div class="sheet__body">${note}<div class="inbox-rows">${rowsHtml}</div></div>
  </section>`;
}
const LIST_ALL = ['a', 'd', 'g', 'k', 'n', 'q', 't', 'w'].map(key => row(ROWS[key])).join('');

/* ---------- Candidate chooser ---------- */
const CROP = { front: [X2, JW - X2], spine: [X1, X2 - X1], back: [0, X1] };
function cropThumb(surface, url) {
  const [x, w] = CROP[surface];
  const width = Math.round(92 * w / JH);
  const pos = w >= JW ? 0 : (x / (JW - w)) * 100;
  return `<i style="width:${width}px;background-image:${url};background-size:${(JW / w) * 100}% 100%;background-position:${pos}% 0"></i>`;
}
function surfaceRow({ key, name, choice, current, manual = false, isNew = false, url }) {
  const size = CROP[key][1];
  const now = current ? `<i class="full" style="background-image:${current}"></i>${manual ? '<span class="ui-badge ui-badge--scrim">직접 고름</span>' : ''}` : '없음';
  return `<div class="surface"><span class="surface__name"><b>${name}</b><small class="numeric">${size} × ${JH}</small></span>
    <span class="surface__pair"><span class="thumb${choice === 'candidate' ? ' is-off' : ''}"><div>${now}</div><small>지금</small></span>${I('ArrowRight')}
      <span class="thumb${choice !== 'candidate' ? ' is-off' : ''}"><div>${cropThumb(key, url)}${choice === 'clear' ? '<span class="ui-badge ui-badge--scrim">비움</span>' : ''}</div><small>후보</small></span></span>
    <span class="choice" role="group" aria-label="${name} 선택">${[['candidate', '후보 사용'], ['keep', '유지'], ['clear', '비우기']].map(([value, text]) =>
      `<button aria-pressed="${choice === value}"${value === 'keep' && (isNew || !current) ? ' disabled' : ''}>${text}</button>`).join('')}</span>
  </div>`;
}
function jacketBlock({ url, keep = {} }) {
  const pct = x => (x / JW) * 100;
  const zone = (left, width, key, short) => `<span class="jacket__zone${keep[key] ? ' is-off' : ''}" style="left:${pct(left)}%;width:${pct(width)}%">${keep[key] && short ? `<span>${keep[key]}</span>` : ''}</span>`;
  return `<div class="jacket" style="background-image:${url}" role="img" aria-label="펼친 재킷 후보, 자동으로 나눈 세 면">
      ${zone(0, X1, 'back', true)}${zone(X1, X2 - X1, 'spine', false)}${zone(X2, JW - X2, 'front', true)}
      <span class="jacket__cut" style="left:${pct(X1)}%"></span><span class="jacket__cut" style="left:${pct(X2)}%"></span></div>
    <div class="ruler" aria-hidden="true">
      <span style="left:0;width:${pct(X1)}%"><b>뒤표지</b><small class="numeric">${X1}px</small></span>
      <span style="left:${pct(X1)}%;width:${pct(X2 - X1)}%"><b>책등</b><small class="numeric">${X2 - X1}</small></span>
      <span style="left:${pct(X2)}%;width:${pct(JW - X2)}%"><b>앞표지</b><small class="numeric">${JW - X2}px</small></span></div>
    <div class="jacket-meta"><span>원본 <b class="numeric">${JW} × ${JH}</b></span><span>책등 <b class="numeric">${X2 - X1}px · ${((X2 - X1) / JW * 100).toFixed(1)}%</b></span><span>서버 자동 나눔</span></div>`;
}
function check(on, disabled = false, label = '') { return `<span class="check"><input type="checkbox" class="ui-checkbox" aria-label="${label} 적용"${on ? ' checked' : ''}${disabled ? ' disabled' : ''}></span>`; }
function diffRow({ label, on, disabled, value, current, tag }) {
  return `<div class="diff-row${on ? '' : ' is-off'}">${check(on, disabled, label)}<b>${label}</b><span class="val"><span>${value}</span>${current !== undefined || tag ? `<small>${current !== undefined ? `지금 ${current}` : ''}${tag ? `<span class="ui-badge${tag === '다름' ? ' is-diff' : ''}">${tag}</span>` : ''}</small>` : ''}</span></div>`;
}
function person(p) {
  const name = p.edit
    ? `<span class="person__name"><span class="text-input">${p.ko}</span><small><span lang="ja">${p.ja}</span>${p.note ? ` · ${p.note}` : ''}</small></span>`
    : `<span class="person__name"><span>${p.ko}</span><small><span lang="ja">${p.ja}</span>${p.note ? ` · ${p.note}` : ''}</small></span>`;
  const control = p.control ? `<button class="select-button">${p.control}${I('ChevronDown')}</button>` : '<span></span>';
  return `<div class="person"><span class="face">${p.initial}</span>${name}${control}</div>`;
}
function peopleRow(label, on, people) {
  return `<div class="diff-row${on ? '' : ' is-off'}">${check(on, false, label)}<b>${label}</b><span class="val people">${people.map(person).join('')}</span></div>`;
}
function genresRow(on, genres, current) {
  return `<div class="diff-row${on ? '' : ' is-off'}">${check(on, false, '장르')}<b>장르</b><span class="val"><span class="genres">${genres.map(([g, pressed]) => `<button aria-pressed="${pressed}" lang="ja">${g}</button>`).join('')}</span>${current !== undefined ? `<small>지금 ${current}</small>` : ''}</span></div>`;
}

function chooser(kind, { picked = false } = {}) {
  const code = { new: 'GHJ-033', existing: 'ABC-001', several: 'DEF-120' }[kind];
  const url = jacket(code, { new: 2, existing: 0, several: 3 }[kind]);
  const isNew = kind === 'new';
  const pending = kind === 'several' && !picked;
  const title = isNew ? '새 AV 컬렉션으로 만들기' : '후보 확인';

  let target = '';
  if (kind === 'existing') target = `<div class="target"><i class="cover" style="background-image:${cover(0)}"></i>
      <span class="target__text"><b lang="ja">サンプルタイトル 〜長い副題〜</b><small>기존 컬렉션에 후보 추가 · AV · <span class="numeric">2021</span></small></span>
      <button class="ui-button">다른 컬렉션</button></div>`;
  if (isNew) target = `<div class="new-name"><label>새 컬렉션 이름<span class="text-input">GHJ-033</span></label><button class="ui-button">원제로 채우기</button></div>
      <div class="target-link"><span class="faint" style="font-size:var(--type-meta)">맞는 기존 컬렉션 없음</span><button class="ui-button ui-button--ghost">기존 컬렉션에 연결…</button></div>`;
  if (kind === 'several') target = `<p class="pick-intro">같은 품번의 컬렉션이 <b class="numeric">2</b>개 있어요</p>
      <div role="radiogroup" aria-label="후보를 넣을 곳">
      <button class="pick" role="radio" aria-checked="${picked}"><i class="cover" style="background-image:${cover(3)}"></i><span class="target__text"><b>DEF-120</b><small>AV · <span class="numeric">2019</span> · 표지 <span class="numeric">3</span>면 · 출연 <span class="numeric">2</span></small></span><span class="radio"></span></button>
      <button class="pick" role="radio" aria-checked="false"><i class="cover" style="background-image:${cover(4)}"></i><span class="target__text"><b>DEF-120 (리마스터)</b><small>AV · <span class="numeric">2023</span> · 표지 <span class="numeric">1</span>면</small></span><span class="radio"></span></button>
      <button class="pick" role="radio" aria-checked="false"><span class="plus">${I('Plus')}</span><span class="target__text"><b>새 AV 컬렉션으로 만들기</b><small>이름 DEF-120</small></span><span class="radio"></span></button></div>`;

  const surfaces = {
    new: [['front', '앞표지', 'candidate'], ['spine', '책등', 'candidate'], ['back', '뒤표지', 'candidate']].map(([key, name, choice]) => surfaceRow({ key, name, choice, isNew: true, url })),
    existing: [surfaceRow({ key: 'front', name: '앞표지', choice: 'keep', current: cover(5), manual: true, url }), surfaceRow({ key: 'spine', name: '책등', choice: 'candidate', url }), surfaceRow({ key: 'back', name: '뒤표지', choice: 'candidate', url })],
    several: [surfaceRow({ key: 'front', name: '앞표지', choice: 'keep', current: cover(3), url }), surfaceRow({ key: 'spine', name: '책등', choice: 'candidate', url }), surfaceRow({ key: 'back', name: '뒤표지', choice: 'keep', current: cover(1), url })],
  }[kind].join('');
  const keep = { new: {}, existing: { front: '유지' }, several: { front: '유지', back: '유지' } }[kind];

  const info = {
    new: [
      diffRow({ label: '원제', on: true, value: '<span lang="ja">サンプル作品 その2 〜副題〜</span>' }),
      diffRow({ label: '발매일', on: true, value: '<span class="numeric">2025.11.21</span>' }),
      diffRow({ label: '제작사', on: true, value: '<span lang="ja">メーカーB</span>' }),
      diffRow({ label: '레이블', on: true, value: '<span lang="ja">レーベルB</span>' }),
      diffRow({ label: '시리즈', on: false, disabled: true, value: '<span class="dash">후보 없음</span>' }),
      peopleRow('출연', true, [
        { initial: 'D', ko: '배우 D', ja: '女優D', note: 'Wikidata 한국어 이름', edit: true, control: '새 인물' },
        { initial: 'E', ko: '女優E', ja: '女優E', note: '한국어 이름 없음', edit: true, control: '새 인물' },
      ]),
      peopleRow('감독', true, [{ initial: 'B', ko: '감독 B', ja: '監督B', edit: true, control: '새 인물' }]),
      genresRow(true, [['ジャンル1', true], ['ジャンル2', true], ['単体作品', true], ['ハイビジョン', true], ['独占配信', true]]),
    ],
    existing: [
      diffRow({ label: '원제', on: true, value: '<span lang="ja">サンプルタイトル 〜長い副題がここに入る〜</span>', current: '<span class="dash">—</span>' }),
      diffRow({ label: '발매일', on: false, value: '<span class="numeric">2021.2.19</span>', current: '<span class="numeric">2021.2.18</span>', tag: '다름' }),
      diffRow({ label: '제작사', on: true, value: '<span lang="ja">メーカーA</span>', current: '<span class="dash">—</span>' }),
      diffRow({ label: '레이블', on: false, disabled: true, value: '<span lang="ja">レーベルA</span>', tag: '같음' }),
      diffRow({ label: '시리즈', on: false, disabled: true, value: '<span class="dash">후보 없음</span>' }),
      peopleRow('출연', true, [
        { initial: 'A', ko: '배우 A', ja: '女優A', note: '이미 연결됨' },
        { initial: 'B', ko: '배우 B', ja: '女優B', note: 'Wikidata 한국어 이름', edit: true, control: '새 인물' },
        { initial: 'C', ko: '배우 C', ja: '女優C', note: '기존 인물 · 작품 <span class="numeric">3</span>', control: '배우 C에 연결' },
      ]),
      peopleRow('감독', true, [{ initial: 'A', ko: '감독 A', ja: '監督A', edit: true, control: '새 인물' }]),
      genresRow(true, [['ジャンル1', true], ['ジャンル2', true], ['ジャンル3', false], ['単体作品', true], ['ハイビジョン', false]], '<span class="dash">—</span>'),
    ],
    several: [
      diffRow({ label: '원제', on: false, disabled: true, value: '<span lang="ja">サンプル作品 その3</span>', tag: '같음' }),
      diffRow({ label: '발매일', on: true, value: '<span class="numeric">2019.5.3</span>', current: '<span class="dash">—</span>' }),
    ],
  }[kind].join('');

  const counts = { new: ['3', '7'], existing: ['2', '5'], several: ['1', '4'] }[kind];
  const foot = `<footer class="chooser__foot"><button class="ui-button ui-button--danger-text">거절</button><span class="sp"></span>
      ${pending ? '<span class="sum">넣을 곳을 고르세요</span>' : `<span class="sum">표지 <b class="numeric">${counts[0]}</b>면 · 정보 <b class="numeric">${counts[1]}</b>개 바뀜</span>`}
      <button class="ui-button">나중에</button><button class="ui-button ui-button--primary"${pending ? ' disabled' : ''}>${isNew ? '새 컬렉션 만들기' : '적용'}</button></footer>`;

  return `<div class="sheet-scrim"></div><section class="sheet sheet--stacked" aria-label="${title}">
    <div class="sheet__head"><div class="sheet__grab"></div><div class="chooser__title">
      <div><h2>${title}<small>${code}</small></h2><p>LibreDMM · <span class="numeric">21:45</span> 조회</p></div>
      <button class="ui-button ui-button--icon" aria-label="원본 페이지 열기">${I('ArrowTopRightOnSquare')}</button>
      <button class="ui-button ui-button--icon" aria-label="닫기">${I('XMark')}</button></div></div>
    <div class="sheet__body"><div class="chooser__body">
      <section class="chooser__section"><div class="label">적용할 곳<span class="rule"></span></div>${target}</section>
      <section class="chooser__section"><div class="label">표지<span class="rule"></span><span class="note">면마다 후보 사용 · 유지 · 비우기</span></div>${jacketBlock({ url, keep: pending ? {} : keep })}
        ${pending ? '<p class="pending-line">넣을 곳을 고르면 지금 표지·정보와 나란히 보여요</p>' : `<div style="margin-top:var(--space-2)">${surfaces}</div>`}</section>
      ${pending ? '' : `<section class="chooser__section"><div class="label">정보<span class="rule"></span><span class="note">체크한 항목만 ${isNew ? '들어갑니다' : '바뀝니다'}</span></div>${info}</section>`}
    </div></div>${foot}</section>`;
}

/* ---------- Screens ---------- */
const frame = (inner, caption, scroll) => `<div class="frame-box"><p>${caption}</p><div class="frame"${scroll ? ` data-scroll="${scroll}"` : ''}>${inner}</div></div>`;
const SCREENS = {
  entry: {
    title: '1 · 진입: 컬렉션 › AV',
    frames: [
      [avScreen({ entry: 'row' }), '<b>A (추천)</b> 목록 맨 위 “받은 품번” 줄 — 비면 사라짐, 탭하면 목록 시트'],
      [avScreen({ entry: 'shortcut' }), '<b>B (대안)</b> 섹션 바의 바로가기 아이콘 + 개수 (만화 › 신간과 같은 방식)'],
    ],
  },
  list: {
    title: '2 · 받은 품번 목록 시트',
    frames: [
      [avScreen() + listSheet(LIST_ALL), '<b>상태 전부</b> 후보 있음 · 보내는 중 · 멈춤 · 찾는 중 · 못 찾음 · 오류'],
      [avScreen() + listSheet([
        row({ code: 'ABC-001', state: 'done', meta: '기존 컬렉션에 반영됨', actions: [] }),
        row(ROWS.d), row(ROWS.g),
        row({ ...ROWS.k, state: 'waiting', step: '6/6', meta: '서버 확인 기다리는 중' }),
        row(ROWS.n),
        row({ code: 'QRS-512', state: 'found', meta: '새 AV 컬렉션 · <span lang="ja">サンプル作品 その4</span>', actions: [['후보 보기']] }),
        row(ROWS.t), row(ROWS.w)].join(''), { found: 3 }), '<b>잠시 뒤</b> 적용된 줄은 잠깐 초록빛 후 빠짐 · 찾는 중 → 후보 있음'],
    ],
  },
  actions: {
    title: '3 · 목록에서 하는 일',
    frames: [
      [avScreen() + listSheet([row(ROWS.a), row(ROWS.d), row(ROWS.g), row(ROWS.k), row(ROWS.n), row(ROWS.q),
        `<div class="inbox-row inbox-row--edit"><span class="inbox-row__icon">${I('PencilSquare')}</span><div class="inbox-row__edit"><label>품번 고치기 · 받은 값 TUV-9999</label><div class="row"><span class="text-input is-focus">TUV-099<span class="caret"></span></span><button class="ui-button ui-button--primary">저장</button><button class="ui-button ui-button--ghost">취소</button></div><small>정규화: <b class="numeric">TUV-099</b> · 저장하면 다시 찾아요</small></div></div>`,
        row(ROWS.w)].join('')), '<b>품번 고치기</b> 줄 안에서 바로 편집 (키보드가 아래에서 올라옴)'],
      [avScreen() + listSheet(LIST_ALL) + `<div class="dialog-scrim"></div><div class="dialog" role="alertdialog"><div class="dialog__what"><i style="background-image:${cover(0)}"></i><div><h3>ABC-001 후보를 버릴까요?</h3><p>가져온 후보만 지워져요. 같은 품번을 다시 보내면 다시 찾아요.</p></div></div><div class="dialog__actions"><button class="ui-button">취소</button><button class="ui-button ui-button--danger">버리기</button></div></div>`, '<b>버리기</b> 후보가 있는 줄만 확인 대화상자'],
      [avScreen() + listSheet(['a', 'd', 'g', 'k', 'n', 'q', 't', 'w'].map(key => row(ROWS[key], { disabled: true })).join(''), { offline: true,
        note: `<div class="inbox-note">${I('Wifi')}<span>서버에 연결되지 않음 · 마지막으로 받은 목록</span><button class="ui-button">다시 시도</button></div>` }), '<b>오프라인</b> 목록은 그대로 두고 동작만 잠금'],
    ],
  },
  new: {
    title: '4 · 후보 확인: 맞는 컬렉션 없음 → 새로 만들기',
    frames: [[chooser('new'), '<b>위</b> 이름 = 품번, 세 면 모두 후보 사용 (유지 불가)'], [chooser('new'), '<b>아래로 스크롤</b> 정보 전부 체크, 새 인물은 한국어 이름 편집', 820]],
  },
  existing: {
    title: '5 · 후보 확인: 기존 컬렉션 하나 → 후보 추가',
    frames: [[chooser('existing'), '<b>위</b> 직접 고른 앞표지는 유지 (빈 면만 후보 사용)'], [chooser('existing'), '<b>아래로 스크롤</b> 빈 칸만 체크 · 다른 값은 “다름”으로 꺼 둠', 820]],
  },
  several: {
    title: '6 · 후보 확인: 같은 품번 컬렉션 여러 개',
    frames: [[chooser('several'), '<b>고르기 전</b> 적용 꺼짐, 비교도 숨김'], [chooser('several', { picked: true }), '<b>하나 고른 뒤</b> 그 컬렉션 기준으로 기본값이 채워짐', 60]],
  },
};

const screen = SCREENS[document.body.dataset.screen];
document.title = `AV 받은 품번 태블릿 · ${screen.title}`;
const solo = new URLSearchParams(location.search).get('frame');
const frames = solo ? [screen.frames[Number(solo) - 1]] : screen.frames;
document.body.innerHTML = `<main class="page"><header><h1>${screen.title}</h1><a href="index.html">← 목록</a></header>
  <div class="frames">${frames.map(([inner, caption, scroll]) => frame(inner, caption, scroll)).join('')}</div></main>`;
const settle = () => document.querySelectorAll('.frame[data-scroll]').forEach(el => { const body = el.querySelector('.sheet--stacked .sheet__body'); if (body) body.scrollTop = Number(el.dataset.scroll); });
settle();
document.fonts?.ready.then(settle);
