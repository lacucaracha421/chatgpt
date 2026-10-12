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
  assert.match(css, /html\.lakomics-arca-picker-push\{margin-right:360px/);
});

// ---- panel -------------------------------------------------------------------------------
const FOLDERS = [
  { id: 'f1', parentId: null, name: '캐릭터', path: ['캐릭터'], imageCount: 0, imageCountWithDescendants: 40 },
  { id: 'f2', parentId: 'f1', name: '아로나', path: ['캐릭터', '아로나'], imageCount: 40, imageCountWithDescendants: 40 },
  { id: 'f3', parentId: null, name: '빈 폴더', path: ['빈 폴더'], imageCount: 0, imageCountWithDescendants: 6 },
];
const item = n => ({ assetId: 'a' + n, width: 1536, height: 2048, byteSize: 1_468_006, mime: 'image/webp' });

function setup({ stored = {}, folders = FOLDERS, batches = null, width = 1440, formRight = 900 } = {}) {
  const w = world({ html: toolbarHtml, width }), doc = w.document;
  doc.querySelector('form').getBoundingClientRect = () => ({ left: 100, right: formRight, top: 0, bottom: 500, width: formRight - 100, height: 500 });
  const sent = [], store = { ...stored }; let nextBatch = 0;
  const behaviour = { folders: { ok: true, entries: folders }, batch: null, original: null };
  const send = async message => {
    sent.push(message);
    if (message.type === 'picker:folders') return behaviour.folders;
    if (message.type === 'picker:batch') {
      if (behaviour.batch) return behaviour.batch(message);
      const list = batches ? batches[nextBatch++ % batches.length] : Array.from({ length: 18 }, (_, i) => item(nextBatch * 18 + i + 1));
      if (!batches) nextBatch++;
      return { ok: true, items: list.map(n => typeof n === 'number' ? item(n) : n), remaining: 100 };
    }
    if (message.type === 'picker:thumb') return { ok: true, mime: 'image/webp', base64: 'AAEC' };
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
  assert.deepEqual(plain(f.store['lakomics:picker:view:v1']), { folderId: 'f2', includeDescendants: true });
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
  assert.equal(requests.length, 3);
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
  assert.equal(wide.panel.host.style.position, 'fixed'); assert.equal(wide.panel.host.style.width, '360px'); assert.equal(wide.panel.host.style.zIndex, '2147483646');
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
