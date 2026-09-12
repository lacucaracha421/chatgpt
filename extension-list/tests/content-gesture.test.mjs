import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const source = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');
function fixture() {
  const dom = new JSDOM('<img id="image">', { url: 'https://example.test/', runScripts: 'outside-only' });
  const w = dom.window, timers = new Map(), mounts = [], requests = [];
  let now = 0, counter = 0;
  w.setTimeout = (callback, delay = 0) => { const id = ++counter; timers.set(id, { callback, at: now + delay }); return id; };
  w.clearTimeout = id => timers.delete(id);
  w.LakomicsForumSource = { findCandidate: target => target.id === 'image' ? { element: target, type: 'image', mediaUrl: 'https://example.test/image.jpg' } : null };
  w.chrome = { runtime: { sendMessage(message, callback) {
    requests.push(message);
    callback?.({ ok: true, state: { classifications: { entries: [{ id: 'games', name: '게임', parentId: null }] }, profile: { preferences: {} } } });
  } } };
  w.LakomicsArcCollector = { mount(options) {
    mounts.push(options); const host = w.document.createElement('div'); w.document.body.append(host);
    return { host, unlockInput() {} };
  } };
  w.eval(source);
  function pointer(type, input = 'mouse', x = 40) {
    const event = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 40, button: 0 });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: input } });
    w.document.querySelector('img').dispatchEvent(event);
    return event;
  }
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const first = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      now = first[1].at; timers.delete(first[0]); first[1].callback();
    }
    now = end;
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  return { w, pointer, advance, mounts, requests, close: () => w.close() };
}

test('short clicks and early drag releases never request or open a collector later', async () => {
  for (const input of ['mouse', 'touch']) {
    const f = fixture();
    f.pointer('pointerdown', input);
    if (input === 'mouse') f.pointer('pointermove', input, 60);
    await f.advance(200); f.pointer('pointerup', input); await f.advance(1000);
    assert.equal(f.requests.length, 0); assert.equal(f.mounts.length, 0); f.close();
  }
});

test('mouse waits for both 250 ms and deliberate movement, while a stationary hold does not open', async () => {
  const f = fixture(); f.pointer('pointerdown'); f.pointer('pointermove', 'mouse', 60);
  await f.advance(249); assert.equal(f.mounts.length, 0);
  await f.advance(1); assert.equal(f.mounts.length, 1); assert.equal(f.mounts[0].origin.x, 40); f.close();
  const still = fixture(); still.pointer('pointerdown'); await still.advance(1000);
  assert.equal(still.mounts.length, 0);
  still.pointer('pointermove', 'mouse', 60); await still.advance(0);
  assert.equal(still.mounts.length, 1); still.close();
});

test('touch waits 500 ms and opens locked until the opening finger releases', async () => {
  const f = fixture(); f.pointer('pointerdown', 'touch');
  await f.advance(499); assert.equal(f.mounts.length, 0);
  await f.advance(1); assert.equal(f.mounts.length, 1); assert.equal(f.mounts[0].inputLocked, true);
  f.pointer('pointerup', 'touch'); await f.advance(0);
  assert.equal(f.mounts.length, 1); f.close();
});

test('scroll, cancelled pointers, focus loss, and touch movement cancel the pending opening', async () => {
  for (const cancel of ['scroll', 'wheel', 'pointercancel', 'blur', 'movement']) {
    const f = fixture(); f.pointer('pointerdown', 'touch'); await f.advance(300);
    if (cancel === 'pointercancel') f.pointer('pointercancel', 'touch');
    else if (cancel === 'movement') f.pointer('pointermove', 'touch', 80);
    else (cancel === 'blur' ? f.w : f.w.document).dispatchEvent(new f.w.Event(cancel));
    await f.advance(1000);
    assert.equal(f.mounts.length, 0, cancel); assert.equal(f.requests.length, 0, cancel); f.close();
  }
});


test('reusing the mouse pointer after release does not swallow subsequent menu clicks', async () => {
  const f = fixture(); f.pointer('pointerdown'); f.pointer('pointermove', 'mouse', 60); await f.advance(250);
  assert.equal(f.pointer('pointerup').defaultPrevented, true);
  await f.advance(400);
  f.pointer('pointerdown');
  assert.equal(f.pointer('pointerup').defaultPrevented, false);
  const click = new f.w.MouseEvent('click', { bubbles: true, cancelable: true });
  f.w.document.body.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false); f.close();
});
