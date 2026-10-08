// Mockup helpers: placeholder art, sample works, co-stars, labels and segmented thumbs. No real people or images.
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
  };
  document.querySelectorAll('[data-icon]').forEach(el => {
    const n = el.dataset.icon, small = el.hasAttribute('data-small');
    el.outerHTML = `<svg class="i${small ? ' s' : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
  });

  // Placeholder portrait: neutral gradient with a generic head-and-shoulders silhouette.
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

  const FACES = [['#5a6a7a', '#22262c', '아오이 린', 6], ['#7a5a62', '#26222a', '사쿠라기 노아', 4], ['#5f6e5c', '#21251f', '키리시마 유나', 3], ['#6d6450', '#27241d', '미즈하라 에마', 3], ['#5c5a78', '#22222c', '히나타 사키', 2], ['#7a6a5a', '#2a2420', '츠키시로 레이', 2]];
  document.querySelectorAll('[data-costars]').forEach(el => {
    const n = Number(el.dataset.costars) || 5;
    el.innerHTML = FACES.slice(0, n).map(([a, b, name, c], i) =>
      `<button class="costar" type="button"><span class="costar__face">${silhouette(a, b, 'f' + pid++ + i)}</span><span><b>${name}</b><small>${c}편</small></span></button>`).join('');
  });

  document.querySelectorAll('[data-labels]').forEach(el => {
    el.innerHTML = [['S1', 7], ['MOODYZ', 5], ['IDEA POCKET', 4], ['PRESTIGE', 2], ['FALENO', 2]]
      .map(([l, c]) => `<span class="ui-badge">${l} <span class="num">${c}</span></span>`).join('');
  });

  // 20 sample works: code, release date, solo flag.
  const WORKS = [
    ['SSIS-912', '9.12', 1], ['MIDV-871', '8.8', 1], ['IPZZ-410', '7.5', 0], ['SSIS-874', '6.7', 1], ['FSDSS-801', '5.9', 0],
    ['SSIS-833', '4.11', 1], ['MIDV-790', '3.8', 1], ['SSIS-801', '2.9', 1], ['ABF-152', '2025.12.5', 0], ['SSIS-766', '2025.11.7', 1],
    ['SSIS-731', '2025.9.12', 1], ['MIDV-702', '2025.8.8', 0], ['SSIS-690', '2025.7.11', 1], ['IPZZ-301', '2025.5.9', 0], ['SSIS-655', '2025.4.11', 1],
    ['SSIS-612', '2025.2.7', 1], ['MIDV-620', '2024.12.6', 0], ['SSIS-571', '2024.11.8', 1], ['SSIS-530', '2024.9.13', 1], ['SSIS-498', '2024.7.12', 1],
  ];
  const HUES = [350, 20, 200, 330, 40, 280, 10, 190, 300, 30, 220, 345, 15, 260, 5, 170, 320, 35, 210, 355];
  document.querySelectorAll('[data-shelf]').forEach(el => {
    const n = Number(el.dataset.shelf) || 20;
    el.innerHTML = WORKS.slice(0, n).map(([code, date], i) => {
      const h = HUES[i % HUES.length];
      return `<div class="case"><div class="case__box">${coverArt(h, 'c' + pid++)}</div><div class="case__meta"><b>${code}</b><span class="num">${date}</span></div></div>`;
    }).join('');
  });
  function coverArt(h, id) {
    return `<svg viewBox="0 0 71 100" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 32% 58%)"/><stop offset="1" stop-color="hsl(${(h + 30) % 360} 26% 26%)"/></linearGradient></defs>
      <rect width="71" height="100" fill="url(#${id})"/>
      <ellipse cx="44" cy="40" rx="11" ry="13" fill="rgba(255,255,255,.22)"/>
      <path d="M24 100c2-26 10-40 20-42 10 2 18 16 20 42Z" fill="rgba(255,255,255,.16)"/>
      <rect x="6" y="8" width="26" height="5" fill="rgba(255,255,255,.55)"/><rect x="6" y="16" width="18" height="3" fill="rgba(255,255,255,.35)"/>
      <rect x="6" y="88" width="14" height="5" fill="rgba(0,0,0,.35)"/>
    </svg>`;
  }

  // Segmented thumbs: place each under its active cell.
  requestAnimationFrame(() => document.querySelectorAll('.ui-segmented').forEach(seg => {
    const cell = seg.querySelector('[data-segmented-active="true"]'), thumb = seg.querySelector('.ui-segmented__thumb');
    if (!cell || !thumb) return;
    thumb.style.left = cell.offsetLeft + 'px'; thumb.style.width = cell.offsetWidth + 'px';
  }));
})();
