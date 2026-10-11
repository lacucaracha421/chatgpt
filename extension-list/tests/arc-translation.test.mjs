import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const names = ['classification-tree', 'arc-collector', 'context-menu/model', 'context-menu/surfaces', 'context-menu/image', 'context-menu/actions', 'context-menu/menu', 'content'];
const sources = await Promise.all(names.map(name => readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')));
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

async function fixture({ key = true, settings = {}, video = false, collector = true, result = { ok: true, lines: [{ original: 'Hello', korean: '안녕' }] } } = {}) {
  const dom = new JSDOM('<body><img id="image" src="https://example.test/i.png"><p id="text">Text</p><video id="video"></video><div id="lakomics-yt-overlay"></div></body>', { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, timers = new Map(), roots = new Map(), mounts = [], messages = [], pageCalls = [];
  let now = 0, counter = 0, pageState = 'off';
  w.setTimeout = (callback, delay = 0) => { const id = ++counter; timers.set(id, { callback, at: now + delay }); return id; };
  w.clearTimeout = id => timers.delete(id); w.Date.now = () => now;
  w.matchMedia = () => ({ matches: false });
  w.navigator.clipboard = { writeText: async () => {} };
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); roots.set(this, root); return root; };
  // JSDOM events cannot be trusted; keep all other event data and propagation.
  const add = w.EventTarget.prototype.addEventListener;
  w.EventTarget.prototype.addEventListener = function(name, listener, options) {
    return add.call(this, name, typeof listener === 'function' ? function(event) {
      return listener.call(this, new Proxy(event, { get: (target, field) => field === 'isTrusted' ? true : typeof target[field] === 'function' ? target[field].bind(target) : target[field] }));
    } : listener, options);
  };
  const image = w.document.querySelector('img'), text = w.document.querySelector('p');
  image.getBoundingClientRect = () => ({ left: 100, right: 300, top: 50, bottom: 250, width: 200, height: 200 });
  let midpointTarget = image, settingsChanged;
  w.document.elementFromPoint = (x, y) => { f.midpoint = { x, y }; return midpointTarget; };
  const candidate = { element: image, source: 'generic', type: video ? 'video' : 'image', mediaUrl: image.src, sourceUrl: w.location.href };
  w.LakomicsForumSource = { findCandidate: target => collector && target === image ? candidate : null, findGenericCandidate: () => null };
  const reply = message => {
    if (message.type === 'translation:settings') return { ok: true, hasImageApiKey: key, hasContextApiKey: key, imageModel: 'test-model' };
    if (message.type === 'translation:image') return result;
    if (message.type === 'collector:state') return { ok: true, state: { classifications: { entries: [{ id: 'one', name: 'One', parentId: null }] }, profile: { preferences: { autoLikeOnSave: false } } } };
    return { ok: true };
  };
  w.chrome = { runtime: { getURL: path => path, sendMessage(message, callback) { messages.push(message); const response = reply(message); callback?.(response); return Promise.resolve(response); } }, storage: { local: { get: async () => ({ 'lakomics:context-menu:v1': settings }) }, onChanged: { addListener(listener) { settingsChanged = listener; } } } };
  w.fetch = async () => ({ ok: true, text: async () => '' });
  for (const source of sources.slice(0, -1)) w.eval(source);
  w.LakomicsContextPage = { create: () => ({ state: () => pageState, activate: context => { pageCalls.push(context); pageState = pageState === 'on' ? 'hidden' : 'on'; }, destroy() {} }) };
  w.LakomicsArcCollector.mount = options => { mounts.push(options); const host = w.document.createElement('div'); host.id = 'lakomics-arc-collector'; w.document.body.append(host); return { host, dispose() { host.remove(); } }; };
  w.eval(sources.at(-1));
  const f = { w, image, text, candidate, roots, mounts, messages, pageCalls, midpoint: null,
    get state() { return pageState; },
    target(value) { midpointTarget = value; },
    settings(value) { settingsChanged({ 'lakomics:context-menu:v1': { newValue: value } }, 'local'); },
    pointer(type, id = 1, x = 100, y = 100, target = image, input = 'touch') {
      const event = new w.MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: 0, clientX: x, clientY: y });
      Object.defineProperties(event, { pointerType: { value: input }, pointerId: { value: id }, timeStamp: { value: now } });
      target.dispatchEvent(event); return event;
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      now = end; await flush();
    },
    popover() { const host = w.document.querySelector('lakomics-image-popover'); return host && roots.get(host).querySelector('.popA'); },
    close() { w.close(); },
  };
  await f.advance(0); return f;
}

async function hold(f, target = f.image) {
  f.target(target);
  assert.equal(f.pointer('pointerdown', 1, 100, 100, target).defaultPrevented, false);
  await f.advance(100);
  assert.equal(f.pointer('pointerdown', 2, 120, 100, target).defaultPrevented, false);
  await f.advance(349);
  assert.equal(f.messages.some(message => message.type === 'translation:image'), false);
  await f.advance(1);
}
function release(f) { f.pointer('pointerup', 1); f.pointer('pointerup', 2); }

test('two-finger hold translates the midpoint image at 350 ms, cancels single-finger save and swallows follow-up events', async () => {
  const f = await fixture(); await hold(f);
  assert.deepEqual(f.midpoint, { x: 110, y: 100 });
  assert.equal(f.messages.filter(message => message.type === 'translation:image').length, 1);
  assert.equal(f.messages.find(message => message.type === 'translation:image').url, f.image.src);
  assert.ok(f.popover()); assert.equal(f.mounts.length, 0); release(f);
  for (const type of ['click', 'contextmenu']) assert.equal(f.pointer(type).defaultPrevented, true);
  await f.advance(1000); assert.equal(f.mounts.length, 0);
  assert.equal(f.pointer('click').defaultPrevented, false); f.close();
});

test('midpoint candidate resolution wins over finger targets', async () => {
  const f = await fixture(); f.target(f.image);
  f.pointer('pointerdown', 1, 100, 100, f.text); f.pointer('pointerdown', 2, 120, 100, f.text);
  await f.advance(350); assert.ok(f.popover()); assert.equal(f.pageCalls.length, 0); f.close();
});

test('hold elsewhere and on a video candidate toggles the existing page translation state', async () => {
  for (const video of [false, true]) {
    const f = await fixture({ video }), target = video ? f.image : f.text;
    for (const expected of ['on', 'hidden', 'on']) {
      await hold(f, target); assert.equal(f.state, expected); release(f);
    }
    assert.equal(f.pageCalls.length, 3);
    assert.equal(f.messages.some(message => message.type === 'translation:image'), false);
    assert.equal(f.mounts.length, 0); f.close();
  }
});

for (const reason of ['pinch-first', 'pinch-second', 'moved-before-second', 'quick-tap', 'late-second', 'third-finger', 'pointercancel', 'scroll', 'blur', 'pagehide']) {
  test(`${reason} cancels silently and never opens translation or the single-finger arc`, async () => {
    const f = await fixture(); f.pointer('pointerdown');
    if (reason === 'moved-before-second') f.pointer('pointermove', 1, 111);
    await f.advance(reason === 'late-second' ? 151 : 100); f.pointer('pointerdown', 2, 120);
    if (reason.startsWith('pinch')) f.pointer('pointermove', reason === 'pinch-first' ? 1 : 2, reason === 'pinch-first' ? 111 : 131);
    if (reason === 'third-finger') f.pointer('pointerdown', 3, 130);
    if (reason === 'quick-tap') { await f.advance(349); release(f); }
    if (reason === 'pointercancel') f.pointer('pointercancel');
    if (['scroll', 'blur', 'pagehide'].includes(reason)) (reason === 'scroll' ? f.w.document : f.w).dispatchEvent(new f.w.Event(reason));
    await f.advance(1000);
    assert.equal(f.messages.some(message => message.type.startsWith('translation:')), false);
    assert.equal(f.mounts.length, 0); release(f);
    for (const type of ['click', 'contextmenu']) assert.equal(f.pointer(type).defaultPrevented, false);
    f.close();
  });
}

test('150 ms pairing and 10 px movement are inclusive, and mouse/pen never form the gesture', async () => {
  const f = await fixture();
  f.pointer('pointerdown'); await f.advance(150); f.pointer('pointerdown', 2, 120);
  f.pointer('pointermove', 1, 110); f.pointer('pointermove', 2, 130);
  await f.advance(350); assert.ok(f.popover()); f.close();
  for (const input of ['mouse', 'pen']) {
    const other = await fixture();
    other.pointer('pointerdown', 1, 100, 100, other.text, input); other.pointer('pointerdown', 2, 120, 100, other.text, input);
    await other.advance(1000); assert.equal(other.messages.length, 0); other.close();
  }
});

test('single-finger save remains a 500 ms hold, and a second finger during its hold cancels it', async () => {
  const f = await fixture(); f.pointer('pointerdown'); await f.advance(499); assert.equal(f.mounts.length, 0);
  await f.advance(1); assert.equal(f.mounts.length, 1); assert.equal(f.mounts[0].inputLocked, true);
  assert.equal(f.messages.some(message => message.type === 'translation:settings'), false); f.close();
  const late = await fixture(); late.pointer('pointerdown'); await late.advance(499); late.pointer('pointerdown', 2); await late.advance(1000);
  assert.equal(late.mounts.length, 0); assert.equal(late.messages.length, 0); late.close();
});

test('disabled/excluded settings, own shadow hosts and YouTube subtitle UI bypass translation', async () => {
  for (const settings of [{ enabled: false }, { excludedHosts: ['example.test'] }]) {
    const f = await fixture({ settings }); await hold(f, f.text); assert.equal(f.messages.length, 0); f.close();
  }
  for (const name of ['lakomics-image-popover', 'youtube']) {
    const f = await fixture();
    const host = name === 'youtube' ? f.w.document.getElementById('lakomics-yt-overlay') : f.w.document.createElement(name);
    f.w.document.body.append(host);
    const target = name === 'youtube' ? host : host.attachShadow({ mode: 'open' }).appendChild(f.w.document.createElement('span'));
    await hold(f, target); assert.equal(f.messages.length, 0); f.close();
  }
  const changed = await fixture(); changed.pointer('pointerdown'); changed.pointer('pointerdown', 2); changed.settings({ enabled: false });
  await changed.advance(350); assert.equal(changed.messages.length, 0); changed.close();
});

test('both translation paths use the menu setup action when keys are missing', async () => {
  for (const image of [true, false]) {
    const f = await fixture({ key: false }); await hold(f, image ? f.image : f.text);
    assert.equal(f.messages.filter(message => message.type === 'context:settings').length, 1);
    assert.equal(f.messages.some(message => message.type === 'translation:image'), false);
    assert.equal(f.pageCalls.length, 0); f.close();
  }
});

test('저장 opens the normal picker for the translated image, leaves the popover open and saves no translation text', async () => {
  const f = await fixture(); await hold(f); release(f);
  const box = f.popover(), save = box.querySelector('[data-action="image.lakomics"]');
  assert.equal(save.textContent, '저장'); assert.equal(save.previousElementSibling.textContent, '모두 복사');
  // A fresh tap clears the release-generated click guard.
  f.pointer('pointerdown', 4, 10, 10, save); f.pointer('pointerup', 4, 10, 10, save); save.click(); await f.advance(0);
  assert.equal(f.mounts.length, 1); assert.equal(f.mounts[0].inputKind, 'touch');
  assert.deepEqual(JSON.parse(JSON.stringify(f.mounts[0].origin)), { x: 200, y: 150 });
  assert.equal(f.popover(), box); assert.equal(f.mounts[0].inputLocked, false);
  const host = box.getRootNode().host;
  assert.equal(host.inert, true); assert.equal(box.classList.contains('picker-hidden'), true);
  await f.mounts[0].onSave('one'); await f.advance(0);
  const payload = f.messages.find(message => message.type === 'collector:save').payload;
  assert.equal(payload.candidate.mediaUrl, f.image.src);
  assert.deepEqual(Object.keys(payload).sort(), ['candidate', 'classificationId', 'classificationPath']);
  assert.equal('text' in payload.candidate, false);
  f.mounts[0].onClose({ok: true, pending: true}); await f.advance(0);
  assert.equal(host.inert, false); assert.equal(box.classList.contains('picker-restored'), true); f.close();
});

test('no arc translation rows or their wiring remain for any input', () => {
  assert.doesNotMatch(sources[1], /translation-actions|translation\?\.|translation =/);
  assert.doesNotMatch(sources.at(-1), /collectorTranslation|translation: contextController/);
  assert.doesNotMatch(sources[names.indexOf('context-menu/menu')], /collectorTranslation/);
});


test('cancelling the picker restores the same translated popover position', async () => {
  const f = await fixture(); await hold(f); release(f);
  const box = f.popover(), save = box.querySelector('[data-action="image.lakomics"]'), host = box.getRootNode().host;
  const position = [host.style.left, host.style.top];
  f.pointer('pointerdown', 4, 10, 10, save); f.pointer('pointerup', 4, 10, 10, save); save.click(); await f.advance(0);
  assert.equal(host.inert, true);
  f.mounts[0].onClose(); await f.advance(0);
  assert.equal(host.inert, false); assert.equal(box.classList.contains('picker-hidden'), false);
  assert.deepEqual([host.style.left, host.style.top], position); f.close();
});
