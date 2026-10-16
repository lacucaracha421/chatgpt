// Procedural sample images (no private art). Each returns { svg, w, h, lines },
// where lines carry the image text positions (in %) used by the translation markers.
(() => {
  "use strict";
  const JP = "'Yu Gothic','YuGothic','Meiryo','Hiragino Sans','Noto Sans JP',sans-serif";
  let uid = 0;

  function manga() {
    const id = `m${uid++}`;
    const svg = `<svg viewBox="0 0 300 420" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
<defs>
<pattern id="${id}d" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.25" fill="#9a9a9a"/></pattern>
<pattern id="${id}h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(40)"><line x1="0" y1="0" x2="0" y2="5" stroke="#c4c4c4" stroke-width="1.6"/></pattern>
<clipPath id="${id}c"><rect x="155" y="170" width="135" height="240"/></clipPath>
</defs>
<rect width="300" height="420" fill="#f4f2ec"/>
<g fill="#fff" stroke="#111" stroke-width="3"><rect x="10" y="10" width="280" height="150"/><rect x="10" y="170" width="135" height="240"/><rect x="155" y="170" width="135" height="240"/></g>
<rect x="11.5" y="112" width="277" height="46.5" fill="url(#${id}d)"/>
<g stroke="#111" stroke-width="2.4" stroke-linejoin="round">
<path d="M170 158 Q176 118 204 112 Q232 118 238 158 Z" fill="#fff"/>
<circle cx="204" cy="82" r="26" fill="#fff"/>
<path d="M176 80 Q178 50 204 52 Q232 50 234 82 Q226 66 214 70 Q204 60 196 70 Q186 64 176 80 Z" fill="#222"/>
</g>
<circle cx="196" cy="86" r="2.6" fill="#111"/><circle cx="214" cy="86" r="2.6" fill="#111"/>
<ellipse cx="86" cy="58" rx="66" ry="31" fill="#fff" stroke="#111" stroke-width="2"/>
<path d="M126 80 L150 96 L118 86 Z" fill="#fff" stroke="#111" stroke-width="2" stroke-linejoin="round"/>
<text x="86" y="63" text-anchor="middle" font-family="${JP}" font-size="14" font-weight="700" fill="#111">ちょっと待って!</text>
<rect x="11.5" y="171.5" width="132" height="92" fill="url(#${id}h)"/>
<g stroke="#111" stroke-width="2.4"><path d="M38 408 Q46 340 80 334 Q114 340 122 408 Z" fill="#fff"/><circle cx="80" cy="304" r="24" fill="#fff"/><path d="M56 300 Q60 272 80 274 Q102 272 104 300 Q96 288 80 292 Q66 288 56 300 Z" fill="#333"/></g>
<path d="M70 312 Q80 318 90 312" fill="none" stroke="#111" stroke-width="2"/>
<ellipse cx="78" cy="216" rx="58" ry="28" fill="#fff" stroke="#111" stroke-width="2"/>
<text x="78" y="221" text-anchor="middle" font-family="${JP}" font-size="12.5" font-weight="700" fill="#111">なんでここに…?</text>
<g clip-path="url(#${id}c)" stroke="#111" stroke-width="1.2" opacity=".55">${Array.from({ length: 22 }, (_, i) => { const a = i / 22 * Math.PI * 2; return `<line x1="${222 + Math.cos(a) * 46}" y1="${300 + Math.sin(a) * 46}" x2="${222 + Math.cos(a) * 190}" y2="${300 + Math.sin(a) * 190}"/>`; }).join("")}</g>
<ellipse cx="222" cy="246" rx="58" ry="26" fill="#fff" stroke="#111" stroke-width="2"/>
<text x="222" y="251" text-anchor="middle" font-family="${JP}" font-size="12.5" font-weight="700" fill="#111">約束したでしょ</text>
<text x="226" y="372" text-anchor="middle" font-family="${JP}" font-size="34" font-weight="900" fill="#111" stroke="#fff" stroke-width="5" paint-order="stroke" transform="rotate(-8 226 372)">ドキッ</text>
</svg>`;
    return { svg, w: 300, h: 420, lines: [
      { x: 86 / 3, y: 58 / 4.2, korean: "잠깐만!", original: "ちょっと待って!" },
      { x: 78 / 3, y: 216 / 4.2, korean: "왜 여기에…?", original: "なんでここに…?" },
      { x: 222 / 3, y: 246 / 4.2, korean: "약속했잖아", original: "約束したでしょ" },
      { x: 226 / 3, y: 362 / 4.2, korean: "두근", original: "ドキッ" },
    ] };
  }

  function night() {
    const id = `n${uid++}`;
    let windows = "";
    const blocks = [[0, 150, 70], [64, 120, 60], [118, 175, 56], [170, 100, 70], [236, 140, 64]];
    for (const [x, top, width] of blocks) {
      windows += `<rect x="${x}" y="${top}" width="${width}" height="${420 - top}" fill="#0a0d1c"/>`;
      for (let row = top + 12; row < 400; row += 18) for (let col = x + 8; col < x + width - 8; col += 14) {
        if ((row * 7 + col * 3) % 5 < 2) windows += `<rect x="${col}" y="${row}" width="6" height="8" fill="#f2c96b" opacity=".75"/>`;
      }
    }
    const svg = `<svg viewBox="0 0 300 420" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
<defs><linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#070a18"/><stop offset=".7" stop-color="#1b2350"/><stop offset="1" stop-color="#2c2a55"/></linearGradient>
<radialGradient id="${id}m"><stop offset="0" stop-color="#fff8e0"/><stop offset=".6" stop-color="#f3e7c2"/><stop offset="1" stop-color="#f3e7c2" stop-opacity="0"/></radialGradient></defs>
<rect width="300" height="420" fill="url(#${id}s)"/>
<circle cx="226" cy="64" r="34" fill="url(#${id}m)"/>
${windows}
<rect x="40" y="230" width="104" height="40" rx="3" fill="#120b1a" stroke="#ff4f8b" stroke-width="2.5"/>
<text x="92" y="258" text-anchor="middle" font-family="${JP}" font-size="20" font-weight="800" fill="#ffd1e3" stroke="#ff4f8b" stroke-width=".8">営業中</text>
<rect x="196" y="300" width="70" height="26" rx="2" fill="#0f1830" stroke="#53d6ff" stroke-width="2"/>
<text x="231" y="318" text-anchor="middle" font-family="${JP}" font-size="13" font-weight="700" fill="#c9f3ff">ラーメン</text>
</svg>`;
    return { svg, w: 300, h: 420, lines: [
      { x: 92 / 3, y: 250 / 4.2, korean: "영업 중", original: "営業中" },
      { x: 231 / 3, y: 313 / 4.2, korean: "라멘", original: "ラーメン" },
    ] };
  }

  function sky() {
    const id = `s${uid++}`;
    const cloud = (x, y, s) => `<g fill="#fff" transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="0" rx="46" ry="22"/><ellipse cx="-30" cy="8" rx="30" ry="18"/><ellipse cx="34" cy="10" rx="34" ry="18"/><ellipse cx="6" cy="-14" rx="28" ry="20"/></g>`;
    const svg = `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
<defs><linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8cc8f2"/><stop offset="1" stop-color="#e4f3fd"/></linearGradient></defs>
<rect width="300" height="300" fill="url(#${id}g)"/>${cloud(70, 70, .9)}${cloud(220, 140, 1.1)}${cloud(250, 270, 1.6)}${cloud(90, 250, 1.3)}
</svg>`;
    return { svg, w: 300, h: 300, lines: [] };
  }

  function bright() {
    const id = `b${uid++}`;
    const svg = `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
<defs>
<radialGradient id="${id}a" cx=".2" cy=".25" r=".7"><stop offset="0" stop-color="#ff6aa8"/><stop offset="1" stop-color="#ff6aa8" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}b" cx=".85" cy=".85" r=".6"><stop offset="0" stop-color="#ffe14d"/><stop offset="1" stop-color="#ffe14d" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}c" cx=".8" cy=".2" r=".6"><stop offset="0" stop-color="#43d6c5"/><stop offset="1" stop-color="#43d6c5" stop-opacity="0"/></radialGradient>
</defs>
<rect width="300" height="300" fill="#7b5cff"/><rect width="300" height="300" fill="url(#${id}c)"/><rect width="300" height="300" fill="url(#${id}a)"/><rect width="300" height="300" fill="url(#${id}b)"/>
<polygon points="150,70 166,120 218,104 184,144 226,178 172,176 170,230 146,186 104,214 124,166 76,150 128,134 106,88 146,114" fill="#fff" stroke="#222" stroke-width="3" stroke-linejoin="round"/>
<text x="152" y="160" text-anchor="middle" font-family="${JP}" font-size="26" font-weight="900" fill="#e8304f">新作!</text>
</svg>`;
    return { svg, w: 300, h: 300, lines: [{ x: 50.6, y: 50, korean: "신작!", original: "新作!" }] };
  }

  function grey() {
    const svg = `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
<rect width="300" height="300" fill="#8b8e92"/>${Array.from({ length: 16 }, (_, i) => `<rect x="${i * 20}" y="0" width="10" height="300" fill="#7d8084"/>`).join("")}
<rect x="60" y="80" width="180" height="140" fill="#a9acb0"/><circle cx="150" cy="150" r="40" fill="#6c6f73"/>
</svg>`;
    return { svg, w: 300, h: 300, lines: [] };
  }

  globalThis.MockArt = { manga, night, sky, bright, grey };
})();
