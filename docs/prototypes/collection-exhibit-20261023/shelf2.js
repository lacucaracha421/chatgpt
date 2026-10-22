/* Collection shelves, round 2: stand-in data, canvas-drawn covers and spine scans, synthesised spines,
   the current shelf layouts with the new light, the pulled-out 3D object, and the board's specimens.
   Mockup code only. Every title, author, publisher, mark and picture is invented; no real covers, logos or library data. */
(() => {
'use strict';
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- small helpers ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rng = s => mulberry32(hash(s));
const px = v => Math.max(1, Math.round(v));
const f1 = v => (+v).toFixed(1);
const hsl = (h, s, l) => `hsl(${((h % 360) + 360) % 360} ${s}% ${l}%)`;
const rgb = c => `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0})`;
const accentOf = c => { let a = c; if (lum(a) > .22) a = mixc(a, [0, 0, 0], .38); return a; };
const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const isLatin = s => /^[\x20-\x7E]+$/.test(s);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

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
  grid: 'M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25a2.25 2.25 0 0 1-2.25 2.25h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z',
  plus: 'M12 4.5v15m7.5-7.5h-15',
};
const svg = k => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[k]}"/></svg>`;

// ---------- manga data (fictional) ----------
const FMT = { shinsho: { h: 176, w: 113, name: '신서판' }, b6: { h: 182, w: 128, name: 'B6' }, a5: { h: 210, w: 148, name: '대형판' } };
/* Each publisher prints its own house spine; the template is chosen by publisher. */
const PUB = {
  haeoreum: { name: '해오름', tpl: 't1' },
  polaris: { name: '은하문고', tpl: 't2' },
  dungji: { name: '둥지북스', tpl: 't3' },
  parang: { name: '파랑새코믹스', tpl: 't4' },
  sora: { name: '소라출판', tpl: 'scan' },
  morae: { name: '모래알', tpl: 't0' },   // no house style recorded: the generic template
};
const SERIES = [
  { id: 'lh', title: '등대지기의 딸', author: '한서윤', rom: 'HAN SEOYUN', pub: 'haeoreum', fmt: 'shinsho', thick: 12, n: 18, owned: 15, soon: '11.6', hue: 218, edgeS: 52, edgeL: 24, scene: 'sea' },
  { id: 'nh', title: 'NEON HARBOR', ko: '네온 하버', author: '타카노 소라', pub: 'polaris', fmt: 'b6', thick: 14, n: 14, owned: 14, hue: 300, rainbow: true, edgeS: 58, edgeL: 40, scene: 'city' },
  { id: 'wt', title: '조용한 숲의 마녀', author: '미즈키 하루', pub: 'dungji', fmt: 'a5', thick: 16, n: 10, owned: 10, hue: 132, edgeS: 34, edgeL: 34, scene: 'forest' },
  { id: 'sea', title: '바다의 서재', author: '이도현', pub: 'sora', fmt: 'b6', thick: 11, n: 8, owned: 8, scans: 7, hue: 188, edgeS: 44, edgeL: 30, scene: 'library' },
  { id: 'cat', title: '고양이 식당', author: '강은채', pub: 'parang', fmt: 'b6', thick: 13, n: 7, owned: 5, hue: 14, edgeS: 62, edgeL: 46, scene: 'kitchen' },
  { id: 'sp', title: '우주 택배', author: '박지후', pub: 'morae', fmt: 'b6', thick: 14, n: 3, owned: 3, hue: 258, edgeS: 40, edgeL: 30, scene: 'space' },
  // only on the mixed shelf
  { id: 'dr', title: '작은 용의 하루', author: '윤가람', pub: 'parang', fmt: 'shinsho', thick: 13, n: 4, owned: 4, hue: 32, edgeS: 70, edgeL: 50, scene: 'sky' },
  { id: 'mu', title: '밤의 미술관', author: '사쿠라이 유', rom: 'SAKURAI YU', pub: 'haeoreum', fmt: 'b6', thick: 15, n: 3, owned: 3, hue: 262, edgeS: 36, edgeL: 20, scene: 'library' },
  { id: 'gl', title: '유리 정원', author: '오카모토 레이', pub: 'dungji', fmt: 'b6', thick: 13, n: 3, owned: 3, hue: 336, edgeS: 46, edgeL: 50, scene: 'forest' },
  { id: 'so', title: 'SILENT ORBIT', ko: '사일런트 오빗', author: '아오이 렌', pub: 'polaris', fmt: 'shinsho', thick: 12, n: 4, owned: 4, hue: 206, edgeS: 50, edgeL: 22, scene: 'space' },
  { id: 'hg', title: '모래시계 학원', author: '이도현', pub: 'morae', fmt: 'b6', thick: 14, n: 3, owned: 3, hue: 44, edgeS: 54, edgeL: 56, scene: 'sky' },
];
const SBY = Object.fromEntries(SERIES.map(s => [s.id, s]));
const thick = (se, n) => se.thick + (rng(se.id + 't' + n)() < .3 ? (rng(se.id + 'd' + n)() < .5 ? -1 : 1) : 0);
const volState = (se, n) => n <= se.owned ? 'own' : n === se.n && se.soon ? 'soon' : 'miss';

// ---------- canvas: covers ----------
const SHEET = document.createElement('style'); document.head.append(SHEET);
const rules = [];
const NL = String.fromCharCode(10);
const flush = () => { SHEET.textContent = rules.join(NL) + NL + '.no-anim, .no-anim * { transition: none !important; }'; };
const COVERS = new Map();
const HAIR = ['#2a2230', '#c9873a', '#ecdcb4', '#8a2f36', '#3d5a8a', '#d6668a', '#f2f2f2', '#5a3a24', '#2f6b4f', '#8f6bd0', '#e2b83c', '#1f3f5f'];
const SKIN = ['#f3d6c1', '#efc9ae', '#f6dccb', '#e8bf9f'];
function sceneDraw(g, kind, W, H, hue, r) {
  g.save();
  if (kind === 'sea') {
    const y = H * .62; const w = g.createLinearGradient(0, y, 0, H); w.addColorStop(0, hsl(hue, 50, 40)); w.addColorStop(1, hsl(hue + 10, 55, 16));
    g.fillStyle = w; g.fillRect(0, y, W, H - y);
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2;
    for (let i = 0; i < 9; i++) { const yy = y + 10 + i * 18; g.beginPath(); for (let x = 0; x <= W; x += 12) g.lineTo(x, yy + Math.sin(x / 14 + i) * 3); g.stroke(); }
    const lx = r() < .5 ? W * .12 : W * .82; g.fillStyle = hsl(hue, 30, 14); g.fillRect(lx, y - H * .22, W * .06, H * .22); g.fillStyle = '#ffe7a8'; g.fillRect(lx, y - H * .24, W * .06, H * .025);
  } else if (kind === 'city') {
    for (let i = 0; i < 14; i++) { const bw = W * (.08 + r() * .1), bh = H * (.18 + r() * .3), bx = r() * W; g.fillStyle = hsl(hue + 200, 30, 10 + r() * 8); g.fillRect(bx, H - bh, bw, bh);
      g.fillStyle = r() < .5 ? hsl(hue, 90, 70) : hsl(hue + 160, 90, 66); for (let k = 0; k < 6; k++) g.fillRect(bx + 3 + r() * (bw - 8), H - bh + 6 + r() * (bh - 12), 3, 3); }
  } else if (kind === 'forest') {
    for (let layer = 0; layer < 3; layer++) for (let i = 0; i < 8; i++) { const x = r() * W, h = H * (.25 + r() * .2 + layer * .06), bw = W * .14; g.fillStyle = hsl(hue + 10, 40, 30 - layer * 8);
      g.beginPath(); g.moveTo(x, H - h - layer * 20); g.lineTo(x - bw / 2, H); g.lineTo(x + bw / 2, H); g.fill(); }
  } else if (kind === 'kitchen') {
    g.fillStyle = hsl(hue + 20, 40, 30); g.fillRect(0, H * .7, W, H * .3);
    g.fillStyle = '#f4efe6'; g.beginPath(); g.ellipse(W * .7, H * .74, W * .2, H * .035, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 3; for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(W * (.64 + i * .05), H * .7); g.bezierCurveTo(W * (.6 + i * .05), H * .62, W * (.7 + i * .05), H * .6, W * (.65 + i * .05), H * .52); g.stroke(); }
  } else if (kind === 'space') {
    g.fillStyle = 'rgba(255,255,255,.8)'; for (let i = 0; i < 60; i++) g.fillRect(r() * W, r() * H * .8, r() < .1 ? 2 : 1, r() < .1 ? 2 : 1);
    g.fillStyle = hsl(hue + 40, 50, 55); g.beginPath(); g.arc(W * .78, H * .3, W * .16, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 2; g.beginPath(); g.ellipse(W * .78, H * .3, W * .27, W * .06, -.3, 0, Math.PI * 2); g.stroke();
  } else if (kind === 'library') {
    for (let x = 0; x < W; x += 9 + r() * 6) { g.fillStyle = hsl(hue + r() * 60 - 30, 35, 20 + r() * 25); const top = H * (.08 + (Math.floor(x / 60) % 2) * .02); g.fillRect(x, top, 7 + r() * 4, H * .28); g.fillRect(x, top + H * .32, 7 + r() * 4, H * .28); }
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, H * .36, W, 4); g.fillRect(0, H * .68, W, 4);
  } else {
    g.fillStyle = 'rgba(255,255,255,.55)'; for (let i = 0; i < 6; i++) { const x = r() * W, y = r() * H * .5; for (let k = 0; k < 4; k++) { g.beginPath(); g.arc(x + k * 14, y + (k % 2) * 4, 14, 0, Math.PI * 2); g.fill(); } }
  }
  g.restore();
}
function character(g, cx, cy, rr, hair, skin, outfit, W, H) {
  g.fillStyle = outfit; g.beginPath(); g.moveTo(cx - rr * 2.4, H); g.quadraticCurveTo(cx - rr * 2.1, cy + rr * 1.5, cx, cy + rr * 1.3); g.quadraticCurveTo(cx + rr * 2.1, cy + rr * 1.5, cx + rr * 2.4, H); g.fill();
  g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(cx - rr * .5, cy + rr * 1.35); g.lineTo(cx, cy + rr * 2.2); g.lineTo(cx + rr * .5, cy + rr * 1.35); g.fill();
  g.fillStyle = skin; g.fillRect(cx - rr * .32, cy + rr * .6, rr * .64, rr * .8);
  g.fillStyle = hair; g.beginPath(); g.ellipse(cx, cy + rr * .25, rr * 1.22, rr * 1.42, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = skin; g.beginPath(); g.ellipse(cx, cy + rr * .12, rr * .88, rr * 1.0, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = hair; g.beginPath(); g.moveTo(cx - rr * 1.02, cy); g.quadraticCurveTo(cx - rr * .7, cy - rr * 1.55, cx + rr * .2, cy - rr * 1.25); g.quadraticCurveTo(cx + rr * 1.15, cy - rr * 1.15, cx + rr * 1.02, cy + rr * .15);
  g.quadraticCurveTo(cx + rr * .55, cy - rr * .5, cx, cy - rr * .42); g.quadraticCurveTo(cx - rr * .55, cy - rr * .3, cx - rr * 1.02, cy); g.fill();
  for (const sx of [-1, 1]) { g.fillStyle = '#1d1a22'; g.beginPath(); g.ellipse(cx + sx * rr * .36, cy + rr * .2, rr * .13, rr * .21, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(cx + sx * rr * .36 - rr * .04, cy + rr * .12, rr * .05, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = '#9b5a52'; g.lineWidth = Math.max(1, rr * .06); g.beginPath(); g.arc(cx, cy + rr * .52, rr * .14, .2, Math.PI - .2); g.stroke();
}
function fitText(g, text, font, maxW, maxSize) { g.font = font(100); const w = g.measureText(text).width; return Math.min(maxSize, 100 * maxW / w); }
function sample(g, x, y, w, h) {
  const d = g.getImageData(x, y, w, h).data; const s = [0, 0, 0]; let n = 0;
  for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; }
  return s.map(v => v / n);
}
/* One volume's front cover. The spine side (right binding) carries a narrow wrap band: the colour the spine is made from. */
function cover(se, n) {
  const key = `${se.id}-${n}`; if (COVERS.has(key)) return COVERS.get(key);
  const f = FMT[se.fmt], W = 240, H = Math.round(W * f.h / f.w), r = rng(key);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const hue = se.rainbow ? se.hue + (n - 1) * 27 : se.hue + (r() - .5) * 12;
  const bg = g.createLinearGradient(0, 0, W * .4, H); bg.addColorStop(0, hsl(hue + 24, 55, 80)); bg.addColorStop(.5, hsl(hue, 46, 54)); bg.addColorStop(1, hsl(hue - 14, 50, 22));
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.arc(W * (.2 + r() * .6), H * .3, W * (.25 + r() * .12), 0, Math.PI * 2); g.fill();
  sceneDraw(g, se.scene, W, H, hue, r);
  const fx = .3 + r() * .36, fy = .47 + r() * .07, hr = .105 + r() * .02;
  character(g, W * fx, H * fy, W * hr, HAIR[(hash(se.id) + n * 5) % HAIR.length], SKIN[n % SKIN.length], hsl(hue + 170 + n * 23, 38, 32), W, H);
  // title logo
  const lat = isLatin(se.title);
  const font = sz => lat ? `800 ${sz}px Cinzel` : `900 ${sz}px "Pretendard Variable"`;
  const sz = fitText(g, se.title, font, W * .84, W * .2);
  g.font = font(sz); g.textAlign = 'center'; g.textBaseline = 'top'; g.lineJoin = 'round';
  g.lineWidth = sz * .16; g.strokeStyle = hsl(hue, 50, 14); g.strokeText(se.title, W / 2 - W * .02, H * .05);
  g.fillStyle = '#fffaf0'; g.fillText(se.title, W / 2 - W * .02, H * .05);
  if (se.ko) { g.font = `700 ${W * .055}px "Pretendard Variable"`; g.fillStyle = '#fffaf0'; g.fillText(se.ko, W / 2, H * .05 + sz * 1.08); }
  // volume number, author, publisher
  g.fillStyle = '#f4f0e6'; g.fillRect(W * .76, H * .17, W * .15, W * .15);
  g.fillStyle = '#16181a'; g.font = `${W * .12}px Anton`; g.textBaseline = 'middle'; g.fillText(String(n), W * .835, H * .17 + W * .077);
  g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = 'rgba(255,255,255,.9)'; g.font = `600 ${W * .05}px "Pretendard Variable"`; g.fillText(se.author, W * .06, H * .955);
  g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(W * .82, H * .925, W * .09, W * .05);
  // the spine-side wrap band
  const edgeHue = se.rainbow ? hue : se.hue;
  g.fillStyle = hsl(edgeHue, se.edgeS, se.edgeL); g.fillRect(W - Math.round(W * .035), 0, Math.round(W * .035), H);
  const edge = sample(g, W - 5, Math.round(H * .25), 4, Math.round(H * .5));
  const url = c.toDataURL('image/jpeg', .86);
  rules.push(`.cv-${key}{background-image:url(${url})}`);
  const out = { key, W, H, fx, fy: fy + hr * .1 * W / H, hr, edge, canvas: c };
  COVERS.set(key, out); return out;
}

// ---------- canvas: bookstore spine scans (the publisher's own design, as a flat scan) ----------
const SCANS = new Map();
const SCAN_W = 74, SCAN_H = 1200, SCAN_NO_Y = 548;
/* The publisher's own spine (소라출판's house design, fictional): white ground, label block, title, number emblem, art cut-in, sideways author, wordmark. */
function scanDesign(se, n) {
  const c = document.createElement('canvas'); c.width = SCAN_W; c.height = SCAN_H; const g = c.getContext('2d'), teal = hsl(188, 50, 28);
  g.fillStyle = '#f7f4ed'; g.fillRect(0, 0, SCAN_W, SCAN_H);
  g.fillStyle = teal; g.fillRect(0, 0, SCAN_W, 150);
  g.strokeStyle = '#efe5cb'; g.lineWidth = 4;
  for (let i = 0; i < 2; i++) { g.beginPath(); for (let x = 12; x <= 62; x += 2) g.lineTo(x, 36 + i * 14 + Math.sin(x / 6) * 4); g.stroke(); }
  g.save(); g.translate(37, 84); g.rotate(Math.PI / 2); g.fillStyle = '#efe5cb'; g.font = '800 16px "Pretendard Variable"'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText('SORA COMICS', 0, 0); g.restore();
  g.fillStyle = teal; g.textAlign = 'center'; g.textBaseline = 'middle';
  let y = 204; g.font = '700 46px "Noto Sans KR"';
  for (const ch of se.title) { if (ch === ' ') { y += 20; continue; } g.fillText(ch, 37, y); y += 52; }
  g.fillStyle = hsl(188 + n * 38, 58, 50); g.beginPath(); g.arc(37, SCAN_NO_Y, 28, 0, Math.PI * 2); g.fill();
  g.lineWidth = 2.5; g.strokeStyle = '#1b1b1a'; g.stroke();
  g.fillStyle = '#fbf8f0'; g.font = '40px Anton'; g.fillText(String(n), 37, SCAN_NO_Y + 2);
  const cv = cover(se, n), cw = cv.W * cv.hr * 2.4, ch = cw * 280 / SCAN_W;
  g.drawImage(cv.canvas, cv.fx * cv.W - cw / 2, Math.max(0, cv.fy * cv.H - ch * .4), cw, ch, 0, 600, SCAN_W, 280);
  g.save(); g.translate(37, 910); g.rotate(Math.PI / 2); g.fillStyle = '#1b1b1a'; g.font = '700 26px "Pretendard Variable"'; g.textAlign = 'left'; g.fillText('LEE DOHYUN', 0, 0); g.restore();
  g.fillStyle = '#1b1b1a'; g.font = '900 20px "Pretendard Variable"'; y = 1092; for (const ch of '소라출판') { g.fillText(ch, 37, y); y += 22; }
  return c;
}
/* What a scan looks like as served: scanner bleed on one edge, a hair of skew, a warm cast, lifted blacks, softness, noise and the shop's tiny watermark at the foot. */
function degrade(src, seed) {
  const r = rng(seed), bl = 1 + Math.floor(r() * 3), W = SCAN_W + bl + 1, H = Math.round(SCAN_H + (r() - .5) * 26);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#f2efe6'; g.fillRect(0, 0, W, H);
  g.save(); g.translate(bl, (H - SCAN_H) / 2); g.rotate((r() - .5) * .006); g.filter = 'blur(.45px)'; g.drawImage(src, 0, 0); g.restore();
  g.fillStyle = 'rgba(120,120,120,.75)'; g.font = '600 9px "Pretendard Variable"'; g.textAlign = 'center'; g.fillText('BOOKSHOP', W / 2, H - 6);
  g.globalCompositeOperation = 'multiply'; g.fillStyle = 'rgb(255 236 196)'; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'screen'; g.fillStyle = 'rgb(34 31 24)'; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  const im = g.getImageData(0, 0, W, H), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const k = (r() - .5) * 18; d[i] += k; d[i + 1] += k; d[i + 2] += k; }
  g.putImageData(im, 0, 0);
  return { c, g, W, H, bl, top: (H - SCAN_H) / 2 };
}
function scan(se, n, kind = 'scan') {
  const key = `${se.id}-${n}-${kind}`; if (SCANS.has(key)) return SCANS.get(key);
  let res;
  if (kind === 'scan') res = degrade(scanDesign(se, n), key);
  else { // 'borrow': the neighbour's scan with its number block repainted (needs the block's position, marked once per series)
    const prev = scan(se, n - 1, 'scan'); const c = document.createElement('canvas'); c.width = prev.W; c.height = prev.H; const g = c.getContext('2d'); g.drawImage(prev.c, 0, 0);
    const cx = 37 + prev.bl, cy = SCAN_NO_Y + prev.top;
    const ink = sample(g, cx - 3, cy - 22, 6, 4), paper = mixc(sample(g, prev.bl + 3, cy - 40, 4, 80), [255, 255, 255], .1);
    // the emblem keeps the series' shape; its colour is the new volume's (from its cover), the number is redrawn
    const tint = mixc(cover(se, n).edge, ink, .35);
    g.fillStyle = rgb(tint); g.beginPath(); g.arc(cx, cy, 26, 0, Math.PI * 2); g.fill();
    g.filter = 'blur(.45px)'; g.fillStyle = rgb(paper); g.font = '40px Anton'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), cx, cy + 2); g.filter = 'none';
    res = { c, g, W: prev.W, H: prev.H, bl: prev.bl, top: prev.top };
  }
  const url = res.c.toDataURL('image/jpeg', .74);
  const cls = `sc-${key}`; rules.push(`.${cls} .img{background-image:url(${url})}`);
  // colours a synthesised neighbour can take from the scan: its ground (margin column) and accent (label block)
  res.ground = sample(res.g, res.bl + 3, Math.round(res.top + 300), 3, 200); res.accent = sample(res.g, res.bl + 8, Math.round(res.top + 8), 30, 14);
  res.cls = cls; SCANS.set(key, res); return res;
}

/* The bookstore's back cover (same size as the front): blurb, barcode and ISBN, price, a band at the spine side.
   Only volumes that have a bookstore scan get one; the rest have no back image. */
const BACKS = new Map();
function backCover(se, n) {
  const key = `${se.id}-${n}-back`; if (BACKS.has(key)) return BACKS.get(key);
  const f = FMT[se.fmt], W = 240, H = Math.round(W * f.h / f.w), r = rng(key);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#f6f3ec'; g.fillRect(0, 0, W, H);
  const band = hsl(188, 50, 28); g.fillStyle = band; g.fillRect(0, 0, W * .1, H);   // spine side (left, for a right-bound book seen from the back)
  g.fillStyle = hsl(188 + n * 38, 58, 50); g.fillRect(W * .1, 0, 3, H);
  g.fillStyle = '#1b1b1a'; g.font = '900 22px "Pretendard Variable"'; g.textBaseline = 'top'; g.fillText('파', W * .17, H * .1);
  g.font = '500 8.5px "Pretendard Variable"'; g.fillStyle = '#2a2a28';
  const lines = ['도가 밀려오는 밤마다 문을 여는 작은 서재.', '책 대신 기억을 빌려주는 사서 미오는', `${n}번째 손님에게서 낯선 지도를 받는다.`, '바닷속 도서관으로 가는 길은 단 하나뿐인데…!'];
  lines.forEach((t, i) => g.fillText(t, W * .17 + (i === 0 ? 24 : 0), H * .1 + 4 + i * 13));
  // barcode block
  const bx = W * .17, by = H * .7; g.fillStyle = '#fff'; g.fillRect(bx, by, W * .44, H * .1);
  g.fillStyle = '#111'; let x = bx + 6; while (x < bx + W * .44 - 6) { const w = r() < .5 ? 1 : 2; g.fillRect(x, by + 4, w, H * .06); x += w + (r() < .5 ? 1 : 2); }
  g.font = '500 6px "Pretendard Variable"'; g.fillText(`ISBN 979-11-0000-${String(100 + n).padStart(3, '0')}-1`, bx + 6, by + H * .068 + 4);
  g.font = '800 11px "Pretendard Variable"'; g.fillText('값 5,500원', bx, by + H * .12);
  g.fillStyle = '#6b6a66'; g.font = '500 5.5px "Pretendard Variable"';
  ['이 책은 소라출판이 독점 계약한 한국어판입니다.', '무단 전재와 복제를 금합니다.', 'Korean edition, for distribution and sale in Korea only.'].forEach((t, i) => g.fillText(t, W * .17, H * .9 + i * 8));
  // served as a scan too: warm cast and noise (normalised on screen like the spine)
  g.globalCompositeOperation = 'multiply'; g.fillStyle = 'rgb(255 244 216)'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
  const url = c.toDataURL('image/jpeg', .84); rules.push(`.b3 > .fc.bk-${key}{background-image:url(${url})}`);
  const out = { cls: `bk-${key}` }; BACKS.set(key, out); return out;
}
const hasBack = (se, n) => n <= (se.scans || 0);

// ---------- synthesised spine templates ----------
function crop(cv, w, h, span = 2.6) {
  const k = w / (cv.hr * cv.W * span), bw = cv.W * k, bh = cv.H * k;
  let bx = w / 2 - cv.fx * bw, by = h * .5 - cv.fy * bh;
  bx = Math.min(0, Math.max(w - bw, bx)); by = Math.min(0, Math.max(h - bh, by));
  return `background-size:${f1(bw)}px ${f1(bh)}px;background-position:${f1(bx)}px ${f1(by)}px`;
}
function titleSize(text, avail, T, lat, k = .66, extra = 0) {
  const len = lat ? text.length * .74 + extra : [...text.replace(/\s/g, '')].length * 1.06 + (text.split(' ').length - 1) * .35 + extra;
  return Math.max(4, Math.min(T * k, avail / Math.max(1, len) * .92));
}
/* Returns the spine's inner HTML and where each part sits (for the anatomy callouts).
   opt: { noCover, privacy, body, paper } */
function synth(tpl, se, n, T, H, opt = {}) {
  const cv = opt.noCover || opt.privacy ? null : cover(se, n);
  const edge = opt.body || (cv ? cv.edge : (() => { const h = hash(se.title) % 360; const c = document.createElement('canvas').getContext('2d'); c.fillStyle = hsl(h, 36, 34); c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); })());
  const privacy = !!opt.privacy;
  const bodyC = privacy ? [58, 59, 60] : edge;
  const light = lum(bodyC) > .36, ink = light ? '#1c1c1b' : '#f6f2e8';
  const lat = isLatin(se.title), P = [], parts = [];
  const part = (k, top, h, style, inner, cls = k) => { parts.push({ k, top: Math.round(top), h: Math.round(h) }); P.push(`<i class="p ${cls}" style="top:${f1(top)}px;height:${f1(h)}px;${style}">${inner}</i>`); };
  const cutPart = (top, h, style = '') => { if (cv) part('cut', top, h, `${crop(cv, T, h)};${style}`, '', `cut cv-${cv.key}`); };
  const pubName = PUB[se.pub].name;
  let bodyCss = rgb(bodyC);
  const titleHTML = `<span class="tl">${lat ? `${esc(se.title)}${se.ko && T >= 15 ? `<small>${esc(se.ko)}</small>` : ''}` : esc(se.title).split(' ').map((w, i) => i ? `<span class="vsp">${w}</span>` : w).join('')}</span>`;
  const ttCls = lat ? 'tt lat' : 'tt';
  if (privacy) {
    const no = T * 1.1; part('no', H * .08, no, `color:#b9b6ae;font-size:${f1(T * .7)}px`, n);
  } else if (tpl === 't1') { // 해오름, the commonest real pattern: white ground, star row + imprint block, heavy title in the cover's colour, number emblem, big cut-in, sideways author, wordmark
    bodyCss = '#f5f2ea'; const acc = rgb(accentOf(edge)), dark = '#1b1b1a';
    const lab = Math.max(H * .075, T * 1.7);
    part('lab', 0, lab, `justify-content:flex-start;padding-top:${f1(T * .1)}px;gap:${f1(T * .08)}px`, `<em style="color:#d8322a;font:900 ${f1(T * .25)}px/1 var(--font-ui);letter-spacing:-.02em">★★★</em><b style="display:grid;place-items:center;width:${f1(T * .86)}px;height:${f1(lab - T * .5)}px;background:#f2c230;color:#1a1a1a;font:900 ${f1(T * .32)}px/1 var(--font-ui);writing-mode:vertical-rl;text-orientation:upright;letter-spacing:-.06em">해오름</b>`);
    const cut = H * .2, auH = H * .14, pubH = T * 1.6, em = T * 1.05;
    const pubTop = H - pubH, auTop = pubTop - auH - T * .2, cutTop = auTop - cut - T * .3, emTop = cutTop - em - T * .3;
    const tTop = lab + T * .4, tBot = emTop - T * .3;
    part('tt', tTop, tBot - tTop, `font-size:${f1(titleSize(se.title, tBot - tTop, T, lat, .74))}px;color:${acc};font-family:'Pretendard Variable';font-weight:900;-webkit-text-stroke:${f1(Math.max(.4, T * .025))}px ${dark}`, titleHTML, ttCls);
    const vh = (hash(se.id) + n * 47) % 360;
    part('no', emTop, em, `color:${dark};font-size:${f1(T * .6)}px`, `<b class="emb" style="width:${f1(em * .72)}px;height:${f1(em * .72)}px;background:${hsl(vh, 64, 64)}"></b><span style="position:relative">${n}</span>`);
    cutPart(cutTop, cut);
    const rom = se.rom || se.author;
    part('au', auTop, auH, `font-size:${f1(Math.min(T * .34, auH / (rom.length * .74)))}px;color:${dark}`, esc(rom), 'au sd');
    part('pub', pubTop, pubH, `color:${dark};gap:${f1(T * .08)}px`, `<b class="mk sun" style="width:${f1(T * .42)}px;height:${f1(T * .42)}px"></b><b style="writing-mode:vertical-rl;text-orientation:upright;font:900 ${f1(T * .3)}px/1 var(--font-ui);letter-spacing:-.08em">해오름</b>`);
  } else if (tpl === 't2') { // POLARIS: black head band with star, sideways Latin logo, cut-in, number block at the foot
    const band = T * 1.5;
    part('lab', 0, band, `background:#121212;color:#f4f0e6;justify-content:flex-start;padding-top:${f1(T * .22)}px;gap:${f1(T * .2)}px`, `<b class="mk star" style="width:${f1(T * .55)}px;height:${f1(T * .55)}px"></b><em class="sw" style="font-size:${f1(T * .24)}px">POLARIS</em>`);
    const foot = T * .6, no = T * 1.3, cut = T * 1.25, auH = H * .085;
    const noTop = H - foot - no - T * .2, auTop = noTop - auH - T * .2, cutTop = auTop - cut - T * .2;
    const tTop = band + T * .45, tBot = cutTop - T * .35;
    part('tt', tTop, tBot - tTop, `font-size:${f1(titleSize(se.title, tBot - tTop, T, lat, .62, se.ko && T >= 15 ? se.ko.length * .5 + .5 : 0))}px;color:${ink}`, titleHTML, ttCls);
    cutPart(cutTop, cut, 'box-shadow:inset 0 0 0 1px rgba(0,0,0,.35)');
    part('au', auTop, auH, `font-size:${f1(Math.min(T * .3, auH / se.author.length))}px;color:${ink};opacity:.85`, esc(se.author));
    part('no', noTop, no, `background:#f4f0e6;color:#111;font-size:${f1(T * .82)}px`, n);
    part('pub', H - foot, foot, 'background:#121212;color:#f4f0e6', `<b class="mk star" style="width:${f1(T * .32)}px;height:${f1(T * .32)}px"></b>`);
  } else if (tpl === 't3') { // 둥지: paper body, series-colour band with the number, dark title, framed cut-in, nest mark
    bodyCss = '#ebe4d3'; const dark = '#1f201e', band = rgb(edge), bandInk = lum(edge) > .36 ? '#1f201e' : '#fbf8f0';
    const bandH = H * .16;
    part('lab', 0, bandH, `background:${band};color:${bandInk};justify-content:space-between;padding:${f1(T * .2)}px 0 ${f1(T * .16)}px`,
      `<em class="sw" style="font-size:${f1(T * .26)}px">둥지 코믹스</em><b style="display:grid;place-items:center;width:${f1(T * .9)}px;height:${f1(T * .9)}px;background:#fbf8f0;color:${band};font:400 ${f1(T * .64)}px/1 Anton">${n}</b>`);
    const pubH = T * 1.3, cut = T * 1.55, auH = H * .08;
    const cutTop = H - pubH - cut - T * .2, auTop = cutTop - auH - T * .3, tTop = bandH + T * .5, tBot = auTop - T * .2;
    part('tt', tTop, tBot - tTop, `font-size:${f1(titleSize(se.title, tBot - tTop, T, lat))}px;color:${dark}`, titleHTML, ttCls);
    part('au', auTop, auH, `font-size:${f1(Math.min(T * .3, auH / se.author.length))}px;color:${dark};opacity:.8`, esc(se.author));
    cutPart(cutTop, cut, `left:${f1(T * .12)}px;right:${f1(T * .12)}px;box-shadow:inset 0 0 0 1px ${band}`);
    part('pub', H - pubH, pubH, `color:${band};gap:${f1(T * .1)}px`, `<b class="mk nest" style="width:${f1(T * .5)}px;height:${f1(T * .26)}px"></b><em class="sw" style="font-size:${f1(T * .22)}px;color:#5b5850">둥지북스</em>`);
  } else if (tpl === 't4') { // 파랑새: full colour with an inset double rule, number at the head, cut-in, heavy title, bird mark
    const inset = Math.max(1.5, T * .12);
    P.push(`<i class="p" style="top:${f1(inset)}px;bottom:${f1(inset)}px;left:${f1(inset)}px;right:${f1(inset)}px;height:auto;border:1px solid rgba(255,255,255,.55);outline:1px solid rgba(255,255,255,.22);outline-offset:${f1(Math.max(1, T * .07))}px"></i>`);
    const no = T * 1.2;
    part('no', T * .35, no, `color:${ink};font-size:${f1(T * .7)}px;gap:${f1(T * .04)}px`, `<span style="font:800 ${f1(T * .2)}px/1 var(--font-ui);letter-spacing:.06em">VOL</span>${n}`);
    const cut = T * .95; cutPart(T * .35 + no + T * .15, cut, `left:${f1(inset + 2)}px;right:${f1(inset + 2)}px`);
    const pubH = T * 1.25, auH = H * .09, tTop = T * .35 + no + cut + T * .55, tBot = H - pubH - auH - T * .3;
    part('tt', tTop, tBot - tTop, `font-size:${f1(titleSize(se.title, tBot - tTop, T, lat))}px;color:${ink};font-family:'Pretendard Variable';font-weight:900`, titleHTML, ttCls);
    part('au', H - pubH - auH, auH, `font-size:${f1(Math.min(T * .3, auH / se.author.length))}px;color:${ink};opacity:.85`, esc(se.author));
    part('pub', H - pubH, pubH, '', `<b class="mk bird" style="width:${f1(T * .58)}px;height:${f1(T * .58)}px;font-size:${f1(T * .36)}px">파</b>`);
  } else { // t0: generic, for any publisher without a house style — white ground, the cover's colour as accent (or a scan's ground and accent)
    const ground = opt.ground || [244, 241, 233], accA = opt.accent || accentOf(edge), acc = rgb(accA);
    bodyCss = rgb(ground); const dark = lum(ground) > .36 ? '#1c1c1b' : '#f2efe6', accInk = lum(accA) > .36 ? '#1c1c1b' : '#f6f2e8';
    const lab = T * 1.15; let y = 0;
    part('lab', 0, lab, `background:${acc};color:${accInk}`, `<b style="font:800 ${f1(T * .34)}px/1 var(--font-ui)">${esc(pubName[0])}</b>`); y = lab;
    const cut = H * .17, auH = H * .1, pubH = T * 1.2, no = T * 1.0;
    const pubTop = H - pubH, auTop = pubTop - auH - T * .2, cutTop = auTop - cut - T * .3, noTop = cutTop - no - T * .3;
    const tTop = y + T * .45, tBot = noTop - T * .35;
    part('tt', tTop, tBot - tTop, `font-size:${f1(titleSize(se.title, tBot - tTop, T, lat))}px;color:${lum(ground) > .36 ? acc : dark}`, titleHTML, ttCls);
    part('no', noTop, no, `left:${f1(T * .12)}px;right:${f1(T * .12)}px;background:${acc};color:${accInk};font-size:${f1(T * .7)}px`, n);
    if (cv) cutPart(cutTop, cut); else part('cut', cutTop, cut, `left:${f1(T * .2)}px;right:${f1(T * .2)}px;border:1px solid ${acc};opacity:.5`, '');
    part('au', auTop, auH, `font-size:${f1(Math.min(T * .32, auH / se.author.length))}px;color:${dark};opacity:.85`, esc(se.author));
    part('pub', pubTop, pubH, `color:${dark}`, `<b style="font:800 ${f1(T * .3)}px/1.1 var(--font-ui);writing-mode:vertical-rl;text-orientation:upright;letter-spacing:-.06em">${esc(pubName)}</b>`);
  }
  return { html: `<span class="bs ${tpl}${T < 15 ? ' lod-s' : ''}" style="--body:${bodyCss};--ink:${ink}">${P.join('')}<i class="lit"></i></span>`, parts, body: bodyCss };
}
function scanSpine(se, n, mode = 'norm', kind = 'scan') {
  const sc = scan(se, n, kind);
  return `<span class="bs scan ${mode} ${sc.cls}"><i class="img"></i>${mode === 'raw' ? '' : '<i class="lit"></i>'}</span>`;
}

/* One volume standing on the shelf. opt: { s, tpl, scanMode, synthFromScan, borrow, privacy, under } */
function vol(se, n, s, opt = {}) {
  const f = FMT[se.fmt]; let T = px(thick(se, n) * s); let H = px(f.h * s);
  const st = volState(se, n);
  const tpl = opt.tpl || PUB[se.pub].tpl;
  let inner, body = '';
  if (tpl === 'scan' && n <= (se.scans || 0) && !opt.privacy) {
    const sc = scan(se, n);
    if (opt.scanMode === 'raw') { H = px(f.h * s * sc.H / SCAN_H); T = px(H * sc.W / sc.H); }
    else T = px(H * SCAN_W / SCAN_H * 1.0);      // width from the scan's own aspect: the real thickness
    inner = scanSpine(se, n, opt.scanMode || 'norm');
  } else if (tpl === 'scan' && opt.borrow && !opt.privacy) {
    T = px(H * SCAN_W / SCAN_H); inner = scanSpine(se, n, 'norm', 'borrow');
  } else {
    const nb = se.scans ? scan(se, se.scans) : null;
    const useT = tpl === 'scan' ? 't0' : tpl;
    const o = { privacy: opt.privacy };
    if (tpl === 'scan' && opt.synthFromScan && nb) { o.ground = nb.ground; o.accent = nb.accent; }
    const sp = synth(useT, se, n, T, H, o); inner = sp.html; body = sp.body;
  }
  const under = st === 'soon' ? `<span class="mv-under">${se.soon}</span>` : '';
  return { w: T, h: H, html: `<button type="button" class="mv${st !== 'own' ? ' ' + st : ''}" data-s="${se.id}" data-n="${n}" style="width:${T}px;height:${H}px" aria-label="${esc(se.title)} ${n}권${st === 'miss' ? ' 미보유' : st === 'soon' ? ' 출간 예정' : ''}">${inner}${under}</button>` };
}

// ---------- shelves ----------
function shelfHTML(items, innerH, g = 24, cls = '') {
  return `<div class="shelf ${cls}" style="--g:${g}px;--ih:${innerH}px"><div class="shelf-back"></div><div class="shelf-books">${items.join('')}</div><div class="shelf-plank"></div><div class="shelf-drop"></div></div>`;
}
function mangaRow(se, s, g, opt = {}) {
  const vs = []; for (let n = 1; n <= se.n; n++) vs.push(vol(se, n, s, opt));
  const owned = se.owned, total = se.n - (se.soon ? 1 : 0);
  return `<section class="mrow" style="padding:0 ${g}px"><div class="mrow-label"><button type="button" class="mrow-title">${esc(se.title)}</button><span class="mrow-count">${owned < total ? `${owned} / ${total}권` : `${owned}권`}</span></div>${shelfHTML(vs.map(v => v.html), Math.max(...vs.map(v => v.h)), g)}</section>`;
}
function mangaList(ids, s, g, opt = {}) { return `<div class="lst s2" data-host style="padding-top:16px">${ids.map(id => mangaRow(SBY[id], s, g, opt)).join('')}</div>`; }

// ---------- game / film / AV data and spines ----------
const PLAT = {
  sw2: { mm: { h: 170, w: 105, t: 11 }, plastic: '#a5141c', hd: '#151515', hdink: '#ff4b55', label: '2', name: '스위치 2' },
  sw: { mm: { h: 170, w: 105, t: 11 }, plastic: '#c8242b', hd: '#efefef', hdink: '#c8242b', label: 'S', name: '스위치' },
  ps5: { mm: { h: 172, w: 135, t: 13 }, plastic: '#e9ecf1', hd: '#f6f6f6', hdink: '#111', label: 'P5', name: 'PS5' },
  ps4: { mm: { h: 172, w: 135, t: 13 }, plastic: '#0f2d6e', hd: '#0b3a8c', hdink: '#fff', label: 'P4', name: 'PS4' },
  av: { mm: { h: 190, w: 135, t: 14 }, plastic: '#0e0f10', label: '', name: 'DVD' },
  film: { mm: { h: 188, w: 125, t: 14 }, plastic: '#111213', label: '', name: '영화' },
};
const GA = ['별', '강철', '바다', '하늘', '그림자', '유리', '숲', '달', '불꽃', '얼음', '모래', '바람', '새벽', '심연', '태엽'];
const GB = ['전설', '기사', '여정', '왕국', '탐험', '연대기', '항해', '정원', '도시', '미궁', '사냥꾼', '수호자'];
const GE = ['LUNAR SAGA', 'IRON TIDES', 'ECHO DRIFT', 'HOLLOW LANTERN', 'NEON RUN', 'PAPER KNIGHT', 'VELVET CIRCUIT', 'SILENT ORBIT', 'CRIMSON GARDEN', 'EMBER ROAD'];
const RG = rng('games');
const pick = a => a[Math.floor(RG() * a.length)];
const games = [];
for (const [p, count] of [['sw2', 14], ['sw', 72], ['ps5', 44], ['ps4', 30]]) for (let i = 0; i < count; i++) {
  const title = RG() < .25 ? pick(GE) : `${pick(GA)}의 ${pick(GB)}${RG() < .2 ? ' ' + (2 + Math.floor(RG() * 2)) : ''}`;
  games.push({ id: 'g' + games.length, p, title, hue: Math.floor(RG() * 360), sat: 30 + Math.floor(RG() * 40), light: 22 + Math.floor(RG() * 28) });
}
const FT = ['겨울의 끝', '푸른 방', '열두 번째 밤', '빛의 지도', '고요한 강', '여름 정류장', '두 개의 달', '마지막 상영', '안개 도시', '바람이 지나간 자리', '유리 심장', '느린 오후',
  '먼 바다', '은하 철도의 밤', '붉은 우산', '그해 봄', '창문 너머', '조용한 추격', '별빛 극장', '하얀 길', '새벽 세 시', '작은 혁명', '검은 호수', '편지', '귀향', '소년의 시간', '여름의 문', '파도 위의 집'];
const films = FT.map((title, i) => ({ id: 'f' + i, p: 'film', title, year: 1984 + Math.floor(RG() * 42), hue: Math.floor(RG() * 360), sat: 40 + Math.floor(RG() * 30), light: 30 + Math.floor(RG() * 15) }));
const avs = Array.from({ length: 16 }, (_, i) => ({ id: 'a' + i, p: 'av', title: `LKA-${String(101 + i * 7).padStart(3, '0')}`, hue: 300 + Math.floor(RG() * 90), sat: 22 + Math.floor(RG() * 20), light: 30 + Math.floor(RG() * 18) }));
const GBY = Object.fromEntries([...games, ...films, ...avs].map(g => [g.id, g]));
function caseSpine(g, s) {
  const P = PLAT[g.p], T = px(P.mm.t * s), H = px(P.mm.h * s), rim = px(2.5 * s);
  const art = `linear-gradient(${140 + g.hue % 80}deg, ${hsl(g.hue + 30, 70, 62)}, ${hsl(g.hue - 20, 55, 28)})`;
  const fs = f1(Math.max(6, Math.min(T * .56, 13)));
  let face;
  if (g.p === 'film') face = `<span class="gface film"><i class="art" style="background:${art}"></i><span class="tt" style="font-size:${fs}px">${esc(g.title)}</span><i class="yr" style="font-size:${f1(T * .42)}px">${g.year}</i><i class="lit board"></i></span>`;
  else if (g.p === 'av') face = `<span class="gface av" style="--plastic:${P.plastic};--rim:${rim}px"><span class="ins" style="--c:${hsl(g.hue, g.sat, g.light)}"><i class="hd" style="background:${hsl(g.hue + 40, 50, 60)}"></i><i class="art" style="background:${art}"></i><span class="tt" style="font-size:${fs}px">${g.title}</span></span><i class="lit plastic"></i></span>`;
  else face = `<span class="gface" style="--plastic:${P.plastic};--rim:${rim}px"><span class="ins" style="--c:${hsl(g.hue, g.sat, g.light)}"><i class="hd" style="background:${P.hd};color:${P.hdink};font-size:${f1(T * .42)}px">${T >= 10 ? P.label : ''}</i><i class="art" style="background:${art}"></i><span class="tt" style="font-size:${fs}px">${esc(g.title)}</span></span><i class="lit plastic"></i></span>`;
  return { w: T, h: H, html: `<button type="button" class="gc" data-g="${g.id}" style="width:${T}px;height:${H}px" aria-label="${esc(g.title)}">${face}</button>` };
}
function packRows(list, s, inner) {
  const rows = []; let row = null, x = 0;
  for (const g of list) { const sp = caseSpine(g, s); if (!row || x + sp.w > inner) { row = []; rows.push(row); x = 0; } row.push(sp); x += sp.w + 1; }
  return rows;
}
function caseGroups(groups, s, width, g = 24) {
  const inner = width - g * 2;
  return `<div class="lst s2" data-host style="padding-top:8px">${groups.map(([label, list]) => `<div class="glabel" style="padding:0 ${g}px"><div class="ui-section-label"><span class="ui-section-label__title">${label}</span> <span class="ui-section-label__count">${list.length}</span><span class="ui-section-label__rule"></span></div></div>`
    + packRows(list, s, inner).map(r => `<div style="padding:0 ${g}px;margin-bottom:24px">${shelfHTML(r.map(x => x.html), Math.max(...r.map(x => x.h)), g)}</div>`).join('')).join('')}</div>`;
}
function caseCover(g, W, H) {
  const c = document.createElement('canvas'); c.width = W * 2; c.height = H * 2; const x = c.getContext('2d'), P = PLAT[g.p], r = rng(g.id);
  const bg = x.createLinearGradient(0, 0, c.width * .5, c.height); bg.addColorStop(0, hsl(g.hue + 30, 70, 64)); bg.addColorStop(1, hsl(g.hue - 20, 55, 22)); x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height);
  sceneDraw(x, ['city', 'forest', 'space', 'sky', 'sea'][hash(g.id) % 5], c.width, c.height, g.hue, r);
  character(x, c.width * .5, c.height * .52, c.width * .12, HAIR[hash(g.id) % HAIR.length], SKIN[1], hsl(g.hue + 160, 40, 30), c.width, c.height);
  if (P.hd) { x.fillStyle = P.hd; x.fillRect(0, 0, c.width, c.height * .085); x.fillStyle = P.hdink; x.font = `800 ${c.height * .05}px "Pretendard Variable"`; x.textBaseline = 'middle'; x.fillText(P.name, c.width * .05, c.height * .045); }
  const lat = isLatin(g.title), font = sz => lat ? `800 ${sz}px Cinzel` : `900 ${sz}px "Pretendard Variable"`;
  const sz = fitText(x, g.title, font, c.width * .86, c.width * .14); x.font = font(sz); x.textAlign = 'center'; x.textBaseline = 'top'; x.lineWidth = sz * .14; x.strokeStyle = 'rgba(0,0,0,.55)';
  x.strokeText(g.title, c.width / 2, c.height * .12); x.fillStyle = '#fff'; x.fillText(g.title, c.width / 2, c.height * .12);
  return c.toDataURL('image/jpeg', .86);
}

// ---------- pulling out ----------
function noAnim(el, fn) { el.classList.add('no-anim'); fn(); void el.offsetWidth; requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('no-anim'))); }
function pullBook(mv, instant = false) {
  const host = mv.closest('[data-host]');
  host.querySelectorAll('.mv.is-out, .gc.is-out').forEach(o => { if (o !== mv) putBack(o, instant); });
  if (mv.classList.contains('is-out')) return putBack(mv, instant);
  const se = SBY[mv.dataset.s], n = +mv.dataset.n, T = mv.offsetWidth, H = mv.offsetHeight, f = FMT[se.fmt];
  const W = Math.round(H * f.w / f.h), cv = cover(se, n), bs = mv.querySelector('.bs');
  mv.dataset.t = T;
  const wrap = document.createElement('span'); wrap.className = 'b3wrap book';
  wrap.style.cssText = `--W:${W}px;--H:${H}px;--T:${T}px;--edge:${(T / W).toFixed(3)};--body:${bs.style.getPropertyValue('--body') || '#333'}`;
  const back = hasBack(se, n) ? `<i class="fc back real ${backCover(se, n).cls}"></i>` : `<i class="fc back plain"><span>뒷표지 이미지 없음</span></i>`;
  wrap.innerHTML = `<span class="b3"><i class="fc front cv-${cv.key}"></i>${back}<i class="fc side right">${bs.outerHTML}</i><i class="fc side left"><i class="pages"></i></i><i class="fc top"></i></span>`;
  if (hasBack(se, n)) { mv.dataset.back = '1'; flush(); }
  const no = document.createElement('span'); no.className = 'mv-under no'; no.textContent = n;
  const go = () => { mv.style.width = W + 'px'; wrap.classList.add('is-turned'); };
  mv.append(wrap, no); mv.classList.add('is-out'); mv.setAttribute('aria-pressed', 'true');
  if (instant || RM) noAnim(mv, go); else requestAnimationFrame(() => requestAnimationFrame(go));
}
function pullCase(gc, instant = false) {
  const host = gc.closest('[data-host]');
  host.querySelectorAll('.mv.is-out, .gc.is-out').forEach(o => { if (o !== gc) putBack(o, instant); });
  if (gc.classList.contains('is-out')) return putBack(gc, instant);
  const g = GBY[gc.dataset.g], P = PLAT[g.p], T = gc.offsetWidth, H = gc.offsetHeight, W = Math.round(H * P.mm.w / P.mm.h);
  const wrap = document.createElement('span'); wrap.className = 'b3wrap kase';
  wrap.style.cssText = `--W:${W}px;--H:${H}px;--T:${T}px;--edge:${(T / W).toFixed(3)}`;
  wrap.innerHTML = `<span class="b3"><i class="fc front" style="background-image:url(${caseCover(g, W, H)})"></i><i class="fc back"><i class="plastic"></i></i><i class="fc side left" style="position:absolute">${gc.querySelector('.gface').outerHTML}</i><i class="fc side right"><i class="plastic"></i></i><i class="fc top"><i class="plastic"></i></i></span>`;
  wrap.querySelector('.fc.left > .gface').style.cssText += ';visibility:visible';
  gc.append(wrap); gc.classList.add('is-out'); gc.setAttribute('aria-pressed', 'true');
  const go = () => wrap.classList.add('is-turned');
  if (instant || RM) noAnim(gc, go); else requestAnimationFrame(() => requestAnimationFrame(go));
}
/* A pulled-out volume with a real back cover turns over on a second click (PC) or a sideways drag (tablet). */
function flip(mv, instant = false) {
  const wrap = mv.querySelector('.b3wrap'); if (!wrap) return;
  if (instant || RM) noAnim(mv, () => wrap.classList.toggle('is-flipped')); else wrap.classList.toggle('is-flipped');
}
function putBack(el, instant = false) {
  const wrap = el.querySelector('.b3wrap'); if (!wrap) return;
  wrap.classList.remove('is-turned', 'is-flipped'); el.setAttribute('aria-pressed', 'false'); delete el.dataset.back;
  if (el.dataset.t) el.style.width = el.dataset.t + 'px';
  el.querySelector('.mv-under.no')?.remove();
  const done = () => { wrap.remove(); el.classList.remove('is-out'); };
  if (instant || RM) done(); else setTimeout(done, 470);
}
function attach(root) {
  root.addEventListener('click', e => {
    const mv = e.target.closest('.mv'), gc = e.target.closest('.gc');
    if (mv) {
      if (mv.classList.contains('is-out') && mv.dataset.back) { flip(mv); return; }
      if (!mv.classList.contains('miss') && !mv.classList.contains('soon')) pullBook(mv); return;
    }
    if (gc) { pullCase(gc); return; }
    root.querySelectorAll('.is-out').forEach(o => putBack(o));
  });
  root.addEventListener('keydown', e => { if (e.key === 'Escape') root.querySelectorAll('.is-out').forEach(o => putBack(o)); });
}

// ---------- mock chrome ----------
function seg(items, active) {
  return `<div class="ui-segmented" role="tablist">${items.map(([k, l]) => `<button class="ui-segmented__cell" role="tab" data-key="${k}" data-segmented-active="${k === active}"><span class="ui-segmented__content"><span class="ui-segmented__label">${l}</span></span></button>`).join('')}<span class="ui-segmented__thumb"></span></div>`;
}
function placeThumbs(root) {
  root.querySelectorAll('.ui-segmented').forEach(sg => {
    const a = sg.querySelector('[data-segmented-active="true"]'), t = sg.querySelector('.ui-segmented__thumb');
    if (!a || !t) return; t.style.left = a.offsetLeft + 'px'; t.style.width = a.offsetWidth + 'px';
  });
}
const TYPES = [['all', '전체'], ['game', '게임'], ['manga', '만화'], ['film', '영화'], ['av', 'AV']];
function winHTML({ active, body }) {
  const extra = active === 'manga' ? `<button class="qb">${svg('cal')}신간 <span class="n">2</span></button>` : active === 'game' ? `<button class="qb">${svg('cal')}발매 캘린더 <span class="n">3</span></button>` : '';
  return `<div class="win"><nav class="win-rail">${['home', 'photo', 'box', 'book', 'doc', 'swap'].map(k => `<i class="${k === 'box' ? 'on' : ''}">${svg(k)}</i>`).join('')}<i class="sp-r">${svg('search')}</i><i>${svg('more')}</i></nav>`
    + `<div class="win-main"><div class="win-title"><span class="wt">컬렉션</span><span class="wc"><i>—</i><i>☐</i><i>✕</i></span></div>`
    + `<div class="ui-section-bar">${seg(TYPES, active)}<div class="ui-section-bar__trailing"><button class="qb">${svg('spark')}쇼케이스</button><button class="qb">${svg('users')}캐릭터</button>${extra}<i class="sepv"></i><button class="qb">${svg('grid')}보기</button></div></div>`
    + `<div class="win-body">${body}</div></div></div>`;
}
function tabHTML({ active, body }) {
  return `<div class="tab"><div class="tb">컬렉션<span class="sp-x"><i>${svg('search')}</i><i>${svg('plus')}</i><i>${svg('more')}</i></span></div>`
    + `<div class="ui-section-bar">${seg(TYPES, active)}<div class="ui-section-bar__trailing"><button class="qb" aria-label="보기" style="width:44px;height:44px;justify-content:center">${svg('grid')}</button></div></div>`
    + `<div class="tab-body">${body}</div>`
    + `<nav class="tnav">${[['home', '홈'], ['photo', '에셋'], ['box', '컬렉션'], ['book', '카탈로그'], ['doc', '메모']].map(([k, l]) => `<i class="${k === 'box' ? 'on' : ''}">${svg(k)}${l}</i>`).join('')}</nav></div>`;
}

// ---------- frames ----------
function frame(id, w, h, html) {
  const fr = document.getElementById(id); if (!fr) return null;
  fr.dataset.w = w; fr.dataset.h = h; fr.innerHTML = `<div class="fr-in">${html}</div>`;
  return fr.querySelector('.fr-in');
}
function fitFrames() {
  document.querySelectorAll('.fr').forEach(fr => {
    const w = +fr.dataset.w, h = +fr.dataset.h, inn = fr.querySelector('.fr-in'); if (!inn) return;
    const avail = Math.min(+fr.dataset.max || Infinity, fr.parentElement.clientWidth);
    const k = Math.min(1, avail / w);
    fr.style.width = w * k + 'px'; fr.style.height = h * k + 'px';
    inn.style.width = w + 'px'; inn.style.height = h + 'px'; inn.style.transform = `scale(${k})`;
  });
}
const findVol = (root, id, n) => root.querySelector(`.mv[data-s="${id}"][data-n="${n}"]`);

// ---------- board builders ----------
const B = {};
// a. games (PC 1700), films (960 x 640), AV close-up, finishes
B.games = () => {
  const inn = frame('f-game', 1700, 1000, winHTML({ active: 'game', body: caseGroups([['스위치 2', games.filter(g => g.p === 'sw2')], ['스위치', games.filter(g => g.p === 'sw')], ['PS5', games.filter(g => g.p === 'ps5')], ['PS4', games.filter(g => g.p === 'ps4')]], 1.1, 1644) }));
  attach(inn); return inn;
};
B.films = () => {
  const inn = frame('f-film', 960, 640, winHTML({ active: 'film', body: caseGroups([['2020년대', films.filter(f => f.year >= 2020)], ['2010년대', films.filter(f => f.year >= 2010 && f.year < 2020)], ['그 전', films.filter(f => f.year < 2010)]], 1.3, 904) }));
  attach(inn); return inn;
};
B.avStrip = () => {
  const el = document.getElementById('spec-av'); if (!el) return;
  const sp = avs.slice(0, 16).map(a => caseSpine(a, 2.0));
  el.innerHTML = `<div class="lst s2" data-host style="padding:8px 24px 0">${shelfHTML(sp.map(x => x.html), Math.max(...sp.map(x => x.h)), 24)}</div>`;
  attach(el);
};
B.finishes = () => {
  const el = document.getElementById('spec-fin'); if (!el) return;
  el.innerHTML = [['fin-ink', '먹색 목재 (기본)'], ['fin-lacquer', '검은 옻칠'], ['fin-oak', '밝은 오크 (종이 테마용)']].map(([cls, name]) => {
    const vs = SBY.wt ? Array.from({ length: 10 }, (_, i) => vol(SBY.lh, i + 1, 1.1)) : [];
    return `<figure class="fin"><div class="lst s2 ${cls}" style="padding:4px 24px 0">${shelfHTML(vs.map(v => v.html), Math.max(...vs.map(v => v.h)), 24)}</div><figcaption>${name}</figcaption></figure>`;
  }).join('');
};
// b. manga (PC 1700 x 1100, 960 x 640), close-up set, mixed shelf
const MAIN_ROWS = ['lh', 'nh', 'wt', 'sea', 'cat', 'sp'];
B.mangaPC = () => {
  const inn = frame('f-manga', 1700, 1120, winHTML({ active: 'manga', body: mangaList(MAIN_ROWS, 1.1, 24) }));
  attach(inn); return inn;
};
B.manga960 = () => {
  const inn = frame('f-manga960', 960, 640, winHTML({ active: 'manga', body: mangaList(['sea', 'nh', 'lh', 'wt'], 1.1, 24) }));
  attach(inn); return inn;
};
B.setClose = () => {
  const el = document.getElementById('spec-set'); if (!el) return;
  const vs = [];
  for (const id of ['lh', 'nh', 'wt']) { const se = SBY[id]; for (let n = 1; n <= Math.min(se.owned, 17); n++) vs.push(vol(se, n, 2.0)); vs.push({ html: '<i style="flex:none;width:6px"></i>' }); }
  vs.pop();
  el.innerHTML = `<div class="lst s2" data-host style="padding:4px 24px 0">${shelfHTML(vs.map(v => v.html), Math.max(...vs.filter(v => v.h).map(v => v.h)), 24)}</div>`;
  attach(el);
};
B.mixed = () => {
  const el = document.getElementById('spec-mixed'); if (!el) return;
  const plan = [['dr', 4], ['lh', 5], ['so', 4], ['gl', 3], ['sea', 4], ['hg', 3], ['mu', 3], ['nh', 6], ['cat', 4], ['wt', 4], ['sp', 3]];
  const vs = []; for (const [id, k] of plan) { for (let n = 1; n <= k; n++) vs.push(vol(SBY[id], n, 1.45)); }
  el.innerHTML = `<div class="lst s2" data-host style="padding:4px 24px 0">${shelfHTML(vs.map(v => v.html), Math.max(...vs.map(v => v.h)), 24)}</div>`;
  attach(el);
};
// c. anatomy
B.anatomy = () => {
  const el = document.getElementById('spec-anat'); if (!el) return;
  const se = SBY.lh, n = 7, s = 3.4, f = FMT[se.fmt];
  const T = px(thick(se, n) * s), H = px(f.h * s), sp = synth('t1', se, n, T, H), cv = cover(se, n);
  const CW = Math.round(H * f.w / f.h), k = CW / cv.W;
  const cutW = cv.hr * cv.W * 2.6 * k, cutH = cutW * 1.3;
  const fx = cv.fx * CW, fy = cv.fy * H;
  const mark = (x, y, w, h, no, dash = true) => `<i class="am" style="left:${f1(x)}px;top:${f1(y)}px;width:${f1(w)}px;height:${f1(h)}px;${dash ? '' : 'border-style:solid'}"><b>${no}</b></i>`;
  const P = Object.fromEntries(sp.parts.map(p => [p.k, p]));
  const CALL = [
    ['lab', 6, '출판사 라벨', '레이블 이름과 표식', 'new', '출판사별 틀 표(손으로 한 번). 없으면 라벨 띠 없이'],
    ['cut', 2, '그림 조각', '저장된 얼굴 위치로 표지를 자름', 'auto', 'focusX 있음, 세로 위치는 새로. 없으면 표지 위쪽 가운데'],
    ['no', 3, '권 번호', '권 번호를 큰 숫자로', 'have', '항상 있음'],
    ['tt', 4, '제목', '작품 이름을 세로쓰기. 한글은 세우고 영문 로고는 눕힘', 'have', '표지의 로고 글자가 아니라 데이터에서'],
    ['au', 5, '작가', '작가 이름, 작게', 'have', '책등이 15px보다 좁으면 생략'],
    ['pub', 7, '출판사 표식', '출판사 이름 → 표식', 'have', '표식 그림은 새로(틀 표). 없으면 첫 글자 네모'],
  ];
  const TAG = { auto: '<span class="tag auto">표지에서 자동</span>', have: '<span class="tag">있는 데이터</span>', new: '<span class="tag new">새 데이터</span>' };
  const calls = CALL.map(([key, no, name, what, src, fb]) => { const p = P[key]; if (!p) return ''; const y = p.top + p.h / 2;
    return `<div class="co" style="top:${f1(y)}px"><i class="co-line"></i><b class="co-no">${no}</b><div><div class="co-h">${name} ${TAG[src]}</div><div class="co-t">${what}. ${fb}.</div></div></div>`; }).join('');
  el.innerHTML = `<div class="anat">
    <div class="anat-cover" style="width:${CW}px;height:${H}px"><i class="cvimg cv-${cv.key}"></i>
      ${mark(CW * .965, H * .25, CW * .035, H * .5, 1)}${mark(fx - cutW / 2, fy - cutH / 2, cutW, cutH, 2)}
      <span class="anat-cap" style="top:${H + 8}px">${se.title} ${n}권 표지 (지어낸 그림)</span></div>
    <div class="anat-arrow">→</div>
    <div class="anat-spine" style="width:${T}px;height:${H}px">${sp.html}
      <i class="dim v" style="height:${H}px"><b>${f.h}mm</b></i><i class="dim h" style="width:${T}px"><b>${thick(se, n)}mm</b></i></div>
    <div class="anat-calls" style="height:${H}px">${calls}</div>
    <div class="anat-side">
      <div class="co-free"><b class="co-no">1</b><div><div class="co-h">시리즈색 ${TAG.auto}</div><div class="co-t">표지의 책등 쪽 끝 띠(오른쪽 제본) 평균색. 흰 바탕 틀에서는 제목 글자색, 색 바탕 틀에서는 바탕색. 권들의 색이 비슷하면 1권 색 하나로 맞춰 세트처럼, 크게 다르면 권별 색(무지개 세트). 번호 표식 색은 권마다 바뀐다.</div></div></div>
      <div class="co-free"><b class="co-no">8</b><div><div class="co-h">판형·두께 <span class="tag new">새 데이터</span></div><div class="co-t">높이는 판형(신서판 176 · B6 182 · 대형판 210mm), 두께는 쪽수에서. 실제 스캔이 있으면 스캔의 가로세로 비율이 곧 두께. 둘 다 없으면 B6 · 14mm.</div></div></div>
      <div class="co-free"><b class="co-no">9</b><div><div class="co-h">표면 <span class="tag">표현만</span></div><div class="co-t">빛·결·접힌 모서리는 모든 책등(합성·스캔·케이스)에 같은 층으로 덮는다.</div></div></div>
      <div class="co-free"><b class="co-no">10</b><div><div class="co-h">뒷표지 <span class="tag new">새 데이터</span></div><div class="co-t">서점 이미지가 있는 권(약 3권에 1권)만. 꺼낸 책을 한 번 더 누르면 뒤집혀 줄거리·바코드·가격이 보인다. 없는 권은 뒤집지 않는다 — 뒷표지는 합성하지 않는다.</div></div></div>
    </div></div>`;
  // fallbacks and sizes
  const fb = document.getElementById('spec-fallback');
  if (fb) {
    const s2 = 2.0, T2 = px(12 * s2), H2 = px(176 * s2), seaH = px(182 * s2);
    const items = [
      ['출판사 틀 있음', synth('t1', se, n, T2, H2).html, T2, H2],
      ['출판사 모름 → 기본 틀', synth('t0', se, n, T2, H2).html, T2, H2],
      ['표지 없음 → 제목에서 색', synth('t0', se, n, T2, H2, { noCover: true }).html, T2, H2],
      ['비밀 모드', synth('t0', se, n, T2, H2, { privacy: true }).html, T2, H2],
      ['실제 스캔 (정규화)', scanSpine(SBY.sea, 3), px(seaH * SCAN_W / SCAN_H), seaH],
    ];
    const sizes = [['작게 0.9', .9], ['보통 1.1', 1.1], ['태블릿 1.25', 1.25], ['크게 1.45', 1.45], ['2.0', 2.0]].map(([name, sc]) => [name, synth('t1', se, n, px(12 * sc), px(176 * sc)).html, px(12 * sc), px(176 * sc)]);
    const strip = list => `<div class="lst s2" style="padding:4px 24px 0">${shelfHTML(list.map(([name, html, w, h]) => `<figure class="spfig" style="width:${w}px;height:${h}px">${html}<figcaption>${name}</figcaption></figure>`), Math.max(...list.map(x => x[3])), 24, 'wide-gaps')}</div>`;
    fb.innerHTML = `<div class="grid-fb"><div><h3 class="h3">없을 때의 순서</h3>${strip(items)}</div><div><h3 class="h3">크기별 (px/mm)</h3>${strip(sizes)}</div></div>`;
  }
};
// d. real scans next to synthesised spines
B.scanMix = () => {
  const el = document.getElementById('spec-pipe'); if (!el) return;
  const se = SBY.sea, n = 3, s = 2.4, H = px(FMT[se.fmt].h * s), sc = scan(se, n);
  const rawH = px(H * sc.H / SCAN_H), rawW = px(rawH * sc.W / sc.H), T = px(H * SCAN_W / SCAN_H);
  const step = (no, name, html, w, h) => `<figure class="pstep"><div class="pbox" style="height:${H + 12}px"><span style="position:relative;display:block;width:${w}px;height:${h}px">${html}</span></div><figcaption><b>${no}</b>${name}</figcaption></figure>`;
  const synthNext = synth('t0', se, 8, T, H, { ground: scan(se, 7).ground, accent: scan(se, 7).accent }).html;
  el.innerHTML = [
    step(1, '받은 스캔 그대로<br>(74 × 1,200 · 빛 없음, 누런 기, 흰 가장자리)', `<span class="bs scan raw ${sc.cls}" style="position:absolute;inset:0"><i class="img"></i></span>`, rawW, rawH),
    step(2, '가장자리 3% 잘라냄<br>스캐너 바탕·기울기 제거', `<span class="bs scan ${sc.cls}" style="position:absolute;inset:0;border-radius:0"><i class="img"></i></span>`, T, rawH),
    step(3, '색 보정<br>종이 흰색 기준 누런 기·대비', `<span class="bs scan norm ${sc.cls}" style="position:absolute;inset:0;border-radius:0"><i class="img"></i></span>`, T, rawH),
    step(4, '높이를 판형에 맞춤<br>폭 = 스캔 비율 = 실제 두께', `<span class="bs scan norm ${sc.cls}" style="position:absolute;inset:0;border-radius:0"><i class="img"></i></span>`, T, H),
    step(5, '공통 빛·결·둥근 모서리<br>합성 책등과 같은 층', scanSpine(se, n), T, H),
    step(6, '옆의 합성 책등 (8권)<br>색은 이웃 스캔에서', synthNext, T, H),
    step(7, '이웃 스캔 틀 빌리기 (8권)<br>7권 스캔의 번호만 다시 씀', scanSpine(se, 8, 'norm', 'borrow'), T, H),
  ].join('');
  const rows = document.getElementById('spec-mixrows'); if (!rows) return;
  const s2 = 1.6, row = (title, opt) => {
    const vs = []; for (let k = 1; k <= 8; k++) vs.push(vol(se, k, s2, opt)); vs.push({ html: '<i style="flex:none;width:6px"></i>', h: 0 });
    for (let k = 1; k <= 6; k++) vs.push(vol(SBY.lh, k, s2)); vs.push({ html: '<i style="flex:none;width:6px"></i>', h: 0 });
    for (let k = 1; k <= 3; k++) vs.push(vol(SBY.sp, k, s2));
    return `<div class="mixrow"><div class="mixrow-h">${title}</div><div class="lst s2" data-host style="padding:0 24px">${shelfHTML(vs.map(v => v.html), Math.max(...vs.map(v => v.h)), 24)}</div></div>`;
  };
  rows.innerHTML = row('가. 그대로 섞음 — 스캔은 평평하고 누렇고 높이가 제각각, 8권(합성)만 따로 논다', { scanMode: 'raw' })
    + row('나. 공통 처리 — 스캔 정규화 + 같은 빛·결·그림자, 8권은 이웃 스캔의 색으로 합성', { synthFromScan: true })
    + row('다. 이웃 스캔 틀 빌리기 — 8권도 7권 스캔에서 번호만 바꿔 씀 (번호 위치를 시리즈마다 한 번 표시)', { borrow: true });
  attach(rows);
};
// e. tablet portrait
B.tablet = () => {
  const inn = frame('f-tab', 800, 1280, tabHTML({ active: 'manga', body: mangaList(['nh', 'lh', 'wt', 'sea', 'cat'], 1.25, 24) }));
  attach(inn); return inn;
};
B.tabletCrop = () => {
  const inn = frame('f-tabcrop', 800, 640, `<div class="tab" style="height:100%"><div class="tab-body">${mangaList(['nh', 'lh'], 1.25, 24)}</div></div>`);
  attach(inn); return inn;
};

// ---------- boot ----------
async function boot() {
  // ?sec=b shows one section only (for screenshots)
  const sec = new URLSearchParams(location.search).get('sec');
  if (sec) document.querySelectorAll('.doc > section, .doc > header, details.r1').forEach(el => { if (el.id !== sec) el.style.display = 'none'; });
  const fontLoads = ['900 20px "Pretendard Variable"', '600 20px "Pretendard Variable"', '700 20px "Noto Sans KR"', '400 20px Anton', '800 20px Cinzel'].map(f => document.fonts.load(f, f.includes('Anton') ? '0123' : '가A'));
  try { await Promise.all(fontLoads); } catch { /* fall back to whatever is available */ }
  const built = {};
  for (const k of ['games', 'films', 'avStrip', 'finishes', 'mangaPC', 'manga960', 'setClose', 'mixed', 'anatomy', 'scanMix', 'tablet', 'tabletCrop']) built[k] = B[k]();
  SHEET.textContent = rules.join('\n') + '\n.no-anim, .no-anim * { transition: none !important; }';
  fitFrames();
  addEventListener('resize', fitFrames);
  requestAnimationFrame(() => {
    document.querySelectorAll('.fr-in').forEach(placeThumbs);
    // the board opens with one object pulled out in each shelf frame
    const g0 = built.games?.querySelector('.gc[data-g="g45"]'); if (g0) pullCase(g0, true);
    const m0 = built.mangaPC && findVol(built.mangaPC, 'lh', 7); if (m0) pullBook(m0, true);
    const m1 = built.manga960 && findVol(built.manga960, 'sea', 2); if (m1) { pullBook(m1, true); flip(m1, true); }
    const t0 = built.tablet && findVol(built.tablet, 'lh', 4); if (t0) pullBook(t0, true);
    const t1 = built.tabletCrop && findVol(built.tabletCrop, 'nh', 9); if (t1) pullBook(t1, true);
    document.body.classList.add('ready');
    if (new URLSearchParams(location.search).has('dbg')) {
      const out = [...document.querySelectorAll('#spec-set .bs.t3 .tt')].slice(0, 2).map(t => `${t.textContent} fs=${getComputedStyle(t).fontSize} h=${t.clientHeight} sh=${t.scrollHeight} sw=${t.scrollWidth} cw=${t.clientWidth} style=${t.getAttribute('style').slice(0, 60)}`);
      const pre = document.createElement('pre'); pre.id = 'dbg'; pre.textContent = out.join(NL); document.body.prepend(pre);
    }
  });
  document.querySelectorAll('[data-fin]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-fin]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    document.querySelectorAll('#f-game .lst, #f-film .lst, #f-manga .lst').forEach(l => { l.classList.remove('fin-ink', 'fin-lacquer', 'fin-oak'); l.classList.add(b.dataset.fin); });
  }));
}
window.S2 = { SBY, cover, scan, synth, vol, pullBook, putBack };
boot();
})();
