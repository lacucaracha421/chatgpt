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

async function twoFingers(f, target = f.image) {
  f.target(target);
  f.pointer('pointerdown', 1, 100, 100, target);
  await f.advance(100);
  f.pointer('pointerdown', 2, 120, 100, target);
  await f.advance(1000);
}
function release(f) { f.pointer('pointerup', 1); f.pointer('pointerup', 2); }

test('two-finger hold no longer translates anything, on an image, text or video', async () => {
  for (const [video, target] of [[false, 'image'], [false, 'text'], [true, 'image']]) {
    const f = await fixture({ video }); await twoFingers(f, f[target]);
    assert.equal(f.messages.some(message => message.type.startsWith('translation:')), false);
    assert.equal(f.pageCalls.length, 0); assert.equal(f.mounts.length, 0); assert.equal(f.popover(), null);
    release(f);
    for (const type of ['click', 'contextmenu']) assert.equal(f.pointer(type).defaultPrevented, false);
    f.close();
  }
});

test('single-finger save remains a 500 ms hold, and a second finger during its hold cancels it', async () => {
  const f = await fixture(); f.pointer('pointerdown'); await f.advance(499); assert.equal(f.mounts.length, 0);
  await f.advance(1); assert.equal(f.mounts.length, 1); assert.equal(f.mounts[0].inputLocked, true);
  assert.equal(f.messages.some(message => message.type === 'translation:settings'), false); f.close();
  const late = await fixture(); late.pointer('pointerdown'); await late.advance(499); late.pointer('pointerdown', 2); await late.advance(1000);
  assert.equal(late.mounts.length, 0); assert.equal(late.messages.length, 0); late.close();
});

test('no arc translation rows or their wiring remain for any input', () => {
  assert.doesNotMatch(sources[1], /translation-actions|translation\?\.|translation =/);
  assert.doesNotMatch(sources.at(-1), /collectorTranslation|translation: contextController/);
  assert.doesNotMatch(sources[names.indexOf('context-menu/menu')], /collectorTranslation/);
});

test('the two-finger gesture and its guards are gone from the content script', () => {
  assert.doesNotMatch(sources.at(-1), /twoFinger|translationGuard|translateTouch/);
  assert.doesNotMatch(sources[names.indexOf('context-menu/menu')], /translateTouch/);
});

test('the arc offers outward-drag translation only for a still https image and runs the image translation action', async () => {
  const f = await fixture(); f.pointer('pointerdown'); await f.advance(501);
  assert.equal(f.mounts.length, 1); assert.equal(typeof f.mounts[0].onTranslate, 'function');
  assert.equal(f.messages.some(message => message.type === 'translation:image'), false);
  assert.equal(f.mounts[0].onTranslate({ isTrusted: true }), true); await f.advance(0);
  assert.equal(f.messages.filter(message => message.type === 'translation:image').length, 1);
  assert.equal(f.messages.find(message => message.type === 'translation:image').url, f.image.src); f.close();
  const video = await fixture({ video: true }); video.pointer('pointerdown'); await video.advance(501);
  assert.equal(video.mounts[0].onTranslate, null); video.close();
  const noKey = await fixture({ key: false }); noKey.pointer('pointerdown'); await noKey.advance(501);
  assert.equal(noKey.mounts[0].onTranslate({ isTrusted: true }), true); await noKey.advance(0);
  assert.equal(noKey.messages.some(message => message.type === 'context:settings'), true);
  assert.equal(noKey.messages.some(message => message.type === 'translation:image'), false); noKey.close();
});
