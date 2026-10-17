/* AV cover dialog mockup: stand-in data in the shapes of AvLinkCandidate (PC) / InboxDetail (tablet),
   the CURRENT dialog markup (before, copied from AvLinkChooserDialog.tsx / AvInboxChooser.tsx with the
   app's class names) and the PROPOSED markup (after, classes in avcover.css). No app code runs here. */
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n = (v) => Number(v).toLocaleString('en-US');

  /* ---------- Icons (Heroicons outline paths) ---------- */
  const P = {
    x: 'M6 18 18 6M6 6l12 12',
    out: 'M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25',
    right: 'm8.25 4.5 7.5 7.5-7.5 7.5',
    down: 'm19.5 8.25-7.5 7.5-7.5-7.5',
    up: 'm4.5 15.75 7.5-7.5 7.5 7.5',
    undo: 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3',
    warn: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
    plus: 'M12 4.5v15m7.5-7.5h-15',
    search: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
    check: 'm4.5 12.75 6 6 9-13.5',
  };
  const icon = (k, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[k]}"/></svg>`;

  /* ---------- Genre names (proposal: one fixed table, src/collections/avGenreNames.ts) ---------- */
  const GENRE_KO = {
    '単体作品': '단독 출연작', 'ハメ撮り': 'POV 섹스', '美乳': '예쁜 가슴', '巨乳': '큰 가슴', '淫乱・ハード系': '음란·하드',
    '3P・4P': '3P·4P', '中出し': '질내사정', 'フェラ': '펠라치오', '騎乗位': '기승위', '潮吹き': '분수', 'ドラマ': '드라마',
    '美少女': '미소녀', '人妻・主婦': '유부녀·주부', 'スレンダー': '슬렌더', '痴女': '치녀', 'デビュー作品': '데뷔작',
    '寝取り・寝取られ・NTR': 'NTR', '水着': '수영복', '野外・露出': '야외·노출', '素人': '아마추어', '企画': '기획물',
  };
  /* Not genres: sale, event, sample and distribution tags are hidden (decision: quality tags). */
  const GENRE_HIDDEN = [/セール/, /[％%]オフ/, /感謝祭/, /キャンペーン/, /期間限定/, /ポイント(還元|\d)/, /^サンプル動画$/, /^独占配信$/, /^配信専用$/, /^ハイビジョン$/, /^4K$/];
  const genreShown = (g) => !GENRE_HIDDEN.some((re) => re.test(g));
  const genreKo = (g) => GENRE_KO[g] ?? g;

  /* ---------- Stand-in candidates ---------- */
  const people = {
    hiyori: { ja: '星野ひより', ko: '호시노 히요리', personId: 'p1' },
    yuna: { ja: '白石ゆな', ko: '시라이시 유나', personId: 'p2' },
    aoi: { ja: '森川あおい', ko: null, personId: null },
    kotone: { ja: '春野ことね', ko: '하루노 코토네', personId: null },
    miku: { ja: '綾瀬みく', ko: '아야세 미쿠', personId: 'p5', linked: true },
    rin: { ja: '早乙女りん', ko: null, personId: null },
  };
  const S = {
    a: {
      code: 'SONE-512', fetched: '21:45', jacket: { src: 'img/a-wrap.svg', w: 2184, h: 1468 },
      split: { x1: 1032, x2: 1152, isWrap: true, useSpine: true }, matches: [], current: null,
      fields: { title_ja: '雨の日、隣の部屋の彼女と過ごした三日間 星野ひより', release_date: '2026-09-12', maker: 'エスワン ナンバーワンスタイル', label: 'S1 NO.1 STYLE', series: null,
        genres: ['単体作品', '美乳', '巨乳', '中出し', '淫乱・ハード系', 'ハイビジョン', '独占配信', 'サンプル動画', 'KMPグループ大感謝祭40％オフセール'] },
      performers: [people.hiyori], directors: [{ ja: 'ザック荒井', ko: null, personId: null }],
    },
    b: {
      code: 'SNOS-130', fetched: '21:47', jacket: { src: 'img/b-wrap43.svg', w: 2184, h: 1638 },
      split: { x1: 1092, x2: 1092, isWrap: true, useSpine: true }, borrowed: { src: 'img/b-dvd.svg', w: 800, h: 438, x1: 382, x2: 418 },
      matches: [], current: null,
      fields: { title_ja: '出張先の相部屋で、憧れの先輩と朝まで 白石ゆな', release_date: '2026-10-07', maker: 'エスワン ナンバーワンスタイル', label: 'S1 NO.1 STYLE', series: '相部屋',
        genres: ['単体作品', 'ドラマ', 'スレンダー', 'ハメ撮り', '3P・4P', 'セール対象商品'] },
      performers: [people.yuna], directors: [{ ja: '苺原', ko: null, personId: null }],
    },
    c: {
      code: 'MIDV-032', fetched: '21:52', jacket: { src: 'img/c-wrap800.svg', w: 800, h: 538 },
      split: { x1: 378, x2: 422, isWrap: true, useSpine: true }, current: null,
      matches: [{ id: 'm1', name: 'MIDV-032', meta: '2022 · 표지 1면' }, { id: 'm2', name: 'MIDV-032 블루레이', meta: '2022 · 표지 3면' }],
      fields: { title_ja: '新人 専属デビュー 森川あおい', release_date: '2022-01-25', maker: 'ムーディーズ', label: 'MOODYZ DIVA', series: null,
        genres: ['単体作品', 'デビュー作品', '美少女', 'ギリモザ', 'サンプル動画'] },
      performers: [people.aoi], directors: [{ ja: '豆沢豆太郎', ko: null, personId: null }],
    },
    d: {
      code: 'FSDSS-701', fetched: '21:58', jacket: { src: 'img/d-front.svg', w: 800, h: 1135 },
      split: { x1: 0, x2: 0, isWrap: false, useSpine: false }, matches: [], current: null,
      fields: { title_ja: '終電を逃した夜、同期の部屋で 春野ことね', release_date: '2026-10-14', maker: 'FALENO', label: 'FALENOstar', series: null,
        genres: ['単体作品', '人妻・主婦', '騎乗位', 'ハイビジョン'] },
      performers: [people.kotone], directors: [],
    },
    e: {
      code: 'IPZZ-118', fetched: '22:03', jacket: { src: 'img/e-wrap.svg', w: 2184, h: 1468 },
      split: { x1: 1032, x2: 1152, isWrap: true, useSpine: true }, matches: [],
      current: { name: 'IPZZ-118', year: '2023', old: { src: 'img/e-old.svg', w: 800, h: 538, x1: 378, x2: 422 },
        fields: { title_ja: '週末だけの恋人 綾瀬みく', release_date: '2023-08-01', maker: 'アイデアポケット', label: null, series: null, genres: ['単体作品'] },
        people: [{ name: '아야세 미쿠', ja: '綾瀬みく', role: 'performer' }] },
      fields: { title_ja: '週末だけの恋人 綾瀬みく', release_date: '2023-08-11', maker: 'アイデアポケット', label: 'ティッシュ', series: '週末だけの恋人',
        genres: ['単体作品', '痴女', '騎乗位', 'フェラ', 'ハイビジョン', 'セール対象商品'] },
      performers: [people.miku, people.rin], directors: [{ ja: 'きとるね川口', ko: null, personId: null }],
    },
  };
  for (const [k, v] of Object.entries(S)) v.key = k;

  const surfacesOf = ['back', 'spine', 'front'];
  const LABEL = { front: '앞표지', spine: '책등', back: '뒤표지' };
  const SHORT = { front: '앞', spine: '옆', back: '뒤' };
  const borrowedSpine = (c) => c.split.isWrap && c.split.useSpine && c.split.x1 === c.split.x2;
  const pcSplit = (c) => {
    if (!c.split.isWrap) return { x1: 0, x2: 0 };
    const W = c.jacket.w; const first = Math.max(1, Math.min(W - 2, c.split.x1));
    return { x1: first, x2: Math.max(first + 1, Math.min(W - 1, c.split.x2)) };
  };
  const bounds = (s, sp, W) => s === 'back' ? { x: 0, w: sp.x1 } : s === 'spine' ? { x: sp.x1, w: sp.x2 - sp.x1 } : { x: sp.x2, w: W - sp.x2 };
  const oldBounds = (s, o) => s === 'back' ? { x: 0, w: o.x1 } : s === 'spine' ? { x: o.x1, w: o.x2 - o.x1 } : { x: o.x2, w: o.w - o.x2 };
  const hasCurrent = (c, s) => Boolean(c.current?.old);
  /* A crop of an image: the img is positioned inside an overflow box of the crop's aspect ratio. */
  const crop = (src, W, H, x, w, cls = 'av-crop', alt = '') => w < 1 ? '' :
    `<span class="${cls}" style="aspect-ratio:${w} / ${H}"><img src="${src}" alt="${esc(alt)}" draggable="false" style="position:absolute;top:0;height:100%;max-width:none;max-height:none;width:${(W / w) * 100}%;left:${(-x / w) * 100}%"></span>`;
  const dateText = (v) => { if (!v) return '—'; const [y, m, d] = v.split('-').map(Number); return y === 2026 ? `${m}.${d}` : `${y}.${m}.${d}`; };
  const fieldText = (k, v) => k === 'release_date' ? dateText(v) : (v || '—');

  function defaultSurfaces(c) {
    const isNew = !c.current;
    return Object.fromEntries(surfacesOf.map((s) => {
      const cur = hasCurrent(c, s);
      if (!c.split.isWrap && s !== 'front') return [s, cur ? 'keep' : 'clear'];
      if (s === 'spine' && !c.split.useSpine) return [s, cur ? 'keep' : 'clear'];
      return [s, isNew || !cur ? 'candidate' : 'keep'];
    }));
  }
  const FIELDS = [['title_ja', '원제'], ['release_date', '발매일'], ['maker', '제작사'], ['label', '레이블'], ['series', '시리즈']];
  const has = (v) => Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim().length > 0 : v != null;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  function defaultChecks(c) {
    const isNew = !c.current;
    return Object.fromEntries(FIELDS.map(([k]) => [k, has(c.fields[k]) && (isNew || !has(c.current.fields[k]))]));
  }

  /* =====================================================================
     BEFORE — the current AvLinkChooserDialog (PC)
     ===================================================================== */
  function before(c) {
    const isNew = !c.current; const W = c.jacket.w, H = c.jacket.h;
    const sp = pcSplit(c); const spinePct = ((sp.x2 - sp.x1) / W) * 100;
    const borrowed = borrowedSpine(c) && spinePct < 1;
    const warn = c.split.isWrap && !borrowed && (spinePct < 1 || spinePct > 12);
    const surf = defaultSurfaces(c); const checks = defaultChecks(c);
    const title = isNew ? '새 AV 컬렉션으로 만들기' : '후보 확인';
    const needsPick = isNew && c.matches.length > 1;
    const pct = (v) => `${(v / W) * 100}%`;
    const zone = (label, left, width, px) => `<span class="av-link-zone" style="left:${pct(left)};width:${pct(width)}"><b>${label}</b>${px !== undefined ? `<small class="numeric">${px}px</small>` : ''}</span>`;
    const heading = isNew
      ? (c.matches.length > 1
        ? `<div class="av-link-chooser__matches" role="group" aria-label="같은 품번의 컬렉션"><p>같은 품번의 컬렉션이 <b>${c.matches.length}</b>개 있어요. 후보를 넣을 곳을 고르세요.</p><span>${c.matches.map((m) => `<button class="ui-button ui-button--secondary ui-button--sm" type="button">${esc(m.name)}</button>`).join('')}<button class="ui-button ui-button--ghost ui-button--sm" type="button" aria-pressed="false">새 AV 컬렉션으로 만들기</button></span></div>`
        : `<p>이 품번과 맞는 AV 컬렉션이 없어요. <button type="button">기존 컬렉션에 연결…</button></p>`)
      : `<p>적용할 컬렉션 <b>${esc(c.current.name)}</b><span> · AV · <span class="numeric">${c.current.year}</span></span> <button type="button">다른 컬렉션 선택</button></p>`;
    const surfaces = surfacesOf.slice().reverse().map((s) => s).sort((a, b) => ['front', 'spine', 'back'].indexOf(a) - ['front', 'spine', 'back'].indexOf(b)).map((s) => {
      const b = bounds(s, sp, W); const isBorrowed = s === 'spine' && borrowed; const cur = hasCurrent(c, s);
      const curBox = cur ? (() => { const o = c.current.old; const ob = oldBounds(s, o); return `<div class="av-link-crop" style="--crop-image-width:${(o.w / ob.w) * 100}%;--crop-image-left:${(-ob.x / ob.w) * 100}%;aspect-ratio:${ob.w} / ${o.h}"><img src="${o.src}" alt="현재 표지"></div>`; })() : '<div><span>없음</span></div>';
      const choice = surf[s];
      let candBox;
      if (isBorrowed) candBox = `<div class="av-link-crop"><span>${choice === 'candidate' ? 'DVD 표지에서' : choice === 'keep' ? '지금 것 유지' : '비움'}</span></div>`;
      else if (b.w < 1) candBox = `<div class="av-link-crop"><span>후보 없음</span></div>`;
      else candBox = `<div class="av-link-crop" style="--crop-image-width:${(W / b.w) * 100}%;--crop-image-left:${(-b.x / b.w) * 100}%;aspect-ratio:${b.w} / ${H}"><img src="${c.jacket.src}" alt="후보 표지 자르기" draggable="false">${choice !== 'candidate' ? `<span>${choice === 'keep' ? '지금 것 유지' : '비움'}</span>` : ''}</div>`;
      const seg = [['candidate', '후보 사용'], ['keep', '유지'], ['clear', '비우기']].map(([v, t]) => `<button type="button" aria-pressed="${choice === v}"${(v === 'keep' && !cur) || (v === 'candidate' && b.w < 1) ? ' disabled' : ''}>${t}</button>`).join('');
      return `<section class="av-link-surface" aria-label="${LABEL[s]}"><h4>${LABEL[s]}${isBorrowed ? '<small>책등은 DVD 표지에서 가져옴</small>' : `<small class="numeric">${b.w} × ${H}</small>`}</h4>
        <div class="av-link-surface__pair"><div class="av-link-art-box">${curBox}<small>지금</small></div>${icon('right')}<div class="av-link-art-box">${candBox}<small>후보</small></div></div>
        <div class="av-link-segment" role="group" aria-label="${LABEL[s]} 선택">${seg}</div></section>`;
    }).join('');
    const diffRow = (k, label) => {
      const cur = c.current?.fields[k] ?? null; const next = c.fields[k] ?? null;
      const isSame = !isNew && has(cur) && same(cur, next); const diff = !isNew && has(cur) && has(next) && !isSame;
      return `<div class="av-link-diff__row${checks[k] ? '' : ' is-off'}" role="row"><input type="checkbox" aria-label="${label} 적용"${checks[k] ? ' checked' : ''}${!has(next) || isSame ? ' disabled' : ''}><b role="cell">${label}</b>${!isNew ? `<span class="av-link-diff__current" role="cell">${has(cur) ? esc(fieldText(k, cur)) : '<span class="av-link-dash">—</span>'}</span>` : ''}<span role="cell" class="av-link-diff__candidate">${has(next) ? esc(fieldText(k, next)) : '<span class="av-link-dash">—</span>'}${isSame ? '<em>같음</em>' : ''}${diff ? '<em class="is-different">다름</em>' : ''}</span></div>`;
    };
    const personRow = (label, list, role) => {
      const curText = !isNew ? (c.current.people.filter((p) => p.role === role).map((p) => `${p.name} · ${p.ja}`).join(' · ') || '—') : '';
      const checked = list.some((p) => !p.linked);
      return `<div class="av-link-diff__row av-link-diff__row--rich${checked ? '' : ' is-off'}" role="row"><input type="checkbox" aria-label="${label} 적용"${checked ? ' checked' : ''}${!checked ? ' disabled' : ''}><b role="cell">${label}</b>${!isNew ? `<span class="av-link-diff__current" role="cell">${esc(curText)}</span>` : ''}<span role="cell" class="av-link-people">${list.length === 0 ? '후보 없음' : list.map((p) => {
        const name = p.ko || p.ja;
        const ctl = p.linked ? '' : `<select aria-label="${esc(name)} 연결 방식">${p.personId ? `<option>${esc(name)}</option>` : ''}<option${p.personId ? '' : ' selected'}>새 인물로 추가</option><option>기존 인물에 연결…</option></select>${p.personId ? '' : `<input aria-label="${esc(name)} 표시 이름" value="${esc(name)}">`}`;
        return `<span class="av-link-person"><span class="av-link-person__name"><b>${esc(name)}</b>${p.ko ? `<small lang="ja">${esc(p.ja)}</small>` : ''}${p.linked ? '<small>이미 연결됨</small>' : ''}</span>${ctl}</span>`;
      }).join('')}</span></div>`;
    };
    const genresCur = !isNew ? `<span class="av-link-diff__current" role="cell">${esc(c.current.fields.genres.join(' · ') || '—')}</span>` : '';
    const coverChanges = Object.values(surf).filter((v) => v === 'candidate').length;
    const infoChanges = Object.values(checks).filter(Boolean).length + (c.performers.some((p) => !p.linked) ? 1 : 0) + (c.directors.length ? 1 : 0) + ((isNew || !c.current.fields.genres.length) ? 1 : 0);
    return `<div class="ui-dialog__overlay"></div><div class="ui-dialog ui-dialog--workspace" role="dialog" aria-label="${title}"><h2 class="ui-dialog__title">${title}</h2><div class="av-link-chooser">
      <header class="av-link-chooser__header">
        <div class="av-link-chooser__heading"><h2>${title}<span class="av-link-code">${c.code}</span></h2>${heading}</div>
        <div class="av-link-chooser__source"><span>출처 <b>LibreDMM</b> · <span class="numeric">${c.fetched}</span> 조회</span><button class="ui-button ui-button--ghost ui-button--sm" type="button">원본 페이지 열기${icon('out', '')}</button></div>
        <button class="ui-button ui-button--ghost ui-button--icon" type="button" aria-label="후보 창 닫기">${icon('x', '')}</button>
      </header>
      <div class="av-link-chooser__body">
        <section class="av-link-chooser__cover">
          <div class="av-link-section-heading"><h3>표지</h3><span>펼친 재킷 · 선을 끌어 뒤 | 옆 | 앞 나누기</span></div>
          <div class="av-link-jacket" style="aspect-ratio:${W} / ${H}"><img src="${c.jacket.src}" alt="펼친 재킷 후보" draggable="false">
            ${zone('뒤', 0, sp.x1, sp.x1)}${zone('옆', sp.x1, sp.x2 - sp.x1)}${zone('앞', sp.x2, W - sp.x2, W - sp.x2)}
            ${c.split.isWrap ? `<button type="button" role="slider" class="av-link-split" style="left:${pct(sp.x1)}" aria-label="뒤와 옆 사이 선"></button><button type="button" role="slider" class="av-link-split" style="left:${pct(sp.x2)}" aria-label="옆과 앞 사이 선"></button>` : ''}
          </div>
          <div class="av-link-jacket__meta"><span>원본 <b class="numeric">${W} × ${H}</b></span><span>책등 <b class="numeric">${sp.x2 - sp.x1}px · ${spinePct.toFixed(1)}%</b></span>${warn ? `<span class="av-link-jacket__warning">${icon('warn', '')}책등이 너무 넓거나 좁아요 — 선을 확인하세요</span>` : ''}${c.split.isWrap ? `<button class="ui-button ui-button--ghost ui-button--sm" type="button">${icon('undo', '')}자동 추정으로</button>` : ''}</div>
          <div class="av-link-surfaces">${surfaces}</div>
        </section>
        <section class="av-link-chooser__info">
          <div class="av-link-section-heading"><h3>정보</h3><span>체크한 항목만 ${isNew ? '들어갑니다' : '바뀝니다'}</span></div>
          ${isNew ? `<div class="av-link-new-name"><label class="ui-text-field"><span>새 컬렉션 이름</span><input value="${c.code}"></label><button class="ui-button ui-button--secondary ui-button--md" type="button">원제로 채우기</button></div>` : ''}
          <div class="av-link-diff${isNew ? ' is-new' : ''}" role="table" aria-label="후보 정보 비교">
            <div class="av-link-diff__head" role="row"><span></span><b role="columnheader">항목</b>${!isNew ? '<b class="av-link-diff__current" role="columnheader">지금</b>' : ''}<b role="columnheader">LibreDMM</b></div>
            ${FIELDS.map(([k, l]) => diffRow(k, l)).join('')}
            ${personRow('출연', c.performers, 'performer')}
            ${personRow('감독', c.directors, 'director')}
            <div class="av-link-diff__row av-link-diff__row--rich" role="row"><input type="checkbox" aria-label="장르 적용" checked><b role="cell">장르</b>${genresCur}<span role="cell" class="av-link-genres">${c.fields.genres.map((g) => `<button type="button" aria-pressed="true">${esc(g)}</button>`).join('')}</span></div>
          </div>
        </section>
      </div>
      <footer class="av-link-chooser__footer"><button class="ui-button ui-button--ghost ui-button--md av-link-chooser__reject" type="button">거절</button><span class="av-link-chooser__footer-spacer"></span><span class="av-link-chooser__summary">표지 <b class="numeric">${coverChanges}</b>면 · 정보 <b class="numeric">${infoChanges}</b>개 바뀜</span><button class="ui-button ui-button--secondary ui-button--md" type="button">나중에</button><button class="ui-button ui-button--primary ui-button--md" type="button"${needsPick ? ' disabled' : ''}>${isNew ? '새 컬렉션 만들기' : '적용'}</button></footer>
    </div></div>`;
  }

  /* =====================================================================
     AFTER — the proposal (shared piece; PC dialog frame or tablet sheet frame)
     ===================================================================== */
  const sectionLabel = (title, { count, actions } = {}) => `<div class="ui-section-label"><span class="ui-section-label__title">${title}</span>${count !== undefined ? ` <span class="ui-section-label__count">${count}</span>` : ''}<span class="ui-section-label__rule" aria-hidden="true"></span>${actions ? `<span class="ui-section-label__actions">${actions}</span>` : ''}</div>`;

  /* The jacket stage: split editor as the hero; the surface choices are the labels under the jacket. */
  function stage(c, o) {
    const W = c.jacket.w, H = c.jacket.h; const borrowed = borrowedSpine(c);
    const sp = c.split.isWrap ? (o.split || (borrowed ? { x1: c.split.x1, x2: c.split.x2 } : pcSplit(c))) : { x1: 0, x2: 0 };
    const surf = { ...defaultSurfaces(c), ...(o.surfaces || {}) };
    const pct = (v) => `${(v / W) * 100}%`;
    const zones = c.split.isWrap ? surfacesOf : ['front'];
    const zoneBox = (s) => { const b = c.split.isWrap ? bounds(s, sp, W) : { x: 0, w: W }; return b; };
    let overlays = '';
    for (const s of zones) {
      const b = zoneBox(s); if (b.w < 1) continue;
      if (surf[s] === 'keep' && c.current?.old) {
        const ob = oldBounds(s, c.current.old);
        overlays += `<span class="av-split__keep" style="left:${pct(b.x)};width:${pct(b.w)}">${crop(c.current.old.src, c.current.old.w, c.current.old.h, ob.x, ob.w, 'av-crop', `지금 ${LABEL[s]}`)}<span class="ui-badge ui-badge--scrim">지금</span></span>`;
      } else if (surf[s] === 'clear') overlays += `<span class="av-split__off" style="left:${pct(b.x)};width:${pct(b.w)}"></span>`;
    }
    const moved = o.split && c.split.isWrap && (o.split.x1 !== c.split.x1 || o.split.x2 !== c.split.x2);
    const spinePx = sp.x2 - sp.x1; const spinePct = (spinePx / W) * 100;
    const warn = c.split.isWrap && !(borrowed && !moved) && (spinePct < 1 || spinePct > 12);
    const lineVal = (k) => o.focusLine === k ? `<span class="av-split__value numeric">${k === 'x1' ? `뒤표지 ${n(sp.x1)}` : `앞표지 ${n(W - sp.x2)}`} · 책등 ${n(spinePx)}px</span>` : '';
    const lines = !c.split.isWrap ? '' : (borrowed && !moved)
      ? `<button type="button" role="slider" class="av-split__line is-joined${o.focusLine ? ' is-focus' : ''}" style="left:${pct(sp.x1)}" aria-label="뒤표지와 앞표지 사이 선" aria-valuenow="${sp.x1}" aria-description="끌어 벌리면 이 재킷에서 책등을 자릅니다"></button>`
      : `<button type="button" role="slider" class="av-split__line${o.focusLine === 'x1' ? ' is-focus' : ''}" style="left:${pct(sp.x1)}" aria-label="뒤표지와 책등 사이 선" aria-valuenow="${sp.x1}">${lineVal('x1')}</button><button type="button" role="slider" class="av-split__line${o.focusLine === 'x2' ? ' is-focus' : ''}" style="left:${pct(sp.x2)}" aria-label="책등과 앞표지 사이 선" aria-valuenow="${sp.x2}">${lineVal('x2')}</button>`;
    const word = (s) => {
      const v = surf[s];
      if (s === 'spine' && borrowed && !moved && v === 'candidate') return ' <span class="av-cap__state">DVD</span>';
      return v === 'keep' ? ' <span class="av-cap__state">지금</span>' : v === 'clear' ? ' <span class="av-cap__state">없음</span>' : '';
    };
    const capAt = (s) => { const b = zoneBox(s); return ((b.x + b.w / 2) / W) * 100; };
    const caps = zones.map((s) => `<button type="button" class="av-cap${surf[s] === 'clear' ? ' is-off' : ''}${o.menu === s ? ' is-open' : ''}" style="left:${capAt(s)}%" aria-haspopup="menu" aria-expanded="${o.menu === s}" aria-label="${LABEL[s]}: ${surf[s] === 'keep' ? '지금 것 유지' : surf[s] === 'clear' ? '비움' : '후보 사용'}">${LABEL[s]}${word(s)}${icon('down', 'i av-cap__chev')}</button>`).join('');
    const menu = o.menu ? surfaceMenu(c, o.menu, surf[o.menu], sp, borrowed && !moved, capAt(o.menu)) : '';
    const foot = [];
    if (warn) foot.push(`<span class="av-stage__warn">${icon('warn')}${spinePct < 1 ? '책등이 좁아요' : '책등이 넓어요'}</span>`);
    if (moved || warn) foot.push(`<button type="button" class="ui-button ui-button--quiet ui-button--sm">${icon('undo')}자동으로</button>`);
    const ar = W / H;
    const heroH = o.heroH || 560;
    return `<div class="av-stage${c.split.isWrap ? '' : ' is-front-only'}" style="--hero-h:${heroH}px">
      <div class="av-stage__jacket" style="width:min(100%, ${Math.round(heroH * ar)}px)">
        <div class="av-split" style="aspect-ratio:${W} / ${H}">${o.privacy ? `<span class="av-split__privacy" role="img" aria-label="표지 숨김"></span>` : `<img src="${c.jacket.src}" alt="${c.code} 펼친 재킷" draggable="false">`}${overlays}${lines}</div>
        <div class="av-caps">${caps}${menu}</div>
        <div class="av-stage__foot">${foot.join('')}<span class="av-stage__size numeric">${W} × ${H}</span></div>
      </div>
    </div>`;
  }
  /* A spine reads sideways, as on a shelf: the thumbnail is the strip turned a quarter, 160 px long. */
  const spineThumb = (src, W, H, x, w) => { const L = 160; const t = Math.max(6, Math.round((L * w) / H));
    return `<span class="av-menu-spine" style="width:${L}px;height:${t}px"><span class="av-crop" style="position:absolute;left:50%;top:50%;width:${t}px;height:${L}px;transform:translate(-50%,-50%) rotate(-90deg)"><img src="${src}" alt="" draggable="false" style="position:absolute;top:0;height:100%;max-width:none;max-height:none;width:${(W / w) * 100}%;left:${(-x / w) * 100}%"></span></span>`; };
  function surfaceMenu(c, s, value, sp, borrowed, at) {
    const W = c.jacket.w, H = c.jacket.h; const items = [];
    const thumbH = 56;
    const thumb = (src, iw, ih, x, w) => s === 'spine' ? spineThumb(src, iw, ih, x, w) : crop(src, iw, ih, x, w, 'av-crop av-menu-thumb');
    let candThumb = '';
    if (s === 'spine' && borrowed && c.borrowed) { const d = c.borrowed; candThumb = thumb(d.src, d.w, d.h, d.x1, d.x2 - d.x1); }
    else { const b = c.split.isWrap ? bounds(s, sp, W) : { x: 0, w: W }; candThumb = thumb(c.jacket.src, W, H, b.x, b.w); }
    items.push(['candidate', s === 'spine' && borrowed ? 'DVD 표지의 책등' : '후보', candThumb, s === 'spine' && borrowed ? '' : `${n(c.split.isWrap ? bounds(s, sp, W).w : W)} × ${n(H)}`]);
    if (c.current?.old) { const o = c.current.old; const ob = oldBounds(s, o); items.push(['keep', '지금 것 유지', thumb(o.src, o.w, o.h, ob.x, ob.w), `${n(ob.w)} × ${n(o.h)}`]); }
    items.push(['clear', '비우기', s === 'spine' ? '<span class="av-menu-spine av-menu-thumb--empty" style="width:160px;height:12px"></span>' : '<span class="av-menu-thumb av-menu-thumb--empty"></span>', '']);
    return `<div class="ui-menu av-cap-menu${s === 'spine' ? ' av-cap-menu--spine' : ''}" role="menu" aria-label="${LABEL[s]}" style="--thumb-h:${thumbH}px;left:${at}%">${items.map(([v, t, th, meta]) => `<button type="button" role="menuitemradio" aria-checked="${v === value}" class="ui-menu__item av-cap-menu__item${v === value ? ' is-current' : ''}">${th}<span class="av-cap-menu__text"><span>${t}</span>${meta ? `<small class="numeric">${meta}</small>` : ''}</span></button>`).join('')}</div>`;
  }

  function destination(c, o) {
    const isNew = !c.current;
    const sel = o.target ?? (c.current ? 'cur' : c.matches.length === 1 ? c.matches[0].id : c.matches.length === 0 ? 'new' : null);
    const row = (id, thumb, name, meta) => `<button type="button" role="radio" aria-checked="${sel === id}" class="av-dest__row${sel === id ? ' is-current' : ''}">${thumb}<span class="av-dest__text"><span class="av-dest__name">${esc(name)}</span>${meta ? `<small>${esc(meta)}</small>` : ''}</span></button>`;
    const cover = (k) => `<span class="av-dest__thumb ph ${k}"></span>`;
    const rows = [];
    if (c.current) rows.push(row('cur', `<span class="av-dest__thumb">${crop(c.current.old.src, c.current.old.w, c.current.old.h, c.current.old.x2, c.current.old.w - c.current.old.x2, 'av-crop')}</span>`, c.current.name, `${c.current.year} · 표지 3면`));
    c.matches.forEach((m, i) => rows.push(row(m.id, cover(i ? 'p8' : 'p6'), m.name, m.meta)));
    if (!c.current) rows.push(row('new', `<span class="av-dest__thumb av-dest__thumb--icon">${icon('plus')}</span>`, '새 컬렉션', ''));
    const nameField = sel === 'new' ? `<div class="av-dest__name-field"><label class="ui-field"><span>이름</span><input class="ui-text-input" value="${esc(o.name ?? c.code)}"></label><button type="button" class="ui-button ui-button--quiet ui-button--sm">원제로</button></div>` : '';
    rows.push(`<button type="button" class="av-dest__row av-dest__row--other">${`<span class="av-dest__thumb av-dest__thumb--icon">${icon('search')}</span>`}<span class="av-dest__text"><span class="av-dest__name">다른 컬렉션…</span></span></button>`);
    const newIdx = rows.findIndex((r) => r.includes('새 컬렉션'));
    if (nameField && newIdx >= 0) rows.splice(newIdx + 1, 0, nameField);
    return `<section class="av-side__section" aria-label="넣을 곳">${sectionLabel('넣을 곳')}<div class="av-dest" role="radiogroup" aria-label="넣을 곳">${rows.join('')}</div></section>`;
  }

  function personDisplay(p) { return p.ko || p.ja; }
  function info(c, o) {
    const isNew = !c.current; const checks = defaultChecks(c);
    const genres = c.fields.genres.filter(genreShown);
    const genreLine = genres.map(genreKo);
    const performersNew = c.performers.filter((p) => !p.linked && !p.personId).length;
    const actions = `<button type="button" class="ui-button ui-button--quiet ui-button--sm" aria-expanded="${!!o.details}">${o.details ? '접기' : '자세히'}${icon(o.details ? 'up' : 'down')}</button>`;
    if (!o.details) {
      const rows = [];
      const push = (label, value, extra = '') => rows.push(`<div class="av-facts__row"><span class="av-facts__label">${label}</span><span class="av-facts__value">${value}${extra}</span></div>`);
      if (isNew) {
        rows.push(`<p class="av-facts__title" lang="ja">${esc(c.fields.title_ja)}</p>`);
        push('발매', `<span class="numeric">${dateText(c.fields.release_date)}</span>`);
        push('제작', `<span lang="ja">${esc([c.fields.maker, c.fields.label].filter(Boolean).join(' · '))}</span>`);
        if (c.fields.series) push('시리즈', `<span lang="ja">${esc(c.fields.series)}</span>`);
        push('출연', esc(c.performers.map(personDisplay).join(' · ')), performersNew ? ` <span class="ui-badge ui-badge--plain">새 인물 ${performersNew}</span>` : '');
        push('장르', esc(genreLine.join(' · ')));
      } else {
        const changing = FIELDS.filter(([k]) => checks[k]);
        const differs = FIELDS.filter(([k]) => !checks[k] && has(c.fields[k]) && has(c.current.fields[k]) && !same(c.fields[k], c.current.fields[k]));
        for (const [k, l] of changing) push(l.replace('발매일', '발매').replace('제작사', '제작'), `<span${k === 'release_date' ? ' class="numeric"' : ' lang="ja"'}>${esc(fieldText(k, c.fields[k]))}</span>`);
        for (const [k, l] of differs) push(l.replace('발매일', '발매'), `<span class="av-facts__old numeric">${esc(fieldText(k, c.current.fields[k]))}</span><span class="av-facts__arrow">→</span><span class="numeric">${esc(fieldText(k, c.fields[k]))}</span>`, ' <span class="ui-badge ui-badge--plain">다름 · 그대로 둠</span>');
        const addPeople = c.performers.filter((p) => !p.linked);
        if (addPeople.length) push('출연', `+ ${esc(addPeople.map(personDisplay).join(' · '))}`, ` <span class="ui-badge ui-badge--plain">새 인물 ${addPeople.filter((p) => !p.personId).length}</span>`);
        const addG = genres.filter((g) => !c.current.fields.genres.includes(g)).map(genreKo);
        push('장르', `+ ${esc(addG.join(' · '))}`);
        const keepN = FIELDS.filter(([k]) => !checks[k] && same(c.fields[k], c.current.fields[k])).length;
        rows.push(`<p class="av-facts__rest">같음 ${keepN}개</p>`);
      }
      return `<section class="av-side__section" aria-label="정보">${sectionLabel(isNew ? '정보' : '바뀌는 정보', { actions })}<div class="av-facts">${rows.join('')}</div></section>`;
    }
    /* 자세히: every field with its own checkbox; existing shows 지금 under the value. */
    const row = (k, label) => {
      const next = c.fields[k]; const cur = c.current?.fields[k];
      const isSame = !isNew && has(cur) && same(cur, next); const disabled = !has(next) || isSame;
      const badge = isNew ? '' : isSame ? '<span class="ui-badge ui-badge--plain">같음</span>' : has(cur) ? '<span class="ui-badge ui-badge--plain">다름</span>' : '<span class="ui-badge ui-badge--plain">빈 칸</span>';
      return `<label class="av-field${checks[k] ? '' : ' is-off'}"><input type="checkbox" class="ui-checkbox"${checks[k] ? ' checked' : ''}${disabled ? ' disabled' : ''} aria-label="${label} 적용"><span class="av-field__label">${label}</span><span class="av-field__value"><span${k === 'release_date' ? ' class="numeric"' : ' lang="ja"'}>${has(next) ? esc(fieldText(k, next)) : '후보 없음'}</span>${!isNew ? `<small>지금 <span${k === 'release_date' ? ' class="numeric"' : ' lang="ja"'}>${esc(fieldText(k, cur))}</span> ${badge}</small>` : ''}</span></label>`;
    };
    const person = (p) => {
      if (p.linked) return `<div class="av-person is-linked"><span class="av-person__check">${icon('check')}</span><span class="av-person__name"><span>${esc(personDisplay(p))}</span><small lang="ja">${esc(p.ja)} · 이미 연결됨</small></span></div>`;
      return `<div class="av-person"><input type="checkbox" class="ui-checkbox" checked aria-label="${esc(p.ja)} 넣기"><span class="av-person__name">${p.personId ? `<span>${esc(personDisplay(p))}</span>` : `<input class="ui-text-input av-person__input" aria-label="${esc(p.ja)} 한국어 이름" value="${esc(p.ko || '')}" placeholder="${esc(p.ja)}">`}<small lang="ja">${esc(p.ja)}</small></span><button type="button" class="ui-button ui-button--quiet ui-button--sm av-person__link" aria-haspopup="dialog">${p.personId ? '기존 인물' : '새 인물'}${icon('down')}</button></div>`;
    };
    const hidden = c.fields.genres.length - genres.length;
    const chips = genres.map((g) => `<button type="button" class="ui-filter-chip av-genre" aria-pressed="true" data-ja="${esc(g)}">${esc(genreKo(g))}</button>`).join('');
    return `<section class="av-side__section" aria-label="정보">${sectionLabel(isNew ? '정보' : '바뀌는 정보', { actions })}
      <div class="av-fields">${FIELDS.map(([k, l]) => row(k, l)).join('')}</div>
      ${sectionLabel('출연', { count: c.performers.length })}<div class="av-people">${c.performers.map(person).join('')}</div>
      ${sectionLabel('장르', { count: genres.length })}<div class="av-genres">${chips}</div>${hidden ? `<p class="av-genres__hidden">판매·샘플 태그 ${hidden}개 숨김</p>` : ''}
    </section>`;
  }

  function after(c, o = {}) {
    const isNew = !c.current;
    const surf = { ...defaultSurfaces(c), ...(o.surfaces || {}) };
    const sel = o.target ?? (c.current ? 'cur' : c.matches.length === 1 ? c.matches[0].id : c.matches.length === 0 ? 'new' : null);
    const covers = surfacesOf.filter((s) => surf[s] === 'candidate' || (surf[s] === 'clear' && c.current?.old)).length;
    const checks = defaultChecks(c);
    const infoN = Object.values(checks).filter(Boolean).length + c.performers.filter((p) => !p.linked).length + 1;
    const summary = sel === null ? '넣을 곳을 고르세요' : `표지 ${covers}면 · 정보 ${infoN}개`;
    const primary = sel === 'new' ? '만들기' : '적용';
    /* Tablet: the sheet title is the code itself (BottomSheet title), so the header keeps only the source. */
    const head = `<header class="av-review__head">${o.tablet ? '' : `<h2 class="av-review__code">${c.code}</h2>`}<span class="av-review__source">LibreDMM · <span class="numeric">${c.fetched}</span></span><button type="button" class="ui-button ui-button--quiet ui-button--icon" aria-label="LibreDMM 원본 페이지 열기">${icon('out')}</button></header>`;
    const foot = `<footer class="av-review__foot"><button type="button" class="ui-button ui-button--danger ui-button--md">거절</button><span class="av-review__spacer"></span><span class="av-review__summary">${summary}</span><button type="button" class="ui-button ui-button--secondary ui-button--md">나중에</button><button type="button" class="ui-button ui-button--primary ui-button--md"${sel === null ? ' disabled' : ''}>${primary}</button></footer>`;
    const body = `<div class="av-review__body"><div class="av-review__stage">${stage(c, o)}</div><div class="av-review__side">${destination(c, { ...o, target: sel })}${info(c, o)}</div></div>`;
    if (o.tablet) return `<div class="av-review av-review--sheet">${stage(c, { ...o, heroH: o.heroH || 470 })}${destination(c, { ...o, target: sel })}${info(c, o)}${foot}</div>`;
    return `<div class="ui-dialog__overlay"></div><div class="ui-dialog ui-dialog--workspace av-review-dialog" role="dialog" aria-label="AV 후보 ${c.code}"><h2 class="ui-dialog__title">AV 후보 ${c.code}</h2><div class="av-review">${head}${body}${foot}</div></div>`;
  }

  /* =====================================================================
     Tablet BEFORE — the current AvInboxChooser bottom sheet
     ===================================================================== */
  function tabletBefore(c) {
    const isNew = !c.current; const W = c.jacket.w, H = c.jacket.h; const sp = c.split;
    const surf = defaultSurfaces(c); const checks = defaultChecks(c);
    const cand = (s) => {
      if (!c.split.isWrap && s !== 'front') return '<span>후보 없음</span>';
      if (s === 'spine' && borrowedSpine(c)) return '<span class="av-inbox-thumb">DVD 표지</span><small>책등은 DVD 표지에서 가져옴</small>';
      const b = c.split.isWrap ? bounds(s, sp, W) : { x: 0, w: W };
      return crop(c.jacket.src, W, H, b.x, b.w, 'av-inbox-thumb', `${LABEL[s]} 후보`);
    };
    const cur = (s) => c.current?.old ? (() => { const o = c.current.old; const ob = oldBounds(s, o); return crop(o.src, o.w, o.h, ob.x, ob.w, 'av-inbox-thumb', `지금 ${LABEL[s]}`); })() : '<span class="av-inbox-thumb">—</span>';
    const order = ['front', 'spine', 'back'];
    const surfaceRows = order.map((s) => `<div class="av-inbox-surface"><b>${LABEL[s]}</b><div class="av-inbox-comparison"><div><small>지금</small>${cur(s)}</div><span>→</span><div><small>후보</small>${cand(s)}</div></div><div class="av-inbox-surface-actions" role="group">${['candidate', 'keep', 'clear'].filter((a) => a !== 'keep' || !isNew).map((a) => `<button class="ui-button ui-button--secondary ui-button--md" type="button" aria-pressed="${surf[s] === a}"${a === 'candidate' && !c.split.isWrap && s !== 'front' ? ' disabled' : ''}>${a === 'candidate' ? '후보 사용' : a === 'keep' ? '유지' : '비우기'}</button>`).join('')}</div></div>`).join('');
    const INFO = [['title_ja', '원제'], ['release_date', '발매일'], ['maker', '제작사'], ['label', '레이블'], ['series', '시리즈'], ['genres', '장르']];
    const text = (v) => Array.isArray(v) ? (v.length ? v.join(' · ') : '—') : (v || '—');
    const infoRows = INFO.map(([k, l]) => {
      const v = c.fields[k]; const old = c.current?.fields[k] ?? (k === 'genres' ? [] : null);
      const empty = !has(v); const sm = same(v, old); const checked = k === 'genres' ? true : checks[k];
      return `<div class="av-inbox-diff"><input type="checkbox" class="ui-checkbox" aria-label="${l} 적용"${checked ? ' checked' : ''}${empty || sm ? ' disabled' : ''}><b>${l}</b><div><span>${empty ? '후보 없음' : esc(text(v))}</span>${c.current ? `<small>지금 ${esc(text(old))} ${!empty ? `<span class="ui-badge ui-badge--plain">${sm ? '같음' : text(old) !== '—' ? '다름' : '빈 칸'}</span>` : ''}</small>` : ''}</div></div>`;
    }).join('');
    const personRows = (role, list) => `<section>${sectionLabel(role === 'performer' ? '출연' : '감독')}${list.map((p) => p.linked
      ? `<div class="av-inbox-person"><b>${esc(p.ko)}</b><small lang="ja">${esc(p.ja)} · 이미 연결됨</small></div>`
      : `<div class="av-inbox-person"><input type="checkbox" class="ui-checkbox" checked aria-label="${esc(p.ja)} 적용"><span class="av-inbox-person-initial" aria-hidden="true">${esc([...(p.ko || p.ja)][0])}</span><div class="av-inbox-person-name"><input class="ui-text-input" value="${esc(p.ko || p.ja)}"${p.personId ? ' disabled' : ''}><small lang="ja">${esc(p.ja)}</small></div><div class="av-inbox-person-link"><select class="ui-text-input"><option>${p.personId ? `${esc(p.ko)} · ${esc(p.ja)}에 연결` : '새 인물'}</option></select></div></div>`).join('')}</section>`;
    const target = c.current
      ? `<div class="av-inbox-target"><b>${esc(c.current.name)}</b><small>기존 컬렉션에 후보 추가</small><button class="ui-button ui-button--secondary ui-button--md" type="button">다른 컬렉션</button></div>`
      : c.matches.length > 1
        ? `<div role="radiogroup" aria-label="후보를 넣을 곳"><p>같은 품번의 컬렉션이 ${c.matches.length}개 있어요</p>${c.matches.map((m) => `<button class="ui-button ui-button--secondary ui-button--md" role="radio" aria-checked="false" type="button">${esc(m.name)}</button>`).join('')}<button class="ui-button ui-button--secondary ui-button--md" role="radio" aria-checked="false" type="button">새 AV 컬렉션으로 만들기</button></div>`
        : `<label class="ui-field"><span>새 컬렉션 이름</span><input class="ui-text-input" value="${c.code}"></label><button class="ui-button ui-button--secondary ui-button--md" type="button">원제로 채우기</button><div class="av-inbox-target"><small>맞는 기존 컬렉션 없음</small><button class="ui-button ui-button--ghost ui-button--md" type="button">기존 컬렉션에 연결…</button></div>`;
    const regions = c.split.isWrap
      ? `${[sp.x1, sp.x2].map((x) => `<i class="av-inbox-cut" style="left:${(x / W) * 100}%"></i>`).join('')}<span class="av-inbox-region" style="left:0;width:${(sp.x1 / W) * 100}%">뒤표지</span><span class="av-inbox-region" style="left:${(sp.x1 / W) * 100}%;width:${((sp.x2 - sp.x1) / W) * 100}%">책등</span><span class="av-inbox-region" style="left:${(sp.x2 / W) * 100}%;right:0">앞표지</span>`
      : '<span class="av-inbox-region">앞표지</span>';
    const covers = Object.values(surf).filter((v) => v === 'candidate').length;
    const infoN = Object.values(checks).filter(Boolean).length + c.performers.filter((p) => !p.linked).length + c.directors.length + 1;
    return `<div class="av-inbox-chooser">
      <header><b class="numeric">${c.code}</b><small>LibreDMM</small></header>
      <section>${sectionLabel('적용할 곳')}${target}</section>
      <section>${sectionLabel('표지')}<div class="av-inbox-jacket" style="aspect-ratio:${W}/${H}"><img src="${c.jacket.src}" alt="후보 펼친 표지" draggable="false">${regions}</div><small>원본 ${W} × ${H} · 서버 자동 나눔</small>${c.matches.length > 1 ? '<p>넣을 곳을 고르면 지금 표지·정보와 나란히 보여요</p>' : surfaceRows}</section>
      ${c.matches.length > 1 ? '' : `<section>${sectionLabel('정보')}${infoRows}${personRows('performer', c.performers)}${personRows('director', c.directors)}</section>`}
      <footer class="av-inbox-footer"><button class="ui-button ui-button--danger ui-button--md" type="button">거절</button><small>${c.matches.length > 1 ? '넣을 곳을 고르세요' : `표지 ${covers}면 · 정보 ${infoN}개 바뀜`}</small><button class="ui-button ui-button--secondary ui-button--md" type="button">나중에</button><button class="ui-button ui-button--primary ui-button--md" type="button"${c.matches.length > 1 ? ' disabled' : ''}>적용</button></footer>
    </div>`;
  }

  /* A tablet bottom sheet around either version (BottomSheet tall stacked markup). */
  /* BottomSheet tall stacked markup. `heading` = BottomSheet's heading prop, `actions` = its headerActions. */
  function tabletSheet(title, inner, { heading, actions = '' } = {}) {
    return `<div class="ui-dialog__overlay"></div><div class="ui-dialog" role="dialog" aria-label="${title}"><h2 class="ui-dialog__title${heading ? ' av-review__sheet-title' : ''}">${heading ?? title}</h2><div class="library-sheet library-sheet--tall library-sheet--stacked"><div class="bottom-sheet-drag-area"><span aria-hidden="true"></span></div><div class="bottom-sheet-header-actions">${actions}<button class="ui-button ui-button--ghost ui-button--md" type="button" aria-label="${title} 닫기">${icon('x', '')}</button></div>${inner}</div></div>`;
  }
  const sheetHeading = (c) => `${c.code}<span class="av-review__source">LibreDMM · <span class="numeric">${c.fetched}</span></span>`;
  const sheetActions = () => `<button type="button" class="ui-button ui-button--ghost ui-button--icon" aria-label="LibreDMM 원본 페이지 열기">${icon('out', '')}</button>`;

  window.AvCover = { S, before, after, tabletBefore, tabletSheet, sheetHeading, sheetActions, GENRE_KO, genreShown, genreKo };
})();
