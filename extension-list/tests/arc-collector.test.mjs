import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const dom = new JSDOM('<!doctype html><body><button id="opener">image</button></body>', { url: 'https://example.test/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
await import('../src/classification-tree.js');
await import('../src/arc-collector.js');
const entries = [
  { id: 'games', name: '게임', parentId: null },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `root${i}`, name: `최상위 ${i}`, parentId: null })),
  ...Array.from({ length: 12 }, (_, i) => ({ id: `game${i}`, name: `게임 ${i}`, parentId: 'games' })),
  ...Array.from({ length: 14 }, (_, i) => ({ id: `child${i}`, name: `하위 ${i}`, parentId: 'game7' })),
];
let views = [];
afterEach(() => { for (const view of views) { view.unlockInput(); view.close(); } views = []; });
function mount(options = {}) {
  const view = globalThis.LakomicsArcCollector.mount({ entries, profile: {}, onSave: async () => ({ ok: true }), ...options });
  views.push(view);
  return { ...view, $: selector => view.host.shadowRoot.querySelector(selector), $$: selector => [...view.host.shadowRoot.querySelectorAll(selector)] };
}
const row = (view, id) => view.$(`[data-classification-id="${id}"]`);
const currentIds = view => view.$$('.sector[data-classification-id]').map(button => button.dataset.classificationId);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const tap = (view, id) => row(view, id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, detail: 1 }));
const enter = (view, id) => { tap(view, id); tap(view, id); };


test('root keeps six folder slots and exposes every overflow folder', () => {
  const view = mount();
  assert.deepEqual(currentIds(view), ['games', 'root0', 'root1', 'root2', 'root3', 'root4']);
  assert.equal(view.$$('.sector').length, 6);
  assert.equal(view.$('.save-current').disabled, true);
  assert.equal(view.$('.back').disabled, true);
  view.$('.root-next').click();
  assert.deepEqual(currentIds(view), ['root5']);
  assert.equal(view.$$('.sector.empty').length, 5);
  view.$('.root-next').click();
  assert.equal(row(view, 'games').dataset.slot, '0');
});

test('children keep five folder slots and the bottom navigation slot through page wrap', () => {
  const view = mount(); enter(view, 'games');
  assert.deepEqual(currentIds(view), ['game0', 'game1', 'game2', 'game3', 'game4']);
  assert.equal(view.$('.next').dataset.slot, '5');
  const target = view.$('.save-current').getAttribute('aria-label');
  view.$('.next').click(); view.$('.next').click();
  assert.deepEqual(currentIds(view), ['game10', 'game11']);
  assert.equal(view.$$('.sector.empty').length, 3);
  assert.match(view.$('.next').textContent, /처음으로3\/3/);
  assert.equal(view.$('.save-current').getAttribute('aria-label'), target);
  view.$('.next').click();
  assert.equal(row(view, 'game0').dataset.slot, '0');
});

test('back follows visited screens, restores parent pages, and skips page changes', () => {
  const view = mount(); enter(view, 'games'); view.$('.next').click(); enter(view, 'game7');
  view.$('.next').click(); view.$('.next').click();
  assert.equal(view.$('.panel').dataset.depth, '2');
  view.$('.back').click();
  assert.equal(view.$('.panel').dataset.page, '2');
  assert.ok(row(view, 'game7'));
  assert.equal(view.$('.destination').textContent, '게임 7');
  view.$('.back').click();
  assert.equal(view.$('.panel').dataset.depth, '0');
});

test('pinned nested folders return straight to the root page they came from', () => {
  const view = mount({ profile: { pinnedClassificationIds: ['game7'] } });
  enter(view, 'game7'); assert.match(view.$('.path').textContent, /게임 \/ 게임 7/);
  view.$('.back').click(); assert.equal(view.$('.back').disabled, true);
  assert.equal(view.$('.save-current').disabled, false);
  assert.equal(view.$('.destination').textContent, '게임 7');
  assert.equal(row(view, 'game7').dataset.slot, '0');
});

test('leaf taps only select and central save sends exactly that destination', async () => {
  const saved = []; const view = mount({ onSave: async id => { saved.push(id); return { ok: true }; } });
  enter(view, 'games'); row(view, 'game2').click();
  assert.deepEqual(saved, []);
  assert.match(view.$('.save-current').getAttribute('aria-label'), /게임 \/ 게임 2에 저장/);
  view.$('.save-current').click(); await tick();
  assert.deepEqual(saved, ['game2']); assert.equal(view.host.isConnected, false);
});

test('branch destinations remain saveable and failures retain selection and prevent duplicate requests', async () => {
  let complete, calls = 0;
  const view = mount({ onSave: () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  enter(view, 'games'); view.$('.next').click();
  view.$('.save-current').click(); view.$('.save-current').click();
  assert.equal(calls, 1); assert.equal(view.$('.back').disabled, true);
  view.host.shadowRoot.querySelector('.backdrop').click();
  assert.equal(view.host.isConnected, true);
  complete({ ok: false, message: 'offline' }); await tick();
  assert.equal(view.host.isConnected, true); assert.equal(view.$('.notice').textContent, 'offline');
  assert.equal(view.$('.panel').dataset.page, '2'); assert.equal(view.$('.destination').textContent, '게임');
  view.$('.save-current').click(); assert.equal(calls, 2);
  complete({ ok: true }); await tick(); assert.equal(view.host.isConnected, false);
});

test('opening finger lock blocks navigation, saving, temporary action and dismissal until release', () => {
  let temporary = 0;
  const view = mount({ inputLocked: true, onTemporary: () => { temporary++; } });
  enter(view, 'games'); view.$('.temporary').click(); view.host.shadowRoot.querySelector('.backdrop').click();
  assert.equal(view.$('.panel').dataset.depth, '0'); assert.equal(temporary, 0); assert.equal(view.host.isConnected, true);
  view.unlockInput(); enter(view, 'games'); assert.equal(view.$('.panel').dataset.depth, '1');
});

test('central temporary save stays root-only and blocks back double taps before becoming synchronous again', async () => {
  let temporary = 0, permanent = 0;
  const view = mount({ onTemporary: () => { temporary++; return false; }, onSave: () => { permanent++; } });
  assert.equal(view.$('footer .temporary'), null);
  assert.ok(view.$('.center .temporary'));
  enter(view, 'games'); assert.equal(view.$('.temporary'), null);
  view.$('.back').click(); view.$('.back').click();
  assert.equal(temporary, 0);
  assert.equal(view.$('.temporary').disabled, true);
  await new Promise(resolve => setTimeout(resolve, 420));
  view.$('.temporary').click();
  assert.equal(temporary, 1); assert.equal(permanent, 0); assert.equal(view.host.isConnected, true);
});

test('the opening press chooses the nearest screen edge without direction or close buttons', () => {
  const left = mount({ origin: { x: 100, y: 300 } });
  assert.equal(left.$('.panel').dataset.side, 'left');
  assert.equal(left.$('.panel').style.left, '0px');
  assert.equal(left.$('.side'), null); assert.equal(left.$('.close'), null);
  left.close();
  const right = mount({ origin: { x: 900, y: 300 } });
  assert.equal(right.$('.panel').dataset.side, 'right');
  assert.equal(right.$('.panel').style.right, '0px');
});

test('drag or cancelled touch never selects or saves a sector', () => {
  const view = mount(), button = row(view, 'games');
  function pointer(type, x) {
    const e = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 20 });
    Object.defineProperty(e, 'pointerId', { value: 1 }); button.dispatchEvent(e);
  }
  pointer('pointerdown', 10); pointer('pointermove', 60); pointer('pointerup', 60); button.click();
  assert.equal(view.$('.panel').dataset.depth, '0');
  pointer('pointerdown', 10); pointer('pointercancel', 10); button.click();
  assert.equal(view.$('.panel').dataset.depth, '0');
});

test('Escape restores focus and a single-page child retains its disabled navigation slot', () => {
  document.getElementById('opener').focus();
  const view = mount({ entries: entries.slice(0, 9) }); enter(view, 'games');
  assert.equal(view.$('.next').disabled, true); assert.equal(view.$('.next').dataset.slot, '5');
  view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(view.host.isConnected, false); assert.equal(document.activeElement.id, 'opener');
});

test('clicking outside the curved edge dismisses the menu, including transparent panel corners', () => {
  const view = mount();
  view.$('.arc').getBoundingClientRect = () => ({ left: 700, right: 924, top: 100, bottom: 548, width: 224, height: 448 });
  const click = (x, y) => view.$('.panel').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  click(710, 324);
  assert.equal(view.host.isConnected, true);
  click(710, 110);
  assert.equal(view.host.isConnected, false);
  assert.equal(view.$('.close'), null);
});

test('hiding a parent removes its entire subtree including pinned shortcuts and restoration preserves positions', () => {
  const profile = { pinnedClassificationIds: ['game7'] };
  const arcLayout = LakomicsClassificationTree.reconcileArcLayout(entries, profile);
  const view = mount({ profile, arcLayout, hiddenClassificationIds: ['games'] });
  assert.equal(row(view, 'games'), null);
  assert.equal(row(view, 'game7'), null);
  assert.deepEqual(currentIds(view), ['root0', 'root1', 'root2', 'root3', 'root4', 'root5']);
  view.update({ hiddenClassificationIds: [] });
  assert.equal(row(view, 'game7').dataset.slot, '0');
  assert.equal(row(view, 'games').dataset.slot, '1');
});

function editor(options = {}) {
  const container = document.createElement('div'); document.body.append(container);
  const state = { classifications: { entries }, profile: {}, hiddenClassificationIds: [], ...options.state };
  state.arcLayout = LakomicsClassificationTree.reconcileArcLayout(entries, state.profile);
  const changes = [];
  const view = mount({ ...state, container,
    onReorder: async (parentId, ids) => {
      changes.push({ parentId, ids });
      state.profile = { ...state.profile, listOrder: { ...state.profile.listOrder, [parentId ?? '__root__']: ids } };
      state.arcLayout = LakomicsClassificationTree.reconcileArcLayout(entries, state.profile, state.arcLayout);
      return { ok: true, state };
    },
    onHide: async id => { state.hiddenClassificationIds.push(id); return { ok: true, state }; },
    ...options,
  });
  return { ...view, changes, state };
}

test('embedded editor selects branches first, opens explicitly, moves across pages, and never saves media', async () => {
  let saves = 0;
  const view = editor({ onSave: () => { saves++; } });
  assert.equal(view.$('.panel').getAttribute('aria-modal'), null);
  assert.equal(view.host.parentElement.tagName, 'DIV');
  row(view, 'games').click();
  assert.equal(view.$('.panel').dataset.depth, '0');
  view.$('.save-current').click();
  assert.equal(view.$('.panel').dataset.depth, '1');
  row(view, 'game4').click();
  assert.equal(view.$('.save-current').disabled, true);
  view.$('.move-after').click(); await tick();
  assert.equal(view.$('.panel').dataset.page, '2');
  assert.equal(row(view, 'game4').dataset.slot, '0');
  assert.equal(view.changes[0].ids[4], 'game5');
  view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  assert.equal(saves, 0);
  view.$('.back').click();
  assert.equal(view.$('.panel').dataset.depth, '0');
  assert.equal(row(view, 'games').getAttribute('aria-pressed'), 'true');
});

test('editor interleaves shortcuts and roots, hides folders, and leaves normal Tab navigation intact', async () => {
  const view = editor({ state: { profile: { pinnedClassificationIds: ['game7'] } } });
  row(view, 'game7').click(); view.$('.move-after').click(); await tick();
  assert.equal(row(view, 'games').dataset.slot, '0');
  assert.equal(row(view, 'game7').dataset.slot, '1');
  row(view, 'games').click(); view.$('.hide-folder').click(); await tick();
  assert.equal(row(view, 'games'), null); assert.equal(row(view, 'game7'), null);
  assert.equal(view.$('.hide-folder').disabled, true);
  const e = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  view.$('.panel').dispatchEvent(e); assert.equal(e.defaultPrevented, false);
  view.$('.panel').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(view.host.isConnected, true);
});

test('failed editor changes retain order and selection and reject repeated changes while pending', async () => {
  let finish, calls = 0;
  const view = editor({ onReorder: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  row(view, 'root0').click(); view.$('.move-before').click(); view.$('.move-before').click();
  assert.equal(calls, 1); assert.equal(view.$('.hide-folder').disabled, true);
  finish({ ok: false }); await tick();
  assert.equal(row(view, 'root0').dataset.slot, '1');
  assert.equal(row(view, 'root0').getAttribute('aria-pressed'), 'true');
  assert.match(view.$('.notice').textContent, /변경하지 못했습니다/);
});


test('single tap selects any branch for saving and only a double tap enters its children', async () => {
  const saved = [], view = mount({ onSave: async id => { saved.push(id); return { ok: true }; } });
  tap(view, 'games');
  assert.equal(view.$('.panel').dataset.depth, '0');
  assert.equal(view.$('.destination').textContent, '게임');
  view.$('.save-current').click(); await tick();
  assert.deepEqual(saved, ['games']);
  const other = mount();
  tap(other, 'games'); tap(other, 'games');
  assert.equal(other.$('.panel').dataset.depth, '1');
  assert.equal(other.$('.destination').textContent, '게임');
});

test('slow repeated taps keep selecting and keyboard users open branches with ArrowRight', async () => {
  const view = mount(); tap(view, 'games');
  await new Promise(resolve => setTimeout(resolve, 370));
  tap(view, 'games');
  assert.equal(view.$('.panel').dataset.depth, '0');
  row(view, 'games').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(view.$('.panel').dataset.depth, '1');
});


test('pinned shortcuts disappear from child pages and return to their canonical position when unpinned', () => {
  const profile = { pinnedClassificationIds: ['game1', 'game7'] };
  const arcLayout = LakomicsClassificationTree.reconcileArcLayout(entries, profile);
  const view = mount({ profile, arcLayout });
  assert.ok(row(view, 'game1')); assert.ok(row(view, 'game7'));
  enter(view, 'games');
  assert.deepEqual(currentIds(view), ['game0', 'game2', 'game3', 'game4', 'game5']);
  view.$('.next').click();
  assert.deepEqual(currentIds(view), ['game6', 'game8', 'game9', 'game10', 'game11']);
  view.update({ profile: { pinnedClassificationIds: [] } });
  view.$('.next').click(); view.$('.next').click();
  assert.equal(row(view, 'game1').dataset.slot, '1');
  assert.equal(view.tree.path('game7')[0].id, 'games');
});

test('a parent with only pinned children remains saveable without offering an empty child screen', () => {
  const view = mount({ entries: entries.slice(0, 9), profile: { pinnedClassificationIds: ['game0', 'game1'] } });
  assert.equal(row(view, 'games').classList.contains('branch'), false);
  tap(view, 'games'); tap(view, 'games');
  assert.equal(view.$('.panel').dataset.depth, '0');
  assert.equal(view.$('.save-current').disabled, false);
});

test('settings preview uses the same shortcut deduplication and never enables temporary saving', () => {
  let calls = 0;
  const view = editor({ state: { profile: { pinnedClassificationIds: ['game1'] } }, onTemporary: () => { calls++; } });
  assert.equal(view.$('.temporary').disabled, true);
  view.$('.temporary').click(); assert.equal(calls, 0);
  row(view, 'games').click(); view.$('.save-current').click();
  assert.deepEqual(currentIds(view), ['game0', 'game2', 'game3', 'game4', 'game5']);
});
