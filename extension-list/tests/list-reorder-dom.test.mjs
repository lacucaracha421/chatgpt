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

test('editing uses vertical drag and applies returned server order in place', async () => {
  const entries = ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase(), parentId: null }));
  let resolveReorder;
  const reordered = new Promise((resolve) => { resolveReorder = resolve; });
  const view = globalThis.LakomicsListCollector.mount({
    entries, profile: { revision: 1, listOrder: {}, pinnedClassificationIds: [] },
    container: document.querySelector('#root'), editing: true,
    onReorder: async (parentId, ids) => {
      resolveReorder({ parentId, ids });
      return { ok: true, state: { profile: { revision: 2, pinnedClassificationIds: [], listOrder: { __root__: ids }, preferences: {} } } };
    },
  });
  const shadow = view.host.shadowRoot;
  const swipe = shadow.querySelector('.swipe');
  let rows = [...shadow.querySelectorAll('.row')];
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index * 40, bottom: index * 40 + 40, height: 40, left: 0, right: 200, width: 200 });
  });
  rows[1].dispatchEvent(pointer('pointerdown', { y: 60 }));
  swipe.dispatchEvent(pointer('pointermove', { y: 125 }));
  swipe.dispatchEvent(pointer('pointerup', { y: 125 }));

  const result = await reordered;
  assert.equal(result.parentId, null);
  assert.deepEqual(result.ids, ['a', 'c', 'b']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  rows = [...shadow.querySelectorAll('.row')];
  assert.deepEqual(rows.map((row) => row.dataset.classificationId), ['a', 'c', 'b']);
  view.close();
});
