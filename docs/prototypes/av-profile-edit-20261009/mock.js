// Mockup helpers for manual AV profile editing (2026-10-09). Placeholder art only: gradients and a generic silhouette, no real people.
(function () {
  const ICONS = {
    back: '<path d="M15.75 19.5 8.25 12l7.5-7.5"/>',
    dots: '<path d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm6 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"/>',
    star: '<path d="M11.48 3.5a.56.56 0 0 1 1.04 0l2.13 5.11 5.52.44c.5.04.7.66.32.99l-4.2 3.6 1.28 5.38a.56.56 0 0 1-.84.61L12 16.77l-4.73 2.89a.56.56 0 0 1-.84-.61l1.28-5.38-4.2-3.6a.56.56 0 0 1 .32-.99l5.52-.44 2.13-5.11Z"/>',
    camera: '<path d="M6.83 6.18A2.31 2.31 0 0 1 5.18 7.23c-.38.05-.76.11-1.13.18C2.99 7.58 2.25 8.5 2.25 9.57V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.57c0-1.07-.74-1.99-1.8-2.16a47.4 47.4 0 0 0-1.13-.18 2.31 2.31 0 0 1-1.65-1.05l-.82-1.31a2.19 2.19 0 0 0-1.73-1.03 48.8 48.8 0 0 0-5.24 0 2.19 2.19 0 0 0-1.73 1.03l-.82 1.31Z"/><path d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z"/>',
    out: '<path d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>',
    sort: '<path d="M3 7.5 7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5"/>',
    view: '<path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6Zm0 9.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Zm0 9.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"/>',
    home: '<path d="m2.25 12 8.95-8.96a1.13 1.13 0 0 1 1.6 0L21.75 12M4.5 9.75v10.13c0 .62.5 1.12 1.13 1.12H9.75v-4.88c0-.62.5-1.12 1.13-1.12h2.25c.62 0 1.12.5 1.12 1.13V21h4.13c.62 0 1.12-.5 1.12-1.13V9.76M8.25 21h8.25"/>',
    photo: '<path d="m2.25 15.75 5.16-5.16a2.25 2.25 0 0 1 3.18 0l5.16 5.16m-1.5-1.5 1.41-1.41a2.25 2.25 0 0 1 3.18 0l2.91 2.91M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Z"/>',
    film: '<path d="M3.38 19.5h17.25M3.38 19.5c-.63 0-1.13-.5-1.13-1.13M3.38 19.5h1.5c.62 0 1.12-.5 1.12-1.13M2.25 18.38V5.63m0 12.75v-1.5c0-.62.5-1.13 1.13-1.13m0 0h1.5m-1.5 0C2.75 15.75 2.25 15.25 2.25 14.63v-1.5c0-.62.5-1.13 1.13-1.13M20.63 19.5c.62 0 1.12-.5 1.12-1.13M20.63 19.5h-1.5c-.63 0-1.13-.5-1.13-1.13m3.75 0V5.63m0 12.75v-1.5c0-.62-.5-1.13-1.12-1.13M21.75 5.63c0-.62-.5-1.13-1.12-1.13H3.38c-.63 0-1.13.5-1.13 1.13M6 18.38V5.63M18 18.38V5.63"/>',
    book: '<path d="M12 6.04A8.97 8.97 0 0 0 6 3.75c-1.05 0-2.06.18-3 .51v14.25A9 9 0 0 1 6 18c2.3 0 4.4.87 6 2.29m0-14.25a8.97 8.97 0 0 1 6-2.29c1.05 0 2.06.18 3 .51v14.25A9 9 0 0 0 18 18a8.97 8.97 0 0 0-6 2.29m0-14.25v14.25"/>',
    cog: '<path d="M10.34 3.94c.09-.54.56-.94 1.11-.94h1.1c.55 0 1.02.4 1.11.94l.15.89c.06.42.38.77.78.93.4.17.86.15 1.22-.11l.74-.53a1.13 1.13 0 0 1 1.45.12l.77.78c.39.39.44 1 .12 1.45l-.53.74c-.26.36-.28.82-.11 1.22.16.4.51.72.93.78l.89.15c.54.09.94.56.94 1.11v1.1c0 .55-.4 1.02-.94 1.11l-.89.15c-.42.06-.77.38-.93.78-.17.4-.15.86.11 1.22l.53.74c.32.45.27 1.06-.12 1.45l-.78.77a1.13 1.13 0 0 1-1.45.12l-.74-.53c-.36-.26-.82-.28-1.22-.11-.4.16-.72.51-.78.93l-.15.89c-.09.54-.56.94-1.11.94h-1.1c-.55 0-1.02-.4-1.11-.94l-.15-.89a1.13 1.13 0 0 0-.78-.93 1.2 1.2 0 0 0-1.22.11l-.74.53a1.13 1.13 0 0 1-1.45-.12l-.77-.78a1.13 1.13 0 0 1-.12-1.45l.53-.74c.26-.36.28-.82.11-1.22a1.13 1.13 0 0 0-.93-.78l-.89-.15A1.13 1.13 0 0 1 3 12.55v-1.1c0-.55.4-1.02.94-1.11l.89-.15c.42-.06.77-.38.93-.78.17-.4.15-.86-.11-1.22l-.53-.74a1.13 1.13 0 0 1 .12-1.45l.78-.77a1.13 1.13 0 0 1 1.45-.12l.74.53c.36.26.82.28 1.22.11.4-.16.72-.51.78-.93l.15-.89Z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>',
    pencil: '<path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125"/>',
    x: '<path d="M6 18 18 6M6 6l12 12"/>',
    plus: '<path d="M12 4.5v15m7.5-7.5h-15"/>',
    undo: '<path d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"/>',
    down: '<path d="m19.5 8.25-7.5 7.5-7.5-7.5"/>',
    doc: '<path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/>',
    link: '<path d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/>',
  };
  const I = (n, small) => `<i data-icon="${n}"${small ? ' data-small' : ''}></i>`;

  /* ---------------- sample performer ---------------- */
  // before = StashDB only; after = 키, 활동 and 링크 set by hand.
  const STASH = { height: 160, start: 2020, links: ['X', 'Instagram', 'FANZA', '공식', '위키'] };
  const MINE = { height: 158, start: 2019, links: ['X', 'Instagram', 'FANZA', '공식', '위키', 'Fantia'] };

  function mark(field, open) {
    return `<button class="manual${open ? ' is-open' : ''}" type="button" aria-label="${field} 직접 입력 · StashDB 값과 비교">직접 입력</button>`;
  }
  function facts(o) {
    const m = o.after && !o.noStash;
    const h = o.after ? MINE.height : STASH.height, s = o.after ? MINE.start : STASH.start;
    return `<dl class="pf-facts" aria-label="프로필">
      <div><dt>생년월일</dt><dd class="num">1999.4.12 <small>만 27세</small></dd></div>
      <div><dt>키${m ? mark('키', o.pop === 'height') : ''}</dt><dd class="num">${h} cm</dd></div>
      <div><dt>사이즈</dt><dd class="num">B86 (F) W58 H85</dd></div>
      <div><dt>컵</dt><dd>F컵 <span class="ui-badge">자연</span></dd></div>
      <div class="wide"><dt>활동${m ? mark('활동') : ''}</dt><dd class="num">${s} – 현역 <small>${2026 - s}년차</small></dd></div>
    </dl>`;
  }
  function links(o) {
    const list = o.after ? MINE.links : STASH.links;
    const shown = list.slice(0, 5).map(l => `<button class="link" type="button">${l}</button>`).join('');
    const more = list.length > 5 ? `<button class="link num" type="button" aria-label="링크 ${list.length - 5}개 더 보기">+${list.length - 5}</button>` : '';
    return `<div class="links-row links--first" aria-label="배우 링크">${shown}${more}${o.after && !o.noStash ? mark('링크') : ''}</div>`;
  }
  function queue(kind) {
    if (kind === 'wait') return `<div class="queue"><span class="ui-badge">대기</span></div>`;
    if (kind === 'conflict') return `<div class="queue"><span class="ui-badge is-danger">충돌</span><small>다른 기기에서 배우 정보가 바뀌었습니다.</small><span class="queue__acts"><button class="ui-button ui-button--quiet" type="button">덮어쓰기</button><button class="ui-button ui-button--quiet" type="button">버리기</button></span></div>`;
    return '';
  }
  function nameRow(o) {
    return `<div class="name-row"><h1>하나세 미오</h1>
      <button class="edit${o.editHover ? ' is-hover' : ''}" type="button" aria-label="프로필 편집"${o.queue === 'conflict' ? ' disabled' : ''}>${I('pencil')}</button>
      <button class="fav" type="button" aria-label="즐겨찾기" aria-pressed="true">${I('star')}</button></div>
      <p class="name-ja" lang="ja">花瀬 澪</p>`;
  }
  function pcSide(o) {
    return `<aside class="a-side">
      <div class="portrait" data-portrait="#6b5257,#24262b"></div>
      <div class="a-id">${nameRow(o)}</div>
      <div style="display:grid;gap:var(--space-3)">
        ${facts(o)}
        ${links(o)}
        ${o.noStash ? '' : `<button class="stash-trigger" type="button">StashDB${I('down', 1)}</button>`}
        ${queue(o.queue)}
      </div>
      <div class="memo">
        <div class="ui-section-label"><span class="ui-section-label__title">메모</span><span class="ui-section-label__rule"></span></div>
        <p>단독작 위주로 모으는 중. 2024년 이후 S1 작품이 좋음.</p>
      </div>
      <p class="lib">내 작품 <b class="num">20</b><span class="dot">·</span>단독 <b class="num">14</b><span class="dot">·</span><span class="num">2024.7 – 9.12</span><span class="dot">·</span>평균 ★<b class="num">4.1</b></p>
    </aside>`;
  }
  function pcPage(o) {
    return `<div class="pc-shell">
      <nav class="rail"><span>${I('home')}</span><span>${I('photo')}</span><span class="on">${I('film')}</span><span>${I('book')}</span><span style="margin-top:auto;margin-bottom:12px">${I('cog')}</span></nav>
      <div>
        <div class="topline">
          <button class="cbtn cbtn--icon" type="button" aria-label="뒤로">${I('back')}</button>
          <span class="crumb">AV · <b>배우</b></span>
          <button class="cbtn cbtn--icon push${o.menu ? ' is-open' : ''}" type="button" aria-label="배우 관리" ${o.menu ? 'style="background:var(--color-surface-hover);color:var(--color-text)"' : ''}>${I('dots')}</button>
        </div>
        <div class="a-page">
          ${pcSide(o)}
          <main class="a-main">
            <div>
              <div class="works-bar">
                <h2>작품</h2><span class="count num">20</span>
                <div class="ctrls">
                  ${seg(['전체', '단독', '공동 출연'], 0)}
                  <button class="cbtn" type="button">정렬 최신순${I('down', 1)}</button>
                  <button class="cbtn cbtn--icon" type="button" aria-label="보기">${I('view')}</button>
                </div>
              </div>
              <div class="shelf" data-shelf="20" style="margin-top:var(--space-3)"></div>
            </div>
            <div class="a-related">
              <div class="block"><div class="ui-section-label"><span class="ui-section-label__title">자주 함께 나온 배우</span><span class="ui-section-label__rule"></span></div><div class="costars" data-costars="5"></div></div>
              <div class="block"><div class="ui-section-label"><span class="ui-section-label__title">레이블</span><span class="ui-section-label__rule"></span></div><div class="labels" data-labels></div></div>
            </div>
          </main>
        </div>
      </div>
    </div>`;
  }
  function tabBand(o) {
    return `<div class="ta-id">
      <div class="portrait" data-portrait="#6b5257,#24262b"><button class="portrait__change" type="button">${I('camera')}사진 바꾸기</button></div>
      <div class="right">
        <div>${nameRow(o)}</div>
        ${facts(o)}
        ${links(o)}
        <div class="ta-foot"><p class="lib">내 작품 <b class="num">20</b><span class="dot">·</span>단독 <b class="num">14</b><span class="dot">·</span>평균 ★<b class="num">4.1</b></p>${o.noStash ? '' : `<button class="stash-trigger" type="button">StashDB${I('down', 1)}</button>`}</div>
        ${queue(o.queue)}
      </div>
    </div>`;
  }
  function tabPage(o) {
    return `<div class="tab-top">
        <button class="cbtn cbtn--icon" type="button" aria-label="뒤로">${I('back')}</button>
        <span class="t" style="font-weight:400;color:var(--color-muted);font-size:var(--type-meta)">컬렉션 › AV › 배우</span>
        <button class="cbtn cbtn--icon push" type="button" aria-label="배우 관리" ${o.menu ? 'style="background:var(--color-surface-pressed);color:var(--color-text)"' : ''}>${I('dots')}</button>
      </div>
      <div class="ta-page">
        ${tabBand(o)}
        <div class="memo">
          <div class="ui-section-label"><span class="ui-section-label__title">메모</span><span class="ui-section-label__rule"></span></div>
          <p>단독작 위주로 모으는 중. 2024년 이후 S1 작품이 좋음.</p>
        </div>
        <div>
          <div class="works-bar"><h2>작품</h2><span class="count num">20</span>
            <div class="ctrls">${seg(['전체', '단독', '공동 출연'], 0)}<button class="cbtn cbtn--icon" type="button" aria-label="정렬" style="width:44px;height:44px">${I('sort')}</button></div></div>
          <div class="shelf" data-shelf="12" style="margin-top:var(--space-3)"></div>
        </div>
      </div>`;
  }
  function seg(labels, active) {
    return `<div class="ui-segmented" role="radiogroup"><span class="ui-segmented__thumb"></span>${labels.map((l, i) =>
      `<button class="ui-segmented__cell" type="button" role="radio" aria-checked="${i === active}"${i === active ? ' data-segmented-active="true"' : ''}><span class="ui-segmented__content"><span class="ui-segmented__label">${l}</span></span></button>`).join('')}</div>`;
  }

  /* ---------------- the shared edit form ---------------- */
  function input(value, o = {}) {
    const cls = ['ui-text-input', o.w || '', o.focus ? 'is-focus' : '', o.invalid ? 'is-invalid' : ''].join(' ');
    return `<label class="${cls}">${o.pre ? `<span class="fix pre">${o.pre}</span>` : ''}<input value="${value}" ${o.ph ? `placeholder="${o.ph}"` : ''} ${o.mode ? `inputmode="${o.mode}"` : ''} aria-label="${o.label || ''}">${o.suf ? `<span class="fix">${o.suf}</span>` : ''}</label>`;
  }
  function label(text, manual) {
    return `<div class="pe-label"><span>${text}</span>${manual ? '<span class="is-manual">직접 입력</span>' : ''}</div>`;
  }
  function compare(text) {
    return `<div class="pe-compare"><span>StashDB ${text}</span><button class="ui-button ui-button--quiet" type="button">${I('undo', 1)}되돌리기</button></div>`;
  }
  function form(o) {
    const ns = o.noStash;
    const manual = !ns && !o.fresh;
    const linkRows = [
      ['X', 'https://x.com/hanase_mio_example'],
      ['Instagram', 'https://www.instagram.com/hanase.mio.example'],
      ['FANZA', 'https://www.dmm.co.jp/digital/videoa/-/list/=/article=actress/id=000000/'],
      ['공식', 'https://agency.example.jp/talent/hanase-mio'],
      ['위키', 'https://ja.wikipedia.org/wiki/花瀬澪_(例)'],
    ].concat(o.fresh || ns ? [] : [['Fantia', o.typing ? 'https://fantia.jp/fanclubs/12' : 'https://fantia.jp/fanclubs/123456']]);
    return `<div class="pe">
      <div class="pe-grid">
        <div class="pe-field">${label('이름')}${input('하나세 미오', { label: '이름' })}</div>
        <div class="pe-field">${label('일본어 이름')}${input('花瀬 澪', { label: '일본어 이름' })}</div>
      </div>
      <section class="pe-section">
        <div class="ui-section-label"><span class="ui-section-label__title">프로필</span><span class="ui-section-label__rule"></span></div>
        <div class="pe-grid">
          <div class="pe-field">${label('생년월일')}<div class="pe-inputs">${input('1999', { w: 'w-year', suf: '년', mode: 'numeric', label: '태어난 해' })}${input('4', { w: 'w-2', suf: '월', mode: 'numeric', label: '월', ph: '-' })}${input('12', { w: 'w-2', suf: '일', mode: 'numeric', label: '일', ph: '-' })}</div></div>
          <div class="pe-field">${label('키', manual)}<div class="pe-inputs">${input(manual ? '158' : '160', { w: 'w-3', suf: 'cm', mode: 'numeric', label: '키' })}</div>${manual ? compare('160 cm') : ''}</div>
          <div class="pe-field">${label('사이즈 (cm)')}<div class="pe-inputs">${input('86', { w: 'w-3', pre: 'B', mode: 'numeric', label: '가슴둘레' })}${input('58', { w: 'w-3', pre: 'W', mode: 'numeric', label: '허리' })}${input('85', { w: 'w-3', pre: 'H', mode: 'numeric', label: '엉덩이' })}</div></div>
          <div class="pe-pair">
            <div class="pe-field">${label('컵', o.emptyCup)}${input(o.emptyCup ? '' : 'F', { w: 'w-cup', label: '컵', ph: o.emptyCup ? '비움' : '', focus: o.emptyCup })}${o.emptyCup ? compare('F') : ''}</div>
            <div class="pe-field">${label('가슴')}${seg(['자연', '인공', '모름'], 0)}</div>
          </div>
          <div class="pe-field">${label('활동', manual)}<div class="pe-inputs">${input(manual ? '2019' : '2020', { w: 'w-year', suf: '년', mode: 'numeric', label: '데뷔' })}<span class="dash">–</span>${input('', { w: 'w-year', ph: '현역', mode: 'numeric', label: '은퇴' })}</div>${manual ? compare('2020 – 현역') : ''}</div>
        </div>
      </section>
      <section class="pe-section">
        <div class="ui-section-label"><span class="ui-section-label__title">링크</span><span class="ui-section-label__rule"></span>${manual ? '<span class="ui-section-label__actions">직접 입력</span>' : ''}</div>
        <div class="pe-links">
          ${linkRows.map(([n, u], i) => { const bad = o.badUrl && i === 3; return `<div class="pe-link">${input(n, { label: '사이트 이름', ph: '이름' })}${input(bad ? u.replace('https://', '') : u, { label: '주소', focus: o.typing && i === linkRows.length - 1, invalid: bad })}<button class="x" type="button" aria-label="${n} 링크 제거">${I('x')}</button></div>${bad ? '<p class="ui-field__error pe-link__error">주소는 https:// 로 시작해야 합니다.</p>' : ''}`; }).join('')}
          <div class="pe-links__foot"><button class="ui-button ui-button--quiet" type="button">${I('plus', 1)}링크 추가</button>${manual ? `<div class="pe-compare"><span>StashDB 링크 5개</span><button class="ui-button ui-button--quiet" type="button">${I('undo', 1)}되돌리기</button></div>` : ''}</div>
        </div>
      </section>
    </div>`;
  }
  function formActions(o) {
    const save = o.badUrl ? ' disabled' : '';
    const reset = !o.noStash && !o.fresh ? `<button class="ui-button ui-button--quiet" type="button">${I('undo', 1)}모두 StashDB 값으로</button>` : '<span></span>';
    return { reset, buttons: `<button class="ui-button ui-button--secondary" type="button">취소</button><button class="ui-button ui-button--primary" type="button"${save}>저장</button>` };
  }
  function dialog(o) {
    const a = formActions(o);
    return `<div class="ui-dialog pe-dialog" role="dialog" aria-label="프로필 편집" ${o.inline ? 'style="position:relative;inset:auto;margin:0"' : ''}>
      <h2 class="ui-dialog__title">프로필 편집</h2>
      ${form(o)}
      <div class="ui-dialog__actions">${a.reset}<div>${a.buttons}</div></div>
    </div>`;
  }
  function sheet(o) {
    const a = formActions(o);
    return `<div class="sheet sheet--tall" role="dialog" aria-label="프로필 편집">
      <div class="sheet__grip"><span></span></div>
      <div class="sheet__head"><h2>프로필 편집</h2></div>
      <div class="sheet__body">${form(o)}</div>
      <div class="sheet__foot">${a.reset}<span class="push"></span>${a.buttons}</div>
    </div>`;
  }

  const R = { pcPage, pcSide, tabPage, tabBand, dialog, sheet, form };
  document.querySelectorAll('[data-render]').forEach(el => {
    const [fn, json] = [el.dataset.render, el.dataset.opts];
    el.insertAdjacentHTML('beforeend', R[fn](json ? JSON.parse(json) : {}));
  });

  document.querySelectorAll('[data-icon]').forEach(el => {
    const n = el.dataset.icon, small = el.hasAttribute('data-small');
    el.outerHTML = `<svg class="i${small ? ' s' : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
  });

  const silhouette = (a, b, id) => `<svg viewBox="0 0 200 250" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="g${id}" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="200" height="250" fill="url(#g${id})"/>
    <path d="M44 250c4-44 26-68 56-74 30 6 52 30 56 74Z" fill="rgba(255,255,255,.13)"/>
    <path d="M58 112c-6-52 16-84 44-84s50 28 42 86c-2 26-8 46-12 60-10-4-18-6-30-6s-22 2-32 6c-4-16-10-36-12-62Z" fill="rgba(0,0,0,.22)"/>
    <ellipse cx="100" cy="104" rx="34" ry="42" fill="rgba(255,255,255,.16)"/>
    <rect x="90" y="140" width="20" height="30" fill="rgba(255,255,255,.12)"/>
  </svg>`;
  let pid = 0;
  document.querySelectorAll('[data-portrait]').forEach(el => {
    const [a, b] = (el.dataset.portrait || '#6b5257,#24262b').split(',');
    el.insertAdjacentHTML('afterbegin', silhouette(a, b, 'p' + pid++));
  });
  const FACES = [['#5a6a7a', '#22262c', '아오이 린', 6], ['#7a5a62', '#26222a', '사쿠라기 노아', 4], ['#5f6e5c', '#21251f', '키리시마 유나', 3], ['#6d6450', '#27241d', '미즈하라 에마', 3], ['#5c5a78', '#22222c', '히나타 사키', 2]];
  document.querySelectorAll('[data-costars]').forEach(el => {
    el.innerHTML = FACES.map(([a, b, name, c], i) => `<button class="costar" type="button"><span class="costar__face">${silhouette(a, b, 'f' + pid++ + i)}</span><span><b>${name}</b><small>${c}편</small></span></button>`).join('');
  });
  document.querySelectorAll('[data-labels]').forEach(el => {
    el.innerHTML = [['S1', 7], ['MOODYZ', 5], ['IDEA POCKET', 4], ['PRESTIGE', 2], ['FALENO', 2]].map(([l, c]) => `<span class="ui-badge">${l} <span class="num">${c}</span></span>`).join('');
  });
  const WORKS = [['SSIS-912', '9.12'], ['MIDV-871', '8.8'], ['IPZZ-410', '7.5'], ['SSIS-874', '6.7'], ['FSDSS-801', '5.9'], ['SSIS-833', '4.11'], ['MIDV-790', '3.8'], ['SSIS-801', '2.9'], ['ABF-152', '2025.12.5'], ['SSIS-766', '2025.11.7'], ['SSIS-731', '2025.9.12'], ['MIDV-702', '2025.8.8'], ['SSIS-690', '2025.7.11'], ['IPZZ-301', '2025.5.9'], ['SSIS-655', '2025.4.11'], ['SSIS-612', '2025.2.7'], ['MIDV-620', '2024.12.6'], ['SSIS-571', '2024.11.8'], ['SSIS-530', '2024.9.13'], ['SSIS-498', '2024.7.12']];
  const HUES = [350, 20, 200, 330, 40, 280, 10, 190, 300, 30, 220, 345, 15, 260, 5, 170, 320, 35, 210, 355];
  document.querySelectorAll('[data-shelf]').forEach(el => {
    const n = Number(el.dataset.shelf) || 20;
    el.innerHTML = WORKS.slice(0, n).map(([code, date], i) => `<div class="case"><div class="case__box">${coverArt(HUES[i], 'c' + pid++)}</div><div class="case__meta"><b>${code}</b><span class="num">${date}</span></div></div>`).join('');
  });
  function coverArt(h, id) {
    return `<svg viewBox="0 0 71 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 32% 58%)"/><stop offset="1" stop-color="hsl(${(h + 30) % 360} 26% 26%)"/></linearGradient></defs><rect width="71" height="100" fill="url(#${id})"/><ellipse cx="44" cy="40" rx="11" ry="13" fill="rgba(255,255,255,.22)"/><path d="M24 100c2-26 10-40 20-42 10 2 18 16 20 42Z" fill="rgba(255,255,255,.16)"/><rect x="6" y="8" width="26" height="5" fill="rgba(255,255,255,.55)"/><rect x="6" y="16" width="18" height="3" fill="rgba(255,255,255,.35)"/></svg>`;
  }

  requestAnimationFrame(() => {
    document.querySelectorAll('.ui-segmented').forEach(seg => {
      const cell = seg.querySelector('[data-segmented-active="true"]'), thumb = seg.querySelector('.ui-segmented__thumb');
      if (!cell || !thumb) return;
      thumb.style.left = cell.offsetLeft + 'px'; thumb.style.width = cell.offsetWidth + 'px';
    });
    // Anchor floating pieces to their trigger inside the frame: [data-anchor="selector"] [data-place="below-start|below-end"].
    document.querySelectorAll('[data-anchor]').forEach(f => {
      const frame = f.closest('.frame'), t = frame.querySelector(f.dataset.anchor);
      if (!t) return;
      const fr = frame.getBoundingClientRect(), r = t.getBoundingClientRect();
      f.style.top = (r.bottom - fr.top + 4) + 'px';
      if ((f.dataset.place || '').endsWith('end')) f.style.right = (fr.right - r.right) + 'px'; else f.style.left = (r.left - fr.left - 8) + 'px';
    });
    // Callouts: data-callouts='[["selector","1"]]' on a frame puts a numbered dot at each element's top-left corner.
    document.querySelectorAll('[data-callouts]').forEach(frame => {
      const fr = frame.getBoundingClientRect();
      JSON.parse(frame.dataset.callouts).forEach(([sel, n]) => {
        const el = frame.querySelector(sel); if (!el) return;
        const r = el.getBoundingClientRect();
        frame.insertAdjacentHTML('beforeend', `<span class="callout" style="left:${r.left - fr.left - 11}px;top:${r.top - fr.top - 11}px">${n}</span>`);
      });
    });
  });
})();
