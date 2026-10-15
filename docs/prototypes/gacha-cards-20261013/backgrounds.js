/* Static, artwork-first Canvas2D backgrounds. No assets or animation required. */
(() => {
  'use strict';

  const W = 600, H = 840;
  const variants = [
    { key: 'digital', label: '디지털 격자' },
    { key: 'ribbon', label: '사선 리본' },
    { key: 'ornament', label: '문양과 꽃잎' },
    { key: 'aurora', label: '오로라와 별자리' },
  ];
  const tiers = { n: 0, r: 1, sr: 2, ssr: 3, ur: 4, lr: 5 };
  const seeds = { digital: 104729, ribbon: 130363, ornament: 155921, aurora: 196613 };
  const cache = new Map();

  function random(seed) {
    return () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  function normalizeTint(tint) {
    if (typeof tint !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(tint)) {
      throw new TypeError('CardBackgrounds tint must be a #RGB or #RRGGBB hex color');
    }
    const hex = tint.slice(1).toLowerCase();
    return '#' + (hex.length === 3 ? [...hex].map(c => c + c).join('') : hex);
  }

  function mix(a, b, amount) {
    const aa = parseInt(a.slice(1), 16), bb = parseInt(b.slice(1), 16);
    const channels = [16, 8, 0].map(shift => {
      const x = (aa >>> shift) & 255, y = (bb >>> shift) & 255;
      return Math.round(x + (y - x) * amount);
    });
    return '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('');
  }

  function canvas() {
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    return cv;
  }

  function linear(c, x0, y0, x1, y1, stops) {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([position, color]) => g.addColorStop(position, color));
    return g;
  }

  function polygon(c, points) {
    c.beginPath();
    points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
    c.closePath();
  }

  function digital(c, R, p) {
    // Plates and circuit routes stay anchored across every tier and tint.
    for (let i = 0; i < 14; i++) {
      const right = i % 2 === 1;
      const x = right ? 445 + R() * 110 : -65 + R() * 155;
      const y = -40 + R() * 640, w = 48 + R() * 116, h = 45 + R() * 135;
      c.globalAlpha = .10 + R() * .14;
      c.fillStyle = linear(c, x, y, x + w, y + h, [[0, p.light], [.45, p.tint], [1, p.dark]]);
      c.fillRect(x, y, w, h);
      c.globalAlpha = .20;
      c.strokeStyle = p.light;
      c.lineWidth = .8;
      c.strokeRect(x + 8, y - 9, w, h);
    }
    for (let i = 0; i < 23; i++) {
      const right = i % 2 === 1;
      const x = right ? 458 + R() * 116 : 14 + R() * 128;
      const y = 12 + R() * 575, endY = y + 35 + R() * 100;
      const dx = (right ? -1 : 1) * (16 + R() * 43);
      c.globalAlpha = .20 + R() * .18;
      c.strokeStyle = i % 4 ? p.light : p.accent;
      c.lineWidth = i % 5 ? .7 : 1.3;
      c.beginPath();
      c.moveTo(x, y); c.lineTo(x, y + 22);
      c.lineTo(x + dx, y + 22 + Math.abs(dx)); c.lineTo(x + dx, endY + Math.abs(dx));
      c.stroke();
      c.fillStyle = p.light;
      c.fillRect(x + dx - 2, endY + Math.abs(dx) - 2, 4, 4);
    }
    for (let i = 0; i < 25; i++) {
      const x = i % 2 ? 462 + R() * 130 : R() * 160;
      const y = R() * 710, size = 2 + R() * 7;
      c.globalAlpha = .14 + R() * .28;
      c.fillStyle = i % 3 ? p.light : p.accent;
      c.fillRect(x, y, size, size);
    }
  }

  function ribbon(c, R, p) {
    // Parallel swept bands, with no shared radial origin.
    for (let i = 0; i < 5; i++) {
      const y = -285 + i * 188 + R() * 24, width = 54 + R() * 48;
      c.beginPath();
      c.moveTo(-110, y + 245);
      c.bezierCurveTo(125, y + 142, 355, y + 38, 710, y - 130);
      c.lineTo(710, y - 130 + width);
      c.bezierCurveTo(350, y + 45 + width, 115, y + 150 + width, -110, y + 245 + width);
      c.closePath();
      c.fillStyle = linear(c, 0, y + 240, 280, y + 75, [
        [0, p.dark], [.28, p.tint], [.47, p.light], [.53, p.tint], [.80, p.accent], [1, p.dark],
      ]);
      c.globalAlpha = .32;
      c.fill();
      c.globalAlpha = .42;
      c.strokeStyle = p.light;
      c.lineWidth = .9;
      c.beginPath();
      c.moveTo(-110, y + 245);
      c.bezierCurveTo(125, y + 142, 355, y + 38, 710, y - 130);
      c.stroke();
    }
    for (let i = 0; i < 16; i++) {
      const x = i % 2 ? 475 + R() * 135 : -20 + R() * 155;
      const y = 20 + R() * 615, size = 9 + R() * 26;
      polygon(c, [[x, y], [x + size * 1.5, y - size * .55], [x + size, y + size], [x - size * .4, y + size * 1.2]]);
      c.globalAlpha = .12 + R() * .16;
      c.fillStyle = linear(c, x, y, x + size, y + size, [[0, p.light], [.45, p.tint], [1, p.dark]]);
      c.fill();
    }
  }

  function ornament(c, R, p) {
    // The medallion extends beyond the left edge and recedes behind the face.
    const cx = 38, cy = 297;
    c.strokeStyle = p.light;
    for (const radius of [176, 187, 213, 239, 245]) {
      c.globalAlpha = radius === 213 ? .28 : .20;
      c.lineWidth = radius === 213 ? 2 : .8;
      c.beginPath(); c.arc(cx, cy, radius, -.92, Math.PI * 1.65); c.stroke();
    }
    for (let i = 0; i < 24; i++) {
      const angle = i * Math.PI / 12;
      c.save(); c.translate(cx, cy); c.rotate(angle);
      c.globalAlpha = .30;
      c.lineWidth = .85;
      c.beginPath();
      c.moveTo(170, 0);
      c.bezierCurveTo(198, -32, 235, -22, 223, 0);
      c.bezierCurveTo(235, 22, 198, 32, 170, 0);
      c.moveTo(187, 0); c.quadraticCurveTo(221, -14, 233, 0);
      c.stroke();
      c.globalAlpha = .26; c.fillStyle = p.accent;
      polygon(c, [[239, 0], [245, -4], [251, 0], [245, 4]]); c.fill();
      c.restore();
    }
    // Loose ornamental arcs on the opposite side, not a card frame.
    c.globalAlpha = .18; c.strokeStyle = p.accent; c.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      c.beginPath(); c.arc(622, 75, 67 + i * 25, .25, 2.65); c.stroke();
    }
    for (let i = 0; i < 18; i++) {
      const x = i % 2 ? 468 + R() * 140 : -12 + R() * 145;
      const y = 15 + R() * 670, size = 8 + R() * 15;
      c.save(); c.translate(x, y); c.rotate(R() * Math.PI);
      c.beginPath(); c.moveTo(0, -size);
      c.bezierCurveTo(size, -size * .2, size * .55, size * .8, 0, size);
      c.bezierCurveTo(-size * .6, size * .5, -size * .6, -size * .6, 0, -size);
      c.fillStyle = linear(c, 0, -size, 0, size, [[0, p.light], [1, p.tint]]);
      c.globalAlpha = .21 + R() * .13; c.fill();
      c.restore();
    }
  }

  function aurora(c, R, p) {
    const colors = [p.tint, mix(p.tint, '#80d6ce', .48), mix(p.tint, '#bca7ed', .44)];
    for (let i = 0; i < 4; i++) {
      const x = -110 + i * 180, bend = R() * 45;
      c.beginPath(); c.moveTo(x, -90);
      c.bezierCurveTo(x + 245, 65, x - 130 - bend, 313, x + 110, 566);
      c.bezierCurveTo(x + 140, 630, x + 240, 690, x + 270, 750);
      c.lineTo(x + 360, 750);
      c.bezierCurveTo(x + 315, 628, x + 185, 580, x + 175, 520);
      c.bezierCurveTo(x - 20, 300, x + 335, 80, x + 110, -90);
      c.closePath();
      c.globalAlpha = .34;
      c.fillStyle = linear(c, x, 60, x + 225, 430, [
        [0, colors[i % 3]], [.37, p.light], [.51, colors[(i + 1) % 3]], [1, p.dark],
      ]);
      c.fill();
    }
    const stars = [];
    for (let i = 0; i < 33; i++) {
      stars.push({ x: i % 2 ? 454 + R() * 132 : 14 + R() * 156, y: 18 + R() * 590, size: .7 + R() * 1.5 });
    }
    c.lineWidth = .65; c.strokeStyle = p.light; c.globalAlpha = .20;
    for (const chain of [[0, 4, 8, 12], [3, 7, 11], [18, 22, 26], [21, 25, 29]]) {
      c.beginPath();
      chain.forEach((index, i) => {
        const s = stars[index];
        if (i) c.lineTo(s.x, s.y); else c.moveTo(s.x, s.y);
      });
      c.stroke();
    }
    stars.forEach((s, i) => {
      c.globalAlpha = .38 + s.size * .12;
      c.fillStyle = i % 5 ? p.light : p.accent;
      c.beginPath(); c.arc(s.x, s.y, s.size, 0, Math.PI * 2); c.fill();
      if (i % 9 === 0) {
        c.globalAlpha = .34; c.strokeStyle = p.light; c.lineWidth = .7;
        c.beginPath(); c.moveTo(s.x - 5, s.y); c.lineTo(s.x + 5, s.y);
        c.moveTo(s.x, s.y - 5); c.lineTo(s.x, s.y + 5); c.stroke();
      }
    });
  }

  const painters = { digital, ribbon, ornament, aurora };

  function render(key, tier, tint) {
    if (!Object.prototype.hasOwnProperty.call(painters, key)) {
      throw new RangeError('Unknown CardBackgrounds variant: ' + key);
    }
    if (!Object.prototype.hasOwnProperty.call(tiers, tier)) {
      throw new RangeError('Unknown CardBackgrounds tier: ' + tier);
    }
    tint = normalizeTint(tint);
    const cacheKey = key + ':' + tier + ':' + tint;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const rank = tiers[tier], strength = [.30, .42, .55, .69, .84, 1][rank];
    const p = {
      tint,
      dark: mix(tint, '#171722', .78),
      light: mix(tint, '#fff6e9', .66 + rank * .035),
      accent: mix(tint, rank >= 4 ? '#efcf94' : '#c5bddb', .35 + rank * .045),
    };
    const cv = canvas(), c = cv.getContext('2d');
    if (!c) throw new Error('Canvas2D is unavailable');
    c.fillStyle = linear(c, 0, 0, W, H, [
      [0, mix(p.dark, tint, .15 + rank * .012)],
      [.46, p.dark], [1, mix(p.dark, '#11131c', .36)],
    ]);
    c.fillRect(0, 0, W, H);

    const detail = canvas(), d = detail.getContext('2d');
    if (!d) throw new Error('Canvas2D is unavailable');
    painters[key](d, random(seeds[key]), p);
    d.globalAlpha = 1;
    d.globalCompositeOperation = 'destination-out';
    // Smooth attenuation protects the entire specified face rectangle.
    d.save(); d.translate(315, 210); d.scale(195, 215);
    const face = d.createRadialGradient(0, 0, 0, 0, 0, 1);
    face.addColorStop(0, 'rgba(0,0,0,.97)');
    face.addColorStop(.80, 'rgba(0,0,0,.95)');
    face.addColorStop(1, 'rgba(0,0,0,0)');
    d.fillStyle = face; d.fillRect(-1, -1, 2, 2); d.restore();
    d.fillStyle = linear(d, 0, 505, 0, 840, [
      [0, 'rgba(0,0,0,0)'], [.195, 'rgba(0,0,0,.88)'],
      [.45, 'rgba(0,0,0,.95)'], [1, 'rgba(0,0,0,.98)'],
    ]);
    d.fillRect(0, 505, W, 335);
    c.globalAlpha = strength;
    c.drawImage(detail, 0, 0);
    c.globalAlpha = 1;
    const url = cv.toDataURL('image/jpeg', .92);
    cache.set(cacheKey, url);
    return url;
  }

  window.CardBackgrounds = { variants, render };
})();
