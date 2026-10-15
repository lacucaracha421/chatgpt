import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const sources = await Promise.all(['model', 'surfaces', 'actions', 'menu'].map(name =>
  readFile(new URL(`../src/context-menu/${name}.js`, import.meta.url), 'utf8')));
function fixture(t, html = '<p>Page</p>', initialSettings = {}) {
  const dom = new JSDOM(html, { url: 'https://sub.example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, doc = w.document;
  t.after(() => w.close());
  w.matchMedia = () => ({ matches: false });
  for (const source of sources) w.eval(source);
  // jsdom cannot produce trusted browser input. Only the controller listener
  // receives the facade; propagation/cancellation still use the real DOM event.
  const add = w.addEventListener.bind(w), remove = w.removeEventListener.bind(w), listeners = new Map();
  w.addEventListener = (type, listener, options) => {
    if (type !== 'contextmenu') return add(type, listener, options);
    const wrapped = event => listener(new Proxy(event, { get(target, key) {
      if (key === 'isTrusted') return true;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }));
    listeners.set(listener, wrapped); add(type, wrapped, options);
  };
  w.removeEventListener = (type, listener, options) => remove(type, listeners.get(listener) || listener, options);
  const controller = w.LakomicsContextMenu.createController({ doc, win: w, initialSettings, send: async () => ({ ok: true }) });
  t.after(() => controller.destroy());
  const click = (target = doc.querySelector('p'), extra = {}) => {
    const event = new w.MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, button: 2, clientX: 20, clientY: 30, ...extra });
    target.dispatchEvent(event); return event;
  };
  return { w, doc, controller, click, model: w.LakomicsContextModel };
}

test('default mode preserves unknown page menus and cancellation', t => {
  const f = fixture(t); let called = 0;
  f.doc.querySelector('p').addEventListener('contextmenu', event => { called++; event.preventDefault(); event.stopPropagation(); });
  assert.equal(f.click().defaultPrevented, true);
  assert.equal(called, 1); assert.equal(f.controller.current, null);
});

test('opt-in capture beats lower capture/bubble blockers and stops duplicate page menus', t => {
  for (const capture of [false, true]) {
    const f = fixture(t, undefined, { priorityHosts: ['example.test'] }); let called = 0;
    f.doc.addEventListener('contextmenu', event => { called++; event.preventDefault(); event.stopImmediatePropagation(); }, capture);
    assert.equal(f.click().defaultPrevented, true);
    assert.ok(f.controller.current); assert.equal(called, 0);
    f.controller.destroy(); f.click(); assert.equal(called, 1, 'destroy removes both menu listeners');
  }
});

test('known editors, maps, canvas/games, embeds and explicit handlers retain ownership', t => {
  for (const html of [
    '<div class="monaco-editor"><p>Code</p></div>', '<div class="cm-editor"><p>Code</p></div>',
    '<div class="ProseMirror"><p>Rich text</p></div>', '<div class="leaflet-container"><p>Map</p></div>',
    '<div class="mapboxgl-map"><p>Map</p></div>', '<div class="gm-style"><p>Map</p></div>',
    '<div role="application"><p>Game</p></div>', '<div aria-haspopup="menu"><p>Menu</p></div>',
    '<div oncontextmenu="return false"><p>Owned</p></div>',
    '<canvas></canvas>', '<iframe></iframe>', '<embed>', '<object></object>',
  ]) {
    const f = fixture(t, html, { priorityHosts: ['example.test'] });
    const target = f.doc.querySelector('p') || f.doc.body.firstElementChild;
    let called = 0; target.addEventListener('contextmenu', event => { called++; event.preventDefault(); });
    f.click(target); assert.equal(f.controller.current, null, html); assert.equal(called, 1, html);
  }
});

test('open shadow roots preserve inner image context and enclosing page ownership', t => {
  const f = fixture(t, '<section></section>', { priorityHosts: ['example.test'] });
  const host = f.doc.querySelector('section'), root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<img src="https://images.test/a.png">';
  f.click(root.querySelector('img')); assert.equal(f.controller.current.context.imageUrl, 'https://images.test/a.png');
  f.controller.close(); host.className = 'leaflet-container'; f.click(root.querySelector('img'));
  assert.equal(f.controller.current, null);
  const closedHost = f.doc.createElement('div'); f.doc.body.append(closedHost);
  const closed = closedHost.attachShadow({ mode: 'closed' }); closed.innerHTML = '<canvas></canvas>';
  // Hidden internals cannot be inspected; the visible host can still signal ownership.
  closedHost.setAttribute('role', 'application'); f.click(closed.querySelector('canvas'));
  assert.equal(f.controller.current, null);
});

test('exclusions, disable, Shift, gesture/picker and earlier cancellation outrank opt-in', t => {
  const f = fixture(t, undefined, { priorityHosts: ['example.test'] });
  f.controller.update({ priorityHosts: ['example.test'], excludedHosts: ['example.test'] });
  assert.equal(f.click().defaultPrevented, false); assert.equal(f.controller.current, null);
  f.controller.update({ priorityHosts: ['example.test'], enabled: false });
  assert.equal(f.click().defaultPrevented, false);
  f.controller.update({ priorityHosts: ['example.test'] });
  assert.equal(f.click(undefined, { shiftKey: true }).defaultPrevented, false);
  const event = { isTrusted: true, defaultPrevented: true, target: f.doc.body };
  assert.equal(f.controller.open(event), false);
  for (const state of [{ phase: 'armed' }, { picker: true }]) assert.equal(Boolean(f.model.bypass({ isTrusted: true }, state)), true);
  assert.equal(f.model.settings({ priorityHosts: [' Example.TEST ', 'example.test', 'https://bad.test'] }).priorityHosts.join(','), 'example.test');
});

test('plain editable fields keep translation/edit menus and unrelated hosts never opt in', t => {
  const f = fixture(t, '<textarea>Hello</textarea>', { priorityHosts: ['notexample.test'] });
  f.click(f.doc.querySelector('textarea')); assert.ok(f.controller.current.context.field);
  f.controller.close(); f.doc.addEventListener('contextmenu', event => event.preventDefault(), true);
  f.click(f.doc.querySelector('textarea')); assert.equal(f.controller.current, null);
});
