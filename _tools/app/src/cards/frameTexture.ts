const newCanvas = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const P = (c: CanvasRenderingContext2D, pts: number[][]) => { c.beginPath(); pts.forEach(([x,y],i) => i ? c.lineTo(x,y) : c.moveTo(x,y)); c.closePath(); };
// Printed N/R borders from the approved card skeleton.
const FT: Partial<Record<"n" | "r", string>> = {};
function seeded(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function rrPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
export function frameTexture(k: "n" | "r") {
  if (FT[k]) return FT[k];
  const FW = 800, FH = 1117, u = FW / 100, cv = newCanvas(FW, FH), c = cv.getContext('2d')!, R = seeded(k.length * 131 + 17);
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
  const n = newCanvas(128, 128), nc = n.getContext('2d')!, id = nc.createImageData(128, 128);
  for (let i = 0; i < id.data.length; i += 4) { const v = R() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
  nc.putImageData(id, 0, 0); c.globalAlpha = M.grain; c.globalCompositeOperation = 'overlay'; c.fillStyle = c.createPattern(n, 'repeat')!; c.fillRect(0, 0, FW, FH);
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  c.restore();
  const eng = (path: () => void, lw: number, fill = false) => {
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
  const corner = (x: number, y: number, sx: number, sy: number, s: number) => { const tr = (f: () => void) => () => { c.translate(x, y); c.scale(sx * s, sy * s); f(); };
    eng(tr(() => { c.beginPath(); c.arc(0, 0, 4.2 * u, 0, Math.PI / 2); }), .2 * u / s);
    eng(tr(() => { c.beginPath(); c.moveTo(1.9 * u, .7 * u); c.lineTo(3.1 * u, 1.9 * u); c.lineTo(1.9 * u, 3.1 * u); c.lineTo(.7 * u, 1.9 * u); c.closePath(); }), 0, true);
    eng(tr(() => { c.beginPath(); c.arc(4.2 * u, 0, .45 * u, 0, 7); c.moveTo(.45 * u, 4.2 * u); c.arc(0, 4.2 * u, .45 * u, 0, 7); }), 0, true); };
  const by = FH - B + .2 * u;
  c.save(); corner(B + .2 * u, by, 1, -1, .62); c.restore(); c.save(); corner(FW - B - .2 * u, by, -1, -1, .62); c.restore();
  [[B / 2 + E / 2, B / 2 + E / 2], [FW - B / 2 - E / 2, B / 2 + E / 2]].forEach(([x, y]) => eng(() => P(c, [[x, y - .8 * u], [x + .8 * u, y], [x, y + .8 * u], [x - .8 * u, y]]), 0, true));
  return FT[k] = cv.toDataURL('image/jpeg', .92);
}


