/* Mockup behaviour for folder navigation (2026-10-17). Stand-in data; the rules are the proposal (see README.md). */
(() => {
'use strict';

/* ---------- Icons (Heroicons outline paths, as the app imports them) ---------- */
const P = {
  folder: 'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',
  chevR: 'm8.25 4.5 7.5 7.5-7.5 7.5',
  chevD: 'm19.5 8.25-7.5 7.5-7.5-7.5',
  group: 'M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z',
  user: 'M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z',
  clock: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  search: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  dots: 'M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z',
  plus: 'M12 4.5v15m7.5-7.5h-15',
  stack: 'M6 6.878V6a2.25 2.25 0 0 1 2.25-2.25h7.5A2.25 2.25 0 0 1 18 6v.878m-12 0c.235-.083.487-.128.75-.128h10.5c.263 0 .515.045.75.128m-12 0A2.25 2.25 0 0 0 4.5 9v.878m13.5-3A2.25 2.25 0 0 1 19.5 9v.878m0 0a2.246 2.246 0 0 0-.75-.128H5.25c-.263 0-.515.045-.75.128m15 0A2.25 2.25 0 0 1 21 12v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6c0-.98.626-1.813 1.5-2.122',
  home: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  photo: 'm2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z',
  book: 'M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25',
  memo: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10',
  swap: 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
  grid: 'M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z',
  x: 'M6 18 18 6M6 6l12 12',
  back: 'M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18',
  pin: 'M8.4 3.6h7.2l-1.2 6 3.6 3.6H6l3.6-3.6-1.2-6zM12 13.2v7.2',
  cloud: 'M2.25 15a4.5 4.5 0 0 0 4.5 4.5H18a3.75 3.75 0 0 0 1.332-7.257 3 3 0 0 0-3.758-3.848 5.25 5.25 0 0 0-10.233 2.33A4.502 4.502 0 0 0 2.25 15Z',
  min: 'M5 12h14', max: 'M5 5h14v14H5z',
};
const svg = (name, cls = '', style = '', fill = false) =>
  `<svg class="i ${cls}" viewBox="0 0 24 24" ${fill ? 'fill="currentColor"' : ''} aria-hidden="true"${style ? ` style="${style}"` : ''}><path d="${P[name]}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLORS = { red: '#ef6b73', orange: '#f28c52', amber: '#dba84b', yellow: '#c9b94d', lime: '#8fbd52', green: '#58b67a', teal: '#47b6a7', cyan: '#4fabc9', blue: '#5b8def', indigo: '#7c7ee8', purple: '#aa75df', pink: '#df6fa7' };
const markCurrent = (el, on) => { if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- Stand-in library (realistic names, deep nesting) ---------- */
const g = (name) => [name, { group: true }];
const TREE = [
  ['캐릭터', { color: 'pink' }, [
    ['블루 아카이브', {}, [g('게헨나'), g('트리니티'), g('밀레니엄'), g('아비도스'), g('백귀야행'), g('샬레'),
      ['공식 일러스트', {}, [['메모리얼 로비'], ['기념일 일러스트'], ['카드 일러스트']]], ['4컷 만화']]],
    ['원신', {}, [g('몬드'), g('리월'), g('이나즈마'), g('수메르'), g('폰타인'), g('나타'), ['공식 일러스트']]],
    ['붕괴: 스타레일', {}, [g('야릴로-VI'), g('선주 나부'), g('페나코니'), g('앰포리어스')]],
    ['승리의 여신: 니케', {}, [g('카운터스'), g('엘리시온'), g('미실리스'), g('테트라')]],
    ['우마무스메', {}, [g('팀 스피카'), g('팀 리기루'), ['승부복']]],
    ['젠레스 존 제로', {}, [g('교활한 토끼굴'), g('빅토리아 하우스키핑'), g('벨로보그 중공업')]],
    ['명일방주', {}, [g('로도스 아일랜드'), g('펭귄 로지스틱스')]],
  ]],
  ['게임 스크린샷', { color: 'blue' }, [
    ['파이널 판타지 XIV', {}, [['하우징', {}, [['개인 집'], ['FC 하우스'], ['아파트']]], ['글래머'],
      ['레이드', {}, [['절 알렉산더'], ['절 오메가'], ['영웅 레이드']]], ['풍경']]],
    ['엘든 링', {}, [['보스전'], ['풍경'], ['포토 모드']]],
    ['젤다의 전설 티어스 오브 더 킹덤'],
    ['몬스터 헌터 와일즈', {}, [['장비 세트'], ['오토모']]],
    ['원신'],
    ['스트리트 파이터 6'],
  ]],
  ['작가별', { color: 'amber' }, [
    ['픽시브', {}, [['랭킹 저장'], ['팔로우 신작'], ['북마크 정리']]],
    ['X', {}, [['일러스트레이터'], ['코스프레']]],
    ['스케브 의뢰', {}, [['2026'], ['2025']]],
    ['팬박스', {}, [['월간 보상'], ['스케치']]],
  ]],
  ['배경화면', { color: 'teal' }, [['데스크톱 16:9'], ['세로 9:16'], ['듀얼 모니터'], ['태블릿']]],
  ['레퍼런스', { color: 'purple' }, [
    ['인체', {}, [['손', {}, [['쥐는 손'], ['펼친 손']]], ['포즈'], ['얼굴 각도']]],
    ['옷 주름'], ['배경 원근'], ['색 배색'],
  ]],
  ['오리지널', {}],
];

const nodes = new Map();
const roots = [];
let seq = 0;
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0; }
(function build(list, parent, color) {
  for (const [name, meta = {}, kids = []] of list) {
    const id = `f${++seq}`;
    const node = { id, name, parent, group: !!meta.group, color: meta.color ? COLORS[meta.color] : color, children: [] };
    node.count = 40 + (hash(id + name) % 1800);
    nodes.set(id, node);
    (parent ? nodes.get(parent).children : roots).push(id);
    build(kids, id, node.color);
  }
})(TREE, null, null);
// subtree counts (a folder shows itself plus everything below, as the sidebar does)
(function total(ids) { let s = 0; for (const id of ids) { const n = nodes.get(id); n.total = n.count + total(n.children); s += n.total; } return s; })(roots);
const byPath = (path) => { let ids = roots, node; for (const name of path.split(' > ')) { node = ids.map((id) => nodes.get(id)).find((n) => n.name === name); if (!node) throw new Error(path); ids = node.children; } return node.id; };
const ancestors = (id) => { const out = []; let n = nodes.get(id); while (n && n.parent) { out.unshift(n.parent); n = nodes.get(n.parent); } return out; };
const descendants = (id) => { const out = []; const walk = (x) => { for (const c of nodes.get(x).children) { out.push(c); walk(c); } }; walk(id); return out; };
const siblings = (id) => { const n = nodes.get(id); return (n.parent ? nodes.get(n.parent).children : roots).filter((x) => x !== id); };
const pathText = (id) => ancestors(id).map((a) => nodes.get(a).name).join(' › ');
const fmt = (n) => n.toLocaleString('ko-KR');
const icon = (n) => (n.group ? 'group' : 'folder');
/** The set a followed location leaves open: its ancestors, and itself when it has subfolders. */
const followSet = (id) => new Set([...ancestors(id), ...(nodes.get(id).children.length ? [id] : [])]);

/* ---------- PC instance ---------- */
const DWELL_MS = 3000, LIST_MAX = 8, BAR_MAX = 5;

class PcMock {
  constructor(host, opts) {
    this.host = host; this.opts = opts;
    this.readout = document.getElementById(opts.readout);
    this.current = opts.current ? byPath(opts.current) : null;
    this.expanded = new Set(opts.expanded ? opts.expanded.map(byPath) : this.current ? followSet(this.current) : []);
    this.accordion = opts.accordion !== false;
    this.pinned = (opts.pinned || []).map(byPath);
    this.recent = (opts.recent || []).map(byPath);
    const now = Date.now();
    this.lastUsed = new Map(this.recent.map((id, i) => [id, now - i * 60000]));
    if (this.current && this.recent.includes(this.current)) this.lastUsed.set(this.current, now + 1);
    this.pending = null; this.dwell = 0; this.anim = 0;
    this.render();
    if (opts.scrollTo) requestAnimationFrame(() => this.revealRow(this.current, false));
    if (opts.menuOpen) requestAnimationFrame(() => this.toggleRecentMenu(true));
  }

  /* --- DOM --- */
  render() {
    const o = this.opts;
    this.host.innerHTML = `
      <div class="frame pc" style="width:${o.width}px;height:${o.height}px">
        <div class="workspace-navigation">
          <nav class="workspace-rail" aria-label="주요 영역">
            <span class="workspace-mark"><span class="mark"></span></span>
            ${[['home', '홈'], ['photo', '에셋', 1], ['stack', '컬렉션'], ['book', '망가'], ['memo', '메모'], ['swap', '전송']].map(([i, l, on]) =>
              `<button type="button" class="workspace-rail__item"${on ? ' aria-current="page"' : ''}>${svg(i)}<span>${l}</span></button>`).join('')}
            <div class="workspace-rail__tail"><button type="button" class="workspace-rail__item">${svg('search')}<span>찾기</span></button><button type="button" class="workspace-rail__item">${svg('dots')}<span>더보기</span></button></div>
          </nav>
          <div class="workspace-index-slot" data-state="open">
            <div class="workspace-index-clip">
              <aside class="workspace-index" aria-label="탐색 인덱스" style="--workspace-index-width:240px">
                <header class="workspace-index__head"><span class="workspace-index__title">에셋</span><div class="workspace-index__head-actions"><button type="button" class="ui-button ui-button--icon ui-button--ghost" aria-label="파일 가져오기">${svg('plus')}</button></div></header>
                <div class="workspace-index__scroll" data-scroller>
                  <nav class="classification-sidebar__pins asset-index__top" aria-label="에셋 보기">
                    ${[['folder', '전체', 'all'], ['user', '작가'], ['stack', '앨범']].map(([i, l, k]) =>
                      `<button type="button" class="classification-sidebar__quick-view" style="min-height:32px" data-quick="${k || ''}"><span class="classification-sidebar__quick-view-surface">${svg(i)}<span class="classification-sidebar__quick-view-label">${l}</span></span></button>`).join('')}
                  </nav>
                  <aside class="classification-sidebar classification-sidebar--embedded" aria-label="분류">
                    ${this.pinned.length ? `<nav class="classification-sidebar__pins" aria-label="고정 폴더"><div class="ui-section-label workspace-section-label"><span class="ui-section-label__title">고정</span><span class="ui-section-label__rule"></span></div><div class="classification-sidebar__pin-chips">${this.pinned.map((id) =>
                      `<button type="button" class="classification-sidebar__pin" data-pin="${id}" aria-description="${esc(pathText(id))}">${svg('pin', '', '', true)}<span>${esc(nodes.get(id).name)}</span></button>`).join('')}</div></nav>` : ''}
                    <section class="classification-sidebar__folder-section" aria-label="폴더 탐색">
                      <div class="chrome-tree-heading"><button type="button" class="classification-sidebar__tree-heading" aria-expanded="true">${svg('chevR')}<span>폴더</span></button>
                        <button type="button" class="ui-button ui-button--icon ui-button--ghost classification-sidebar__heading-menu" data-tree-menu aria-label="폴더 보기 옵션" style="width:24px;min-height:24px;padding:0">${svg('dots')}</button></div>
                      <div class="classification-sidebar__reveal" data-open="true"><ul class="classification-sidebar__tree" role="tree" aria-label="폴더">${roots.map((id, i) => this.item(id, i < roots.length - 1)).join('')}</ul></div>
                    </section>
                  </aside>
                </div>
              </aside>
            </div>
          </div>
        </div>
        <div class="workspace-content">
          <div class="workspace-titlebar">
            <div class="workspace-titlebar__context">
              <header class="view-toolbar view-toolbar--context" role="toolbar" aria-label="자산 도구">
                <h2 data-title></h2>
                ${o.noRecent ? '<span style="flex:1"></span>' : `<nav class="recent-folders" aria-label="최근 폴더">
                  <button type="button" class="ui-button ui-button--quiet recent-folders__more" aria-label="최근 폴더" aria-haspopup="menu" aria-expanded="false" data-recent-more>${svg('clock')}<span class="ui-badge ui-badge--corner" data-hidden-count hidden></span></button>
                  <div class="recent-folders__list" data-recent-list></div>
                </nav>`}
                <div class="asset-toolbar__controls">
                  <button type="button" class="ui-button ui-button--quiet">${svg('search')}<span>검색</span></button>
                  <button type="button" class="ui-menu__trigger asset-toolbar__quiet-menu">${svg('grid')}<span>보기</span></button>
                </div>
              </header>
            </div>
            <span class="status-dot">${svg('cloud')}</span>
            <div class="window-controls"><span>${svg('min')}</span><span>${svg('max')}</span><span>${svg('x')}</span></div>
          </div>
          <div class="library-content" data-content></div>
        </div>
        <div class="ui-menu mock-menu recent-folders__menu is-closed" role="menu" data-recent-menu></div>
        <div class="ui-menu mock-menu tree-menu is-closed" role="menu" data-tree-menu-surface>
          <button type="button" class="ui-menu__item" role="menuitem" data-collapse-all><span class="ui-menu__item-label">모든 폴더 접기</span></button>
        </div>
      </div>`;
    const $ = (s) => this.host.querySelector(s);
    this.frame = $('.frame'); this.scroller = $('[data-scroller]'); this.tree = $('.classification-sidebar__tree');
    this.titleEl = $('[data-title]'); this.content = $('[data-content]');
    this.list = $('[data-recent-list]'); this.more = $('[data-recent-more]'); this.menu = $('[data-recent-menu]');
    this.hiddenBadge = $('[data-hidden-count]'); this.treeMenu = $('[data-tree-menu-surface]');
    this.rows = new Map([...this.host.querySelectorAll('[data-row]')].map((r) => [r.dataset.row, r]));
    this.wire();
    this.applyExpanded(this.expanded);
    this.paintCurrent();
    this.renderRecent(false);
    if (this.list) new ResizeObserver(() => this.fitRecent()).observe(this.list.parentElement);
  }

  item(id, hasNext) {
    const n = nodes.get(id), kids = n.children.length > 0;
    return `<li class="classification-sidebar__tree-item"${hasNext ? ' data-has-next-sibling="true"' : ''}>
      <div class="classification-sidebar__tree-row" role="treeitem" tabindex="-1" data-row="${id}" aria-label="${esc(n.name)}" aria-selected="false"${kids ? ' aria-expanded="false"' : ''}>
        ${kids ? `<button type="button" class="ui-button ui-button--icon ui-button--ghost classification-sidebar__tree-toggle" data-toggle="${id}" aria-label="${esc(n.name)} 펼치기">${svg('chevR', 'classification-sidebar__tree-toggle-mark')}</button>` : '<span class="classification-sidebar__tree-spacer" aria-hidden="true"></span>'}
        <span class="classification-sidebar__tree-surface">${svg(icon(n), 'classification-sidebar__tree-folder', n.color ? `color:${n.color}` : '')}<span class="classification-sidebar__tree-label">${esc(n.name)}</span><span class="classification-sidebar__badge classification-sidebar__hover-count" aria-hidden="true">${fmt(n.total)}</span></span>
      </div>
      ${kids ? `<div class="classification-sidebar__reveal" data-reveal="${id}" data-open="false"><ul role="group">${n.children.map((c, i) => this.item(c, i < n.children.length - 1)).join('')}</ul></div>` : ''}
    </li>`;
  }

  wire() {
    this.tree.addEventListener('click', (e) => {
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) { e.stopPropagation(); this.onChevron(toggle.dataset.toggle, e.ctrlKey || e.metaKey); return; }
      const row = e.target.closest('[data-row]');
      if (row) this.openFromTree(row.dataset.row, row);
    });
    this.host.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', () => this.openFromOutside(b.dataset.pin, 'pin')));
    this.host.querySelector('[data-quick="all"]').addEventListener('click', () => { this.setCurrent(null); this.say('<b>전체</b>를 열었습니다. 폴더 트리는 그대로 둡니다.'); });
    this.content.addEventListener('click', (e) => { const c = e.target.closest('[data-open-folder]'); if (c) this.openFromOutside(c.dataset.openFolder, 'shelf'); });
    // Folding that was postponed because the pointer was over the tree happens once the pointer leaves the index.
    this.scroller.addEventListener('pointerleave', () => this.flushPending());
    if (this.more) {
      this.more.addEventListener('click', (e) => { e.stopPropagation(); this.toggleRecentMenu(); });
      this.list.addEventListener('click', (e) => { const c = e.target.closest('[data-chip]'); if (c) this.openFromOutside(c.dataset.chip, 'chip'); });
      this.list.addEventListener('contextmenu', (e) => { const c = e.target.closest('[data-chip]'); if (!c) return; e.preventDefault(); this.removeRecent(c.dataset.chip); });
      this.menu.addEventListener('click', (e) => {
        const it = e.target.closest('[data-menu-open]');
        if (it) { this.toggleRecentMenu(false); this.openFromOutside(it.dataset.menuOpen, 'menu'); }
        if (e.target.closest('[data-clear]')) { this.toggleRecentMenu(false); this.clearRecent(); }
      });
    }
    this.host.querySelector('[data-tree-menu]').addEventListener('click', (e) => { e.stopPropagation(); this.toggleTreeMenu(); });
    this.treeMenu.querySelector('[data-collapse-all]').addEventListener('click', () => {
      this.toggleTreeMenu(false); this.applyExpanded(new Set()); this.paintCurrent();
      this.say('<b>모든 폴더 접기</b>: 다 접힙니다. 지금 연 폴더가 숨으면 그 맨 위 폴더에 옅은 표시가 남습니다.');
    });
    document.addEventListener('click', (e) => {
      if (this.menu && !this.menu.contains(e.target)) this.toggleRecentMenu(false);
      if (!this.treeMenu.contains(e.target)) this.toggleTreeMenu(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.toggleRecentMenu(false); this.toggleTreeMenu(false); } });
  }

  say(html) { if (this.readout) this.readout.innerHTML = html; }

  /* --- Tree state --- */
  applyExpanded(next) {
    this.expanded = new Set(next);
    for (const [id, row] of this.rows) {
      if (!nodes.get(id).children.length) continue;
      const open = this.expanded.has(id);
      row.setAttribute('aria-expanded', open);
      row.querySelector('.classification-sidebar__tree-toggle-mark').dataset.state = open ? 'expanded' : 'collapsed';
      row.querySelector('[data-toggle]').setAttribute('aria-label', `${nodes.get(id).name} ${open ? '접기' : '펼치기'}`);
      const reveal = row.parentElement.querySelector(':scope > [data-reveal]');
      reveal.dataset.open = open; reveal.inert = !open; reveal.setAttribute('aria-hidden', !open);
    }
    this.paintHolder();
  }
  /** The nearest visible ancestor of a folded-away current row takes the parent-context tint. */
  paintHolder() {
    this.rows.forEach((r) => r.removeAttribute('data-holds-current'));
    if (!this.current) return;
    const hidden = ancestors(this.current).find((a) => !this.expanded.has(a));
    if (hidden) this.rows.get(hidden).dataset.holdsCurrent = 'true';
  }
  closing(next) { return [...this.expanded].filter((id) => !next.has(id)); }

  onChevron(id, keepOthers) {
    const n = nodes.get(id);
    if (this.expanded.has(id)) {
      const next = new Set(this.expanded); next.delete(id); descendants(id).forEach((d) => next.delete(d));
      this.applyAnchored(next, this.rows.get(id));
      this.say(`<b>${esc(n.name)}</b> 접기: 그 아래 열린 폴더도 함께 접힙니다.`);
      return;
    }
    const next = new Set(this.expanded); next.add(id);
    let folded = [];
    if (this.accordion && !keepOthers) for (const s of siblings(id)) if (next.has(s)) { folded.push(nodes.get(s).name); next.delete(s); descendants(s).forEach((d) => next.delete(d)); }
    const deferred = this.applyAnchored(next, this.rows.get(id));
    this.say(keepOthers ? `<b>${esc(n.name)}</b>를 <kbd>Ctrl</kbd>+클릭으로 펼침: 같은 단계의 다른 폴더를 그대로 둡니다.`
      : `<b>${esc(n.name)}</b> 펼치기${folded.length ? ` → 같은 단계의 <b>${folded.map(esc).join(', ')}</b> 접힘` : ''}${deferred ? ' (위쪽 접기는 포인터가 사이드바를 떠날 때)' : ''}.`);
  }

  /** Open from inside the tree: the clicked row stays under the pointer while the other branches fold. */
  openFromTree(id, row) {
    const next = this.accordion ? followSet(id) : new Set([...this.expanded, ...followSet(id)]);
    const folded = this.closing(next).length;
    const deferred = this.applyAnchored(next, row);
    this.setCurrent(id, 'tree');
    this.say(`트리에서 <b>${esc(nodes.get(id).name)}</b> 열기${folded ? ' → 다른 갈래 접힘, 누른 줄은 포인터 아래 그대로' : ''}${deferred ? ' · 위쪽 갈래는 포인터가 사이드바를 떠나면 접힙니다' : ''}. ${this.dwellNote(id)}`);
  }

  /** Open from elsewhere (recent chip, pin, folder shelf, palette): follow the location. */
  openFromOutside(id, source) {
    const prev = this.current;
    this.setCurrent(id, source);
    const next = this.accordion ? followSet(id) : new Set([...this.expanded, ...followSet(id)]);
    this.flushPending(true);
    this.revealRow(id, true, next);
    const names = { chip: '최근 칩', menu: '최근 폴더 메뉴', pin: '고정', shelf: '폴더 선반' };
    const recentNote = source === 'pin' ? '고정 폴더는 이미 한 번에 열리므로 최근에 넣지 않습니다.' : source === 'chip' || source === 'menu' ? '칩 자리는 그대로입니다.' : this.dwellNote(id);
    this.say(`${names[source]}에서 <b>${esc(nodes.get(id).name)}</b> 열기 → 사이드바가 그 경로만 펼치고 줄을 화면 안으로 부드럽게 가져옵니다. ${prev === id ? '' : recentNote}`);
  }

  dwellNote(id) {
    if (this.pinned.includes(id)) return '고정 폴더라 최근에 넣지 않습니다.';
    if (this.recent.includes(id)) return '이미 최근에 있어 칩 자리는 그대로입니다.';
    return '3초 머물면 최근에 들어갑니다.';
  }

  /**
   * Apply a new open set while keeping `row` where it is on screen. Branches above the row that are
   * taller than the room the scroller has to give are left open until the pointer leaves the index.
   * Returns true when some folding was postponed.
   */
  applyAnchored(next, row) {
    this.pending = null;
    const closing = this.closing(next);
    const rowTop = row.getBoundingClientRect().top;
    const outer = closing.filter((id) => !closing.includes(nodes.get(id).parent));
    let above = 0; const aboveIds = [];
    for (const id of outer) {
      const reveal = this.rows.get(id).parentElement.querySelector(':scope > [data-reveal]');
      const r = reveal.getBoundingClientRect();
      if (r.height > 0 && r.bottom <= rowTop + 1) { above += r.height; aboveIds.push(id); }
    }
    let target = next;
    if (above > this.scroller.scrollTop + 1) {
      target = new Set(next);
      for (const id of aboveIds) { target.add(id); descendants(id).forEach((d) => this.expanded.has(d) && target.add(d)); }
      this.pending = next;
    }
    this.applyExpanded(target);
    this.holdRow(row, rowTop);
    return !!this.pending;
  }
  flushPending(silent) {
    if (!this.pending) return;
    const next = this.pending; this.pending = null;
    this.applyExpanded(next);
    if (!silent) this.say('포인터가 사이드바를 떠나서 미뤄 둔 위쪽 갈래를 접었습니다.');
  }
  /** Keep a row at a fixed screen position while the reveal heights animate (scroll compensation). */
  holdRow(row, top) {
    cancelAnimationFrame(this.anim);
    const start = performance.now(), dur = reduced() ? 0 : 420;
    const step = (t) => {
      const d = row.getBoundingClientRect().top - top;
      if (Math.abs(d) > 0.5) this.scroller.scrollTop += d;
      if (t - start < dur) this.anim = requestAnimationFrame(step);
    };
    step(start);
  }
  /**
   * Fold to `next` and bring the row into view. The final layout is measured first with transitions
   * off (one synchronous pass, nothing paints in between), so the scroll and the fold run together.
   */
  revealRow(id, animate, next = this.expanded) {
    if (!id) return;
    const row = this.rows.get(id), sc = this.scroller, old = new Set(this.expanded);
    const frame = this.frame;
    frame.classList.add('is-measuring');
    this.applyExpanded(next); void sc.offsetHeight;
    const scRect = sc.getBoundingClientRect();
    const y = row.getBoundingClientRect().top - scRect.top + sc.scrollTop;
    const max = sc.scrollHeight - sc.clientHeight;
    this.applyExpanded(old); void sc.offsetHeight;
    frame.classList.remove('is-measuring'); void sc.offsetHeight;
    this.applyExpanded(next);
    const view = sc.clientHeight, from = sc.scrollTop;
    const visible = y >= from + 8 && y + 32 <= from + view - 8;
    const to = visible ? from : Math.max(0, Math.min(max, Math.round(y - view * 0.35)));
    cancelAnimationFrame(this.anim);
    if (!animate || reduced() || to === from) { sc.scrollTop = to; return; }
    const start = performance.now(), dur = 320, ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur);
      sc.scrollTop = from + (to - from) * ease(k);
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  setCurrent(id, source) {
    this.current = id;
    this.paintCurrent();
    clearTimeout(this.dwell);
    if (!id || this.opts.noRecent) return;
    if (this.recent.includes(id)) { this.lastUsed.set(id, Date.now()); this.renderRecent(false); return; }
    if (this.pinned.includes(id)) { this.renderRecent(false); return; }
    this.renderRecent(false);
    this.dwell = setTimeout(() => { if (this.current === id) { this.addRecent(id); this.say(`<b>${esc(nodes.get(id).name)}</b>에 3초 머물러 최근 맨 앞에 들어갔습니다. 다른 칩은 한 칸씩 밀리고, 가장 오래 안 쓴 칩이 빠집니다.`); } }, DWELL_MS);
  }

  paintCurrent() {
    for (const [id, row] of this.rows) row.setAttribute('aria-selected', id === this.current);
    markCurrent(this.host.querySelector('[data-quick="all"]'), !this.current);
    this.host.querySelectorAll('[data-pin]').forEach((b) => markCurrent(b, b.dataset.pin === this.current));
    this.titleEl.textContent = this.current ? nodes.get(this.current).name : '전체';
    this.paintHolder();
    this.renderContent();
  }

  /* Content swaps in one step (no fade): folder shelf at a folder's top level, then stand-in tiles. */
  renderContent() {
    const id = this.current, n = id ? nodes.get(id) : null;
    const kids = n ? n.children : roots;
    const hue = (s) => hash(s) % 360;
    const tile = (seed) => { const h = hue(seed), w = 90 + (hash(seed + 'w') % 170); return `<span style="width:${w}px;background:linear-gradient(160deg,hsl(${h} 22% 30%),hsl(${(h + 40) % 360} 18% 18%))"></span>`; };
    const shelf = kids.length ? `<section class="mock-shelf"><div class="ui-section-label"><span class="ui-section-label__title">폴더 ${kids.length}</span><span class="ui-section-label__rule"></span></div><div class="mock-shelf__track">${kids.slice(0, 8).map((c) => {
      const k = nodes.get(c), h = hue(k.name);
      return `<button type="button" class="mock-card" data-open-folder="${c}" style="--folder-color:${k.color || 'var(--color-muted)'}"><span class="mock-card__cover" style="background:linear-gradient(150deg,hsl(${h} 24% 32%),hsl(${(h + 50) % 360} 16% 17%))"></span><span class="mock-card__name">${svg(icon(k))}${esc(k.name)}</span></button>`;
    }).join('')}</div></section>` : '';
    const days = ['10.17', '10.16', '10.14'];
    this.content.innerHTML = shelf + days.map((d, i) => `<div class="mock-date">${d}</div><div class="mock-tiles">${Array.from({ length: 5 + (hash((id || 'all') + d) % 6) }, (_, k) => tile(`${id}${d}${k}`)).join('')}</div>`).join('');
  }

  /* --- Recent folders --- */
  addRecent(id) {
    this.lastUsed.set(id, Date.now());
    if (this.recent.includes(id)) return this.renderRecent(true);
    if (this.recent.length >= LIST_MAX) {
      const lru = [...this.recent].sort((a, b) => this.lastUsed.get(a) - this.lastUsed.get(b))[0];
      this.recent = this.recent.filter((x) => x !== lru);
    }
    this.recent.unshift(id);
    this.renderRecent(true, id);
  }
  removeRecent(id) {
    this.recent = this.recent.filter((x) => x !== id);
    this.renderRecent(true);
    this.say(`<b>${esc(nodes.get(id).name)}</b>를 최근에서 뺐습니다 (칩 우클릭 → 최근에서 빼기).`);
  }
  clearRecent() { this.recent = []; this.renderRecent(true); this.say('최근 목록을 비웠습니다.'); }

  renderRecent(animate, entering) {
    if (!this.list) return;
    const before = new Map([...this.list.querySelectorAll('[data-chip]:not([hidden])')].map((c) => [c.dataset.chip, c.getBoundingClientRect().left]));
    const shown = this.recent.slice(0, BAR_MAX);
    const names = this.recent.map((x) => nodes.get(x).name);
    const existing = new Map([...this.list.querySelectorAll('[data-chip]')].map((c) => [c.dataset.chip, c]));
    // leaving chips fade out where they are, then go
    for (const [id, el] of existing) if (!shown.includes(id)) {
      if (animate && !reduced()) { el.classList.add('is-leaving'); el.removeAttribute('data-chip'); setTimeout(() => { el.remove(); this.fitRecent(); }, 140); }
      else el.remove();
    }
    let anchor = null;
    for (const id of shown) {
      const n = nodes.get(id);
      let el = existing.get(id);
      if (!el) {
        el = document.createElement('button'); el.type = 'button'; el.className = 'ui-button ui-button--quiet recent-folders__chip'; el.dataset.chip = id;
        if (animate && id === entering && !reduced()) { el.classList.add('is-entering'); el.addEventListener('animationend', () => el.classList.remove('is-entering'), { once: true }); }
      }
      const dup = names.filter((x) => x === n.name).length > 1;
      el.style.setProperty('--folder-color', n.color || 'var(--color-muted)');
      el.innerHTML = `${svg(icon(n))}<span>${dup ? `<span class="recent-folders__parent">${esc(nodes.get(n.parent).name)} › </span>` : ''}${esc(n.name)}</span>`;
      el.setAttribute('aria-description', [...ancestors(id).map((a) => nodes.get(a).name), n.name].join(' / '));
      markCurrent(el, id === this.current);
      if (anchor ? anchor.nextSibling !== el : this.list.firstChild !== el) this.list.insertBefore(el, anchor ? anchor.nextSibling : this.list.firstChild);
      anchor = el;
    }
    this.fitRecent();
    if (animate && !reduced()) for (const el of this.list.querySelectorAll('[data-chip]')) {
      const was = before.get(el.dataset.chip); if (was === undefined) continue;
      const dx = was - el.getBoundingClientRect().left; if (Math.abs(dx) < 1) continue;
      el.style.transition = 'none'; el.style.transform = `translateX(${dx}px)`;
      void el.offsetWidth; // commit the start position, then slide to the new one
      el.style.transition = 'transform 200ms var(--ease-standard)'; el.style.transform = '';
    }
    this.renderMenu();
  }
  /** Show as many chips as fit; the rest are counted on the 최근 button and listed in its menu. */
  fitRecent() {
    if (!this.list) return;
    const chips = [...this.list.querySelectorAll('[data-chip]')];
    chips.forEach((c) => { c.hidden = false; });
    const room = this.list.parentElement.getBoundingClientRect().right;
    let hidden = 0;
    for (let i = chips.length - 1; i >= 0; i--) {
      if (chips[i].getBoundingClientRect().right <= room + 0.5 && this.list.scrollWidth <= this.list.clientWidth + 0.5) break;
      chips[i].hidden = true; hidden++;
    }
    this.hiddenBadge.hidden = hidden === 0;
    this.hiddenBadge.textContent = hidden;
    this.more.setAttribute('aria-description', hidden ? `칩 ${hidden}개가 좁아서 메뉴에만 있음` : '');
    this.more.hidden = this.recent.length === 0;
  }
  renderMenu() {
    if (!this.menu) return;
    this.menu.innerHTML = `<div class="ui-section-label"><span class="ui-section-label__title">최근 폴더</span><span class="ui-section-label__rule"></span></div>
      ${this.recent.map((id) => { const n = nodes.get(id), cur = id === this.current;
        return `<button type="button" class="ui-menu__item" role="menuitem" data-menu-open="${id}"${cur ? ' data-selected="true"' : ''} style="--folder-color:${n.color || 'var(--color-muted)'}"><span class="ui-menu__item-icon">${svg(icon(n))}</span><span class="ui-menu__item-label">${esc(n.name)}</span><span class="recent-folders__path"><bdi>${esc(pathText(id))}</bdi></span><span class="ui-menu__item-check" aria-hidden="true"></span></button>`; }).join('')}
      <div class="recent-folders__sep"></div>
      <button type="button" class="ui-menu__item" role="menuitem" data-clear><span class="ui-menu__item-label" style="color:var(--color-muted)">최근 목록 비우기</span></button>`;
  }
  toggleRecentMenu(force) {
    if (!this.menu || !this.more) return;
    const open = force ?? this.menu.classList.contains('is-closed');
    if (open) {
      this.renderMenu();
      const f = this.frame.getBoundingClientRect(), b = this.more.getBoundingClientRect();
      this.menu.style.left = `${Math.min(b.left - f.left, f.width - 328)}px`; this.menu.style.top = `${b.bottom - f.top + 6}px`;
    }
    this.menu.classList.toggle('is-closed', !open);
    this.more.setAttribute('aria-expanded', open);
  }
  toggleTreeMenu(force) {
    const open = force ?? this.treeMenu.classList.contains('is-closed');
    if (open) { const f = this.frame.getBoundingClientRect(), b = this.host.querySelector('[data-tree-menu]').getBoundingClientRect(); this.treeMenu.style.left = `${b.left - f.left}px`; this.treeMenu.style.top = `${b.bottom - f.top + 4}px`; }
    this.treeMenu.classList.toggle('is-closed', !open);
  }
}

/* ---------- Tablet (static layout, chips switch the place) ---------- */
function tabletChips(ids, current) {
  const names = ids.map((x) => nodes.get(x).name);
  return ids.map((id) => { const n = nodes.get(id), dup = names.filter((x) => x === n.name).length > 1;
    return `<button type="button" class="ui-button ui-button--quiet recent-folders__chip" style="--folder-color:${n.color || 'var(--color-muted)'}"${id === current ? ' aria-current="page"' : ''}>${svg(icon(n))}<span>${dup ? `<span class="recent-folders__parent">${esc(nodes.get(n.parent).name)} › </span>` : ''}${esc(n.name)}</span></button>`; }).join('');
}
const swatch = (seed) => { const h = hash(seed) % 360; return `background:linear-gradient(150deg,hsl(${h} 24% 32%),hsl(${(h + 50) % 360} 16% 17%))`; };
function mountTablet(host, variant, recent, scale) {
  const ids = recent.map(byPath);
  host.style.width = `${800 * scale}px`; host.style.height = `${1280 * scale}px`;
  const nav = `<div class="t-nav">${['홈', '에셋', '컬렉션', '망가', '메모'].map((l) => `<span${l === '에셋' ? ' class="on"' : ''}>${l}</span>`).join('')}</div>`;
  if (variant === 'root') {
    const top = roots.map((id) => nodes.get(id));
    host.innerHTML = `<div class="tablet" style="transform:scale(${scale})">
      <header class="t-bar"><span class="brand"></span><h1>에셋</h1><span class="t-space"></span><span class="t-icon">${svg('search')}</span><span class="t-icon">${svg('dots')}</span></header>
      <div class="t-scroll">
        <div class="t-all"><span class="covers">${[1, 2, 3, 4].map((k) => `<span style="${swatch('all' + k)}"></span>`).join('')}</span><span><strong>모든 이미지</strong><small>${fmt(48213)}장</small></span></div>
        <div class="ui-section-label"><span class="ui-section-label__title">최근</span><span class="ui-section-label__rule"></span></div>
        <div class="t-recent">${tabletChips(ids)}</div>
        <div class="ui-section-label"><span class="ui-section-label__title">분류</span> <span class="ui-section-label__count">${top.length}</span><span class="ui-section-label__rule"></span></div>
        <div class="t-grid">${top.map((n) => `<button type="button" class="t-folder" style="--folder-color:${n.color || 'var(--color-muted)'}"><span style="${swatch(n.name)}"></span><span>${svg('folder')}${esc(n.name)}</span></button>`).join('')}</div>
      </div>${nav}</div>`;
  } else {
    const id = byPath('게임 스크린샷 > 파이널 판타지 XIV > 하우징'), n = nodes.get(id);
    host.innerHTML = `<div class="tablet" style="transform:scale(${scale})">
      <header class="t-bar has-back"><span class="t-icon">${svg('back')}</span><div class="t-titles"><div class="t-crumbs">${ancestors(id).map((a) => `<span>${esc(nodes.get(a).name)}</span>`).join('')}</div><h1>${esc(n.name)} <small>${fmt(n.total)}</small></h1></div><span class="t-space"></span><span class="t-icon">${svg('grid')}</span><span class="t-icon">${svg('search')}</span><span class="t-icon">${svg('dots')}</span></header>
      <div class="t-shade">
        <div class="ui-segmented-mock"><span>미분류</span><span class="on">전체</span></div>
        <div class="ui-section-label"><span class="ui-section-label__title">최근</span><span class="ui-section-label__rule"></span></div>
        <div class="t-recent">${tabletChips(ids, id)}</div>
      </div>
      <div class="t-dim"></div>
      <div class="t-scroll" style="padding-top:150px">
        <div class="ui-section-label"><span class="ui-section-label__title">폴더 ${n.children.length}</span><span class="ui-section-label__rule"></span></div>
        <div class="t-grid">${n.children.map((c) => `<button type="button" class="t-folder"><span style="${swatch(nodes.get(c).name)}"></span><span>${svg('folder')}${esc(nodes.get(c).name)}</span></button>`).join('')}</div>
        <div class="t-tiles">${Array.from({ length: 9 }, (_, k) => `<span style="width:${150 + (hash('t' + k) % 160)}px;${swatch('tile' + k)}"></span>`).join('')}</div>
      </div>${nav}</div>`;
  }
  // tapping a chip marks it current (the real tap opens the folder)
  host.querySelectorAll('.recent-folders__chip').forEach((c) => c.addEventListener('click', () => {
    host.querySelectorAll('.recent-folders__chip').forEach((x) => x.removeAttribute('aria-current')); c.setAttribute('aria-current', 'page');
    const h1 = host.querySelector('h1'); if (variant !== 'root' && h1) h1.firstChild.textContent = c.textContent.split(' › ').pop() + ' ';
  }));
}

/* ---------- Mount ---------- */
const RECENT = ['캐릭터 > 블루 아카이브 > 게헨나', '게임 스크린샷 > 파이널 판타지 XIV > 하우징', '게임 스크린샷 > 엘든 링 > 풍경', '레퍼런스 > 인체 > 손 > 쥐는 손', '배경화면 > 데스크톱 16:9',
  '작가별 > 스케브 의뢰 > 2026', '캐릭터 > 블루 아카이브 > 공식 일러스트 > 메모리얼 로비', '게임 스크린샷 > 파이널 판타지 XIV > 풍경'];
const PINS = ['게임 스크린샷 > 파이널 판타지 XIV > 레이드', '작가별 > 픽시브 > 랭킹 저장'];

new PcMock(document.getElementById('pc-before'), {
  width: 304, height: 720, noRecent: true, accordion: false, pinned: PINS, current: '레퍼런스 > 인체 > 손 > 쥐는 손',
  expanded: ['캐릭터', '캐릭터 > 블루 아카이브', '캐릭터 > 원신', '캐릭터 > 블루 아카이브 > 공식 일러스트', '게임 스크린샷', '게임 스크린샷 > 파이널 판타지 XIV', '게임 스크린샷 > 파이널 판타지 XIV > 하우징', '작가별', '작가별 > 픽시브', '레퍼런스', '레퍼런스 > 인체', '레퍼런스 > 인체 > 손'],
  scrollTo: true,
});
new PcMock(document.getElementById('pc-live'), {
  width: 1376, height: 800, readout: 'pc-live-readout', pinned: PINS, recent: RECENT, current: '캐릭터 > 블루 아카이브 > 게헨나',
});
new PcMock(document.getElementById('pc-narrow'), {
  width: 860, height: 560, readout: 'pc-narrow-readout', pinned: PINS, recent: RECENT, current: '게임 스크린샷 > 파이널 판타지 XIV > 하우징', menuOpen: true,
});
const TABLET_SCALE = Math.min(0.6, (Math.min(document.documentElement.clientWidth, 1440) - 32) / 800);
mountTablet(document.getElementById('tab-root'), 'root', RECENT.slice(0, 6), TABLET_SCALE);
mountTablet(document.getElementById('tab-folder'), 'folder', RECENT.slice(0, 6), TABLET_SCALE);
})();
