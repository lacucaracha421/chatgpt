import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from '../../app/node_modules/jsdom/lib/api.js';

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'https://example.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
await import('../src/classification-tree.js');
await import('../src/list-collector.js');

function pointer(type, { id = 1, x = 10, y = 10 } = {}) {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: id });
  return event;
}

function mount(entries, onSave = async () => ({ ok: true })) {
  return globalThis.LakomicsListCollector.mount({
    entries, profile: { revision: 1, listOrder: {}, pinnedClassificationIds: [] },
    container: document.querySelector('#root'), onSave, onClose: () => {},
  });
}
test('left swipe saves the row and exposes the legacy save surface', async () => {
  let saved = null;
  const view = mount([{ id: 'a', name: 'A', parentId: null }], async (id) => { saved = id; return { ok: true }; });
  const shadow = view.host.shadowRoot;
  const row = shadow.querySelector('.row');
  const swipe = shadow.querySelector('.swipe');
  row.dispatchEvent(pointer('pointerdown', { x: 10, y: 20 }));
  swipe.dispatchEvent(pointer('pointermove', { x: -72, y: 20 }));
  assert.equal(row.parentElement.classList.contains('ready'), true);
  assert.equal(row.parentElement.querySelector('.reveal').textContent, '저장');
  swipe.dispatchEvent(pointer('pointerup', { x: -72, y: 20 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved, 'a');
});

test('legacy paper chooser styling is retained in the list-only build', () => {
  const view = mount([{ id: 'a', name: 'A', parentId: null }]);
  const css = view.host.shadowRoot.querySelector('style').textContent;
  assert.match(css, /--paper:#d7d3b9/);
  assert.match(css, /width:350px;height:410px/);
  assert.match(css, /justify-content:flex-end/);
  view.close();
});
test('right swipe goes back inside a folder and never saves', async () => {
  let saves = 0;
  const view = mount([
    { id: 'root', name: 'ROOT', parentId: null },
    { id: 'child', name: 'CHILD', parentId: 'root' },
  ], async () => { saves += 1; return { ok: true }; });
  const shadow = view.host.shadowRoot;
  shadow.querySelector('.row').click();
  let row = shadow.querySelector('.row');
  const swipe = shadow.querySelector('.swipe');
  row.dispatchEvent(pointer('pointerdown', { x: 20, y: 20 }));
  swipe.dispatchEvent(pointer('pointermove', { x: 100, y: 20 }));
  swipe.dispatchEvent(pointer('pointerup', { x: 100, y: 20 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saves, 0);
  assert.equal(shadow.querySelector('.back').disabled, true);
  view.close();
});

test('chooser long press owns its shadow DOM and exposes no native title tooltip', () => {
  const view = mount([{ id: 'a', name: 'A', parentId: null }]);
  const shadow = view.host.shadowRoot;
  const row = shadow.querySelector('.row');
  const context = new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  const selection = new dom.window.Event('selectstart', { bubbles: true, cancelable: true });
  row.dispatchEvent(context);
  row.dispatchEvent(selection);
  assert.equal(context.defaultPrevented, true);
  assert.equal(selection.defaultPrevented, true);
  assert.equal(row.hasAttribute('title'), false);
  assert.match(shadow.querySelector('style').textContent, /-webkit-touch-callout:none/);
  view.close();
});


test('touch picker starts locked and unlocks only after the opening finger is released', () => {
  const view = globalThis.LakomicsListCollector.mount({
    entries: [{ id: 'a', name: 'A', parentId: null }],
    profile: { revision: 1, listOrder: {}, pinnedClassificationIds: [] },
    container: document.querySelector('#root'), onSave: async () => ({ ok: true }), onClose: () => {},
    inputKind: 'touch', inputLocked: true,
  });
  assert.equal(view.host.classList.contains('input-locked'), true);
  assert.match(view.host.shadowRoot.querySelector('style').textContent, /input-locked[^}]*pointer-events:none/);
  view.unlockInput();
  assert.equal(view.host.classList.contains('input-locked'), false);
  view.close();
});

test('touch picker anchors the press point to its inert header instead of row one', () => {
  const view = globalThis.LakomicsListCollector.mount({
    entries: [{ id: 'a', name: 'A', parentId: null }],
    profile: { revision: 1, listOrder: {}, pinnedClassificationIds: [] },
    origin: { x: 500, y: 300 }, inputKind: 'touch', inputLocked: true,
    onSave: async () => ({ ok: true }), onClose: () => {},
  });
  const panel = view.host.shadowRoot.querySelector('.panel');
  assert.equal(panel.style.left, '325px');
  assert.equal(panel.style.top, '274px');
  view.close();
});
