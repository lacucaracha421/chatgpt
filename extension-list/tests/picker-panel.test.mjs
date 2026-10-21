import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';
const names = ['model', 'insert', 'toolbar', 'panel-css', 'panel'];
const sources = await Promise.all(names.map(name => readFile(new URL(`../src/picker/${name}.js`, import.meta.url), 'utf8')));
const wait = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await wait(1); };

function world({ html = '', width = 1440 } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://arca.live/b/channel/write', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  Object.defineProperty(w, 'innerWidth', { value: width, configurable: true });
  w.matchMedia = () => ({ matches: false });
  let urls = 0; w.URL.createObjectURL = () => 'blob:https://arca.live/t' + ++urls; w.URL.revokeObjectURL = () => {};
  for (const source of sources) w.eval(source);
  return w;
}
const toolbarHtml = '<form id="article_write_form"><div class="fr-toolbar"><button type="button" id="imagesMultiUpload-1" data-cmd="imagesMultiUpload" class="fr-command" style="width:36px;height:36px;margin:0 2px">이미지</button><button type="button" data-cmd="bold">B</button></div><div class="write-body"><div class="fr-element fr-view" contenteditable="true"><p>본문</p></div></div></form>';

test('the toolbar button sits after "이미지 업로드", copies its size and survives a toolbar rebuild', async () => {
  const w = world({ html: toolbarHtml }), doc = w.document, T = w.LakomicsPickerToolbar;
  let clicks = 0;
  const toolbar = T.createToolbarButton({ doc, win: w, onClick: () => { clicks++; } });
  toolbar.start();
  const anchor = doc.querySelector('#imagesMultiUpload-1');
  const button = anchor.nextElementSibling;
  assert.equal(button.className, 'lakomics-arca-pick');
  assert.equal(button.getAttribute('aria-label'), 'Lakomics에서 그림 넣기');
  assert.equal(button.getAttribute('aria-pressed'), 'false'); assert.equal(button.getAttribute('aria-keyshortcuts'), 'Alt+Shift+L');
  assert.equal(button.hasAttribute('data-cmd'), false); assert.equal(button.hasAttribute('title'), false); assert.equal(/fr-/.test(button.className), false);
  assert.equal(button.style.width, '36px'); assert.equal(button.style.height, '36px'); assert.equal(button.style.margin, '0px 2px');
  assert.equal(button.querySelector('path').getAttribute('d'), 'M2 2h8v2H4v16h14v-6h2v8H2zM8 8h12v4H8z');
  const down = new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }); button.dispatchEvent(down); assert.equal(down.defaultPrevented, true);
  button.click(); assert.equal(clicks, 1);
  toolbar.setPressed(true); assert.equal(button.getAttribute('aria-pressed'), 'true');
  // Froala rebuilds its toolbar: everything inside is replaced.
  const bar = doc.querySelector('.fr-toolbar'); bar.innerHTML = '<button type="button" id="imagesMultiUpload-1" data-cmd="imagesMultiUpload">이미지</button>';
  await wait(40);
  assert.equal(doc.querySelectorAll('.lakomics-arca-pick').length, 1);
  assert.equal(doc.querySelector('#imagesMultiUpload-1').nextElementSibling.className, 'lakomics-arca-pick');
  assert.equal(doc.querySelector('.lakomics-arca-pick').getAttribute('aria-pressed'), 'true');
  // Idempotent: further unrelated edits add nothing.
  doc.querySelector('.fr-element').append(doc.createElement('p')); await wait(40);
  assert.equal(doc.querySelectorAll('.lakomics-arca-pick').length, 1);
  // The theme follows Arca.
  assert.equal(doc.querySelector('.lakomics-arca-pick').dataset.lkTheme, 'light');
  doc.body.classList.add('dark-theme'); await wait(20);
  assert.equal(doc.querySelector('.lakomics-arca-pick').dataset.lkTheme, 'dark');
  toolbar.stop(); assert.equal(doc.querySelector('.lakomics-arca-pick'), null);
  w.close();
});

test('the toolbar button waits for a toolbar that is built late and never appears without one', async () => {
  const w = world({ html: '<form id="article_write_form"><div class="write-body"><div class="fr-element fr-view"></div></div></form>' }), doc = w.document;
  const toolbar = w.LakomicsPickerToolbar.createToolbarButton({ doc, win: w });
  toolbar.start(); assert.equal(doc.querySelector('.lakomics-arca-pick'), null);
  doc.querySelector('#article_write_form').prepend(Object.assign(doc.createElement('div'), { innerHTML: '<button type="button" id="imagesMultiUpload-1" data-cmd="imagesMultiUpload"></button>' }));
  await wait(40);
  assert.equal(doc.querySelectorAll('.lakomics-arca-pick').length, 1);
  w.close();
});

test('the button style makes the icon stand out in both themes and keeps a visible focus ring', async () => {
  const css = await readFile(new URL('../src/picker/button.css', import.meta.url), 'utf8');
  const light = css.match(/--lk-icon:(#[0-9a-f]{6})/i)[1], dark = css.match(/\[data-lk-theme="dark"\]\{--lk-icon:(#[0-9a-f]{6})/i)[1];
  const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  assert.ok(ratio(light, '#ffffff') >= 4.5, 'light icon on a white toolbar');
  assert.ok(ratio(dark, '#1f2021') >= 4.5, 'dark icon on a dark toolbar');
  assert.notEqual(light, '#555555'); assert.notEqual(dark, '#c3c6c9');
  assert.match(css, /\.lakomics-arca-pick:focus-visible\{outline:2px solid var\(--lk-ring\)/);
});

// ---- panel -------------------------------------------------------------------------------
const FOLDERS = [
  { id: 'f1', parentId: null, name: '캐릭터', path: ['캐릭터'], imageCount: 0, imageCountWithDescendants: 40 },
  { id: 'f2', parentId: 'f1', name: '아로나', path: ['캐릭터', '아로나'], imageCount: 40, imageCountWithDescendants: 40 },
  { id: 'f3', parentId: null, name: '빈 폴더', path: ['빈 폴더'], imageCount: 0, imageCountWithDescendants: 6 },
];
const item = n => ({ assetId: 'a' + n, width: 1536, height: 2048, byteSize: 1_468_006, mime: 'image/webp' });

function setup({ stored = {}, folders = FOLDERS, characters = [], batches = null, width = 1440, height = 768, formRight = 900 } = {}) {
  const w = world({ html: toolbarHtml, width }), doc = w.document;
  Object.defineProperty(w, 'innerHeight', { value: height, configurable: true });
  doc.querySelector('form').getBoundingClientRect = () => ({ left: 100, right: formRight - (doc.documentElement.classList.contains('lakomics-arca-picker-push') ? parseFloat(doc.documentElement.style.getPropertyValue('--lakomics-picker-width')) || 0 : 0), top: 0, bottom: 500, width: formRight - 100, height: 500 });
  const sent = [], store = { ...stored }; let nextBatch = 0;
  const behaviour = { folders: { ok: true, entries: folders, characters }, batch: null, original: null };
  const send = async message => {
    sent.push(message);
    if (message.type === 'picker:folders') return behaviour.folders;
    if (message.type === 'picker:batch') {
      if (behaviour.batch) return behaviour.batch(message);
      const list = batches ? batches[nextBatch++ % batches.length] : Array.from({ length: 18 }, (_, i) => item(nextBatch * 18 + i + 1));
      if (!batches) nextBatch++;
      return { ok: true, items: list.map(n => typeof n === 'number' ? item(n) : n), remaining: 100 };
    }
    if (message.type === 'picker:thumb') return behaviour.thumb ? behaviour.thumb(message) : { ok: true, mime: 'image/webp', base64: 'AAEC' };
    if (message.type === 'picker:original') return behaviour.original ? behaviour.original(message) : { ok: true, mime: 'image/png', size: 3, base64: 'AAEC' };
    return { ok: true };
  };
  const storage = { async get(keys) { return Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])); }, async set(v) { Object.assign(store, v); } };
  const results = []; const inserted = [];
  const editor = { available: () => true, remember() { return true; }, restore() { return true; } };
  const inserter = { async insertOne(file) { inserted.push(file.name); return results.length ? results.shift() : { ok: true }; } };
  const changes = [];
  const panel = w.LakomicsPickerPanel.createPanel({ doc, win: w, css: w.LakomicsPickerCss, send, storage, editor, inserter, detectTheme: w.LakomicsPickerToolbar.detectTheme, onOpenChange: open => changes.push(open), timers: { pause: async () => {} } });
  const q = (selector, root = panel.root) => root.querySelector(selector), qa = (selector, root = panel.root) => Array.from(root.querySelectorAll(selector));
  const key = (target, name, init = {}) => { const e = new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, composed: true, ...init }); target.dispatchEvent(e); return e; };
  return { w, doc, panel, sent, store, results, inserted, changes, behaviour, q, qa, key, editor };
}

test('first open shows the folder picker, the choice loads a batch, and the view is remembered', async () => {
  const f = setup();
  await f.panel.open(); await settle();
  assert.equal(f.panel.host.id, 'lakomics-arca-picker');
  assert.equal(f.doc.documentElement.lastElementChild, f.panel.host);
  assert.equal(f.panel.host.shadowRoot, null, 'the shadow root is closed');
  assert.equal(f.q('.lk').getAttribute('aria-label'), 'Lakomics 그림 넣기'); assert.equal(f.q('.lk').getAttribute('role'), 'complementary');
  assert.ok(f.q('.pop'), 'first use opens the folder popover');
  assert.equal(f.sent.filter(m => m.type === 'picker:batch').length, 0);
  f.q('.pop input').value = '아로'; f.q('.pop input').dispatchEvent(new f.w.Event('input'));
  assert.deepEqual(f.qa('.trow').map(r => r.dataset.id), ['f1', 'f2'], 'search keeps ancestors');
  assert.equal(f.q('.trow mark').textContent, '아로');
  f.q('.trow[data-id="f2"]').click(); await settle();
  assert.equal(f.q('.pop'), null);
  assert.equal(f.qa('.tile').length, 18);
  assert.equal(f.q('.folder .par').textContent, '캐릭터 › '); assert.equal(f.q('.folder .leaf').textContent, '아로나');
  assert.equal(f.q('.lk-sub .cnt').textContent, '40장');
  const batch = f.sent.find(m => m.type === 'picker:batch');
  assert.deepEqual({ ...batch, exclude: [...batch.exclude] }, { type: 'picker:batch', folderId: 'f2', includeDescendants: true, exclude: [], limit: 18 });
  assert.deepEqual(plain(f.store['lakomics:picker:view:v1']), { folderId: 'f2', includeDescendants: true, order: 'random', panelWidth: 300, folded: false });
  assert.deepEqual(f.changes, [true]);
  // A fresh panel in the same browser reopens on the remembered folder without asking.
  const g = setup({ stored: f.store }); await g.panel.open(); await settle();
  assert.equal(g.q('.pop'), null); assert.equal(g.qa('.tile').length, 18);
  f.panel.destroy(); g.panel.destroy(); f.w.close(); g.w.close();
});

test('selection numbers follow click order, renumber on removal and survive "다른 그림"', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  await f.panel.open(); await settle();
  const tile = n => f.q(`.tile[data-id="a${n}"]`);
  tile(5).click(); tile(2).click(); tile(9).click();
  assert.deepEqual(f.qa('.tile .num').map(n => n.textContent), ['2', '1', '3'].sort((a, b) => 0));
  assert.equal(tile(5).querySelector('.num').textContent, '1'); assert.equal(tile(2).querySelector('.num').textContent, '2'); assert.equal(tile(9).querySelector('.num').textContent, '3');
  assert.equal(tile(2).getAttribute('aria-description'), '2번째'); assert.equal(tile(2).getAttribute('aria-selected'), 'true');
  assert.equal(f.q('.tray').hidden, false); assert.equal(f.qa('.tray .t').length, 3);
  assert.equal(f.q('.btn.primary').textContent, '본문에 넣기 (3장)'); assert.equal(f.q('.btn.primary').disabled, false);
  tile(5).click();
  assert.equal(tile(2).querySelector('.num').textContent, '1'); assert.equal(tile(9).querySelector('.num').textContent, '2');
  // 다른 그림: the old grid stays until the new one is ready, seen ids are excluded, the tray keeps the selection.
  f.q('.foot .cbtn').click();
  assert.equal(f.q('.grid').inert, true, 'the old grid is inert while loading, not removed');
  await settle();
  const second = f.sent.filter(m => m.type === 'picker:batch')[1];
  assert.equal(second.exclude.length, 18); assert.ok(second.exclude.includes('a1'));
  assert.equal(f.qa('.tile').length, 18); assert.equal(f.q('.tile').dataset.id, 'a19');
  assert.deepEqual(f.qa('.tray .t').map(t => t.dataset.id), ['a2', 'a9']);
  assert.equal(f.q('.btn.primary').textContent, '본문에 넣기 (2장)');
  f.panel.destroy(); f.w.close();
});

test('when fewer than 18 unseen remain the grid fills from the least recently seen and says 모두 봄', async () => {
  const first = Array.from({ length: 18 }, (_, i) => i + 1), partial = [19, 20];
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } }, batches: [first, partial, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]] });
  await f.panel.open(); await settle();
  f.q('.foot .cbtn').click(); await settle();
  const requests = f.sent.filter(m => m.type === 'picker:batch');
  assert.equal(requests.length, 4, "the following batch is prefetched too");
  assert.equal(requests[2].exclude.length > 0, true);
  assert.equal(requests[2].exclude.includes('a19') && requests[2].exclude.includes('a20'), true);
  assert.equal(requests[2].exclude.includes('a1'), false, 'the oldest seen may come back');
  assert.equal(f.qa('.tile').length, 18);
  assert.equal(f.q('.lk-sub .cnt').textContent, '40장 · 모두 봄');
  f.panel.destroy(); f.w.close();
});

test('inserting keeps going after a failure; the failure stays selected in red and retries alone', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } }, batches: [[1, 2, 3, 4, 5, 6, 7, 8, 9]] });
  await f.panel.open(); await settle();
  for (const n of [3, 1, 2]) f.q(`.tile[data-id="a${n}"]`).click();
  f.results.push({ ok: true }, { ok: false, reason: 'editorTimeout' }, { ok: true });
  f.q('.btn.primary').click();
  assert.equal(f.q('.btn.primary').disabled, true, 'one job at a time');
  await wait(450); await settle();
  assert.deepEqual(f.inserted, ['lakomics-a3.webp'.replace('webp', 'png'), 'lakomics-a1.png', 'lakomics-a2.png']);
  assert.deepEqual(f.sent.filter(m => m.type === 'picker:original').map(m => m.assetId), ['a3', 'a1', 'a2'], 'originals are fetched one by one, only on insert');
  const rows = f.qa('.jr');
  assert.deepEqual(rows.map(r => r.className), ['jr ok', 'jr bad', 'jr ok']);
  assert.match(rows[1].textContent, /실패/); assert.match(rows[1].textContent, /시간 초과/);
  assert.equal(f.q('.slab .c').textContent, '본문에 넣기 3/3');
  assert.deepEqual(plain(f.panel.selection.ids()), ['a1'], 'only the failed picture stays selected');
  assert.equal(f.q('.tile[data-id="a1"] .num').className, 'num bad');
  assert.ok(f.q('.tile[data-id="a3"] .done')); assert.match(f.q('.tile[data-id="a3"] .done').textContent, /넣음/);
  assert.equal(f.q('.btn.primary').textContent, '본문에 넣기 (1장)');
  assert.equal(f.q('.job').hidden, false, 'the job list stays');
  assert.equal(f.panel.isOpen, true, 'the panel stays open after inserting');
  f.qa('.jr .cbtn')[0].click(); await wait(450); await settle();
  assert.deepEqual(f.inserted.slice(3), ['lakomics-a1.png']);
  assert.deepEqual(plain(f.panel.selection.ids()), []);
  assert.equal(f.qa('.jr').map(r => r.className).join('|'), 'jr ok|jr ok|jr ok');
  // selecting something new swaps the list for the tray
  f.q('.tile[data-id="a7"]').click();
  assert.equal(f.q('.job').hidden, true); assert.equal(f.q('.tray').hidden, false);
  f.panel.destroy(); f.w.close();
});

test('the stop button leaves the queued pictures selected', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  await f.panel.open(); await settle();
  for (const n of [1, 2, 3]) f.q(`.tile[data-id="a${n}"]`).click();
  f.behaviour.original = async () => { f.panel.jobs.stop(); return { ok: true, mime: 'image/png', size: 3, base64: 'AAEC' }; };
  f.q('.btn.primary').click(); await wait(450); await settle();
  assert.deepEqual(f.inserted, ['lakomics-a1.png']);
  assert.deepEqual(plain(f.panel.selection.ids()), ['a2', 'a3']);
  f.panel.destroy(); f.w.close();
});

test('PC problems show the right empty state, and the connection setup opens the settings', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  f.behaviour.folders = { ok: false, kind: 'offline' };
  await f.panel.open(); await settle();
  assert.equal(f.q('.empty b').textContent, 'PC Lakomics에 연결되지 않음'); assert.equal(f.q('.empty small').textContent, 'PC에서 Lakomics를 켜면 바로 이어집니다');
  assert.equal(f.q('.empty .btn').textContent, '다시 시도');
  f.behaviour.folders = { ok: true, entries: FOLDERS };
  f.q('.empty .btn').click(); await settle();
  assert.equal(f.qa('.tile').length, 18, 'retry reaches the grid');
  f.panel.destroy(); f.w.close();

  const locked = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  locked.behaviour.batch = async () => ({ ok: false, kind: 'locked' });
  await locked.panel.open(); await settle();
  assert.equal(locked.q('.empty b').textContent, 'PC Lakomics가 잠겨 있음'); assert.equal(locked.q('.empty small').textContent, 'PC에서 비공개 모드가 켜져 있어 그림을 보여줄 수 없습니다');
  locked.panel.destroy(); locked.w.close();

  const unpaired = setup();
  unpaired.behaviour.folders = { ok: false, kind: 'unpaired' };
  await unpaired.panel.open(); await settle();
  assert.equal(unpaired.q('.empty b').textContent, '연결 설정 필요');
  unpaired.q('.empty .btn').click(); await settle();
  assert.ok(unpaired.sent.some(m => m.type === 'picker:settings'));
  unpaired.panel.destroy(); unpaired.w.close();
});

test('a failed refresh keeps the old grid and offers 다시 시도', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  await f.panel.open(); await settle();
  // Consume the successful prefetch; the next prefetch fails silently.
  f.behaviour.batch = async () => ({ ok: false, kind: 'offline' });
  await f.panel.refresh(); await settle();
  const before = f.q('.tile').dataset.id;
  f.behaviour.batch = async () => ({ ok: false, kind: 'offline' });
  f.q('.foot .cbtn').click(); await settle();
  assert.equal(f.q('.tile').dataset.id, before); assert.equal(f.qa('.tile').length, 18);
  assert.equal(f.q('.note').hidden, false); assert.match(f.q('.note').textContent, /그림을 불러오지 못함/);
  assert.equal(f.q('.grid').inert, false);
  f.panel.destroy(); f.w.close();
});

test('an empty folder says so and offers the descendants when the toggle is off', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f3', includeDescendants: false } }, batches: [[]] });
  await f.panel.open(); await settle();
  assert.equal(f.q('.empty b').textContent, '이 폴더에 그림 없음'); assert.equal(f.q('.empty small').textContent, '하위 폴더에 6장');
  assert.equal(f.q('.empty .btn').textContent, '하위 폴더 포함');
  f.panel.destroy(); f.w.close();
});

test('keyboard: roving tile focus, space selects, enter inserts, P previews, Esc closes innermost first', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  await f.panel.open(); await settle();
  const tiles = f.qa('.tile');
  assert.equal(tiles.filter(t => t.getAttribute('tabindex') === '0').length, 1);
  f.key(tiles[0], 'ArrowRight'); assert.equal(tiles[1].getAttribute('tabindex'), '0'); assert.equal(tiles[0].getAttribute('tabindex'), '-1');
  f.key(tiles[1], 'ArrowDown'); assert.equal(tiles[4].getAttribute('tabindex'), '0');
  f.key(tiles[4], 'End'); assert.equal(tiles[17].getAttribute('tabindex'), '0');
  f.key(tiles[17], 'Home');
  f.key(tiles[0], ' '); assert.equal(f.panel.selection.ids().length, 1);
  assert.equal(f.q('.tile .num').textContent, '1');
  f.key(f.q('.tray .t'), 'Delete'); assert.equal(f.panel.selection.size, 0);
  // preview
  f.key(tiles[2], 'p'); assert.ok(f.q('.prev')); assert.equal(f.q('.prev .pos').textContent, '3 / 18'); assert.equal(f.q('.prev .pf').textContent, '1,536×2,048 · 1.4MB');
  f.key(f.q('.prev .selbtn'), 'ArrowRight'); assert.equal(f.q('.prev .pos').textContent, '4 / 18');
  assert.equal(f.panel.isOpen, true);
  f.key(f.q('.prev .selbtn'), 'Escape'); assert.equal(f.q('.prev'), null); assert.equal(f.panel.isOpen, true, 'Esc closes only the preview');
  // popover
  f.q('.folder').click(); assert.ok(f.q('.pop'));
  f.key(f.q('.pop input'), 'Escape'); assert.equal(f.q('.pop'), null); assert.equal(f.panel.isOpen, true);
  f.key(tiles[0], 'Escape'); assert.equal(f.panel.isOpen, false);
  assert.deepEqual(f.changes, [true, false]);
  f.panel.destroy(); f.w.close();
});

test('folder popover keyboard: arrows move, right/left expand and collapse, enter chooses', async () => {
  const f = setup();
  await f.panel.open(); await settle();
  const input = f.q('.pop input');
  assert.deepEqual(f.qa('.trow').map(r => r.dataset.id), ['f1', 'f3']);
  f.key(input, 'ArrowRight'); assert.deepEqual(f.qa('.trow').map(r => r.dataset.id), ['f1', 'f2', 'f3']);
  f.key(input, 'ArrowDown'); assert.ok(f.qa('.trow')[1].classList.contains('kf'));
  f.key(input, 'ArrowUp'); f.key(input, 'ArrowLeft'); assert.equal(f.qa('.trow').length, 2);
  f.key(input, 'ArrowRight'); f.key(input, 'ArrowDown'); f.key(input, 'Enter'); await settle();
  assert.equal(f.q('.pop'), null); assert.equal(f.q('.folder .leaf').textContent, '아로나'); assert.equal(f.qa('.tile').length, 18);
  f.panel.destroy(); f.w.close();
});

test('page keys are not handled outside the panel and handled keys do not leak to the page', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  await f.panel.open(); await settle();
  let leaked = 0; f.doc.addEventListener('keydown', () => { leaked++; });
  f.key(f.qa('.tile')[0], ' '); assert.equal(leaked, 0);
  f.key(f.qa('.tile')[0], 'x'); assert.equal(leaked, 1, 'unhandled keys pass through untouched');
  f.panel.destroy(); f.w.close();
});

test('the panel overlays a free gutter, pushes the page otherwise, and follows the Arca theme', async () => {
  const wide = setup({ formRight: 900, stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  await wide.panel.open(); await settle();
  assert.equal(wide.doc.documentElement.classList.contains('lakomics-arca-picker-push'), false);
  assert.equal(wide.panel.host.style.position, 'fixed'); assert.equal(wide.panel.host.style.width, '300px'); assert.equal(wide.panel.host.style.zIndex, '2147483646');
  assert.equal(wide.panel.host.dataset.theme, 'light');
  wide.doc.documentElement.classList.add('dark-theme'); await wait(20);
  assert.equal(wide.panel.host.dataset.theme, 'dark');
  wide.panel.close(); wide.panel.destroy(); wide.w.close();

  const tight = setup({ formRight: 1300, stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  await tight.panel.open(); await settle();
  assert.equal(tight.doc.documentElement.classList.contains('lakomics-arca-picker-push'), true);
  tight.panel.close(); assert.equal(tight.doc.documentElement.classList.contains('lakomics-arca-picker-push'), false);
  tight.panel.destroy(); tight.w.close();

  const narrow = setup({ formRight: 1300, width: 900, stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  await narrow.panel.open(); await settle();
  assert.equal(narrow.doc.documentElement.classList.contains('lakomics-arca-picker-push'), false, 'under 1024px it always overlays');
  narrow.panel.destroy(); narrow.w.close();
});

test('a missing editor disables inserting with a notice', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  await f.panel.open(); await settle();
  f.editor.available = () => false;
  f.q('.tile').click(); f.q('.btn.primary').click(); await settle();
  assert.match(f.q('.note').textContent, /본문 편집기를 찾지 못함/); assert.equal(f.inserted.length, 0);
  f.panel.destroy(); f.w.close();
});

test('the manifest wires the Arca page, the bridge, the shortcut and the loopback permission', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const pages = manifest.content_scripts.filter(entry => entry.js?.some(path => path.startsWith('src/picker/')));
  assert.equal(pages.length, 2);
  for (const entry of pages) assert.deepEqual(entry.matches, ['https://arca.live/b/*/write*']);
  const bridge = pages.find(entry => entry.world === 'MAIN');
  assert.deepEqual(bridge.js, ['src/picker/page-bridge.js']);
  const isolated = pages.find(entry => entry.world !== 'MAIN');
  assert.deepEqual(isolated.js, ['src/picker/model.js', 'src/picker/insert.js', 'src/picker/toolbar.js', 'src/picker/panel-css.js', 'src/picker/panel.js', 'src/picker/content.js']);
  assert.deepEqual(isolated.css, ['src/picker/button.css']);
  assert.equal(manifest.commands['toggle-arca-picker'].suggested_key.default, 'Alt+Shift+L');
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1:32145/*'));
  for (const entry of pages) for (const path of [...entry.js, ...(entry.css || [])]) await readFile(new URL('../' + path, import.meta.url));
  const background = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  assert.match(background, /importScripts\("picker\/model\.js", "picker\/background\.js"\)/);
  assert.match(background, /startsWith\("picker:"\)\) return globalThis\.LakomicsPickerBackground\.handle/);
});

test('a remembered folder that disappeared on the PC sends the user back to the folder picker', async () => {
  const f = setup({ stored: { 'lakomics:picker:view:v1': { folderId: 'f2', includeDescendants: true } } });
  f.behaviour.batch = async () => ({ ok: false, kind: 'folderGone' });
  await f.panel.open(); await settle();
  assert.equal(f.q('.empty b').textContent, '폴더를 골라 주세요'); assert.ok(f.q('.pop'));
  assert.equal(f.panel.state.folderId, null);
  f.panel.destroy(); f.w.close();
});

// ---- characters and groups ------------------------------------------------------------------
const SERIES_PATH = ['캐릭터', '아로나'];
const PEOPLE = [
  { kind: 'group', id: 'g1', name: '라플라스', seriesId: 'f2', seriesPath: SERIES_PATH, groupId: null, imageCount: 30 },
  { kind: 'character', id: 'c1', name: '라플라스 A', seriesId: 'f2', seriesPath: SERIES_PATH, groupId: 'g1', imageCount: 20 },
  { kind: 'character', id: 'c2', name: '호시노', seriesId: 'f2', seriesPath: SERIES_PATH, groupId: null, imageCount: 8 },
];
const VIEW = 'lakomics:picker:view:v1';
const batchesOf = f => f.sent.filter(m => m.type === 'picker:batch').map(plain);

test('the popover lists groups, then characters, under their series folder with distinct icons and counts', async () => {
  const f = setup({ characters: PEOPLE });
  await f.panel.open(); await settle();
  const ids = () => f.qa('.trow').map(r => `${r.dataset.kind}:${r.dataset.id}`);
  assert.deepEqual(ids(), ['folder:f1', 'folder:f3']);
  f.q('.trow[data-id="f1"] .tw').click();
  assert.deepEqual(ids(), ['folder:f1', 'folder:f2', 'folder:f3']);
  f.q('.trow[data-id="f2"] .tw').click();
  assert.deepEqual(ids(), ['folder:f1', 'folder:f2', 'group:g1', 'character:c2', 'folder:f3'], 'groups first, then characters without a group');
  assert.equal(f.q('.trow[data-id="g1"]').getAttribute('aria-expanded'), 'false');
  assert.equal(f.q('.trow[data-id="c2"]').hasAttribute('aria-expanded'), false);
  f.q('.trow[data-id="g1"] .tw').click();
  assert.deepEqual(ids(), ['folder:f1', 'folder:f2', 'group:g1', 'character:c1', 'character:c2', 'folder:f3'], 'a group opens to its characters');
  assert.equal(f.q('.trow[data-id="c1"]').getAttribute('aria-level'), '4');
  assert.equal(f.q('.trow[data-id="c2"]').getAttribute('aria-level'), '3');
  // counts: folders with sub-folders, groups and characters their own
  assert.deepEqual(['f2', 'g1', 'c1', 'c2'].map(id => f.q(`.trow[data-id="${id}"] .n`).textContent), ['40', '30', '20', '8']);
  // one small icon per row, different for folder, group and character
  const shape = id => f.q(`.trow[data-id="${id}"] .ki path`).getAttribute('d');
  assert.equal(new Set([shape('f2'), shape('g1'), shape('c2')]).size, 3);
  assert.equal(shape('c1'), shape('c2'));
  assert.equal(f.qa('.trow .ki').length, f.qa('.trow').length);
  assert.equal(f.q('.trow .sec'), null, 'no secondary text while browsing');
  f.panel.destroy(); f.w.close();
});

test('search matches characters and groups by name and shows the series path as secondary text', async () => {
  const f = setup({ characters: PEOPLE });
  await f.panel.open(); await settle();
  const input = f.q('.pop input');
  input.value = '라플라스'; input.dispatchEvent(new f.w.Event('input'));
  assert.deepEqual(f.qa('.trow').map(r => `${r.dataset.kind}:${r.dataset.id}`), ['folder:f1', 'folder:f2', 'group:g1', 'character:c1']);
  assert.deepEqual(f.qa('.trow mark').map(m => m.textContent), ['라플라스', '라플라스']);
  assert.equal(f.q('.trow[data-id="g1"] .sec').textContent, '캐릭터 › 아로나');
  assert.equal(f.q('.trow[data-id="c1"] .sec').textContent, '캐릭터 › 아로나');
  assert.equal(f.q('.trow[data-id="f2"] .sec'), null);
  assert.ok(f.q('.trow[data-id="f2"]').classList.contains('anc'));
  input.value = '호시노'; input.dispatchEvent(new f.w.Event('input'));
  assert.deepEqual(f.qa('.trow').map(r => r.dataset.id), ['f1', 'f2', 'c2']);
  input.value = '없는'; input.dispatchEvent(new f.w.Event('input'));
  assert.equal(f.q('.pop .none').textContent, '찾는 폴더·캐릭터가 없음');
  f.panel.destroy(); f.w.close();
});

test('choosing a character loads its pictures by scope, names it in the header and hides the sub-folder switch', async () => {
  const f = setup({ characters: PEOPLE });
  await f.panel.open(); await settle();
  const input = f.q('.pop input');
  input.value = '호시노'; input.dispatchEvent(new f.w.Event('input'));
  f.q('.trow[data-id="c2"]').click(); await settle();
  assert.equal(f.q('.pop'), null);
  const request = batchesOf(f)[0];
  assert.deepEqual({ ...request, exclude: [...request.exclude] }, { type: 'picker:batch', scope: { kind: 'character', id: 'c2' }, exclude: [], limit: 18 });
  assert.equal('folderId' in request || 'includeDescendants' in request, false);
  assert.equal(f.qa('.tile').length, 18);
  assert.equal(f.q('.folder .par').textContent, '캐릭터 › 아로나 › '); assert.equal(f.q('.folder .leaf').textContent, '호시노');
  assert.equal(f.q('.lk-sub .cnt').textContent, '8장', 'the character count, not a folder count');
  assert.equal(f.q('.lk-sub .scope').hidden, true, 'the sub-folder switch is hidden, not shown disabled');
  assert.equal(f.q('.lk-sub .cnt').parentElement, f.q('.lk-sub'), 'the count keeps its place in the row');
  assert.equal(f.q('.folder .ic').firstElementChild.getAttribute('d'), f.w.LakomicsPickerPanel.icon(f.doc, 'character').firstElementChild.getAttribute('d'), 'the header icon is the character icon');
  assert.deepEqual(plain(f.store[VIEW]), { folderId: null, includeDescendants: true, order: 'random', panelWidth: 300, folded: false, scope: { kind: 'character', id: 'c2' } });
  assert.equal(f.panel.state.folderId, null);
  // the next "다른 그림" keeps asking for the same scope
  f.q('.foot .cbtn').click(); await settle();
  assert.deepEqual(batchesOf(f)[1].scope, { kind: 'character', id: 'c2' });
  assert.equal(batchesOf(f)[1].exclude.length, 18);
  // a group, then back to a folder: the switch returns and the request has the folder shape
  f.q('.folder').click();
  f.q('.pop input').value = '라플라스'; f.q('.pop input').dispatchEvent(new f.w.Event('input'));
  f.q('.trow[data-id="g1"]').click(); await settle();
  assert.deepEqual(batchesOf(f).find(m => m.scope?.kind === 'group').scope, { kind: 'group', id: 'g1' });
  assert.equal(f.q('.folder .leaf').textContent, '라플라스'); assert.equal(f.q('.lk-sub .cnt').textContent, '30장'); assert.equal(f.q('.lk-sub .scope').hidden, true);
  f.q('.folder').click();
  f.q('.pop input').value = '아로나'; f.q('.pop input').dispatchEvent(new f.w.Event('input'));
  f.q('.trow[data-id="f2"]').click(); await settle();
  const folderRequest = batchesOf(f).find(m => m.folderId === "f2");
  assert.equal(folderRequest.folderId, 'f2'); assert.equal(folderRequest.includeDescendants, true); assert.equal('scope' in folderRequest, false);
  assert.equal(f.q('.lk-sub .scope').hidden, false); assert.equal(f.q('.lk-sub .cnt').textContent, '40장');
  assert.deepEqual(plain(f.store[VIEW]), { folderId: 'f2', includeDescendants: true, order: 'random', panelWidth: 300, folded: false });
  f.panel.destroy(); f.w.close();
});

test('a remembered character or group scope is restored on the next open, with its own request shape', async () => {
  const f = setup({ characters: PEOPLE, stored: { [VIEW]: { folderId: null, includeDescendants: false, scope: { kind: 'group', id: 'g1' } } } });
  await f.panel.open(); await settle();
  assert.equal(f.q('.pop'), null, 'no picker when the scope is remembered');
  assert.deepEqual(batchesOf(f)[0].scope, { kind: 'group', id: 'g1' });
  assert.equal(f.q('.folder .leaf').textContent, '라플라스'); assert.equal(f.q('.lk-sub .scope').hidden, true);
  assert.equal(f.panel.state.scopeKind, 'group'); assert.equal(f.panel.state.scopeId, 'g1');
  // opening the popover shows the remembered row expanded to it and marked as the current one
  f.q('.folder').click();
  assert.ok(f.q('.trow[data-id="g1"]').classList.contains('me')); assert.equal(f.q('.trow[data-id="g1"] .cur') !== null, true);
  // a member of a group: the popover opens the group around it
  f.panel.destroy(); f.w.close();
  const g = setup({ characters: PEOPLE, stored: { [VIEW]: { scope: { kind: 'character', id: 'c1' }, includeDescendants: true } } });
  await g.panel.open(); await settle();
  assert.equal(g.q('.folder .leaf').textContent, '라플라스 A'); assert.equal(g.q('.folder .par').textContent, '캐릭터 › 아로나 › 라플라스 › ');
  g.q('.folder').click();
  assert.ok(g.q('.trow[data-id="c1"]').classList.contains('me'));
  // junk in the stored view is ignored
  g.panel.destroy(); g.w.close();
  const h = setup({ characters: PEOPLE, stored: { [VIEW]: { folderId: 'f2', scope: { kind: 'series', id: 'c1' }, includeDescendants: true } } });
  await h.panel.open(); await settle();
  assert.equal(batchesOf(h)[0].folderId, 'f2');
  h.panel.destroy(); h.w.close();
});

test('a remembered character that is gone on the PC sends the user back to the picker', async () => {
  const missing = setup({ characters: PEOPLE, stored: { [VIEW]: { scope: { kind: 'character', id: 'zz' }, includeDescendants: true } } });
  await missing.panel.open(); await settle();
  assert.equal(batchesOf(missing).length, 1, 'remembered scope starts in parallel; its result is discarded when absent from folders');
  assert.equal(missing.q('.empty b').textContent, '폴더를 골라 주세요'); assert.ok(missing.q('.pop'));
  missing.panel.destroy(); missing.w.close();
  const f = setup({ characters: PEOPLE, stored: { [VIEW]: { scope: { kind: 'character', id: 'c2' }, includeDescendants: true } } });
  f.behaviour.batch = async () => ({ ok: false, kind: 'scopeGone' });
  await f.panel.open(); await settle();
  assert.equal(f.q('.empty b').textContent, '폴더를 골라 주세요'); assert.match(f.q('.empty small').textContent, /캐릭터·그룹/);
  assert.ok(f.q('.pop')); assert.equal(f.panel.state.scopeId, null); assert.equal(f.panel.state.folderId, null);
  assert.equal(f.q('.lk-sub .scope').hidden, false, 'with nothing chosen the switch is back');
  f.panel.destroy(); f.w.close();
});

test('a character without pictures says so and offers no sub-folder action', async () => {
  const f = setup({ characters: PEOPLE, stored: { [VIEW]: { scope: { kind: 'character', id: 'c2' }, includeDescendants: false } }, batches: [[]] });
  await f.panel.open(); await settle();
  assert.equal(f.q('.empty b').textContent, '이 캐릭터에 그림 없음'); assert.equal(f.q('.empty .btn'), null);
  f.panel.destroy(); f.w.close();
});

test('popover keyboard walks groups and characters: right opens a group, left goes to its parent row', async () => {
  const f = setup({ characters: PEOPLE, stored: { [VIEW]: { scope: { kind: 'character', id: 'c2' }, includeDescendants: true } } });
  await f.panel.open(); await settle();
  f.q('.folder').click();
  const input = f.q('.pop input');
  assert.deepEqual(f.qa('.trow').map(r => r.dataset.id), ['f1', 'f2', 'g1', 'c2', 'f3']);
  f.key(input, 'ArrowDown'); f.key(input, 'ArrowDown'); // f1 -> f2 -> g1
  f.key(input, 'ArrowRight');
  assert.deepEqual(f.qa('.trow').map(r => r.dataset.id), ['f1', 'f2', 'g1', 'c1', 'c2', 'f3']);
  f.key(input, 'ArrowDown'); f.key(input, 'ArrowLeft'); // member c1 -> its group g1
  assert.ok(f.qa('.trow').find(r => r.dataset.id === 'g1').classList.contains('kf'));
  f.key(input, 'ArrowDown'); f.key(input, 'Enter'); await settle();
  assert.deepEqual(batchesOf(f).at(-1).scope, { kind: 'character', id: 'c1' });
  f.panel.destroy(); f.w.close();
});


test('고정 section precedes the full tree in pin order and search keeps PC order', async () => {
  const f = setup({ folders: [
    { id: 'a', name: 'match Alpha', path: ['match Alpha'], imageCount: 0, imageCountWithDescendants: 0, parentId: null, order: 1, pinned: true, pinOrder: 0 },
    { id: 'z', name: 'match Zulu', path: ['match Zulu'], imageCount: 0, imageCountWithDescendants: 0, parentId: null, order: 0, pinned: true, pinOrder: 1 },
  ] });
  await f.panel.open(); await settle();
  assert.deepEqual(f.qa('.tree-section').map(e => e.textContent), ['고정', '폴더']);
  assert.deepEqual(f.qa('.trow').map(e => [e.dataset.section, e.dataset.id]),
    [['pinned', 'a'], ['pinned', 'z'], ['tree', 'z'], ['tree', 'a']]);
  const input = f.q('.pop input'); input.value = 'match'; input.dispatchEvent(new f.w.Event('input'));
  assert.deepEqual(f.qa('.trow').map(e => e.dataset.id), ['a', 'z', 'z', 'a']);
  input.value = 'Zulu'; input.dispatchEvent(new f.w.Event('input'));
  assert.deepEqual(f.qa('.trow').map(e => e.dataset.id), ['z', 'z']);
  f.q('.trow[data-section="pinned"]').click(); await settle();
  assert.equal(f.sent.find(m => m.type === 'picker:batch').folderId, 'z');
  f.panel.destroy(); f.w.close();
});


test('newest uses inline thumbnails, reuses prefetch and appends without replacing tiles until end', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2', order: 'newest' } } });
  f.behaviour.batch = async request => ({ ok: true, nextOffset: request.offset === 0 ? 18 : null,
    items: Array.from({ length: request.offset === 0 ? 18 : 2 }, (_, i) => ({ ...item(request.offset + i + 1), thumbMime: 'image/webp', thumbBase64: 'AAEC' })) });
  await f.panel.open(); await settle();
  assert.equal(f.sent.filter(m => m.type === 'picker:thumb').length, 0);
  assert.deepEqual(batchesOf(f).map(m => m.offset), [0, 18]);
  assert.equal(f.panel.seen.size, 18, 'prefetch is not seen before display');
  const first = f.q('.tile'); first.click(); first.focus();
  assert.match(f.q('.foot .cbtn').textContent, /새로고침/);
  const grid = f.q('.grid');
  Object.defineProperties(grid, { clientHeight: { value: 400 }, scrollHeight: { value: 700 } });
  grid.scrollTop = 250; grid.dispatchEvent(new f.w.Event('scroll')); await settle();
  assert.equal(f.qa('.tile').length, 20); assert.equal(f.q('.tile'), first);
  assert.equal(f.panel.root.activeElement, first); assert.equal(first.getAttribute('aria-selected'), 'true');
  assert.equal(batchesOf(f).length, 2, 'prepared next page is reused');
  assert.equal(f.q('.foot .cbtn').disabled, false); assert.match(f.q('.cnt').textContent, / · 끝$/);
  f.q('.tile:last-child .pv')?.click();
  assert.equal(f.panel.state.batch.length, 20);
  f.panel.destroy(); f.w.close();
});

test('random prefetch survives thumbnail cleanup, is reused, and scope changes discard it', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2' } } });
  const revoked = []; f.w.URL.revokeObjectURL = url => revoked.push(url);
  await f.panel.open(); await settle();
  assert.equal(batchesOf(f).length, 2); assert.equal(f.panel.seen.size, 18);
  const thumbRequests = f.sent.filter(m => m.type === 'picker:thumb').length;
  await f.panel.refresh(); await settle();
  assert.equal(f.q('.tile').dataset.id, 'a19'); assert.ok(f.q('.tile img').src.startsWith('blob:'));
  assert.equal(f.sent.filter(m => m.type === 'picker:thumb').length, thumbRequests + 18, 'only the following prefetch fetches thumbnails');
  f.q('.folder').click(); f.q('.trow[data-id="f3"]').click(); await settle();
  assert.equal(f.q('.tile').dataset.id, 'a55', 'the previous scope prefetch is discarded');
  assert.equal(batchesOf(f).at(-1).folderId, 'f3');
  assert.ok(revoked.length >= 18);
  f.panel.destroy(); f.w.close();
});

test('order radios persist arrow-key changes and keep the old grid until ready', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2' } } });
  await f.panel.open(); await settle();
  const first = f.q('.tile'); let answer;
  f.behaviour.batch = () => new Promise(resolve => { answer = resolve; });
  f.key(f.q('[data-order="random"]'), 'ArrowRight');
  assert.equal(f.q('.tile'), first); assert.equal(f.q('[data-order="newest"]').getAttribute('aria-checked'), 'true');
  assert.equal(f.store[VIEW].order, 'newest');
  answer({ ok: true, items: [{ ...item(99), thumbBase64: 'AAEC' }], nextOffset: null }); await settle();
  assert.equal(f.qa('.tile').length, 1); assert.equal(f.q('.tile').dataset.id, 'a99');
  f.panel.destroy(); f.w.close();
});


test('newest auto-appends near the bottom and caps loaded items at 240', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2', order: 'newest' } } });
  f.behaviour.batch = async request => ({ ok: true, nextOffset: request.offset + 18,
    items: Array.from({ length: 18 }, (_, i) => ({ ...item(request.offset + i + 1), thumbBase64: 'AAEC' })) });
  await f.panel.open(); await settle();
  const grid = f.q('.grid');
  Object.defineProperties(grid, { clientHeight: { value: 400 }, scrollHeight: { value: 700 } });
  grid.scrollTop = 250;
  grid.dispatchEvent(new f.w.Event('scroll')); await settle();
  assert.equal(f.qa('.tile').length, 36);
  while (f.panel.state.batch.length < 240) { grid.dispatchEvent(new f.w.Event('scroll')); await settle(); }
  assert.equal(f.qa('.tile').length, 240); assert.equal(f.q('.foot .cbtn').disabled, false);
  const requests = batchesOf(f).length; grid.dispatchEvent(new f.w.Event('scroll')); await settle();
  assert.equal(batchesOf(f).length, requests);
  f.panel.destroy(); f.w.close();
});

test('a remembered scope starts its batch while folders are still pending', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2' } } });
  let foldersReady;
  f.behaviour.folders = new Promise(resolve => { foldersReady = resolve; });
  const opening = f.panel.open(); await settle();
  assert.equal(batchesOf(f).length, 1); assert.equal(f.qa('.tile').length, 0);
  foldersReady({ ok: true, entries: FOLDERS, characters: [] });
  await opening; await settle(); assert.equal(f.qa('.tile').length, 18);
  f.panel.destroy(); f.w.close();
});


test('discarding an in-flight prefetch preserves thumbnails of the replacement scope', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2' } } });
  const pending = new Map(), revoked = new Set();
  f.w.URL.revokeObjectURL = url => revoked.add(url);
  f.behaviour.thumb = async request => {
    if (['a19', 'a37'].includes(request.assetId)) await new Promise(resolve => pending.set(request.assetId, resolve));
    return { ok: true, mime: 'image/webp', base64: 'AAEC' };
  };
  await f.panel.open(); await settle();
  assert.ok(pending.has('a19'));
  f.q('.folder').click(); f.q('.trow[data-id="f3"]').click(); await settle();
  assert.ok(pending.has('a37'));
  pending.get('a19')(); await settle();
  pending.get('a37')(); await settle();
  assert.equal(f.q('.tile').dataset.id, 'a37');
  assert.ok(f.qa('.tile img').every(img => !revoked.has(img.src)));
  f.panel.destroy(); f.w.close();
});

// jsdom has no layout. Model only the scroller's available height and rendered rows;
// the panel still owns column selection, paging, request sizes and focus behavior.
function gridGeometry(f, initialHeight) {
  let height = initialHeight;
  const proto = f.w.HTMLElement.prototype;
  const originalHeight = Object.getOwnPropertyDescriptor(f.w.Element.prototype, 'clientHeight').get;
  const originalScroll = Object.getOwnPropertyDescriptor(f.w.Element.prototype, 'scrollHeight').get;
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() {
    return this.matches('.grid,.body') ? height : originalHeight.call(this);
  } });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() {
    if (!this.matches('.grid')) return originalScroll.call(this);
    const { width, columns } = f.panel.state;
    return Math.ceil(this.querySelectorAll('.tile').length / columns) * ((width - 2 * (columns - 1)) / columns + 2);
  } });
  return value => { height = value; f.w.dispatchEvent(new f.w.Event('resize')); };
}

test('width is clamped, rows and keyboard navigation follow the effective columns', async () => {
  for (const [remembered, width, columns] of [[200, 264, 2], [288, 288, 3], [419, 419, 3], [420, 420, 4], [600, 480, 4]]) {
    const f = setup({ stored: { [VIEW]: { folderId: 'f2', panelWidth: remembered } } });
    await f.panel.open();
    assert.equal(f.panel.state.width, width); assert.equal(f.panel.state.columns, columns);
    assert.equal(f.q('.grid').getAttribute('aria-colcount'), String(columns));
    assert.equal(f.q('.row').children.length, columns);
    f.key(f.q('.tile'), 'ArrowDown');
    assert.equal(f.panel.root.activeElement, f.qa('.tile')[columns]);
    const handle = f.q('[role="separator"]');
    assert.equal(handle.tabIndex, 0); assert.equal(handle.getAttribute('aria-orientation'), 'vertical');
    assert.equal(Number(handle.getAttribute('aria-valuenow')), width);
    f.panel.destroy(); f.w.close();
  }
});

test('pointer resize captures the pointer, saves only on release, keyboard resizes and double click resets', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2', panelWidth: 300 } } });
  await f.panel.open();
  const handle = f.q('[role="separator"]'); let captured = null;
  handle.setPointerCapture = id => { captured = id; };
  handle.hasPointerCapture = id => captured === id;
  handle.releasePointerCapture = () => { captured = null; };
  const pointer = (name, x) => {
    const event = new f.w.MouseEvent(name, { button: 0, clientX: x, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 7 }); handle.dispatchEvent(event);
  };
  pointer('pointerdown', 1000); assert.equal(captured, 7);
  pointer('pointermove', 850);
  assert.equal(f.panel.state.width, 450); assert.equal(f.panel.state.columns, 4);
  assert.equal(f.store[VIEW].panelWidth, 300, 'live drag is not persisted');
  pointer('pointerup', 850);
  assert.equal(captured, null); assert.equal(f.store[VIEW].panelWidth, 450);
  f.key(handle, 'ArrowRight'); assert.equal(f.panel.state.width, 434);
  f.key(handle, 'ArrowLeft'); assert.equal(f.store[VIEW].panelWidth, 450);
  handle.dispatchEvent(new f.w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(f.panel.state.width, 300); assert.equal(f.store[VIEW].panelWidth, 300);
  assert.equal(f.q('.row').children.length, 3);
  f.panel.destroy(); f.w.close();
});

test('fit narrows after pushing without saving, restores remembered width on resize, and falls back to overlay', async () => {
  const f = setup({ width: 1168, stored: { [VIEW]: { folderId: 'f2', panelWidth: 480 } } });
  const html = f.doc.documentElement; let minimumRight = 850;
  f.doc.querySelector('form').getBoundingClientRect = () => {
    const push = html.classList.contains('lakomics-arca-picker-push') ? Number.parseFloat(html.style.getPropertyValue('--lakomics-picker-width')) : 0;
    return { right: Math.max(minimumRight, f.w.innerWidth - push - 20) };
  };
  await f.panel.open();
  assert.equal(f.panel.state.width, 318); assert.equal(f.panel.state.panelWidth, 480);
  assert.equal(f.store[VIEW].panelWidth, 480);
  assert.ok(f.doc.querySelector('form').getBoundingClientRect().right <= f.w.innerWidth - f.panel.state.width);
  Object.defineProperty(f.w, 'innerWidth', { value: 1500, configurable: true });
  f.w.dispatchEvent(new f.w.Event('resize')); await wait(40);
  assert.equal(f.panel.state.width, 480); assert.equal(f.store[VIEW].panelWidth, 480);
  Object.defineProperty(f.w, 'innerWidth', { value: 1168, configurable: true }); minimumRight = 950;
  f.w.dispatchEvent(new f.w.Event('resize')); await wait(40);
  assert.equal(f.panel.state.width, 264); assert.equal(f.panel.state.overlay, true);
  assert.equal(html.classList.contains('lakomics-arca-picker-push'), false);
  f.q('.lk-head [aria-label="접기"]').click();
  assert.equal(html.classList.contains('lakomics-arca-picker-push'), true);
  assert.equal(Number.parseFloat(html.style.getPropertyValue('--lakomics-picker-width')), 56);
  assert.equal(f.store[VIEW].panelWidth, 480);
  f.panel.destroy(); f.w.close();
});

test('fold preserves picks, rail thumbs unfold and focus, and the folded state is remembered', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2', panelWidth: 420 } } });
  Object.defineProperty(f.w, 'innerHeight', { value: 300, configurable: true });
  await f.panel.open();
  f.qa('.tile').slice(0, 7).forEach(tile => tile.click());
  f.q('.lk-head [aria-label="접기"]').click();
  assert.equal(f.panel.state.folded, true); assert.equal(f.q('.lk').inert, true);
  assert.equal(f.q('.rail-count').textContent, '7장');
  assert.equal(f.qa('.rail-thumb').length, 2); assert.equal(f.q('.rail-more').textContent, '+5');
  assert.equal(f.q('.rail .primary').disabled, false);
  f.qa('.rail-thumb')[1].click();
  assert.equal(f.panel.state.folded, false); assert.equal(f.panel.root.activeElement.dataset.id, 'a2');
  assert.equal(f.panel.selection.size, 7);
  f.q('.lk-head [aria-label="접기"]').click(); f.panel.close({ animate: false });
  await f.panel.open(); assert.equal(f.panel.state.folded, true);
  const g = setup({ stored: plain(f.store) }); await g.panel.open();
  assert.equal(g.panel.state.folded, true); assert.equal(g.panel.state.panelWidth, 420);
  assert.equal(g.q('.rail .primary').disabled, true);
  f.key(f.q('.rail-thumb'), 'p');
  assert.equal(f.panel.state.folded, false); assert.ok(f.q('.prev'));
  f.panel.destroy(); g.panel.destroy(); f.w.close(); g.w.close();
});

test('shortcut cycles closed, open, folded, open; Escape and close still close', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2' } } });
  const editor = f.doc.querySelector('.fr-element'); editor.tabIndex = 0; editor.focus();
  await f.panel.toggle(); assert.equal(f.panel.isOpen, true); assert.equal(f.panel.state.folded, false);
  assert.equal(f.doc.activeElement, editor, 'the shortcut leaves the editor caret in place');
  f.panel.toggle(); assert.equal(f.panel.isOpen, true); assert.equal(f.panel.state.folded, true);
  assert.deepEqual(f.changes, [true], 'folding keeps the toolbar pressed');
  f.panel.toggle(); assert.equal(f.panel.state.folded, false);
  f.q('.lk-head [aria-label="닫기"]').click(); assert.equal(f.panel.isOpen, false);
  await f.panel.open(); f.q('.lk-head [aria-label="접기"]').click();
  f.key(f.q('.rail [aria-label="펼치기"]'), 'Escape'); assert.equal(f.panel.isOpen, false);
  assert.deepEqual(f.changes, [true, false, true, false]);
  f.panel.destroy(); f.w.close();
});

test('content routes the shortcut to folding while the pressed toolbar button closes the rail', async () => {
  const w = world({ html: toolbarHtml }); w.__LAKOMICS_TEST__ = true;
  w.eval(await readFile(new URL('../src/picker/content.js', import.meta.url), 'utf8'));
  let command;
  const runtime = {
    onMessage: { addListener(listener) { command = listener; } },
    sendMessage(message, reply) {
      if (message.type === 'picker:folders') reply({ ok: true, entries: FOLDERS });
      else if (message.type === 'picker:batch') reply({ ok: true, items: [{ ...item(1), thumbBase64: 'AAEC' }] });
      else reply({ ok: true });
    },
  };
  const storage = { async get() { return { [VIEW]: { folderId: 'f2' } }; } };
  const app = w.LakomicsPickerContent.start({ doc: w.document, win: w, runtime, storage });
  command({ type: 'picker:toggle' }); await settle();
  assert.equal(app.panel.isOpen, true); assert.equal(app.toolbar.button.getAttribute('aria-pressed'), 'true');
  command({ type: 'picker:toggle' }); assert.equal(app.panel.state.folded, true);
  assert.equal(app.toolbar.button.getAttribute('aria-pressed'), 'true');
  app.toolbar.button.click();
  assert.equal(app.panel.isOpen, false); assert.equal(app.toolbar.button.getAttribute('aria-pressed'), 'false');
  app.panel.destroy(); app.toolbar.stop(); w.close();
});

test('rail insert uses the same jobs, reports progress and unfolds on any failure', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2' } } });
  await f.panel.open();
  f.qa('.tile').slice(0, 2).forEach(tile => tile.click()); f.q('.lk-head [aria-label="접기"]').click();
  const replies = [];
  f.behaviour.original = () => new Promise(resolve => replies.push(resolve));
  f.q('.rail .primary').click();
  assert.equal(f.q('.rail .primary').disabled, true); assert.equal(f.q('.rail-count').textContent, '0/2');
  replies.shift()({ ok: true, mime: 'image/png', base64: 'AAEC' }); await settle();
  assert.equal(f.q('.rail-count').textContent, '1/2'); assert.equal(f.panel.state.folded, true);
  replies.shift()({ ok: false, kind: 'missing' }); await settle();
  assert.equal(f.panel.state.folded, false); assert.equal(f.q('.job').hidden, false);
  assert.equal(f.qa('.jr.bad').length, 1); assert.equal(f.inserted.length, 1);
  assert.deepEqual(plain(f.panel.selection.ids()), ['a2']);
  f.panel.destroy(); f.w.close();
});

test('last selected tray stays under the pointer until it leaves', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2' } } }); await f.panel.open();
  f.q('.tile').click(); const tray = f.q('.tray');
  tray.dispatchEvent(new f.w.Event('pointerenter'));
  f.q('.tray .x').click();
  assert.equal(f.panel.selection.size, 0); assert.equal(tray.hidden, false); assert.equal(f.qa('.tray .t').length, 1);
  tray.dispatchEvent(new f.w.Event('pointerleave')); await wait(170);
  assert.equal(tray.hidden, true);
  f.panel.destroy(); f.w.close();
});

test('newest fills until one row overflows and fills again after viewport or column changes', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2', order: 'newest' } } });
  const resize = gridGeometry(f, 600);
  f.behaviour.batch = async request => ({ ok: true, nextOffset: request.offset + 18,
    items: Array.from({ length: 18 }, (_, i) => ({ ...item(request.offset + i + 1), thumbBase64: 'AAEC' })) });
  await f.panel.open(); await wait(80); await settle();
  assert.equal(f.panel.state.batch.length, 36);
  const first = f.q('.tile'); first.click(); first.focus();
  resize(1400); await wait(80); await settle();
  assert.equal(f.panel.state.batch.length, 54); assert.equal(f.q('.tile'), first);
  assert.equal(f.panel.root.activeElement, first);
  // Four columns fit more rows; narrowing tile size must fill the new space too.
  for (let i = 0; i < 8; i++) f.key(f.q('[role="separator"]'), 'ArrowLeft');
  await wait(80); await settle();
  assert.equal(f.panel.state.columns, 4); assert.equal(f.panel.state.batch.length, 72);
  assert.equal(f.q('.tile'), first); assert.equal(f.panel.selection.size, 1);
  f.panel.destroy(); f.w.close();
});

test('newest automatic fill stops at the end or 240 items', async () => {
  for (const end of [20, 1000]) {
    const f = setup({ stored: { [VIEW]: { folderId: 'f2', order: 'newest' } } }); gridGeometry(f, 10000);
    f.behaviour.batch = async request => {
      const count = Math.min(18, end - request.offset);
      return { ok: true, nextOffset: request.offset + count < end ? request.offset + count : null,
        items: Array.from({ length: count }, (_, i) => ({ ...item(request.offset + i + 1), thumbBase64: 'AAEC' })) };
    };
    await f.panel.open(); await wait(150); await settle();
    assert.equal(f.panel.state.batch.length, Math.min(end, 240));
    assert.equal(f.q('.foot .cbtn').disabled, false, 'refresh stays available at the end');
    f.panel.destroy(); f.w.close();
  }
});

test('newest fill continues through an empty page when the cursor advances', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2', order: 'newest' } } }); gridGeometry(f, 600);
  f.behaviour.batch = async request => ({ ok: true,
    items: request.offset === 18 ? [{ ...item(1), thumbBase64: 'AAEC' }] : [],
    nextOffset: request.offset < 36 ? request.offset + 18 : null });
  await f.panel.open(); await wait(80); await settle();
  assert.equal(f.panel.state.batch.length, 1); assert.equal(f.panel.state.nextOffset, null);
  assert.deepEqual(batchesOf(f).map(request => request.offset), [0, 18, 36]);
  f.panel.destroy(); f.w.close();
});

test('random sizes requests for the grid, splits at 24, and tops up instead of replacing on resize', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2' } } }); const resize = gridGeometry(f, 1000);
  let next = 1;
  f.behaviour.batch = async request => ({ ok: true, items: Array.from({ length: request.limit }, () => ({ ...item(next++), thumbBase64: 'AAEC' })) });
  await f.panel.open(); await wait(60); await settle();
  assert.equal(f.panel.state.batch.length, 30); assert.deepEqual(batchesOf(f).slice(0, 2).map(request => request.limit), [24, 6]);
  const first = f.q('.tile'); first.click(); first.focus(); const requests = batchesOf(f).length;
  resize(1400); await wait(60); await settle();
  assert.equal(f.panel.state.batch.length, 42); assert.equal(f.q('.tile'), first);
  assert.equal(f.panel.root.activeElement, first); assert.equal(first.getAttribute('aria-selected'), 'true');
  assert.equal(batchesOf(f)[requests].limit, 12); assert.ok(batchesOf(f)[requests].exclude.includes('a1'));
  for (let i = 0; i < 8; i++) f.key(f.q('[role="separator"]'), 'ArrowLeft');
  await wait(60); await settle();
  assert.equal(f.panel.state.columns, 4); assert.equal(f.panel.state.batch.length, 56);
  assert.ok(batchesOf(f).every(request => request.limit <= 24)); assert.equal(f.q('.tile'), first);
  f.panel.destroy(); f.w.close();
});

test('newest refresh and R restart at offset zero, jump to top and retain the old grid until ready', async () => {
  const f = setup({ stored: { [VIEW]: { folderId: 'f2', order: 'newest' } } });
  f.behaviour.batch = async request => ({ ok: true, nextOffset: 18,
    items: Array.from({ length: 18 }, (_, i) => ({ ...item(request.offset + i + 1), thumbBase64: 'AAEC' })) });
  await f.panel.open(); await settle();
  const grid = f.q('.grid'), first = f.q('.tile'); grid.scrollTop = 300;
  let reply; f.behaviour.batch = () => new Promise(resolve => { reply = resolve; });
  f.q('.foot .cbtn').click(); await settle();
  assert.equal(grid.scrollTop, 0); assert.equal(f.q('.tile'), first); assert.equal(grid.inert, true);
  assert.equal(batchesOf(f).at(-1).offset, 0);
  reply({ ok: true, items: [{ ...item(99), thumbBase64: 'AAEC' }], nextOffset: null }); await settle();
  assert.equal(f.q('.tile').dataset.id, 'a99');
  f.key(f.q('.tile'), 'R'); await settle(); assert.equal(batchesOf(f).at(-1).offset, 0);
  reply({ ok: true, items: [{ ...item(100), thumbBase64: 'AAEC' }], nextOffset: null }); await settle();
  assert.equal(f.q('.tile').dataset.id, 'a100'); assert.match(f.q('.foot .cbtn').textContent, /새로고침/);
  f.panel.destroy(); f.w.close();
});

function rotate(f, width, height) {
  Object.defineProperties(f.w, { innerWidth: { value: width, configurable: true }, innerHeight: { value: height, configurable: true } });
  f.w.dispatchEvent(new f.w.Event('resize'));
}
function touch(f, target, type, x, y, time) {
  const event = new f.w.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] }, timeStamp: { value: time } });
  target.dispatchEvent(event);
}
function dragSheet(f, delta, duration = 1000) {
  const handle = f.q('.sheet-handle');
  touch(f, handle, 'touchstart', 200, 200, 0);
  touch(f, handle, 'touchmove', 200, 200 - delta, duration);
  touch(f, handle, 'touchend', 200, 200 - delta, duration + 1);
}

test('portrait mode follows viewport and rotation keeps picks, batch, and grid scroll', async () => {
  const f = setup({ width: 674, height: 1078, stored: { [VIEW]: { folderId: 'f2' } } });
  await f.panel.open(); await settle();
  assert.equal(f.panel.state.sheet, true); assert.equal(f.panel.state.columns, 5);
  assert.equal(f.panel.state.sheetLevel, 'half');
  assert.equal(f.doc.documentElement.classList.contains('lakomics-arca-picker-push'), false);
  assert.ok(batchesOf(f).every(request => request.limit <= 24));
  assert.equal(f.panel.state.batch.length, 35);
  const first = f.q('.tile'), grid = f.q('.grid'), batch = f.panel.state.batch.map(item => item.assetId);
  first.click(); grid.scrollTop = 200;
  rotate(f, 1078, 674); await wait(40);
  assert.equal(f.panel.state.sheet, false); assert.equal(f.q('.tile'), first); assert.equal(grid.scrollTop, 200);
  rotate(f, 674, 1078); await wait(40);
  assert.equal(f.panel.state.sheet, true); assert.deepEqual(f.panel.state.batch.map(item => item.assetId), batch);
  assert.equal(grid.scrollTop, 200); assert.equal(f.panel.selection.size, 1);
  rotate(f, 900, 1200); await wait(40); assert.equal(f.panel.state.sheet, false);
  f.panel.destroy(); f.w.close();
});

test('sheet snap chooses nearest height, and a flick advances in its direction', () => {
  const w = world(), { snapSheet, portrait, caretScroll } = w.LakomicsPickerPanel;
  assert.equal(snapSheet(100, 0, 1078), 72);
  assert.equal(snapSheet(500, .2, 1078), 593);
  assert.equal(snapSheet(800, 0, 1078), 593);
  assert.equal(snapSheet(800, .5, 1078), 1042);
  assert.equal(snapSheet(500, -.5, 1078), 72);
  assert.equal(snapSheet(60, -.5, 1078), 0);
  assert.equal(portrait({ innerWidth: 674, innerHeight: 1078 }), true);
  assert.equal(portrait({ innerWidth: 899, innerHeight: 899 }), false);
  assert.equal(caretScroll(600, 593, 1078), 139);
  assert.equal(caretScroll(400, 593, 1078), 0);
  assert.equal(caretScroll(1000, 1042, 1078), 0);
  w.close();
});

test('sheet handle snaps, scrim returns full to half, bar drag closes keeping picks', async () => {
  const f = setup({ width: 674, height: 1078, stored: { [VIEW]: { folderId: 'f2' } } }); await f.panel.open();
  f.q('.tile').click(); dragSheet(f, 400); await wait(1);
  assert.equal(f.panel.state.sheetLevel, 'full');
  f.q('.sheet-scrim').click(); assert.equal(f.panel.state.sheetLevel, 'half');
  f.q('.sheet-handle').click(); assert.equal(f.panel.state.sheetLevel, 'bar');
  assert.equal(f.store[VIEW].folded, true);
  dragSheet(f, -60); assert.equal(f.panel.isOpen, false); assert.equal(f.panel.selection.size, 1);
  await f.panel.open(); assert.equal(f.panel.state.sheetLevel, 'bar');
  f.q('.rail').click(); assert.equal(f.panel.state.sheetLevel, 'half');
  f.panel.destroy(); f.w.close();
});

test('visual viewport folds only for keyboard, restores its prior height, and bar tap blurs', async () => {
  const f = setup({ width: 674, height: 1078, stored: { [VIEW]: { folderId: 'f2' } } });
  const vv = new f.w.EventTarget(); Object.assign(vv, { height: 1078, offsetTop: 0 });
  Object.defineProperty(f.w, 'visualViewport', { value: vv });
  let blurred = 0; f.editor.find = () => ({ blur() { blurred++; } });
  const resize = height => { vv.height = height; vv.dispatchEvent(new f.w.Event('resize')); };
  await f.panel.open(); dragSheet(f, 400); await wait(1);
  resize(650); assert.equal(f.panel.state.keyboard, true); assert.equal(f.panel.state.sheetLevel, 'bar');
  assert.equal(f.store[VIEW].folded, false, 'automatic fold is not remembered');
  resize(1078); assert.equal(f.panel.state.sheetLevel, 'full');
  f.q('.sheet-handle').click(); resize(650); resize(1078);
  assert.equal(f.panel.state.sheetLevel, 'bar', 'a manually folded bar remains folded');
  resize(650); f.q('.rail').click(); assert.equal(blurred, 1); assert.equal(f.panel.state.sheetLevel, 'half');
  resize(1078); assert.equal(f.panel.state.sheetLevel, 'half');
  f.panel.destroy(); f.w.close();
});

test('portrait insert drops to bar on complete success and raises job rows on failure', async () => {
  for (const failed of [false, true]) {
    const f = setup({ width: 674, height: 1078, stored: { [VIEW]: { folderId: 'f2' } } }); await f.panel.open();
    f.qa('.tile').slice(0, 2).forEach(tile => tile.click());
    if (failed) f.results.push({ ok: true }, { ok: false, reason: 'ignored' });
    await f.panel.insert();
    assert.equal(f.panel.state.sheetLevel, failed ? 'half' : 'bar');
    assert.equal(f.panel.selection.size, failed ? 1 : 0);
    if (failed) assert.equal(f.qa('.jr.bad').length, 1);
    f.panel.destroy(); f.w.close();
  }
});

test('portrait remembers caret, scrolls by its overlap and draws marker only while unfocused', async () => {
  const f = setup({ width: 674, height: 1078, stored: { [VIEW]: { folderId: 'f2' } } });
  const field = f.doc.querySelector('.fr-element'); field.tabIndex = 0;
  let scroll = 0; Object.defineProperty(f.w, 'scrollY', { get: () => scroll });
  f.w.scrollTo = ({ top }) => { scroll = top; };
  f.editor.find = () => field;
  f.editor.caretRect = () => ({ left: 100, top: 580 - scroll, bottom: 600 - scroll, height: 20 });
  field.focus(); await f.panel.open({ focus: false }); await wait(250);
  assert.equal(scroll, 139); assert.equal(f.q('.remembered-caret').hidden, true);
  field.blur(); await wait(5); assert.equal(f.q('.remembered-caret').hidden, false);
  const before = scroll; dragSheet(f, 400); await wait(240); assert.equal(scroll, before, 'full height does not scroll');
  f.panel.destroy(); f.w.close();
});

test('bar insert retains editor focus above the keyboard and reports progress', async () => {
  const f = setup({ width: 674, height: 1078, stored: { [VIEW]: { folderId: 'f2' } } });
  const vv = new f.w.EventTarget(); Object.assign(vv, { height: 1078, offsetTop: 0 });
  Object.defineProperty(f.w, 'visualViewport', { value: vv });
  await f.panel.open(); f.qa('.tile').slice(0, 2).forEach(tile => tile.click());
  const field = f.doc.querySelector('.fr-element'); field.tabIndex = 0; field.focus();
  let scroll = 0; Object.defineProperty(f.w, 'scrollY', { get: () => scroll });
  f.w.scrollTo = ({ top }) => { scroll = top; };
  f.editor.caretRect = () => ({ left: 100, top: 580 - scroll, bottom: 600 - scroll, height: 20 });
  vv.height = 650; vv.offsetTop = 20; vv.dispatchEvent(new f.w.Event('resize'));
  assert.equal(Number.parseFloat(f.panel.host.style.bottom), 408);
  const down = new f.w.MouseEvent('mousedown', { bubbles: true, cancelable: true }); f.q('.rail .primary').dispatchEvent(down);
  assert.equal(down.defaultPrevented, true); assert.equal(f.doc.activeElement, field);
  const replies = []; f.behaviour.original = () => new Promise(resolve => replies.push(resolve));
  const pending = f.panel.insert(); assert.equal(f.q('.rail-count').textContent, '0/2');
  replies.shift()({ ok: true, mime: 'image/png', base64: 'AAEC' }); await settle();
  assert.equal(f.q('.rail-count').textContent, '1/2');
  replies.shift()({ ok: true, mime: 'image/png', base64: 'AAEC' }); await pending;
  assert.equal(f.panel.state.sheetLevel, 'bar'); assert.equal(f.panel.state.keyboard, true); assert.equal(f.doc.activeElement, field);
  await wait(240); assert.equal(scroll, 26, 'caret is revealed above the bar and keyboard together');
  vv.height = 1078; vv.offsetTop = 0; vv.dispatchEvent(new f.w.Event('resize'));
  assert.equal(f.panel.state.sheetLevel, 'bar', 'successful insert cancels keyboard restore');
  f.panel.destroy(); f.w.close();
});

test('grid moves the sheet only from its top when dragged down; previews swipe both directions', async () => {
  const f = setup({ width: 674, height: 1078, stored: { [VIEW]: { folderId: 'f2' } } }); await f.panel.open();
  const grid = f.q('.grid'); grid.scrollTop = 100;
  touch(f, grid, 'touchstart', 200, 200, 0); touch(f, grid, 'touchmove', 200, 700, 1000); touch(f, grid, 'touchend', 200, 700, 1001);
  assert.equal(f.panel.state.sheetLevel, 'half'); grid.scrollTop = 0;
  touch(f, grid, 'touchstart', 200, 700, 0); touch(f, grid, 'touchmove', 200, 200, 1000); touch(f, grid, 'touchend', 200, 200, 1001);
  assert.equal(f.panel.state.sheetLevel, 'half');
  touch(f, grid, 'touchstart', 200, 200, 0); touch(f, grid, 'touchmove', 200, 700, 1000); touch(f, grid, 'touchend', 200, 700, 1001);
  assert.equal(f.panel.state.sheetLevel, 'bar'); await wait(1);
  f.q('.rail').click(); dragSheet(f, 400); await wait(1);
  f.key(f.q('.tile'), 'p'); assert.equal(f.panel.state.sheetLevel, 'half'); assert.equal(f.panel.state.preview, 0);
  const preview = f.q('.prev');
  for (const [delta, expected] of [[-100, 1], [100, 0]]) {
    touch(f, preview, 'touchstart', 200, 200, 0); touch(f, preview, 'touchmove', 200 + delta, 200, 100); touch(f, preview, 'touchend', 200 + delta, 200, 101);
    assert.equal(f.panel.state.preview, expected);
  }
  touch(f, preview, 'touchstart', 200, 200, 0); touch(f, preview, 'touchmove', 200, 300, 100); touch(f, preview, 'touchend', 200, 300, 101);
  assert.equal(f.panel.state.preview, null);
  f.w.matchMedia = query => ({ matches: query === '(pointer: coarse)' });
  const tile = f.q('.tile'); tile.dispatchEvent(new f.w.MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }));
  await wait(430); assert.equal(f.panel.state.preview, 0);
  tile.click(); assert.equal(f.panel.selection.size, 0, 'long press does not select the picture');
  tile.dispatchEvent(new f.w.MouseEvent('pointerup', { bubbles: true }));
  f.panel.destroy(); f.w.close();
});
