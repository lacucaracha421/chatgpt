(() => {
  'use strict';

  // Local fixtures only: this study never calls extension or save APIs.
  const leaf = (id, name) => ({ id, name });
  const roots = [
    leaf('favorites', '즐겨찾기'),
    leaf('illustration', '일러스트'),
    { id: 'characters', name: '캐릭터', children: [
      { id: 'original', name: '오리지널', children: [
        leaf('original-a', '캐릭터 A'), leaf('original-b', '캐릭터 B'),
        leaf('original-c', '캐릭터 C'), leaf('original-d', '캐릭터 D'),
      ] },
      leaf('animation', '애니메이션'), leaf('game-characters', '게임'),
      leaf('portraits', '인물'), leaf('costumes', '의상'), leaf('references', '레퍼런스'),
    ] },
    leaf('manga', '만화'),
    { id: 'games', name: '게임', children: [
      leaf('rpg', 'RPG'), leaf('adventure', '어드벤처'), leaf('action', '액션'),
      leaf('indie', '인디'), leaf('strategy', '전략'), leaf('screenshots', '스크린샷'),
    ] },
    leaf('photo', '사진'),
  ];
  const entries = new Map();
  function index(list) {
    for (const entry of list) {
      entries.set(entry.id, entry);
      if (entry.children) index(entry.children);
    }
  }
  index(roots);

  const NS = 'http://www.w3.org/2000/svg';
  const theme = { outer: 181, inner: 91, corner: 9, gap: 3, fill: '#343e4e', selected: '#3579df', ink: '#e2eaf5', stroke: '#465265' };
  const SAVE_ICON = 'M -12 -5 V 9 Q -12 11 -10 11 H 10 Q 12 11 12 9 V -4 Q 12 -6 10 -6 H 1 L -3 -9 H -10 Q -12 -9 -12 -7 Z M 2 -2 V 6 M -2 2 L 2 6 L 6 2';
  const DOWNLOAD_ICON = 'M 0 -9 V 3 M -4 -1 L 0 3 L 4 -1 M -8 5 V 9 H 8 V 5';
  const BACK_ICON = 'M 7 -7 H -2 Q -9 -7 -9 0 V 4 M -13 0 L -9 4 L -5 0';
  const screen = document.querySelector('.screen');
  const replay = document.querySelector('#replay');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)') || { matches: false };
  const motions = new Map();
  let opened = false;
  let lastTap = null;
  let history = [];
  let items = [];
  let outgoing = null;

  function node(tag, attrs = {}, content) {
    const el = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (content !== undefined) el.textContent = content;
    return el;
  }
  function point(radius, angle) {
    const radians = angle * Math.PI / 180;
    return [440 - radius * Math.cos(radians), 265 + radius * Math.sin(radians)];
  }
  const pair = values => values.map(value => value.toFixed(2)).join(' ');
  function wedge(outer, inner, start, end, corner) {
    const od = corner / outer * 180 / Math.PI, id = corner / inner * 180 / Math.PI;
    return `M ${pair(point(outer, start + od))} A ${outer} ${outer} 0 0 0 ${pair(point(outer, end - od))} Q ${pair(point(outer, end))} ${pair(point(outer - corner, end))} L ${pair(point(inner + corner, end))} Q ${pair(point(inner, end))} ${pair(point(inner, end - id))} A ${inner} ${inner} 0 0 1 ${pair(point(inner, start + id))} Q ${pair(point(inner, start))} ${pair(point(inner + corner, start))} L ${pair(point(outer - corner, start))} Q ${pair(point(outer, start))} ${pair(point(outer, start + od))} Z`;
  }
  function stopMotion(target) {
    const running = motions.get(target);
    if (!running) return;
    motions.delete(target);
    running.animation.onfinish = null;
    running.animation.cancel();
  }
  function motion(target, frames, duration, after, easing = 'cubic-bezier(.2,0,0,1)') {
    stopMotion(target);
    if (reduced.matches || !target.animate) { after?.(); return; }
    const animation = target.animate(frames, { duration, easing });
    motions.set(target, { animation, after });
    animation.onfinish = () => {
      if (motions.get(target)?.animation !== animation) return;
      motions.delete(target);
      after?.();
    };
  }
  function clearOutgoing() {
    if (!outgoing) return;
    stopMotion(outgoing);
    outgoing.remove();
    outgoing = null;
  }
  function stopAll() {
    for (const target of [...motions.keys()]) stopMotion(target);
    clearOutgoing();
  }
  reduced.addEventListener?.('change', () => {
    if (!reduced.matches) return;
    for (const [target, running] of [...motions]) {
      stopMotion(target);
      running.after?.();
    }
  });

  screen.innerHTML = '<div class="browser"><span>‹</span><div class="address"><span class="lock"></span>x.com</div><span>⋮</span></div><div class="feed"><div class="profile"><div class="avatar"></div><div>Studio Archive<div class="handle">@studio_archive · 2h</div></div></div><div class="caption"></div><div class="caption short"></div><div class="art"></div><div class="feed-actions"><span>♡ 248</span><span>↻ 32</span><span>↗</span></div><div class="feed-rule"></div><div class="profile"><div class="avatar"></div><div>Daily Collection<div class="handle">@daily_collection · 4h</div></div></div><div class="art second"></div></div><div class="veil"></div><div class="menu"></div><div class="edge-handle"></div><div class="static-notice" role="status" aria-live="polite"></div>';
  const menu = screen.querySelector('.menu');
  const veil = screen.querySelector('.veil');
  const notice = screen.querySelector('.static-notice');
  const svg = node('svg', { viewBox: '0 0 440 524', role: 'group', 'aria-label': '분류 선택 시안' });
  menu.append(svg);
  const defs = node('defs');
  const filter = node('filter', { id: 'shadow-b', x: '-35%', y: '-25%', width: '180%', height: '160%' });
  filter.append(node('feDropShadow', { dx: 0, dy: 3, stdDeviation: 5, 'flood-color': '#172c4d', 'flood-opacity': .20 }));
  defs.append(filter); svg.append(defs);
  const sectors = node('g', { class: 'folder-sectors' });
  svg.append(sectors);
  const central = node('g', { 'aria-label': '저장 작업' });
  svg.append(central);
  central.append(node('path', { d: 'M 440 187 A 78 78 0 0 0 440 343 Z', fill: '#2b3749', stroke: '#49596f', 'stroke-width': .8, filter: 'url(#shadow-b)' }));
  function action(label, surface, fill, x, y, path, stroke) {
    const button = node('g', { class: 'center-button', role: 'button', tabindex: 0, 'aria-label': label });
    button.append(node('path', { class: 'center-surface', d: surface, fill }));
    const icon = node('g', { class: 'action-icon', transform: `translate(${x} ${y})`, fill: 'none', stroke, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', 'pointer-events': 'none' });
    const drawing = node('path', { d: path });
    icon.append(drawing); button.append(icon); central.append(button);
    return { button, drawing };
  }
  const save = action('저장 시뮬레이션', 'M 440 194 A 71 71 0 0 0 370 277 Q 371 280 376 280 L 440 280 Z', '#326ed0', 407, 244, SAVE_ICON, '#ffffff');
  const secondary = action('임시 저장 시뮬레이션', 'M 375 287 L 440 287 L 440 335 Q 394 335 375 287 Z', '#2b3749', 412, 307, DOWNLOAD_ICON, '#c5d1e3');
  const current = () => history.at(-1);
  const currentEntries = () => current().entry?.children || roots;
  const pathName = () => history.slice(1).map(frame => frame.entry.name).join(' / ') || '전체';

  function syncSelection() {
    for (const item of items) {
      const chosen = item.entry.id === current().selectedId;
      item.button.setAttribute('aria-pressed', String(chosen));
      item.tile.setAttribute('fill', chosen ? theme.selected : theme.fill);
      item.tile.setAttribute('stroke', chosen ? '#8eb8f5' : theme.stroke);
      item.tile.setAttribute('stroke-width', chosen ? 1.2 : .6);
      item.label.setAttribute('font-weight', chosen ? 750 : 540);
      item.label.setAttribute('fill', chosen ? '#ffffff' : theme.ink);
      item.rear?.setAttribute('fill', chosen ? '#759bce' : '#647187');
    }
    save.button.setAttribute('aria-label', entries.get(current().selectedId).name + '에 저장 시뮬레이션');
    secondary.button.setAttribute('aria-label', history.length > 1 ? '이전 폴더로' : '임시 저장 시뮬레이션');
    secondary.drawing.setAttribute('d', history.length > 1 ? BACK_ICON : DOWNLOAD_ICON);
    screen.dataset.depth = String(history.length - 1);
    screen.dataset.folder = current().entry?.id || 'root';
  }
  function select(entry) {
    if (!opened) return;
    current().selectedId = entry.id;
    syncSelection();
  }
  function enter(entry) {
    if (!opened || !entry.children) return;
    lastTap = null;
    history.push({ entry, selectedId: entry.id });
    renderFolders(1);
  }
  function back() {
    if (!opened || history.length < 2) return;
    lastTap = null;
    history.pop();
    renderFolders(-1);
  }
  function snapshotFolders() {
    // On rapid navigation, carry the more visible page forward, not an unseen intermediate page.
    const foregroundOpacity = parseFloat(getComputedStyle(sectors).opacity);
    const source = outgoing && foregroundOpacity < .5 ? outgoing : sectors;
    const opacity = parseFloat(getComputedStyle(source).opacity);
    const layer = source.cloneNode(true);
    layer.setAttribute('class', 'folder-exit');
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute('pointer-events', 'none');
    layer.setAttribute('inert', '');
    for (const child of layer.querySelectorAll('*')) {
      child.classList.remove('sector');
      for (const attribute of ['tabindex', 'role', 'data-id', 'aria-pressed', 'aria-label', 'aria-description']) child.removeAttribute(attribute);
    }
    return { layer, opacity: Number.isFinite(opacity) ? opacity : 1 };
  }
  function renderFolders(direction = 0) {
    const previous = direction && !reduced.matches && sectors.animate ? snapshotFolders() : null;
    clearOutgoing();
    stopMotion(sectors);
    items = [];
    sectors.replaceChildren();
    const list = currentEntries();
    for (let i = 0; i < list.length; i++) {
      const entry = list[i], angle = (i - (list.length - 1) / 2) * 30;
      const start = angle - 15 + theme.gap / 2, end = angle + 15 - theme.gap / 2;
      const button = node('g', { class: 'sector', role: 'button', tabindex: 0, 'data-id': entry.id, 'aria-label': entry.name });
      let rear = null;
      if (entry.children) {
        button.setAttribute('aria-description', '한 번 누르면 선택, 더블탭 또는 오른쪽 방향키로 하위 폴더 열기');
        rear = node('path', { class: 'rear-layer', d: wedge(theme.outer, theme.inner, start, end, theme.corner), fill: '#647187', stroke: '#8a9ab0', 'stroke-width': .5 });
        button.append(rear);
      }
      const tile = node('path', { class: 'tile', d: wedge(entry.children ? theme.outer - 6 : theme.outer, theme.inner, entry.children ? start + 1.5 : start, end, theme.corner), filter: 'url(#shadow-b)' });
      button.append(tile);
      const [x, y] = point(135, angle);
      const label = node('text', { x, y: y + 5, 'text-anchor': 'middle', 'font-size': 13.2 }, entry.name);
      button.append(label); sectors.append(button);
      items.push({ entry, button, tile, label, rear });
      button.addEventListener('click', event => {
        if (!opened) return;
        const now = performance.now();
        const doubleTap = event.detail > 0 && lastTap?.id === entry.id && now - lastTap.at < 350;
        lastTap = event.detail > 0 ? { id: entry.id, at: now } : null;
        select(entry);
        if (doubleTap) enter(entry);
      });
      button.addEventListener('keydown', event => {
        if (!opened) return;
        if (event.key === 'ArrowRight') { event.preventDefault(); select(entry); enter(entry); }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); lastTap = null; select(entry); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          items[(i + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].button.focus({ preventScroll: true });
        }
      });
    }
    syncSelection();
    notice.textContent = pathName() + ' · 실제 저장 없는 시안';
    if (direction) {
      items[0]?.button.focus({ preventScroll: true });
      // Only the visual snapshot fades out; the new page owns input from the first frame.
      if (previous) {
        const layer = previous.layer;
        outgoing = layer;
        svg.insertBefore(layer, sectors);
        motion(layer, [{ opacity: previous.opacity }, { opacity: 0 }], 140, () => {
          layer.remove();
          if (outgoing === layer) outgoing = null;
        }, 'cubic-bezier(.25,.1,.25,1)');
        motion(sectors, [{ opacity: 0 }, { opacity: 1 }], 180, null, 'cubic-bezier(.25,.1,.25,1)');
      }
    }
  }
  function closeMenu(duration = 90) {
    if (!opened) return;
    opened = false;
    lastTap = null;
    screen.dataset.open = 'false';
    menu.inert = true;
    menu.setAttribute('aria-hidden', 'true');
    menu.style.pointerEvents = 'none';
    veil.style.pointerEvents = 'none';
    if (menu.contains(document.activeElement)) replay.focus({ preventScroll: true });
    motion(menu, [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(4px)' }], duration, () => { menu.hidden = true; clearOutgoing(); stopMotion(sectors); });
    motion(veil, [{ opacity: 1 }, { opacity: 0 }], duration, () => { veil.hidden = true; });
  }
  function simulateSave(temporary) {
    if (!opened) return;
    const name = entries.get(current().selectedId).name;
    notice.textContent = temporary ? '임시 저장 효과 미리보기 · 실제 다운로드 없음' : name + ' 저장 효과 미리보기 · 실제 저장 없음';
    const drawing = temporary ? secondary.drawing : save.drawing;
    motion(drawing, [{ opacity: .7, transform: 'translateY(-2px)' }, { opacity: 1, transform: 'translateY(2px)' }], 100);
    // The fixture result is immediate. In production, success must follow a real receipt.
    closeMenu(100);
  }
  function activate(button, handler) {
    button.addEventListener('click', handler);
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handler(); }
    });
  }
  activate(save.button, () => simulateSave(false));
  activate(secondary.button, () => { if (!opened) return; history.length > 1 ? back() : simulateSave(true); });
  menu.addEventListener('keydown', event => {
    if (!opened) return;
    if (event.key === 'Backspace' || event.key === 'ArrowLeft') { event.preventDefault(); back(); }
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); }
  });
  svg.addEventListener('click', event => {
    if (event.target.closest('.sector,.center-button')) return;
    const bounds = svg.getBoundingClientRect();
    const scale = Math.min(bounds.width / 440, bounds.height / 524);
    const x = (event.clientX - bounds.left - (bounds.width - 440 * scale) / 2) / scale;
    const y = (event.clientY - bounds.top - (bounds.height - 524 * scale) / 2) / scale;
    if (x < 440 - theme.outer || Math.hypot(x - 440, y - 265) > theme.outer) closeMenu();
  });
  function openMenu() {
    stopAll();
    opened = true;
    lastTap = null;
    history = [{ entry: null, selectedId: new URLSearchParams(location.search).get('selected') === 'branch' ? 'characters' : 'illustration' }];
    screen.dataset.open = 'true';
    menu.hidden = false; veil.hidden = false;
    menu.inert = false;
    menu.removeAttribute('aria-hidden');
    menu.style.pointerEvents = ''; veil.style.pointerEvents = '';
    renderFolders();
    motion(menu, [{ opacity: .72, transform: 'translateX(8px)' }, { opacity: 1, transform: 'translateX(0)' }], 140);
    motion(veil, [{ opacity: 0 }, { opacity: 1 }], 140);
  }
  replay.addEventListener('click', openMenu);
  window.addEventListener('pagehide', () => {
    stopAll(); opened = false; menu.hidden = true; veil.hidden = true;
    screen.dataset.open = 'false';
  });
  openMenu();
})();
