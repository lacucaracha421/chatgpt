/* Mockup data and render helpers shared by index.html (PC) and tablet.html.
   Not app code: the real implementation follows README.md (shared SimilarityClues piece + clueText.ts). */
(function () {
  const L = '<svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M15.75 19.5 8.25 12l7.5-7.5"/></svg>';
  const R = '<svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>';

  // side: 0 = A / 기존 이미지, 1 = B / 새 이미지. clue value: 0 | 1 | null (tie or cannot compare).
  const CASES = {
    a: {
      key: 'a', short: '작가 vs 알 수 없음', title: '(a) 작가 계정 vs 알 수 없는 계정 — 작가 쪽이 늦게 올라왔지만 더 큼',
      incoming: true,
      sides: [
        { account: '@kuroba_rin_', role: 'unknown', posted: '2026-06-02T19:40', w: 1200, h: 1697, bytes: 812e3, format: 'JPEG', art: { hue: 212, crop: true } },
        { account: '@shiro_neko_art', role: 'artist', posted: '2026-06-03T21:05', w: 2480, h: 3508, bytes: 4.9e6, format: 'PNG', art: { hue: 212 } },
      ],
      clues: { account: 1, posted: 0, resolution: 1, bytes: 1 }, reason: 'account',
    },
    b: {
      key: 'b', short: '퍼온 계정 둘', title: '(b) 퍼온 계정 둘 — 먼저 올라온 쪽이 더 작음',
      sides: [
        { account: '@anime_art_daily', role: 'reposter', posted: '2026-09-14T08:12', w: 1920, h: 2716, bytes: 1.46e6, format: 'JPEG', art: { hue: 330, mark: 'anime_art_daily' } },
        { account: '@wallpaper_hub_', role: 'reposter', posted: '2026-09-12T23:47', w: 1280, h: 1810, bytes: 706e3, format: 'JPEG', art: { hue: 330, mark: 'wallpaper hub', crop: true } },
      ],
      clues: { account: null, posted: 1, resolution: 0, bytes: 0 }, reason: 'posted',
    },
    c: {
      key: 'c', short: '계정 정보 없음', title: '(c) 계정 정보 없음 (pixiv · arca) — 해상도만 다름',
      sides: [
        { account: null, host: 'pixiv.net', role: 'unknown', posted: null, w: 1000, h: 1414, bytes: 553e3, format: 'JPEG', art: { hue: 28 } },
        { account: null, host: 'arca.live', role: 'unknown', posted: null, w: 2000, h: 2828, bytes: 2.41e6, format: 'JPEG', art: { hue: 28 } },
      ],
      clues: { account: null, posted: null, resolution: 1, bytes: 1 }, reason: 'resolution',
    },
    d: {
      key: 'd', short: '같은 계정', title: '(d) 같은 작가 계정 — 나중 게시가 고해상도 재업로드',
      sides: [
        { account: '@shiro_neko_art', role: 'artist', posted: '2025-08-14T21:03', w: 1447, h: 2047, bytes: 1.84e6, format: 'PNG', art: { hue: 160 } },
        { account: '@shiro_neko_art', role: 'artist', posted: '2025-09-02T18:30', w: 2894, h: 4094, bytes: 6.4e6, format: 'PNG', art: { hue: 160 } },
      ],
      clues: { account: null, posted: 0, resolution: 1, bytes: 1 }, reason: 'posted',
      // Open question 2: for the same account, skip post time and let resolution decide.
      alt: { reason: 'resolution', sameAccount: true },
    },
    e: {
      key: 'e', short: '권장 없음', title: '(e) 단서가 같거나 없음 — 권장 없음',
      sides: [
        { account: null, host: 'dcinside.com', role: 'unknown', posted: null, w: 1600, h: 2263, bytes: 1.241e6, format: 'JPEG', art: { hue: 260 } },
        { account: null, host: 'arca.live', role: 'unknown', posted: null, w: 1600, h: 2263, bytes: 1.234e6, format: 'JPEG', art: { hue: 260, crop: true } },
      ],
      clues: { account: null, posted: null, resolution: null, bytes: null }, reason: null,
    },
  };

  const ROLE = { artist: '작가', reposter: '퍼온 계정', unknown: '알 수 없음' };
  const ROWS = [['account', '계정'], ['posted', '게시'], ['resolution', '해상도'], ['bytes', '크기']];
  const NOW = new Date('2026-10-17T12:00');

  const n = (v) => v.toLocaleString('en-US');
  function bytes(v) { const u = ['B', 'KB', 'MB', 'GB']; let a = v, i = 0; while (a >= 1024 && i < 3) { a /= 1024; i++; } return `${i ? a.toFixed(a >= 100 ? 0 : 1) : a} ${u[i]}`; }
  function when(s) {
    if (!s) return null;
    const d = new Date(s), t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${d.getFullYear() === NOW.getFullYear() ? '' : d.getFullYear() + '.'}${d.getMonth() + 1}.${d.getDate()} ${t}`;
  }

  /** Effective clue set, honouring the case-(d) rule switch. */
  function resolved(c, alt) {
    if (alt && c.alt) return { ...c, reason: c.alt.reason, sameAccount: true };
    return c;
  }
  const recSide = (c) => (c.reason ? c.clues[c.reason] : null);

  function names(c, client) {
    if (client === 'pc' && c.incoming) return ['기존 이미지', '새 이미지'];
    return ['A', 'B'];
  }

  /** The one-sentence reason (README §3). */
  function reasonText(c, nm) {
    const side = recSide(c);
    if (side === null || side === undefined) return '단서가 같거나 없어 권장하지 않습니다.';
    const who = nm[side];
    switch (c.reason) {
      case 'account':
        return c.sides[side].role === 'artist' ? `작가 계정에 올라온 ${who}를 권장합니다.` : `퍼온 계정이 아닌 ${who}를 권장합니다.`;
      case 'posted': return `먼저 올라온 ${who}를 권장합니다.`;
      case 'resolution': return c.sameAccount ? `같은 계정이라 해상도가 더 큰 ${who}를 권장합니다.` : `해상도가 더 큰 ${who}를 권장합니다.`;
      case 'bytes': return `파일이 더 큰 ${who}를 권장합니다.`;
    }
    return '';
  }

  function cell(c, key, i) {
    const s = c.sides[i];
    if (key === 'account') {
      const value = s.account ? `<span class="clue-handle">${s.account}</span>` : `<span class="clue-host">${s.host || '—'}</span>`;
      return `${value}<span class="ui-badge">${ROLE[s.role]}</span>`;
    }
    if (key === 'posted') { const w = when(s.posted); return w ? `<span class="numeric">${w}</span>` : '<span class="clue-none">—</span>'; }
    if (key === 'resolution') return `<span class="numeric">${n(s.w)} × ${n(s.h)}</span>`;
    return `<span class="numeric">${bytes(s.bytes)}</span><span class="clue-format">${s.format}</span>`;
  }

  /** NEW shared piece: the clue comparison (README §2). */
  function clueTable(c, nm) {
    const rec = recSide(c);
    const head = [0, 1].map((i) => `<th scope="col" class="clue-side clue-side--${i ? 'b' : 'a'}"><span class="clue-name">${nm[i]}</span>${rec === i ? '<span class="ui-badge">권장</span>' : ''}</th>`);
    const rows = ROWS.map(([key, label]) => {
      const fav = c.clues[key];
      const deciding = c.reason === key;
      const sr = fav === null || fav === undefined ? '' : `<span class="sr"> · ${nm[fav]} 쪽</span>`;
      const td = (i) => `<td class="clue-value clue-value--${i ? 'b' : 'a'}"${fav === i ? ' data-favoured' : fav === null || fav === undefined ? '' : ' data-other'}>${cell(c, key, i)}</td>`;
      return `<tr${deciding ? ' data-deciding' : ''}>${td(0)}<th scope="row" class="clue-label"><span class="clue-mark">${fav === 0 ? L : ''}</span><span>${label}${sr}</span><span class="clue-mark">${fav === 1 ? R : ''}</span></th>${td(1)}</tr>`;
    }).join('');
    return `<table class="similarity-clues"><caption class="sr">단서 비교</caption><thead><tr>${head[0]}<th aria-hidden="true"></th>${head[1]}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  function choices(c, client) {
    if (client === 'pc' && c.incoming) return [['keep_existing', '기존 이미지 유지'], ['replace_existing', '새 이미지로 교체'], ['keep_both', '둘 다 보관']];
    return [['keep_existing', 'A 유지 · B 휴지통'], ['replace_existing', 'B 유지 · A 휴지통'], ['keep_both', '둘 다 보관']];
  }

  function buttons(c, client) {
    const rec = recSide(c);
    const recDecision = rec === 0 ? 'keep_existing' : rec === 1 ? 'replace_existing' : null;
    return choices(c, client).map(([d, label]) => {
      const primary = d === recDecision;
      return `<button type="button" class="ui-button ui-button--${primary ? 'primary' : 'secondary'} ui-button--md"${primary ? ' aria-description="권장"' : ''}>${label}</button>`;
    }).join('');
  }

  /** Stand-in artwork: one composition per case; reposts carry a corner watermark, `crop` trims the edges. */
  function art(a, w, h) {
    const vb = a.crop ? '10 14 280 396' : '0 0 300 424';
    const H = a.hue;
    const mark = a.mark ? `<text x="${a.crop ? 282 : 290}" y="${a.crop ? 400 : 414}" text-anchor="end" font-size="11" font-family="sans-serif" fill="#fff" fill-opacity=".55">${a.mark}</text>` : '';
    return `<svg class="art" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${w} × ${h} 이미지">
      <defs><linearGradient id="g${H}${a.crop ? 'c' : ''}${a.mark ? 'm' : ''}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${H} 32% 30%)"/><stop offset="1" stop-color="hsl(${H + 30} 26% 12%)"/></linearGradient></defs>
      <rect width="300" height="424" fill="url(#g${H}${a.crop ? 'c' : ''}${a.mark ? 'm' : ''})"/>
      <circle cx="206" cy="112" r="54" fill="hsl(${H + 180} 40% 82%)" fill-opacity=".85"/>
      <path d="M0 300 Q 80 240 160 286 T 300 262 V424 H0Z" fill="hsl(${H} 24% 18%)"/>
      <path d="M0 344 Q 110 300 200 340 T 300 330 V424 H0Z" fill="hsl(${H + 20} 20% 10%)"/>
      <path d="M118 340 C 112 270 128 214 150 196 C 172 214 188 270 182 340 Z" fill="hsl(${H + 200} 30% 70%)" fill-opacity=".9"/>
      <circle cx="150" cy="178" r="22" fill="hsl(${H + 200} 30% 76%)"/>
      <path d="M128 172 Q 150 132 174 170 Q 186 214 170 236 Q 168 196 150 190 Q 132 196 130 236 Q 114 214 128 172Z" fill="hsl(${H + 160} 30% 22%)"/>
      ${mark}</svg>`;
  }

  window.SIM = { CASES, ROLE, resolved, recSide, names, reasonText, clueTable, buttons, art };
})();
