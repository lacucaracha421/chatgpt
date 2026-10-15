import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const names = ['model', 'surfaces', 'image', 'selection-chip'];
const sources = await Promise.all(names.map(name => readFile(new URL(`../src/context-menu/${name}.js`, import.meta.url), 'utf8')));
const css = await readFile(new URL('../src/context-menu/menu.css', import.meta.url), 'utf8');
const pure = vm.createContext({});
vm.runInContext(sources[3], pure);
const { shouldShow, placement } = pure.LakomicsSelectionChip;
const view = { width: 800, height: 600 };
const rect = { left: 200, right: 400, top: 250, bottom: 280, width: 200, height: 30 };
const plain = value => JSON.parse(JSON.stringify(value));

test('trigger accepts touch, pen and a coarse device without a pointer event', () => {
  for (const input of [{ pointerType: 'touch' }, { pointerType: 'pen' }, { coarse: true }]) {
    assert.equal(shouldShow({ text: 'Hello', ...input }), true);
  }
  for (const input of [{}, { pointerType: 'mouse' }, { pointerType: 'mouse', coarse: true }, { pointerType: 'keyboard', coarse: true }]) {
    assert.equal(shouldShow({ text: 'Hello', ...input }), false);
  }
});

test('trigger rejects empty, collapsed, editable, blocked and moving selections', () => {
  for (const input of [{ text: '  ' }, { text: 'a'.repeat(12001) }, { collapsed: true }, { editable: true }, { blocked: true }, { pointers: 1 }, { pointers: 2 }]) {
    assert.equal(shouldShow({ text: 'Hello', pointerType: 'touch', ...input }), false);
  }
  assert.equal(shouldShow({ text: 'a'.repeat(12000), pointerType: 'pen' }), true);
});

test('placement prefers above with space for the native toolbar', () => {
  const p = placement(rect, view);
  assert.deepEqual(plain(p), { x: 264, y: 142, side: 'above' });
  assert.equal(p.y + 44 + 64, rect.top);
});

test('placement moves below near the top and avoids the toolbar/handles', () => {
  const r = { ...rect, top: 8, bottom: 38 };
  assert.deepEqual(plain(placement(r, view)), { x: 264, y: 102, side: 'below' });
});

test('placement handles horizontal edges and a panned visual viewport', () => {
  for (const r of [{ ...rect, left: -30, right: 20 }, { ...rect, left: 770, right: 820 }]) {
    const p = placement(r, view);
    assert.ok(p.x >= 8 && p.x + 72 <= 792);
  }
  const p = placement({ ...rect, top: 330, bottom: 360 }, { width: 300, height: 400, offsetLeft: 180, offsetTop: 100 });
  assert.ok(p.x >= 188 && p.x + 72 <= 472 && p.y >= 108 && p.y + 44 <= 492);
});

test('placement tries handle-safe sides when neither vertical side fits', () => {
  const tall = { left: 200, right: 400, top: 20, bottom: 580 };
  assert.equal(placement(tall, view).side, 'right');
  assert.equal(placement({ ...tall, right: 790 }, view).side, 'left');
  assert.equal(placement({ ...tall, left: 0, right: 800 }, view), null);
  assert.equal(placement({ ...rect, top: 610, bottom: 640 }, view), null);
  assert.equal(placement(rect, { width: 70, height: 600 }), null);
});

function fixture(t, { coarse = false, blocked = false, settings = { ok: true, hasContextApiKey: true }, reply, html = '<p>Hello world</p>' } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, doc = w.document, roots = new WeakMap(), requests = [];
  let now = 0, serial = 0;
  const timers = new Map();
  w.matchMedia = query => ({ matches: query === '(pointer: coarse)' && coarse });
  w.setTimeout = (fn, delay = 0) => { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id; };
  w.clearTimeout = id => timers.delete(id);
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) { const root = attach.call(this, options); roots.set(this, root); return root; };
  // The facade supplies trusted browser input, which jsdom cannot manufacture.
  const add = w.EventTarget.prototype.addEventListener;
  w.EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!['pointerdown', 'pointerup', 'pointercancel', 'click'].includes(type)) return add.call(this, type, listener, options);
    return add.call(this, type, event => listener(new Proxy(event, { get(target, key) {
      if (key === 'isTrusted') return true;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } })), options);
  };
  w.Range.prototype.getBoundingClientRect = () => rect;
  for (const source of sources) w.eval(source);
  const chip = w.LakomicsSelectionChip.create({ doc, win: w, css, canShow: () => !blocked, send: async message => {
    requests.push(plain(message));
    if (message.type === 'translation:settings') return settings;
    return reply ? reply(message) : { ok: true, text: '안녕하세요' };
  } });
  t.after(() => { chip.destroy(); w.close(); });
  const select = (start = 0, end = 5) => {
    const range = doc.createRange(); range.setStart(doc.querySelector('p').firstChild, start); range.setEnd(doc.querySelector('p').firstChild, end);
    w.getSelection().removeAllRanges(); w.getSelection().addRange(range);
    doc.dispatchEvent(new w.Event('selectionchange'));
  };
  const pointer = (type, pointerType = 'touch', id = 1, target = doc.querySelector('p')) => {
    const event = new w.MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0 });
    Object.defineProperties(event, { pointerType: { value: pointerType }, pointerId: { value: id } });
    target.dispatchEvent(event); return event;
  };
  const advance = async ms => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    now = until;
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const host = () => doc.querySelector('lakomics-selection-chip');
  return { w, doc, roots, requests, select, pointer, advance, host, chip };
}

test('native touch selection settles after release and 250 ms, then uses the existing translation popover', async t => {
  const f = fixture(t);
  f.pointer('pointerdown'); f.select(); await f.advance(500);
  assert.equal(f.host(), null, 'do not cover handles while a finger is down');
  f.pointer('pointerup'); await f.advance(249); assert.equal(f.host(), null);
  await f.advance(1);
  const button = f.roots.get(f.host()).querySelector('button');
  assert.equal(button.textContent, '번역');
  assert.equal(f.requests.length, 0, 'selection alone must not send text to the worker');
  assert.equal(f.pointer('pointerdown', 'touch', 1, button).defaultPrevented, true);
  f.pointer('pointerup', 'touch', 1, button); button.click(); await f.advance(0);
  assert.equal(f.host(), null);
  assert.deepEqual(f.requests, [{ type: 'translation:settings' }, { type: 'translation:context', kind: 'translate.ko.inline', text: 'Hello' }]);
  const popup = f.doc.querySelector('lakomics-image-popover');
  assert.ok(popup);
  assert.equal(f.roots.get(popup).querySelector('[role="dialog"]').getAttribute('aria-label'), '선택한 글 번역');
  assert.match(f.roots.get(popup).textContent, /안녕하세요/);
  assert.equal(f.doc.querySelector('lakomics-translation-block'), null);
  assert.equal(f.w.getSelection().toString(), 'Hello');
  f.doc.dispatchEvent(new f.w.Event('selectionchange')); await f.advance(500);
  assert.equal(f.host(), null, 'the same translated selection must not respawn the chip');
});

test('selection changes restart the settle delay and clearing removes the chip', async t => {
  const f = fixture(t, { coarse: true });
  f.select(); await f.advance(200); f.select(0, 11); await f.advance(200); assert.equal(f.host(), null);
  await f.advance(50); assert.ok(f.host());
  f.w.getSelection().removeAllRanges(); f.doc.dispatchEvent(new f.w.Event('selectionchange'));
  assert.equal(f.host(), null);
});

test('scroll dismisses visible and pending chips until a different selection', async t => {
  const f = fixture(t, { coarse: true });
  f.select(); await f.advance(100); f.doc.dispatchEvent(new f.w.Event('scroll')); await f.advance(500);
  assert.equal(f.host(), null);
  f.doc.dispatchEvent(new f.w.Event('selectionchange')); await f.advance(500); assert.equal(f.host(), null);
  f.select(0, 11); await f.advance(250); assert.ok(f.host());
  f.doc.dispatchEvent(new f.w.Event('scroll')); assert.equal(f.host(), null);
});

test('mouse selections stay native even on coarse devices; pen is supported', async t => {
  const f = fixture(t, { coarse: true });
  f.pointer('pointerdown', 'mouse'); f.select(); f.pointer('pointerup', 'mouse'); await f.advance(500);
  assert.equal(f.host(), null);
  f.pointer('pointerdown', 'pen'); f.select(0, 11); f.pointer('pointerup', 'pen'); await f.advance(250);
  assert.ok(f.host());
});

test('exclusions, fields and extension-owned selections never show a chip', async t => {
  for (const options of [{ blocked: true }, { html: '<div contenteditable="true"><p>Hello world</p></div>' }, { html: '<lakomics-image-popover><p>Hello world</p></lakomics-image-popover>' }]) {
    const f = fixture(t, { coarse: true, ...options });
    f.select(); await f.advance(500); assert.equal(f.host(), null);
  }
});

test('a missing key opens settings without submitting selected text', async t => {
  const f = fixture(t, { coarse: true, settings: { ok: true, hasContextApiKey: false } });
  f.select(); await f.advance(250); f.roots.get(f.host()).querySelector('button').click(); await f.advance(0);
  assert.deepEqual(f.requests.map(message => message.type), ['translation:settings', 'context:settings']);
});

test('navigation invalidates pending chips and in-flight translation results', async t => {
  let finish;
  const f = fixture(t, { coarse: true, reply: () => new Promise(resolve => { finish = resolve; }) });
  f.select(); f.w.history.pushState({}, '', '/next'); await f.advance(500); assert.equal(f.host(), null);
  f.select(0, 11); await f.advance(250); f.roots.get(f.host()).querySelector('button').click(); await f.advance(0);
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  finish({ ok: true, text: '늦은 응답' }); await f.advance(0);
  assert.equal(f.doc.querySelector('lakomics-image-popover'), null);
});

test('manifest loads the chip module before the content entry in both bundles', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const entry of manifest.content_scripts.filter(entry => entry.js?.includes('src/content.js'))) {
    const index = entry.js.indexOf('src/context-menu/selection-chip.js');
    assert.ok(index > entry.js.indexOf('src/context-menu/image.js') && index < entry.js.indexOf('src/content.js'));
  }
});
