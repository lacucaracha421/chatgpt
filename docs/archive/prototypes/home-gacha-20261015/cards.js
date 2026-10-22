/* Card engine copied from ../gacha-cards-20261013/index.html (2026-10-13): procedural demo art, tiers, frames,
   glitter and tilt are unchanged. Changes: per-asset background variant, no private samples, a small export (LKCards). */
(() => {
'use strict';
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r = document) => r.querySelector(s);
const DPR = Math.min(2, window.devicePixelRatio || 1);
const BACKGROUNDS = window.CardBackgrounds;
let backgroundVariant = 'digital';
let originalArt = false;
/* ------------------------------------------------------- procedural art
   Every scene is two layers at card size (600×840): a background and a transparent subject.
   Card geometry in canvas px: art window x 40–560, y 90–475; name bar y 34–84; text box y 510–750. */
const W = 600, H = 840;
function seeded(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${a})`; };
const newCanvas = (w = W, h = H) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function sky(c, stops) { const g = c.createLinearGradient(0, 0, 0, H); stops.forEach(([o, col]) => g.addColorStop(o, col)); c.fillStyle = g; c.fillRect(0, 0, W, H); }
function glow(c, x, y, r, hex, a = 1, op = 'lighter') {
  c.save(); c.globalCompositeOperation = op; const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hexA(hex, a)); g.addColorStop(.3, hexA(hex, a * .45)); g.addColorStop(1, hexA(hex, 0));
  c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2); c.restore();
}
function bokeh(c, R, n, hexes, y0, y1, r0, r1, a) {
  c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const x = R() * W, y = y0 + R() * (y1 - y0), r = r0 + R() ** 2 * (r1 - r0), h = hexes[R() * hexes.length | 0], al = a * (.35 + R() * .65);
    const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, hexA(h, al)); g.addColorStop(.72, hexA(h, al * .6)); g.addColorStop(1, hexA(h, 0));
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  }
  c.restore();
}
function rays(c, R, x, y, n, dir, spread, len, hex, a) {
  c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const ang = dir + (R() - .5) * spread, w = .008 + R() * .03;
    const g = c.createRadialGradient(x, y, 0, x, y, len); g.addColorStop(0, hexA(hex, a * (.4 + R() * .6))); g.addColorStop(1, hexA(hex, 0));
    c.fillStyle = g; c.beginPath(); c.moveTo(x, y);
    c.lineTo(x + Math.cos(ang - w) * len, y + Math.sin(ang - w) * len); c.lineTo(x + Math.cos(ang + w) * len, y + Math.sin(ang + w) * len); c.fill();
  }
  c.restore();
}
function dabs(c, R, n, hexes, y0, y1, w0, w1, a, op = 'source-over', ang = 0, aj = .3) {
  c.save(); c.globalCompositeOperation = op;
  for (let i = 0; i < n; i++) {
    const w = w0 + R() * (w1 - w0); c.globalAlpha = a * (.4 + R() * .6); c.fillStyle = hexes[R() * hexes.length | 0];
    c.beginPath(); c.ellipse(R() * W, y0 + R() * (y1 - y0), w, w * (.12 + R() * .25), ang + (R() - .5) * aj, 0, 7); c.fill();
  }
  c.restore();
}
function ridge(c, R, base, amp, f, col) {
  const p = [R() * 9, R() * 9, R() * 9]; c.beginPath(); c.moveTo(0, H);
  for (let x = 0; x <= W; x += 4) c.lineTo(x, base + amp * (Math.sin(x * f + p[0]) * .6 + Math.sin(x * f * 2.3 + p[1]) * .3 + Math.sin(x * f * 5.7 + p[2]) * .1));
  c.lineTo(W, H); c.closePath(); c.fillStyle = col; c.fill();
}
function peaks(c, R, base, amp, n, col, snow) {
  const pts = [[-20, base]]; for (let i = 0; i <= n; i++) pts.push([i * W / n + (R() - .5) * 40, base - amp * (.35 + R() * .65)], [i * W / n + W / n / 2 + (R() - .5) * 30, base - amp * R() * .3]);
  pts.push([W + 20, base]);
  c.beginPath(); c.moveTo(-20, H); pts.forEach(([x, y]) => c.lineTo(x, y)); c.lineTo(W + 20, H); c.closePath(); c.fillStyle = col; c.fill();
  if (snow) { c.save(); c.clip(); const g = c.createLinearGradient(0, base - amp, 0, base); g.addColorStop(0, snow); g.addColorStop(.55, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(0, base - amp, W, amp); c.restore(); }
}
function stars(c, R, n, y1, bright) {
  for (let i = 0; i < n; i++) { const s = R() ** 3 * 1.8 + .4; c.fillStyle = `rgba(255,255,255,${(.25 + R() * .75).toFixed(2)})`; c.fillRect(R() * W, R() * y1, s, s); }
  for (let i = 0; i < bright; i++) {
    const x = R() * W, y = R() * y1 * .9, l = 5 + R() * 10; glow(c, x, y, l * 1.6, '#dfe6ff', .6);
    c.save(); c.globalCompositeOperation = 'lighter'; c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 1; c.beginPath(); c.moveTo(x - l, y); c.lineTo(x + l, y); c.moveTo(x, y - l); c.lineTo(x, y + l); c.stroke(); c.restore();
  }
}
function aurora(c, R, y0, amp, top, bot, a) {
  c.save(); c.globalCompositeOperation = 'lighter'; const ph = R() * 6;
  for (let x = -10; x < W + 10; x += 2) {
    const y = y0 + Math.sin(x * .011 + ph) * amp + Math.sin(x * .033 + ph * 2) * amp * .3, h = 80 + 110 * Math.sin(x * .017 + ph * 3) ** 2;
    const g = c.createLinearGradient(0, y - h, 0, y + 8); g.addColorStop(0, hexA(top, 0)); g.addColorStop(.65, hexA(top, a * .55)); g.addColorStop(.93, hexA(bot, a)); g.addColorStop(1, hexA(bot, 0));
    c.fillStyle = g; c.fillRect(x, y - h, 2.2, h + 8);
  }
  c.restore();
}
function grain(c, R, a = .06) {
  const n = newCanvas(128, 128), nc = n.getContext('2d'), id = nc.createImageData(128, 128);
  for (let i = 0; i < id.data.length; i += 4) { const v = R() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
  nc.putImageData(id, 0, 0); c.save(); c.globalAlpha = a; c.globalCompositeOperation = 'overlay'; c.fillStyle = c.createPattern(n, 'repeat'); c.fillRect(0, 0, W, H); c.restore();
}
function vignette(c, a) { const g = c.createRadialGradient(W / 2, H * .42, H * .2, W / 2, H * .45, H * .78); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${a})`); c.fillStyle = g; c.fillRect(0, 0, W, H); }
const P = (c, pts) => { c.beginPath(); pts.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); };
function lin(c, x0, y0, x1, y1, stops) { const g = c.createLinearGradient(x0, y0, x1, y1); stops.forEach(([o, col]) => g.addColorStop(o, col)); return g; }
const bez = (p0, p1, p2, p3, t) => { const u = 1 - t; return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]; };

/* Subject finishing: crisp dark outline, warm/cool rim light on one side, soft shade on the other. */
function finishSubject(src, rimHex, dx, dy, outline = '#0b0d1a') {
  const shape = (fill, ox, oy, cut) => {
    const m = newCanvas(), mc = m.getContext('2d'); mc.drawImage(src, 0, 0);
    if (cut) { mc.globalCompositeOperation = 'destination-out'; mc.drawImage(src, ox, oy); }
    mc.globalCompositeOperation = 'source-in'; mc.fillStyle = fill; mc.fillRect(0, 0, W, H); return m;
  };
  const out = newCanvas(), oc = out.getContext('2d');
  const sil = shape(outline, 0, 0, false);
  for (let a = 0; a < 8; a++) oc.drawImage(sil, Math.cos(a * Math.PI / 4) * 2.2, Math.sin(a * Math.PI / 4) * 2.2);
  oc.drawImage(src, 0, 0);
  oc.save(); oc.globalCompositeOperation = 'source-atop'; oc.globalAlpha = .5; oc.drawImage(shape('#000', -dx * 2.5, -dy * 2.5, true), 0, 0); oc.restore();
  oc.save(); oc.globalCompositeOperation = 'source-atop'; oc.globalAlpha = .95; oc.filter = 'blur(.6px)'; oc.drawImage(shape(rimHex, dx, dy, true), 0, 0); oc.restore();
  return out;
}

/* ---------- backgrounds ---------- */
const BG = [
  (c, R) => { // dusk sky behind the crystal dragon
    sky(c, [[0, '#1d1446'], [.22, '#4b2a6e'], [.4, '#a94a74'], [.55, '#ef8a58'], [.66, '#ffc77e'], [.74, '#ffe6b4'], [1, '#f4b98a']]);
    dabs(c, R, 260, ['#ff9a7a', '#ffc49a', '#c86a9a', '#8a4a8a', '#ffe0c0'], 120, 520, 40, 150, .14, 'source-over', 0, .12);
    glow(c, 300, 560, 360, '#ffb35c', .55); glow(c, 300, 560, 80, '#fff2cc', 1);
    rays(c, R, 300, 560, 30, -Math.PI / 2, Math.PI * 1.3, 700, '#ffd7a0', .1);
    ridge(c, R, 600, 26, .008, '#7a3a63'); ridge(c, R, 640, 20, .014, '#4a2047'); ridge(c, R, 690, 16, .02, '#2a1230');
    grain(c, R); vignette(c, .35);
  },
  (c, R) => { // deep sea
    sky(c, [[0, '#46b5c4'], [.14, '#167894'], [.42, '#08395b'], [1, '#020a18']]);
    rays(c, R, 300, -160, 40, Math.PI / 2, 1.2, 1000, '#c8f6ff', .09);
    dabs(c, R, 220, ['#bff6ff', '#6fd6e8'], 0, 150, 20, 70, .14, 'overlay', 0, .6);
    c.save(); c.globalAlpha = .22; c.fillStyle = '#021624'; c.beginPath(); c.ellipse(120, 300, 110, 28, -.08, 0, 7); c.fill(); c.restore();
    c.save(); c.strokeStyle = 'rgba(200,245,255,.45)'; c.lineWidth = 1.2; for (let i = 0; i < 50; i++) { c.beginPath(); c.arc(R() * W, 100 + R() * 640, 1.5 + R() ** 2 * 6, 0, 7); c.stroke(); } c.restore();
    ridge(c, R, 640, 26, .012, '#041a2a'); ridge(c, R, 690, 22, .02, '#020d17');
    bokeh(c, R, 60, ['#8de9ff', '#c0b4ff', '#ffffff'], 60, 820, 2, 10, .45);
    grain(c, R); vignette(c, .45);
  },
  (c, R) => { // star night behind the winged guardian
    sky(c, [[0, '#04051a'], [.35, '#141a4e'], [.6, '#3d2f7a'], [.78, '#8a5aa0'], [1, '#d88fae']]);
    c.save(); c.translate(300, 330); c.rotate(-.6); dabs(c, R, 420, ['#c9b8ff', '#ffd6f0', '#9ab8ff'], -70, 70, 30, 100, .08, 'lighter', 0, .25);
    for (let i = 0; i < 700; i++) { const s = R() ** 3 * 1.6 + .4; c.fillStyle = `rgba(255,255,255,${(.3 + R() * .7).toFixed(2)})`; c.fillRect((R() - .5) * 1000, (R() - .5) * 140 * (R() + .3), s, s); } c.restore();
    stars(c, R, 500, 700, 12);
    glow(c, 300, 700, 420, '#ff9fc0', .25);
    ridge(c, R, 680, 18, .006, '#2a1b48'); ridge(c, R, 720, 14, .01, '#120f2c');
    grain(c, R); vignette(c, .3);
  },
  (c, R) => { // aurora behind the crystal sword
    sky(c, [[0, '#020812'], [.42, '#07202f'], [.66, '#0f3a48'], [1, '#1d5360']]);
    stars(c, R, 420, 500, 8);
    aurora(c, R, 250, 60, '#5effb3', '#c9fff0', .38); aurora(c, R, 170, 40, '#c56bff', '#ff9de0', .2); aurora(c, R, 320, 30, '#45d6ff', '#9ff7ff', .22);
    peaks(c, R, 560, 180, 4, '#1e4256', 'rgba(220,245,255,.55)'); peaks(c, R, 610, 120, 6, '#0d2433', 'rgba(200,235,255,.3)');
    const g = lin(c, 0, 600, 0, H, [[0, '#a8cdd8'], [.35, '#4c7584'], [1, '#0d1d27']]); c.fillStyle = g;
    c.beginPath(); c.moveTo(0, H); c.lineTo(0, 620); c.quadraticCurveTo(300, 590, 600, 625); c.lineTo(600, H); c.fill();
    bokeh(c, R, 60, ['#ffffff'], 0, 840, 1, 3, .7);
    grain(c, R); vignette(c, .4);
  },
];

/* Foil backgrounds for the gold and starlight tiers: a sunburst with uneven ray widths so it never reads as stripes. */
function sunburst(c, R, cx, cy, base, rayHex, n, a) {
  c.fillStyle = base; c.fillRect(0, 0, W, H);
  c.save(); c.globalCompositeOperation = 'lighter';
  let ang = R() * .2;
  while (ang < Math.PI * 2) {
    const w = .02 + R() * .07, len = 900, al = a * (.25 + R() * .75);
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, len); g.addColorStop(0, hexA(rayHex, al)); g.addColorStop(.55, hexA(rayHex, al * .55)); g.addColorStop(1, hexA(rayHex, 0));
    c.fillStyle = g; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, len, ang, ang + w); c.closePath(); c.fill();
    ang += w + .015 + R() * .06;
  }
  c.restore();
}
function fineRays(c, R, cx, cy, hex, a, n = 320) {
  c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) { const ang = R() * Math.PI * 2, w = .002 + R() * .006, len = 500 + R() * 400, al = a * R() ** 2;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, len); g.addColorStop(0, hexA(hex, al)); g.addColorStop(1, hexA(hex, 0));
    c.fillStyle = g; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, len, ang, ang + w); c.closePath(); c.fill(); }
  c.restore();
}
function goldBG() {
  const cv = newCanvas(), c = cv.getContext('2d'), R = seeded(4242);
  const base = c.createRadialGradient(300, 330, 20, 300, 380, 640); base.addColorStop(0, '#fff3c2'); base.addColorStop(.25, '#f1c45e'); base.addColorStop(.6, '#b67a1f'); base.addColorStop(1, '#5a3608');
  sunburst(c, R, 300, 330, base, '#fff0b8', 0, .55);
  c.save(); c.globalCompositeOperation = 'multiply'; c.globalAlpha = .35; sunburst(c, R, 300, 330, '#ffffff', '#c98a2a', 0, .0); c.restore();
  fineRays(c, R, 300, 330, '#fff7d6', .5);
  glow(c, 300, 330, 260, '#fff6d8', .55);
  dabs(c, R, 160, ['#fff4cc', '#ffe08a'], 0, H, 30, 120, .08, 'overlay', 0, 6);
  grain(c, R, .08); vignette(c, .25);
  return cv;
}
function starBG() {
  const cv = newCanvas(), c = cv.getContext('2d'), R = seeded(777);
  const base = c.createRadialGradient(300, 330, 10, 300, 400, 680); base.addColorStop(0, '#eceaff'); base.addColorStop(.1, '#a9aade'); base.addColorStop(.3, '#45468a'); base.addColorStop(.62, '#191944'); base.addColorStop(1, '#06061a');
  sunburst(c, R, 300, 330, base, '#e8ecff', 0, .3);
  fineRays(c, R, 300, 330, '#ffffff', .35, 420);
  c.save(); c.globalCompositeOperation = 'soft-light'; c.globalAlpha = .6;
  const tf = c.createLinearGradient(0, 0, W, H); ['#ff9cc8', '#ffe39a', '#9cffd6', '#9cc8ff', '#c9a6ff', '#ff9cc8'].forEach((col, i) => tf.addColorStop(i / 5, col));
  c.fillStyle = tf; c.fillRect(0, 0, W, H); c.restore();
  stars(c, R, 700, H, 22);
  glow(c, 300, 330, 220, '#ffffff', .45);
  grain(c, R, .07); vignette(c, .45);
  return cv;
}

/* ---------- subjects (transparent) ---------- */
function plates(c, p0, p1, p2, p3, r0, r1, n, light, dark, rim) {
  for (let i = 0; i <= n; i++) {
    const t = i / n, [x, y] = bez(p0, p1, p2, p3, t), r = r0 + (r1 - r0) * t;
    const g = c.createRadialGradient(x - r * .35, y - r * .45, r * .1, x, y, r * 1.05); g.addColorStop(0, light); g.addColorStop(.7, dark); g.addColorStop(1, dark);
    c.fillStyle = g; c.beginPath(); c.ellipse(x, y, r, r * .86, 0, 0, 7); c.fill();
    c.strokeStyle = rim; c.lineWidth = 1.4; c.beginPath(); c.ellipse(x, y, r * .92, r * .78, 0, Math.PI * 1.05, Math.PI * 1.75); c.stroke();
  }
}
function wing(c, R, S, E, T, tips, flip) {
  const f = p => flip ? [600 - p[0], p[1]] : p; S = f(S); E = f(E); T = f(T); tips = tips.map(f);
  // membrane
  c.save();
  c.beginPath(); c.moveTo(...S); c.lineTo(...E); c.lineTo(...T);
  let prev = T; tips.forEach((tp, i) => { const ctl = [(prev[0] + tp[0]) / 2 + (T[0] - (prev[0] + tp[0]) / 2) * .28, (prev[1] + tp[1]) / 2 + (T[1] - (prev[1] + tp[1]) / 2) * .28]; if (i === 0) c.lineTo(...tp); else c.quadraticCurveTo(...ctl, ...tp); prev = tp; });
  c.quadraticCurveTo(S[0] + (flip ? -10 : 10), S[1] + 120, S[0], S[1] + 70); c.closePath();
  const g = c.createRadialGradient(T[0], T[1], 20, T[0], T[1], 520); g.addColorStop(0, 'rgba(236,248,255,.97)'); g.addColorStop(.35, 'rgba(150,196,255,.93)'); g.addColorStop(.75, 'rgba(70,96,200,.9)'); g.addColorStop(1, 'rgba(40,40,140,.9)');
  c.fillStyle = g; c.fill(); c.clip();
  // crystal facets inside the membrane
  for (let i = 0; i < tips.length; i++) {
    const a = tips[i], b = tips[i + 1] || S;
    c.fillStyle = `rgba(255,255,255,${(.06 + R() * .14).toFixed(2)})`; P(c, [T, a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]]); c.fill();
    c.fillStyle = `rgba(20,30,110,${(.08 + R() * .14).toFixed(2)})`; P(c, [T, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b]); c.fill();
  }
  c.restore();
  // finger bones
  tips.forEach(tp => { c.strokeStyle = lin(c, ...T, ...tp, [[0, '#f4fbff'], [1, '#6e86d8']]); c.lineWidth = 6; c.lineCap = 'round'; c.beginPath(); c.moveTo(...T); c.lineTo(...tp); c.stroke();
    c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(T[0], T[1] - 2); c.lineTo(tp[0], tp[1] - 2); c.stroke(); });
  // arm
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = '#3f55a8'; c.lineWidth = 20; c.beginPath(); c.moveTo(...S); c.lineTo(...E); c.lineTo(...T); c.stroke();
  c.strokeStyle = lin(c, ...S, ...T, [[0, '#a9c8ff'], [1, '#f2f9ff']]); c.lineWidth = 13; c.beginPath(); c.moveTo(...S); c.lineTo(...E); c.lineTo(...T); c.stroke();
  c.fillStyle = '#eaf6ff'; c.beginPath(); c.arc(...E, 10, 0, 7); c.fill();
  // claw spike at the wrist
  P(c, [[T[0] - 6, T[1] + 4], [T[0] + (flip ? -18 : 18), T[1] - 40], [T[0] + 6, T[1] - 4]]); c.fillStyle = '#f6fbff'; c.fill();
}
const SUBJ = [
  (c, R) => { // crystal dragon, wings past the frame, horns into the name bar
    wing(c, R, [250, 250], [140, 130], [20, 30], [[-40, 170], [-10, 290], [50, 380], [150, 400]], false);
    wing(c, R, [350, 250], [470, 120], [610, 10], [[650, 160], [620, 290], [560, 390], [455, 410]], false);
    // tail
    plates(c, [250, 470], [160, 560], [60, 520], [-20, 640], 30, 10, 18, '#e3f1ff', '#4a64c0', 'rgba(255,255,255,.7)');
    // body
    P(c, [[255, 240], [345, 240], [380, 330], [360, 450], [300, 500], [235, 450], [220, 330]]);
    c.fillStyle = lin(c, 220, 240, 380, 500, [[0, '#f0f8ff'], [.45, '#90b3f0'], [1, '#33479e']]); c.fill();
    for (let i = 0; i < 6; i++) { const y = 300 + i * 30, w = 64 - Math.abs(i - 2) * 6; P(c, [[300 - w / 2, y], [300 + w / 2, y], [300 + w / 2 - 6, y + 24], [300 - w / 2 + 6, y + 24]]); c.fillStyle = i % 2 ? 'rgba(255,255,255,.35)' : 'rgba(20,30,100,.18)'; c.fill(); }
    // chest gem
    glow(c, 300, 300, 70, '#7fd0ff', .9); P(c, [[300, 270], [324, 300], [300, 334], [276, 300]]); c.fillStyle = lin(c, 280, 270, 320, 330, [[0, '#ffffff'], [.4, '#79c8ff'], [1, '#2a53d6']]); c.fill();
    // legs and claws
    [[235, 440, 170, 500], [365, 440, 430, 500]].forEach(([x0, y0, x1, y1]) => {
      c.strokeStyle = '#3f55a8'; c.lineWidth = 34; c.lineCap = 'round'; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      c.strokeStyle = '#b7d2ff'; c.lineWidth = 24; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      for (let k = -1; k <= 1; k++) { P(c, [[x1 + k * 12 - 5, y1 + 6], [x1 + k * 16, y1 + 34], [x1 + k * 12 + 5, y1 + 6]]); c.fillStyle = '#f4faff'; c.fill(); }
    });
    // neck spines
    for (let i = 1; i < 9; i++) { const [x, y] = bez([300, 250], [300, 180], [360, 160], [395, 130], i / 9); P(c, [[x - 12, y - 4], [x - 30, y - 40 + i], [x + 4, y - 14]]); c.fillStyle = '#e9f4ff'; c.fill(); }
    // neck
    plates(c, [300, 250], [300, 180], [360, 160], [395, 130], 38, 22, 12, '#f2f9ff', '#5570c8', 'rgba(255,255,255,.8)');
    c.save(); c.translate(390, 140); c.scale(1.35, 1.35); c.translate(-390, -140);
    // head
    P(c, [[372, 128], [402, 92], [450, 86], [512, 104], [520, 116], [478, 128], [500, 140], [458, 150], [410, 156]]);
    c.fillStyle = lin(c, 380, 86, 480, 160, [[0, '#ffffff'], [.5, '#a8c6ff'], [1, '#3a50aa']]); c.fill();
    P(c, [[402, 92], [450, 86], [512, 104], [440, 110]]); c.fillStyle = 'rgba(255,255,255,.55)'; c.fill();
    // horns
    [[[400, 98], [338, 8], [412, 92]], [[420, 92], [372, 20], [432, 90]], [[392, 118], [330, 70], [398, 110]]].forEach(h => { P(c, h); c.fillStyle = lin(c, h[0][0], h[0][1], h[1][0], h[1][1], [[0, '#c8dcff'], [1, '#ffffff']]); c.fill(); });
    // eye
    glow(c, 462, 106, 26, '#8ff4ff', 1); P(c, [[450, 104], [474, 102], [466, 110]]); c.fillStyle = '#e8ffff'; c.fill();
    // teeth
    for (let i = 0; i < 4; i++) { P(c, [[488 - i * 12, 126], [482 - i * 12, 138], [478 - i * 12, 126]]); c.fillStyle = '#fff'; c.fill(); }
    c.restore();
  },
  (c, R) => { // giant lantern jellyfish, bell above the window, tentacles over the frame
    c.save(); c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 34; i++) {
      const sx = 90 + i * 12.5, len = 420 + R() * 340, sway = (R() - .5) * 260, side = (i - 17) * 9;
      c.strokeStyle = `rgba(${150 + R() * 100 | 0},${200 + R() * 55 | 0},255,${(.25 + R() * .3).toFixed(2)})`; c.lineWidth = 1.2 + R() * 2;
      c.beginPath(); c.moveTo(sx, 300); c.bezierCurveTo(sx + side, 300 + len * .35, sx + sway + side * 1.6, 300 + len * .7, sx + sway * 1.4 + side * 2.4, 300 + len); c.stroke();
    }
    c.restore();
    // oral arms: frilly ribbons
    for (let k = 0; k < 4; k++) {
      const x0 = 250 + k * 33, sw = (k - 1.5) * 50;
      for (let t = 0; t < 1; t += .012) {
        const y = 300 + t * 520, x = x0 + Math.sin(t * 9 + k) * 22 + sw * t * 1.4, r = 16 * (1 - t * .7);
        c.fillStyle = `rgba(255,${170 + 60 * t | 0},${220},${(.16 - t * .1).toFixed(3)})`; c.beginPath(); c.ellipse(x, y, r, r * .5, Math.sin(t * 12) * .8, 0, 7); c.fill();
      }
    }
    // bell
    c.save();
    c.beginPath(); c.moveTo(60, 300); c.bezierCurveTo(60, 120, 170, 20, 300, 20); c.bezierCurveTo(430, 20, 540, 120, 540, 300);
    for (let i = 0; i <= 16; i++) { const x = 540 - i * 30; c.quadraticCurveTo(x - 15, 322 + (i % 2) * 6, x - 30, 300); }
    c.closePath();
    const g = c.createRadialGradient(300, 130, 20, 300, 220, 300); g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.3, 'rgba(180,240,255,.85)'); g.addColorStop(.7, 'rgba(90,170,240,.75)'); g.addColorStop(1, 'rgba(150,110,255,.8)');
    c.fillStyle = g; c.fill(); c.clip();
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 26; i++) { const a = Math.PI + i / 25 * Math.PI; c.strokeStyle = 'rgba(255,255,255,.28)'; c.lineWidth = 2; c.beginPath(); c.moveTo(300, 60); c.quadraticCurveTo(300 + Math.cos(a) * 140, 160 + Math.sin(a) * -20, 300 + Math.cos(a) * 260, 310); c.stroke(); }
    [[250, 200], [350, 200], [270, 250], [330, 250]].forEach(([x, y]) => { c.strokeStyle = 'rgba(255,160,220,.85)'; c.lineWidth = 7; c.beginPath(); c.ellipse(x, y, 34, 22, 0, 0, 7); c.stroke(); glow(c, x, y, 40, '#ff9fd8', .5); });
    c.restore();
    // rim frills
    c.save(); c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 60; i++) { const x = 64 + i * 8; c.fillStyle = `rgba(255,190,240,${(.4 + R() * .4).toFixed(2)})`; c.beginPath(); c.arc(x, 304 + Math.sin(i) * 4, 3 + R() * 2, 0, 7); c.fill(); }
    c.restore();
    // highlight on the bell top
    c.save(); c.globalCompositeOperation = 'lighter'; c.strokeStyle = 'rgba(255,255,255,.75)'; c.lineWidth = 5; c.lineCap = 'round'; c.beginPath(); c.arc(300, 300, 250, Math.PI * 1.18, Math.PI * 1.42); c.stroke(); c.restore();
  },
  (c, R) => { // winged guardian with a star: wings arch past the frame top and sides
    const feather = (x, y, ang, len, wdt, cA, cB, edge) => {
      c.save(); c.translate(x, y); c.rotate(ang);
      c.beginPath(); c.moveTo(0, -wdt * .35); c.bezierCurveTo(len * .35, -wdt * .62, len * .8, -wdt * .4, len, 0); c.bezierCurveTo(len * .8, wdt * .45, len * .35, wdt * .6, 0, wdt * .35); c.closePath();
      c.fillStyle = lin(c, 0, 0, len, 0, [[0, cA], [.7, cB], [1, edge]]); c.fill();
      c.strokeStyle = 'rgba(150,130,190,.35)'; c.lineWidth = 1; c.stroke();
      c.strokeStyle = 'rgba(255,255,255,.75)'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(2, 0); c.lineTo(len * .95, 0); c.stroke();
      c.restore();
    };
    const wingSide = s => {
      const m = p => [300 + s * (p[0] - 300), p[1]];
      const S = m([335, 250]), C1 = m([400, 110]), C2 = m([500, 40]), T = m([630, 30]);
      const rows = [ // [length at shoulder, length at tip, width, count, colour]
        [150, 360, 40, 26, '#f4efff', '#ffffff', '#d8c8ff'],
        [110, 250, 34, 22, '#fffaf0', '#ffffff', '#ffe2a0'],
        [70, 150, 28, 18, '#ffffff', '#fff8ec', '#f0e4ff'],
        [36, 70, 22, 14, '#fff7e6', '#ffffff', '#ffe9c0'],
      ];
      rows.forEach(([l0, l1, w, n, cA, cB, ce], row) => {
        for (let i = n - 1; i >= 0; i--) {
          const t = i / (n - 1), A = bez(S, C1, C2, T, t * (1 - row * .12));
          const dirDown = Math.PI / 2 - s * (.12 + t * 1.15);
          feather(A[0], A[1], dirDown + (R() - .5) * .06, (l0 + (l1 - l0) * t) * (.95 + R() * .1), w * (1 - t * .25), cA, cB, ce);
        }
      });
      c.strokeStyle = lin(c, ...S, ...T, [[0, '#fff3c8'], [1, '#ffffff']]); c.lineWidth = 10; c.lineCap = 'round';
      c.beginPath(); c.moveTo(...S); c.bezierCurveTo(...C1, ...C2, ...T); c.stroke();
      c.strokeStyle = '#c99a3a'; c.lineWidth = 2.5; c.beginPath(); c.moveTo(S[0], S[1] - 4); c.bezierCurveTo(C1[0], C1[1] - 4, C2[0], C2[1] - 4, T[0], T[1] - 4); c.stroke();
    };
    wingSide(-1); wingSide(1);
    // halo
    c.save(); c.globalCompositeOperation = 'lighter'; glow(c, 300, 175, 140, '#ffe6a0', .5);
    c.strokeStyle = 'rgba(255,226,150,.95)'; c.lineWidth = 5; c.beginPath(); c.ellipse(300, 148, 64, 17, 0, 0, 7); c.stroke(); c.restore();
    // hair behind
    c.lineCap = 'round';
    for (let i = 0; i < 60; i++) {
      const sx = 300 + (R() - .5) * 44, side = sx < 300 ? -1 : 1, ex = 300 + side * (40 + R() * 80), ey = 330 + R() * 110;
      c.strokeStyle = lin(c, sx, 180, ex, ey, [[0, '#fff2c0'], [1, i % 3 ? '#d9a443' : '#f6d27c']]); c.lineWidth = 3 + R() * 4;
      c.beginPath(); c.moveTo(sx, 190); c.bezierCurveTo(sx + side * 30, 250, ex - side * 30, ey - 80, ex, ey); c.stroke();
    }
    // dress with sleeves
    c.beginPath(); c.moveTo(270, 245); c.lineTo(330, 245); c.bezierCurveTo(372, 300, 380, 420, 420, 560); c.bezierCurveTo(450, 660, 480, 760, 500, 840); c.lineTo(100, 840); c.bezierCurveTo(120, 760, 150, 660, 180, 560); c.bezierCurveTo(220, 420, 228, 300, 270, 245); c.closePath();
    c.fillStyle = lin(c, 200, 240, 420, 840, [[0, '#ffffff'], [.35, '#e7e2ff'], [.75, '#a79cdf'], [1, '#5a4fa8']]); c.fill();
    c.strokeStyle = 'rgba(90,80,160,.28)'; c.lineWidth = 3;
    for (let i = 0; i < 8; i++) { const x = 300 + (i - 3.5) * 22; c.beginPath(); c.moveTo(300 + (x - 300) * .25, 400); c.quadraticCurveTo(x * 1 + (x - 300) * .6, 600, 300 + (x - 300) * 2.6, 840); c.stroke(); }
    P(c, [[262, 340], [338, 340], [334, 360], [266, 360]]); c.fillStyle = lin(c, 262, 340, 338, 360, [[0, '#b8862b'], [.5, '#fff0b8'], [1, '#b8862b']]); c.fill();
    P(c, [[284, 248], [316, 248], [300, 286]]); c.fillStyle = '#f6e2d4'; c.fill();
    // sleeves reaching to the star
    [[-1], [1]].forEach(([s]) => {
      c.beginPath(); c.moveTo(300 + s * 32, 252); c.bezierCurveTo(300 + s * 70, 300, 300 + s * 60, 360, 300 + s * 18, 386); c.lineTo(300 + s * 6, 372); c.bezierCurveTo(300 + s * 30, 340, 300 + s * 30, 300, 300 + s * 14, 262); c.closePath();
      c.fillStyle = lin(c, 300, 250, 300 + s * 70, 390, [[0, '#ffffff'], [1, '#c9c0f2']]); c.fill();
    });
    glow(c, 300, 386, 110, '#fff3c4', .55); glow(c, 300, 386, 36, '#ffffff', .8);
    c.save(); c.globalCompositeOperation = 'lighter'; c.fillStyle = '#fffbe8'; c.beginPath(); c.moveTo(300, 340); c.quadraticCurveTo(304, 382, 346, 386); c.quadraticCurveTo(304, 390, 300, 432); c.quadraticCurveTo(296, 390, 254, 386); c.quadraticCurveTo(296, 382, 300, 340); c.fill(); c.restore();
    // face and fringe
    c.fillStyle = '#f7e4d6'; c.beginPath(); c.ellipse(300, 206, 25, 31, 0, 0, 7); c.fill();
    c.fillStyle = lin(c, 270, 170, 330, 220, [[0, '#fff6d6'], [1, '#e2b25a']]);
    c.beginPath(); c.moveTo(274, 214); c.bezierCurveTo(268, 170, 290, 168, 300, 170); c.bezierCurveTo(314, 168, 334, 176, 327, 214); c.bezierCurveTo(318, 196, 306, 192, 300, 200); c.bezierCurveTo(292, 192, 282, 198, 274, 214); c.fill();
    c.strokeStyle = 'rgba(80,50,60,.7)'; c.lineWidth = 2; c.beginPath(); c.moveTo(287, 214); c.quadraticCurveTo(292, 218, 297, 214); c.moveTo(303, 214); c.quadraticCurveTo(308, 218, 313, 214); c.stroke();
  },
  (c, R) => { // crystal sword with orbiting shards
    // aurora ribbons around the blade (behind)
    c.save(); c.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 3; k++) { c.strokeStyle = ['rgba(110,255,190,.35)', 'rgba(120,200,255,.3)', 'rgba(220,140,255,.28)'][k]; c.lineWidth = 16 - k * 4;
      c.beginPath(); for (let t = 0; t <= 1; t += .01) { const y = 40 + t * 520, x = 300 + Math.sin(t * 7 + k * 2) * (140 + k * 30) * (1 - t * .3); t ? c.lineTo(x, y) : c.moveTo(x, y); } c.stroke(); }
    c.restore();
    // blade
    P(c, [[300, -10], [338, 70], [334, 470], [266, 470], [262, 70]]); c.fillStyle = lin(c, 262, 0, 338, 0, [[0, '#e9fbff'], [.48, '#ffffff'], [.52, '#7fb8e0'], [1, '#2f5f9a']]); c.fill();
    P(c, [[300, -10], [300, 470], [266, 470], [262, 70]]); c.fillStyle = 'rgba(255,255,255,.25)'; c.fill();
    for (let i = 0; i < 9; i++) { const y = 80 + i * 44; P(c, [[300, y], [336, y + 20], [300, y + 40]]); c.fillStyle = `rgba(20,60,140,${(.1 + R() * .15).toFixed(2)})`; c.fill(); }
    c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 2; c.beginPath(); c.moveTo(300, -10); c.lineTo(300, 470); c.stroke();
    glow(c, 300, 40, 60, '#e6fbff', .8);
    // guard
    P(c, [[300, 455], [420, 420], [470, 380], [452, 440], [360, 500], [300, 510], [240, 500], [148, 440], [130, 380], [180, 420]]);
    c.fillStyle = lin(c, 130, 380, 470, 510, [[0, '#7a4c10'], [.3, '#ffe9a6'], [.5, '#c88d2a'], [.7, '#fff3c8'], [1, '#7a4c10']]); c.fill();
    glow(c, 300, 478, 50, '#7dffd0', .9); P(c, [[300, 458], [318, 478], [300, 498], [282, 478]]); c.fillStyle = lin(c, 282, 458, 318, 498, [[0, '#ffffff'], [.5, '#5effb3'], [1, '#0d7a5a']]); c.fill();
    // grip and pommel
    c.fillStyle = lin(c, 284, 0, 316, 0, [[0, '#2a1d38'], [.5, '#5a4378'], [1, '#2a1d38']]); c.fillRect(286, 508, 28, 120);
    c.strokeStyle = '#d9a64a'; c.lineWidth = 2; for (let y = 514; y < 628; y += 10) { c.beginPath(); c.moveTo(286, y); c.lineTo(314, y + 6); c.stroke(); }
    c.fillStyle = lin(c, 280, 630, 320, 660, [[0, '#ffe9a6'], [1, '#8a5a12']]); c.beginPath(); c.arc(300, 642, 16, 0, 7); c.fill();
    // shards
    for (let i = 0; i < 16; i++) {
      const a = R() * Math.PI * 2, d = 150 + R() * 200, x = 300 + Math.cos(a) * d * 1.2, y = 270 + Math.sin(a) * d * .9, s = 14 + R() * 30, rot = R() * 6;
      c.save(); c.translate(x, y); c.rotate(rot);
      P(c, [[0, -s], [s * .45, 0], [0, s * .9], [-s * .45, 0]]); c.fillStyle = lin(c, -s, -s, s, s, [[0, '#ffffff'], [.5, '#9ad6ff'], [1, '#3a62c4']]); c.fill();
      P(c, [[0, -s], [s * .45, 0], [0, 0]]); c.fillStyle = 'rgba(255,255,255,.5)'; c.fill(); c.restore();
    }
  },
];
const RIM = [['#ffcf8a', 3, -3], ['#c8fbff', 0, -3], ['#ffe9b0', 2, -3], ['#c8fff0', -3, -2]];
function buildArt() {
  const out = { bg: [], subj: [], gold: goldBG().toDataURL('image/jpeg', .9), star: starBG().toDataURL('image/jpeg', .9) };
  BG.forEach((fn, i) => { const cv = newCanvas(); fn(cv.getContext('2d'), seeded(1000 + i * 17)); out.bg.push(cv.toDataURL('image/jpeg', .9)); });
  SUBJ.forEach((fn, i) => { const cv = newCanvas(); fn(cv.getContext('2d'), seeded(500 + i * 31)); const [h, dx, dy] = RIM[i]; out.subj.push(finishSubject(cv, h, dx, dy).toDataURL('image/png')); });
  return out;
}


/* ------------------------------------------------------------------ data */
// Material keys preserve the existing six stages; code is the displayed rarity.
const TIERS = [
  { k: 'n',   code: 'N',   name: '일반',        odds: 55,  glow: '#e9edf3', sym: ['dot'],
    desc: '인쇄 카드 스톡. 그림은 이름줄 위까지, 효과 1줄. 여섯 등급이 모두 같은 뼈대를 씁니다.',
    layers: [['카드 스톡 테두리', '종이 결 + 음각선'], ['코스트 · 보유 · 파워', '모든 등급 같은 자리'], ['효과 1줄', '카르투슈 모양 패널'], ['이름줄', 'Lv · 이름 · 번호·등급']] },
  { k: 'r',   code: 'U',   name: '백랍 인쇄',    odds: 25,  glow: '#5aa8ff', sym: ['dia'],
    desc: '같은 뼈대에 백랍(은회색) 재질과 은박 줄, 은박 이름. 효과 2줄.',
    layers: [['백랍 테두리', '헤어라인 결 + 은박 줄'], ['은박 이름', '빛 따라 하이라이트'], ['효과 2줄', '']] },
  { k: 'sr',  code: 'S',   name: '건메탈 인쇄',  odds: 13,  glow: '#b46bff', sym: ['dia', 'dia'],
    desc: '건메탈 재질과 은 상감. 그림 배경에만 옅은 홀로, 인물은 원래 색 그대로. 효과 2줄.',
    layers: [['건메탈 테두리', '은 상감'], ['배경 홀로', '인물 뒤에만'], ['은가루', '배경에 드문드문'], ['은박 이름', '']] },
  { k: 'ssr', code: 'SR',  name: '실버 풀아트', odds: 5,   glow: '#ffd25a', sym: ['star'],
    desc: '같은 뼈대가 은박으로 바뀝니다. 그림이 테두리까지 채우고 효과 패널은 반투명, 이름줄은 은박. 인물은 테두리 위를 완전히 덮습니다.',
    layers: [['은박 테두리', 'N·U·S와 같은 폭'], ['선택한 배경', '은박 반사와 가장자리 입자'], ['인물 층', '테두리 위로, 완전 불투명'], ['반투명 효과 패널', '2줄'], ['은박 이름줄', '']] },
  { k: 'ur',  code: 'SSR', name: '골드 풀아트', odds: 1.8, glow: '#ffb21e', sym: ['star', 'star'],
    desc: '금박 테두리와 이름줄, 선택한 배경 위에 인물. 금가루는 배경과 테두리에만. 효과 3줄.',
    layers: [['금박 테두리 · 이름줄', ''], ['선택한 배경', '금박 반사'], ['금가루', '배경과 테두리에만'], ['반투명 효과 패널', '3줄']] },
  { k: 'lr',  code: 'SEC', name: '별빛 한정',   odds: .2,  glow: 'rainbow', sym: ['spark'],
    desc: '그림마다 단 1장. 무지갯빛 은 테두리와 이름줄, 선택한 배경에 홀로 반사와 별가루. 시리얼 1 / 1, 효과 3줄.',
    layers: [['무지갯빛 은 테두리 · 이름줄', '각도 따라 색이 돎'], ['선택한 배경', '옅은 홀로 반사'], ['별가루', '큰 알갱이는 십자 빛'], ['시리얼', 'No. 1 / 1']] },
];
const TI = Object.fromEntries(TIERS.map((t, i) => [t.k, i]));
const PREMIUM = new Set(['ssr', 'ur', 'lr']);
// 속성 comes from the art's dominant colour (detectAttr below); this list is the palette and icon per attribute.
const ATTR = [
  { name: '빛',   c1: '#ffe39a', c2: '#b8820f', icon: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>' },
  { name: '어둠', c1: '#c7a6ff', c2: '#3a1c78', icon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>' },
  { name: '불꽃', c1: '#ffb08a', c2: '#c92a4a', icon: '<path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.6-5.6 3.6-8.8 1.6 1.5 2.2 3 2.2 4.6 1.2-1 1.8-2.4 1.9-4.1 2.6 2.2 5.3 5.1 5.3 8.6 0 3.4-2.6 5.9-6.5 5.9z"/>' },
  { name: '물',   c1: '#8fe2ff', c2: '#1a5fb4', icon: '<path d="M3 10c3 0 3-3 6-3s3 3 6 3 3-3 6-3M3 16c3 0 3-3 6-3s3 3 6 3 3-3 6-3"/>' },
  { name: '숲',   c1: '#c8f0a0', c2: '#2f7a3a', icon: '<path d="M5 19C5 10 11 5 19 5c0 8-5 14-14 14zM5 19l8-8"/>' },
  { name: '바람', c1: '#e6f2f4', c2: '#5f8a94', icon: '<path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3M3 12h7"/>' },
];
let ASSETS = [];

/* --------------------------------------------------------------- textures */
const svgURL = s => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
(function textures() {
  const root = document.documentElement.style;
  root.setProperty('--tex-paper', svgURL(`<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='p'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' seed='4'/><feColorMatrix values='0 0 0 0 .3  0 0 0 0 .27  0 0 0 0 .22  0 0 0 .09 0'/></filter><rect width='120' height='120' filter='url(#p)'/></svg>`));
  root.setProperty('--tex-brush', svgURL(`<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='b'><feTurbulence type='fractalNoise' baseFrequency='.004 .9' numOctaves='2' seed='9'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .22 -.04'/></filter><rect width='240' height='240' filter='url(#b)'/></svg>`));
})();

/* ------------------------------------------------- backdrops behind cutouts */
const mixHex = (a, b, t) => { const p = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; const A = p(a), B = p(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
const BD = {};
function backdrop(kind, tint) {
  const key = kind + tint; if (BD[key]) return BD[key];
  const cv = newCanvas(), c = cv.getContext('2d'), R = seeded(kind.length * 97 + parseInt(tint.slice(1), 16) % 1000);
  const rad = (stops, cx = 300, cy = 320, r = 640) => { const g = c.createRadialGradient(cx, cy, 10, cx, cy + 60, r); stops.forEach(([o, col]) => g.addColorStop(o, col)); return g; };
  if (kind === 'paper') { c.fillStyle = rad([[0, '#fffaf0'], [.55, mixHex('#efe6d2', tint, .1)], [1, mixHex('#cdbf9f', tint, .22)]]); c.fillRect(0, 0, W, H); dabs(c, R, 120, ['#ffffff', mixHex('#e8dcc0', tint, .15)], 0, H, 40, 160, .12, 'source-over', 0, 6); }
  else if (kind === 'silver') { sunburst(c, R, 300, 320, rad([[0, '#ffffff'], [.35, '#dde2e8'], [1, '#7a8492']]), '#ffffff', 0, .14); }
  else if (kind === 'holo') { sunburst(c, R, 300, 320, rad([[0, '#c9d2ff'], [.3, '#4a58a8'], [1, '#0c1030']]), '#c7d0ff', 0, .3); stars(c, R, 160, H, 4); }
  else if (kind === 'deep') { sunburst(c, R, 300, 320, rad([[0, mixHex(tint, '#ffffff', .75)], [.25, mixHex(tint, '#ffffff', .15)], [.6, mixHex(tint, '#000000', .45)], [1, mixHex(tint, '#000000', .8)]]), mixHex(tint, '#ffffff', .6), 0, .4); }
  else if (kind === 'gold') return BD[key] = ART.gold;
  else if (kind === 'star') return BD[key] = ART.star;
  grain(c, R, .06); vignette(c, .25);
  return BD[key] = cv.toDataURL('image/jpeg', .9);
}
const BACKDROP_OF = { n: 'paper', r: 'silver', sr: 'holo', ssr: 'deep', ur: 'gold', lr: 'star' };
/* ------------------------------------------------- printed frames (N · R · SR)
   One card family: a 3.8cqw printed outer border, then an illustrated frame panel whose material changes by tier
   (ivory card stock → pewter → brushed gunmetal), engraved double rules, corner ornaments, a notched name plate,
   a bevelled art window and a footer rule. Drawn once per tier at 8 px per cqw. */
const FT = {};
function rrPath(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function frameTex(k) {
  if (FT[k]) return FT[k];
  const FW = 800, FH = 1117, u = FW / 100, cv = newCanvas(FW, FH), c = cv.getContext('2d'), R = seeded(k.length * 131 + 17);
  const M = {
    n:  { border: '#1d1c22', base: ['#f1e9d3', '#e4d8bb', '#d8c9a7', '#e6dcc2'], mott: .07, brush: 0, slope: 0, grain: .1, ink: 'rgba(96,78,50,.92)', hi: 'rgba(255,252,240,.9)',
          plate: ['#fbf5e3', '#e8dcbc'], plateLine: 'rgba(96,78,50,.9)', foil: null, win: ['rgba(255,252,240,.9)', 'rgba(70,56,34,.55)'] },
    r:  { border: '#18191e', base: ['#eff2f5', '#d3d9df', '#b9c1ca', '#dde2e7'], mott: .05, brush: .07, slope: 0, grain: .07, ink: 'rgba(66,74,86,.92)', hi: 'rgba(255,255,255,.95)',
          plate: ['#ffffff', '#cdd3da'], plateLine: 'rgba(66,74,86,.9)', foil: ['#6b737e', '#ffffff', '#8d959f', '#f1f3f5', '#6b737e'], win: ['rgba(255,255,255,.95)', 'rgba(40,46,56,.55)'] },
    sr: { border: '#0c0d15', base: ['#3b4488', '#272e62', '#181c42', '#2a3268'], mott: .06, brush: .1, slope: .015, grain: .06, ink: 'rgba(206,214,246,.9)', hi: 'rgba(2,3,14,.75)',
          plate: ['#3a4488', '#1b2048'], plateLine: 'rgba(206,214,246,.9)', foil: ['#6d7690', '#ffffff', '#8890ad', '#eef1ff', '#6d7690'], win: ['rgba(200,210,255,.55)', 'rgba(0,0,10,.7)'] },
  }[k];
  // round-5 skeleton: thin dark print edge, then the material as the border (3.8cqw) and the lower block under the art (117cqw down)
  const E = .9 * u, B = 3.8 * u, AB = 117 * u;
  c.fillStyle = M.border; c.fillRect(0, 0, FW, FH);
  c.save(); rrPath(c, E, E, FW - 2 * E, FH - 2 * E, 3.4 * u); c.clip();
  const g = c.createLinearGradient(0, 0, FW * .7, FH); M.base.forEach((col, i) => g.addColorStop(i / (M.base.length - 1), col)); c.fillStyle = g; c.fillRect(0, 0, FW, FH);
  for (let i = 0; i < 180; i++) { const x = R() * FW, y = R() * FH, r = 20 + R() * 130, a = M.mott * R(), gg = c.createRadialGradient(x, y, 0, x, y, r);
    gg.addColorStop(0, R() < .5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`); gg.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = gg; c.fillRect(x - r, y - r, 2 * r, 2 * r); }
  if (M.brush) for (let i = 0; i < 3200; i++) { const y = R() * FH, x = R() * FW - 100, l = 60 + R() * 320;
    c.strokeStyle = R() < .5 ? `rgba(255,255,255,${(R() * M.brush).toFixed(3)})` : `rgba(0,0,0,${(R() * M.brush).toFixed(3)})`; c.lineWidth = .5 + R() * .9; c.beginPath(); c.moveTo(x, y); c.lineTo(x + l, y + l * M.slope); c.stroke(); }
  const n = newCanvas(128, 128), nc = n.getContext('2d'), id = nc.createImageData(128, 128);
  for (let i = 0; i < id.data.length; i += 4) { const v = R() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
  nc.putImageData(id, 0, 0); c.globalAlpha = M.grain; c.globalCompositeOperation = 'overlay'; c.fillStyle = c.createPattern(n, 'repeat'); c.fillRect(0, 0, FW, FH);
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  c.restore();
  const eng = (path, lw, fill) => {
    c.save(); c.translate(.13 * u, .13 * u); path(); if (fill) { c.fillStyle = M.hi; c.fill(); } else { c.strokeStyle = M.hi; c.lineWidth = lw; c.stroke(); } c.restore();
    c.save(); path(); if (fill) { c.fillStyle = M.ink; c.fill(); } else { c.strokeStyle = M.ink; c.lineWidth = lw; c.stroke(); } c.restore();
  };
  if (M.foil) { c.save(); rrPath(c, E + .45 * u, E + .45 * u, FW - 2 * E - .9 * u, FH - 2 * E - .9 * u, 3 * u); const fg = c.createLinearGradient(0, 0, FW, FH); M.foil.forEach((col, i) => fg.addColorStop(i / (M.foil.length - 1), col)); c.strokeStyle = fg; c.lineWidth = .4 * u; c.stroke(); c.restore(); }
  // engraved line around the art opening and around the lower block
  eng(() => rrPath(c, B - .7 * u, B - .7 * u, FW - 2 * B + 1.4 * u, AB - B + 1.4 * u, 1.2 * u), .16 * u);
  eng(() => rrPath(c, B - .7 * u, AB + 1.2 * u, FW - 2 * B + 1.4 * u, FH - AB - B - .5 * u, 1.2 * u), .16 * u);
  // raised lip along the art's lower edge
  c.fillStyle = M.win[0]; c.fillRect(B, AB, FW - 2 * B, .45 * u); c.fillStyle = M.win[1]; c.fillRect(B, AB - .25 * u, FW - 2 * B, .25 * u);
  // corner ornaments on the lower block and small diamonds at the top corners
  const corner = (x, y, sx, sy, s) => { const tr = f => () => { c.translate(x, y); c.scale(sx * s, sy * s); f(); };
    eng(tr(() => { c.beginPath(); c.arc(0, 0, 4.2 * u, 0, Math.PI / 2); }), .2 * u / s);
    eng(tr(() => { c.beginPath(); c.moveTo(1.9 * u, .7 * u); c.lineTo(3.1 * u, 1.9 * u); c.lineTo(1.9 * u, 3.1 * u); c.lineTo(.7 * u, 1.9 * u); c.closePath(); }), 0, true);
    eng(tr(() => { c.beginPath(); c.arc(4.2 * u, 0, .45 * u, 0, 7); c.moveTo(.45 * u, 4.2 * u); c.arc(0, 4.2 * u, .45 * u, 0, 7); }), 0, true); };
  const by = FH - B + .2 * u;
  c.save(); corner(B + .2 * u, by, 1, -1, .62); c.restore(); c.save(); corner(FW - B - .2 * u, by, -1, -1, .62); c.restore();
  [[B / 2 + E / 2, B / 2 + E / 2], [FW - B / 2 - E / 2, B / 2 + E / 2]].forEach(([x, y]) => eng(() => P(c, [[x, y - .8 * u], [x + .8 * u, y], [x, y + .8 * u], [x - .8 * u, y]]), 0, true));
  return FT[k] = cv.toDataURL('image/jpeg', .92);
}


/* ------------------------------------------------- luminance maps (no-cutout art)
   Foil and glitter follow the picture's own light; an optional ellipse keeps them off the face. */
const LUM = new Map();
function lumMap(src, pos, protect) {
  const key = src + pos + (protect || ''); if (LUM.has(key)) return LUM.get(key);
  const p = new Promise(res => {
    const im = new Image(); im.onload = () => {
      try {
        const w = 90, h = 126, cv = newCanvas(w, h), c = cv.getContext('2d', { willReadFrequently: true });
        const [px, py] = (pos || '50% 50%').split(' ').map(v => parseFloat(v) / 100), ia = im.width / im.height, ca = 63 / 88;
        let sx = 0, sy = 0, sw = im.width, sh = im.height;
        if (ia > ca) { sw = im.height * ca; sx = (im.width - sw) * px; } else { sh = im.width / ca; sy = (im.height - sh) * py; }
        c.drawImage(im, sx, sy, sw, sh, 0, 0, w, h);
        const d = c.getImageData(0, 0, w, h), wt = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
          const r = d.data[i * 4], g = d.data[i * 4 + 1], b = d.data[i * 4 + 2], l = (.299 * r + .587 * g + .114 * b) / 255;
          let v = Math.min(1, Math.max(0, (l - .42) / .4)); v = v * v * (3 - 2 * v);
          if (protect) { const x = (i % w) / w, y = (i / w | 0) / h, e = ((x - protect[0]) / protect[2]) ** 2 + ((y - protect[1]) / protect[3]) ** 2; v *= Math.min(1, Math.max(0, (e - .6) / .8)); }
          wt[i] = v; d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = 255; d.data[i * 4 + 3] = v * 255;
        }
        c.putImageData(d, 0, 0);
        res({ w, h, wt, mask: `url("${cv.toDataURL('image/png')}")` });
      } catch (e) { res(null); } // a file:// page cannot read pixels; effects then stay unmasked and light
    };
    im.onerror = () => res(null); im.src = src;
  });
  LUM.set(key, p); return p;
}

/* ------------------------------------------------------------ card build */
const SYM = {
  dot: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.6"/></svg>',
  dia: '<svg viewBox="0 0 10 10"><path d="M5 .4 9.6 5 5 9.6.4 5z"/></svg>',
  star: '<svg viewBox="0 0 10 10"><path d="M5 .3l1.4 3.1 3.3.3-2.5 2.2.8 3.3L5 7.5 2 9.2l.8-3.3L.3 3.7l3.3-.3z"/></svg>',
  spark: '<svg viewBox="0 0 10 10"><path d="M5 0Q5.6 4.4 10 5 5.6 5.6 5 10 4.4 5.6 0 5 4.4 4.4 5 0z"/></svg>',
};
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20.3 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9a4.6 4.6 0 0 1 6.5 6.5z"/></svg>';
const pad = n => String(n).padStart(4, '0');
const fmt = n => n.toLocaleString('ko-KR');
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
let userBg = null, userFg = null; const madeURLs = [];
const cards = new Set();

/* Card-game stats from real asset data:
   코스트 ← tier · 보유 / Lv ← duplicates · 파워 ← resolution · 속성 ← dominant colour · 특성 ← tags · effects ← artist, albums, favourite. */
const powerOf = (w, h) => Math.max(500, Math.floor(w * h / 1e6 * 1000 / 500) * 500);
const powerHTML = v => v >= 1000 ? `<b class="num">${Math.floor(v / 1000)}</b><span class="pw-tail"><i>LP</i><small class="num">${String(v % 1000).padStart(3, '0')}</small></span>` : `<b class="num">${v}</b><span class="pw-tail"><i>LP</i></span>`;
function effectsFor(a, tier) {
  const out = [];
  if (a.albums) out.push(['앨범', `담긴 앨범 ${a.albums}곳 · 파워 <b>+${fmt(a.albums * 500)}</b>`]);
  if (a.credit !== 'NoOne') out.push(['작가 연계', '같은 작가 카드 3장을 모으면 파워 <b>+2,000</b>']);
  if (a.fav) out.push(['즐겨찾기', '즐겨찾기 표시가 붙는다']);
  out.push(['첫 수집', '도감에 새로 등록되면 뽑기권 <b>+1</b>']);
  return out.slice(0, { n: 1, r: 2, sr: 2, ssr: 2, ur: 3, lr: 3 }[tier]);
}
function frontInner(a) {
  const at = ATTR[a.attr];
  return `<img class="f-bg" alt="" draggable="false" decoding="async">
      <div class="f-sheen"></div><div class="f-shade"></div><div class="f-frame"></div>
      <canvas class="f-glit"></canvas><div class="f-glare"></div>
      <div class="f-subjwrap"><img class="f-subj" alt="" draggable="false" decoding="async"></div>
      <div class="f-cost"><span class="num">1</span></div><div class="f-dup"><span class="num">1</span></div>
      <div class="f-power">${powerHTML(powerOf(a.w || 600, a.h || 840))}</div>
      <div class="f-gem">${a.fav ? `<span class="f-heart" title="즐겨찾기">${HEART}</span>` : ''}<span class="f-type" title="속성 ${at.name}"><svg viewBox="0 0 24 24">${at.icon}</svg></span></div>
      <div class="f-fx"></div>
      <div class="f-nb"><span class="nb-lv"><i>Lv.</i><b class="num">1</b></span><span class="f-title">${esc(a.title)}</span><span class="nb-no"><span>LK01-${pad(a.id)}</span><span class="f-rar"></span></span></div>
      <div class="f-traits"><span class="f-serial" hidden></span>${a.tags.map(t => `<span class="t">${esc(t)}</span>`).join('')}</div>
      <div class="f-vc">Illus. ${esc(a.credit)} · © Lakomics</div>`;
}
function makeCard(a, tier, opts = {}) {
  const el = document.createElement('div'); el.className = 'card'; el._asset = a; el._serial = opts.serial; el._live = !!opts.live;
  el._dup = opts.dup || a.dup || 1;
  el.innerHTML = `<div class="card__flip"><div class="card__tilt">
    <div class="face front">${frontInner(a)}</div>
    <div class="face back">
      <div class="b-frame"></div><div class="b-corner tl"></div><div class="b-corner tr"></div><div class="b-corner bl"></div><div class="b-corner br"></div>
      <div class="b-word t">LAKOMICS</div><div class="b-sub t">ASSET CARD</div><div class="b-word b">LAKOMICS</div><div class="b-sub b">ASSET CARD</div>
      <div class="b-emblem"></div><svg class="b-mark" viewBox="0 0 32 36"><use href="#mk"/></svg>
      <div class="b-sheen"></div>
    </div></div></div>`;
  el._cv = $('.f-glit', el); el._lx = .3; el._ly = .22;
  if (opts.ovBg) el._ovBg = opts.ovBg;
  setTier(el, tier);
  bindTilt(el, opts.tilt);
  cards.add(el); ro.observe(el);
  return el;
}
function setTier(el, k) {
  const t = TIERS[TI[k]], a = el._asset;
  el.dataset.tier = k; el.dataset.glow = t.glow === 'rainbow' ? 'rainbow' : ''; el.dataset.fav = a.fav ? '1' : '0';
  el.style.setProperty('--glow', t.glow === 'rainbow' ? '#fff' : t.glow);
  el.querySelectorAll('.f-rar').forEach(r => { r.innerHTML = t.sym.map(s => SYM[s]).join('') + `<span>${t.code}</span>`; });
  const serial = el._serial ?? (k === 'lr' ? 'No. 1 / 1' : k === 'ur' ? 'No. 3 / 10' : '');
  el.querySelectorAll('.f-serial').forEach(f => { f.textContent = (k === 'lr' || k === 'ur') ? serial : ''; f.hidden = !f.textContent; });
  $('.f-cost', el).innerHTML = `<span class="num">${TI[k] + 1}</span>`;
  const dup = $('.f-dup', el); dup.innerHTML = `<span class="num">${el._dup}</span>`; dup.classList.toggle('two', el._dup > 9);
  $('.nb-lv', el).innerHTML = `<i>Lv.</i><b class="num">${Math.min(5, el._dup)}</b>`;
  $('.f-fx', el).innerHTML = effectsFor(a, k).map(([kw, tx]) => `<div class="fx"><span class="kw">${kw}</span><span class="tx">${tx}</span></div>`).join('');
  const title = $('.f-title', el), metal = { r: 'silverdk', sr: 'silver' }[k];
  title.classList.toggle('metal', !!metal); if (metal) title.style.setProperty('--metal', `var(--${metal})`);
  const fr = $('.f-frame', el); if (k === 'n' || k === 'r' || k === 'sr') fr.style.backgroundImage = `url(${frameTex(k)})`; else fr.style.removeProperty('background-image');
  el.classList.toggle('fa', PREMIUM.has(k));
  refreshArt(el);
}
function applyAttr(el, i) {
  const at = ATTR[i]; el._attr = i; el.style.setProperty('--c1', at.c1); el.style.setProperty('--c2', at.c2);
  const ty = $('.f-type', el); ty.title = '속성 ' + at.name; ty.innerHTML = `<svg viewBox="0 0 24 24">${at.icon}</svg>`;
}
/* 속성 from the art's dominant colour: dark → 어둠, pale → 바람, else the strongest saturated hue. */
const ATTRC = new Map();
function detectAttr(src) {
  if (ATTRC.has(src)) return ATTRC.get(src);
  const pr = loadI(src).then(im => {
    if (!im) return null;
    try {
      const w = 48, h = 48, cv = newCanvas(w, h), c = cv.getContext('2d', { willReadFrequently: true }); c.drawImage(im, 0, 0, w, h);
      const d = c.getImageData(0, 0, w, h).data, bins = new Float32Array(12); let n = 0, dark = 0, pale = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 200) continue; const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, ch = mx - mn;
        const sat = ch === 0 ? 0 : ch / (1 - Math.abs(2 * l - 1)); n++;
        if (l < .2) dark++; if (sat < .15 && l > .72) pale++;
        if (ch > 0 && sat > .25 && l > .15 && l < .9) { let hue = mx === r ? ((g - b) / ch) % 6 : mx === g ? (b - r) / ch + 2 : (r - g) / ch + 4; hue = (hue * 60 + 360) % 360; bins[Math.floor(hue / 30) % 12] += sat; }
      }
      if (!n) return null; if (dark / n > .5) return 1; if (pale / n > .45) return 5;
      let bi = 0; bins.forEach((v, i) => { if (v > bins[bi]) bi = i; }); const hue = bi * 30 + 15;
      return hue < 25 || hue >= 290 ? 2 : hue < 70 ? 0 : hue < 165 ? 4 : hue < 255 ? 3 : 1;
    } catch (e) { return null; } // a file:// page cannot read pixels: keep the asset's stored attribute
  });
  ATTRC.set(src, pr); return pr;
}
/* Which layers a card shows, from its asset, its tier and any user images. */
function artPlan(el) {
  const a = el._asset, k = el.dataset.tier;
  const bgOverride = el._ovBg || userBg;
  const fullArt = originalArt || (bgOverride ? !userFg : !!a.fullArt);
  if (fullArt) return { bg: bgOverride || a.art || a.scene, pos: a.pos || '50% 50%', cut: null, fit: [0, 0, 100], fade: false, protect: null, lumNeeded: false, fullArt: true };
  let cut = null, fit = [0, 0, 100], fade = false;
  if (el._ovBg) cut = userFg; else if (userFg) cut = userFg; else if (!userBg) { if (a.cut) { cut = a.cut; fit = a.fit; fade = true; } else if (a.subj) cut = a.subj; }
  if (cut === userFg && userFg) { fit = [0, 0, 100]; fade = false; }
  let bg, pos = '50% 50%', protect = null;
  if (bgOverride) { bg = bgOverride; }
  else if (cut) bg = BACKGROUNDS.render(a.variant || backgroundVariant, k, a.tint || '#6a3aa8');
  else { bg = a.art; pos = a.pos || '50% 50%'; protect = a.protect || null; }
  if (cut && bgOverride && !userFg) cut = null;
  return { bg, pos, cut, fit, fade, protect, lumNeeded: !cut };
}
function refreshArt(el) {
  const p = artPlan(el), bg = $('.f-bg', el), sj = $('.f-subj', el);
  el.classList.toggle('original-art', !!p.fullArt);
  el.classList.toggle('fa', PREMIUM.has(el.dataset.tier) || !!p.fullArt);
  if (bg.getAttribute('src') !== p.bg) bg.src = p.bg;
  el.style.setProperty('--bgpos', p.pos); el.style.setProperty('--tint', el._asset.tint || '#6a3aa8');
  el.dataset.subj = p.cut ? '1' : '0'; el.dataset.cut = p.cut ? '1' : '0';
  if (p.cut) { if (sj.getAttribute('src') !== p.cut) sj.src = p.cut; sj.style.setProperty('--sx', p.fit[0] + '%'); sj.style.setProperty('--sy', p.fit[1] + '%'); sj.style.setProperty('--sw', p.fit[2] + '%');
    sj.style.setProperty('--sfade', 'none');
    if (p.fade && PREMIUM.has(el.dataset.tier)) { const setFade = () => { if (!sj.naturalWidth) return; const h = p.fit[2] * sj.naturalHeight / sj.naturalWidth, top = p.fit[1] * 1.3968;
        const end = Math.min(1, (128 - top) / h), start = Math.max(0, end - 18 / h);
        sj.style.setProperty('--sfade', `linear-gradient(180deg, #000 ${(start * 100).toFixed(1)}%, transparent ${(end * 100).toFixed(1)}%)`); };
      sj.complete ? setFade() : sj.addEventListener('load', setFade, { once: true }); } }
  el._lum = null; el.style.removeProperty('--lum');
  const token = el._artToken = {};
  const a = el._asset;
  applyAttr(el, a.attr);
  detectAttr(p.cut || p.bg).then(i => { if (el._artToken === token && i != null) applyAttr(el, i); });
  const pw = $('.f-power', el), ownArt = el._ovBg || userBg || userFg;
  pw.innerHTML = powerHTML(powerOf(a.w || 600, a.h || 840));
  if (ownArt) loadI(ownArt).then(im => { if (im && el._artToken === token) pw.innerHTML = powerHTML(powerOf(im.naturalWidth, im.naturalHeight)); });
  if (p.lumNeeded) lumMap(p.bg, p.pos, p.protect).then(m => { if (el._artToken !== token) return; el._lum = m; if (m) el.style.setProperty('--lum', m.mask); regen(el); });
  regen(el);
}

const IMGC = new Map();
const loadI = src => { if (!IMGC.has(src)) IMGC.set(src, new Promise(r => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = src; })); return IMGC.get(src); };
/* ---------------------------------------------------------------- glitter
   Each flake has a facet: it flashes when the light sits at its own reflection spot (flake position + facet offset),
   so moving the light makes different flakes catch it — like real foil glitter. Crisp 1–2 device-px cores; the
   brightest big flakes get a small four-point star. Drawn under the subject, so the figure stays clean. */
const GLIT = {
  sr:  { d: .0012, win: 1,   frame: 0,  text: 0,   cols: ['#ffffff', '#dfe6ff', '#cfd8ff'], big: .04 },
  ssr: { d: .0045, win: .3,  frame: 1,  text: .02, cols: ['#fff3c8', '#ffd36b', '#ffe9a6', '#ffffff'], big: .1 },
  ur:  { d: .0085, win: 1,   frame: 1,  text: .04, cols: ['#ffffff', '#fff6d8', '#ffe08a', '#ffffff', '#fff0b8'], big: .1 },
  lr:  { d: .0075, win: 1,   frame: 1,  text: .04, cols: ['#ffffff', '#ffffff', '#e8f2ff', '#ffd6ec', '#fff2c8', '#d0ffec', '#e2d6ff'], big: .14 },
};
const WIN = [.07, 15.4 / 139.68, .93, 95.4 / 139.68], TXT = [.07, 96 / 139.68, .93, 123 / 139.68];
const inRect = (x, y, r) => x > r[0] && x < r[2] && y > r[1] && y < r[3];
function hashStr(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }
function regen(el) {
  const spec = GLIT[el.dataset.tier], cw = el._cw, ch = el._ch;
  if (!spec || !cw) { el._flakes = null; drawGlit(el); return; }
  const R = seeded(hashStr(el._asset.key + el.dataset.tier)), n = Math.round(spec.d * cw * ch), lum = el._lum, cut = el.dataset.cut === '1';
  const fl = [], scale = Math.max(.65, Math.min(1.15, cw / 380));
  for (let tries = 0; fl.length < n && tries < n * 10; tries++) {
    const x = R(), y = R(); let w;
    if (PREMIUM.has(el.dataset.tier)) { const band = x < .038 || x > .962 || y < .027 || y > .973; w = band ? spec.frame : y > .6 ? spec.text * 3 : spec.win; }
    else if (inRect(x, y, TXT)) w = spec.text; else if (inRect(x, y, WIN)) w = spec.win; else w = spec.frame;
    if (!cut && el.dataset.tier !== 'sr') { if (lum) { const v = lum.wt[(y * lum.h | 0) * lum.w + (x * lum.w | 0)]; w *= inRect(x, y, WIN) || inRect(x, y, [.03, .03, .97, .97]) ? .04 + .96 * v : 1; } else w *= .35; }
    if (R() > w) continue;
    const phi = R() * Math.PI * 2, rr = R() ** .7 * .42;
    fl.push({ x, y, tx: Math.cos(phi) * rr, ty: Math.sin(phi) * rr * .8, s: (.7 + R() ** 2.5 * 1.9) * scale, c: spec.cols[R() * spec.cols.length | 0], base: .08 + R() ** 2 * .32, big: R() < spec.big, sc: scale });
  }
  el._flakes = fl; sizeCanvas(el); drawGlit(el);
}
function sizeCanvas(el) { const cv = el._cv, w = Math.round(el._cw * DPR), h = Math.round(el._ch * DPR); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } }
function drawGlit(el) {
  const cv = el._cv, ctx = cv.getContext('2d'), f = el._flakes; ctx.clearRect(0, 0, cv.width, cv.height);
  if (!f || !cv.width) return;
  const Wc = cv.width, Hc = cv.height, ar = Hc / Wc, lx = el._lx, ly = el._ly;
  ctx.globalCompositeOperation = 'lighter';
  for (const k of f) {
    const dx = lx - (k.x + k.tx), dy = (ly - (k.y + k.ty)) * ar, sx = lx - k.x, sy = (ly - k.y) * ar;
    let b = (k.base + Math.exp(-(dx * dx + dy * dy) / .026) * 1.3) * (.6 + .4 * Math.exp(-(sx * sx + sy * sy) / .25));
    if (b < .05) continue; if (b > 1) b = 1;
    const px = k.x * Wc, py = k.y * Hc, s = Math.max(1, Math.round(k.s * DPR));
    ctx.fillStyle = k.c; ctx.globalAlpha = b; ctx.fillRect(Math.round(px - s / 2), Math.round(py - s / 2), s, s);
    if (k.big && b > .5) {
      const L = (2.5 + 7 * b) * DPR * k.sc, t = Math.max(1, Math.round(DPR * .75));
      ctx.globalAlpha = b * .9; ctx.fillRect(px - L * .5, py - t / 2, L, t); ctx.fillRect(px - t / 2, py - L * .5, t, L);
      ctx.globalAlpha = b * .35; ctx.fillRect(px - L, py - t / 2, L * 2, t); ctx.fillRect(px - t / 2, py - L, t, L * 2);
      ctx.globalAlpha = b * .25; ctx.beginPath(); ctx.arc(px, py, 2.2 * DPR * k.sc, 0, 7); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
const ro = new ResizeObserver(es => es.forEach(e => { const el = e.target, r = e.contentRect; if (!r.width) return; if (Math.abs((el._cw || 0) - r.width) < .5) return; el._cw = r.width; el._ch = r.height; regen(el); }));

/* --------------------------------------------------------------- tilt */
const MAX = RM ? 3 : 14;
let glitQueue = new Set(), glitRAF = 0;
function queueGlit(el) { glitQueue.add(el); if (!glitRAF) glitRAF = requestAnimationFrame(() => { glitRAF = 0; glitQueue.forEach(drawGlit); glitQueue.clear(); }); }
function applyPose(el, x, y) {
  const px = x - .5, py = y - .5, s = el.style;
  s.setProperty('--mx', (x * 100).toFixed(2) + '%'); s.setProperty('--my', (y * 100).toFixed(2) + '%');
  s.setProperty('--rx', (-py * MAX * 1.4).toFixed(2) + 'deg'); s.setProperty('--ry', (px * MAX * 2).toFixed(2) + 'deg');
  s.setProperty('--ang', (Math.atan2(py, px) * 180 / Math.PI + 90).toFixed(1) + 'deg'); s.setProperty('--o', '1');
  if (el._live) { el._lx = x; el._ly = y; if (el._flakes) queueGlit(el); }
}
function clearPose(el) { ['--mx', '--my', '--rx', '--ry', '--ang', '--o'].forEach(p => el.style.removeProperty(p)); if (el._live) { el._lx = .3; el._ly = .22; if (el._flakes) queueGlit(el); } }
function bindTilt(el, hooks = {}) {
  let rect = null, raf = 0, lx = .5, ly = .5, down = false;
  const update = () => { raf = 0; applyPose(el, lx, ly); };
  const move = e => {
    if (el.classList.contains('down') || el.classList.contains('charge')) return;
    if (e.pointerType === 'touch' && !down) return;
    if (!rect) rect = el.getBoundingClientRect();
    lx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)); ly = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    if (!el.classList.contains('active')) { el.classList.add('active'); hooks.start && hooks.start(); }
    if (!raf) raf = requestAnimationFrame(update);
  };
  const end = () => { down = false; rect = null; if (raf) cancelAnimationFrame(raf), raf = 0; if (el.classList.contains('active')) { el.classList.remove('active'); clearPose(el); hooks.end && hooks.end(); } };
  el.addEventListener('pointerenter', () => { rect = el.getBoundingClientRect(); });
  el.addEventListener('pointerdown', e => { down = true; rect = el.getBoundingClientRect(); move(e); });
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerleave', end); el.addEventListener('pointercancel', end);
  el.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') end(); });
}

/* ------------------------------------------------------------ export */
let ART = null;
function boot() { if (!ART) ART = buildArt(); return ART; }
const COMPOSITE = new Map();
/** A demo asset from procedural parts: background scene `bg`, subject `subj` (optionally mirrored). */
async function makeAsset(d) {
  boot();
  const key = `${d.bg}:${d.subj}:${d.flip ? 1 : 0}`;
  if (!COMPOSITE.has(key)) COMPOSITE.set(key, (async () => {
    const [bg, fg] = await Promise.all([loadI(ART.bg[d.bg]), loadI(ART.subj[d.subj])]);
    const sc = newCanvas(), s = sc.getContext('2d');
    if (d.flip) { s.translate(W, 0); s.scale(-1, 1); } s.drawImage(fg, 0, 0);
    const subj = d.flip ? sc.toDataURL('image/png') : ART.subj[d.subj];
    const cv = newCanvas(), ctx = cv.getContext('2d'); ctx.drawImage(bg, 0, 0); ctx.drawImage(sc, 0, 0);
    return { scene: ART.bg[d.bg], subj, art: cv.toDataURL('image/jpeg', .9) };
  })());
  const parts = await COMPOSITE.get(key);
  return { w: 600, h: 840, dup: 1, albums: 1, fav: false, tags: [], credit: 'NoOne', ...d, ...parts };
}
function dispose(el) { cards.delete(el); ro.unobserve(el); }
function packArt() { boot(); return ART.star; }
window.LKCards = { RM, TIERS, TI, PREMIUM, ATTR, makeAsset, makeCard, setTier, dispose, applyPose, clearPose, packArt, hexA, variants: BACKGROUNDS.variants };
})();
