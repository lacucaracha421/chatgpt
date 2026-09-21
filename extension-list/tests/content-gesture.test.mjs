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
    // The real worker answers across an async boundary; resolve on a macrotask so
    // a same-task departure is still observable by the session watcher.
    w.setTimeout(() => callback?.({ ok: true, state: { classifications: { entries: [{ id: 'games', name: '게임', parentId: null }] }, profile: { preferences: {} } } }), 0);
  } } };
  // Tests that queue their own worker answers replace this with a `w.setTimeout`
  // based mock so the fixture clock still drives every pending callback.
  w.lakomicsStateReply = candidate => ({ ok: true, state: { classifications: { entries: [{ id: 'games', name: '게임', parentId: null }] }, profile: { preferences: candidate?.preferences ?? {} } } });
  // The mount path reads the classification model via this global, exactly as the
  // injected classification-tree script provides it on a real page.
  w.LakomicsClassificationTree = { createModel: () => ({ path: () => [{ name: '게임' }] }) };
  w.LakomicsArcCollector = { mount(options) {
    mounts.push(options);
    const host = w.document.createElement('div'); w.document.body.append(host);
    const view = { host, unlocked: 0, disposed: 0, closeResult: 'unset', unlockInput() { view.unlocked++; }, dispose() { view.disposed++; host.remove(); } };
    options._view = view;
    return view;
  } };
  w.eval(source);
  function pointer(type, input = 'mouse', x = 40) {
    const event = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 40, button: 0 });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: input } });
    w.document.querySelector('img').dispatchEvent(event);
    return event;
  }
  async function advance(ms) {
    // Deliver the earliest due timer, then let its callback and the microtasks it
    // schedules settle before choosing the next one. The deadline bounds what is
    // delivered, so a session that keeps re-arming its liveness poll cannot run
    // the clock away from the caller's intent.
    const end = now + ms;
    let delivered = 0;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || delivered >= 500) break;
      const at = next[1].at;
      timers.delete(next[0]);
      now = Math.max(now, at);
      delivered += 1;
      next[1].callback();
      for (let i = 0; i < 4; i++) await Promise.resolve();
    }
    now = Math.max(now, end);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  function fireNextTimer() {
    // Callback-style chrome.runtime.sendMessage can resolve in the same task, so a
    // caller may need to act between a timer and the microtasks that follow it.
    const first = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!first) return false;
    now = Math.max(now, first[1].at); timers.delete(first[0]); first[1].callback();
    return true;
  }
  return { w, pointer, advance, fireNextTimer, mounts, requests, close: () => w.close(), timers: () => timers.size };
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
  still.pointer('pointermove', 'mouse', 60); await still.advance(1);
  assert.equal(still.mounts.length, 1); still.close();
});

test('touch waits 500 ms and opens locked until the opening finger releases', async () => {
  const f = fixture(); f.pointer('pointerdown', 'touch');
  await f.advance(499); assert.equal(f.mounts.length, 0);
  await f.advance(1); assert.equal(f.mounts.length, 1); assert.equal(f.mounts[0].inputLocked, true);
  // The release must actually unlock the mounted list, not just leave the lock set.
  f.pointer('pointerup', 'touch'); await f.advance(1);
  assert.equal(f.mounts.length, 1);
  assert.equal(f.mounts[0]._view.unlocked, 1, 'the opening finger release unlocks the list'); f.close();
});

test('a cancelled opening finger still delivers the release-time unlock', async () => {
  const f = fixture(); f.pointer('pointerdown', 'touch');
  await f.advance(500);
  assert.equal(f.mounts[0].inputLocked, true);
  f.pointer('pointercancel', 'touch'); await f.advance(1);
  assert.equal(f.mounts[0]._view.unlocked, 1); f.close();
});

test('a release for a departed session never unlocks the list mounted after it', async () => {
  const f = fixture();
  f.pointer('pointerdown', 'touch');
  await f.advance(500);
  const stale = f.mounts[0];
  assert.equal(stale.inputLocked, true);
  // The page navigates while the opening finger is still down.
  f.w.dispatchEvent(new f.w.Event('popstate'));
  await f.advance(1);
  assert.equal(stale._view.disposed, 1);
  assert.equal(stale._view.unlocked, 0);

  // A fresh session opens with a mouse press, which never leaves a pending
  // release-time unlock of its own, so any later unlock can only be the stale one.
  f.pointer('pointerdown', 'mouse'); f.pointer('pointermove', 'mouse', 60);
  await f.advance(251);
  assert.equal(f.mounts.length, 2);
  const fresh = f.mounts[1];
  assert.equal(fresh._view.disposed, 0);
  assert.equal(fresh._view.unlocked, 0);

  // The stale touch release arrives now, after the new list is already up. It must
  // be discarded rather than unlocking a list it does not own.
  f.pointer('pointerup', 'touch');
  await f.advance(2);
  assert.equal(stale._view.unlocked, 0);
  assert.equal(fresh._view.unlocked, 0, 'the stale release must not unlock the new session');
  assert.equal(fresh._view.disposed, 0);
  f.close();
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

function deliverNavigation(f, kind) {
  // The long-press timer opens and requests state, so delivering it by hand lets
  // the departure be dispatched in the same task the worker reply resolves in.
  for (let i = 0; i < 4 && !f.requests.some(request => request.type === 'collector:state'); i++) f.fireNextTimer();
  assert.equal(f.requests.filter(request => request.type === 'collector:state').length, 1);
  if (kind === 'popstate') f.w.dispatchEvent(new f.w.Event('popstate'));
  else if (kind === 'hashchange') { f.w.location.hash = '#other'; f.w.dispatchEvent(new f.w.Event('hashchange')); }
  else if (kind === 'pagehide') f.w.dispatchEvent(new f.w.Event('pagehide'));
  else if (kind === 'push') f.w.history.pushState({}, '', '/spa-route');
  else throw new Error(`unknown navigation kind ${kind}`);

  f.fireNextTimer(); // worker state reply, delivered after the departure
}

for (const kind of ['popstate', 'hashchange', 'pagehide']) {
  test(`a ${kind} commit invalidation releases a pending opening during the state load`, async () => {
    const f = fixture();
    f.pointer('pointerdown', 'touch');
    deliverNavigation(f, kind);
    await f.advance(2000);
    assert.equal(f.mounts.length, 0, kind);
    // The cancelled request must not resurface as a later one either.
    assert.equal(f.requests.filter(request => request.type === 'collector:state').length, 1, kind);
    f.close();
  });
}

test('a pushed URL with no popstate is caught by the session liveness poll', async () => {
  const f = fixture();
  f.pointer('pointerdown', 'touch');
  // Isolated worlds do not observe the page's own history.pushState, so the only
  // remaining signal is the session-scoped location.href poll.
  deliverNavigation(f, 'push');
  // The push itself was never observed, so the poll is what must tear the session down.
  assert.equal(f.mounts.length, 0);
  await f.advance(1000);
  assert.equal(f.mounts.length, 0);
  assert.equal(f.requests.filter(request => request.type === 'collector:state').length, 1);
  f.close();
});

test('navigation while a touch is still armed cancels its delayed opening', async () => {
  const f = fixture();
  f.pointer('pointerdown', 'touch');
  await f.advance(100);
  f.w.dispatchEvent(new f.w.Event('pagehide'));
  await f.advance(1000);
  assert.equal(f.requests.length, 0);
  assert.equal(f.mounts.length, 0);
  assert.equal(f.timers(), 0);
  f.close();
});

test('temporary download feedback survives normal session teardown', async () => {
  const f = fixture();
  f.pointer('pointerdown', 'touch'); await f.advance(500);
  f.pointer('pointerup', 'touch'); await f.advance(1);
  const resultPromise = f.mounts[0].onTemporary(); await f.advance(1);
  const result = await resultPromise;
  assert.equal(result.ok, true);
  f.mounts[0].onClose(result);
  assert.equal(f.w.document.querySelector('.lakomics-list-toast').textContent, '임시 다운로드 시작됨');
  f.close();
});

test('permanent and PC temporary video saves use page-resolved media before messaging the worker', async () => {
  for (const action of ['onSave', 'onTemporary']) {
    const f = fixture();
    const mediaUrl = 'https://video.twimg.com/amplify_video/123/vid/clip.mp4';
    f.w.LakomicsForumSource.findCandidate = target => target.id === 'image' ? {
      element: target, source: 'x', type: 'video', mediaUrl: null,
      postId: '2101939591297294668', mediaIndex: 1, overallMediaIndex: 1,
      sourceUrl: 'https://x.com/AniGodoyG/status/2101939591297294668/video/1',
    } : null;
    let resolutions = 0;
    f.w.LakomicsXVideo = { resolve: async candidate => { resolutions++; return { ...candidate, mediaUrl }; } };
    f.pointer('pointerdown', 'touch'); await f.advance(500);
    f.pointer('pointerup', 'touch'); await f.advance(1);
    assert.equal(resolutions, 0, 'opening the menu must not request a save or resolve media');
    const pending = f.mounts[0][action]('games');
    for (let i = 0; i < 4; i++) await Promise.resolve();
    await f.advance(1);
    const result = await pending;
    assert.equal(result.ok, true);
    const type = action === 'onSave' ? 'collector:save' : 'collector:temporary';
    const request = f.requests.find(message => message.type === type);
    assert.equal((request.payload?.candidate || request.candidate).mediaUrl, mediaUrl);
    assert.equal(resolutions, 1);
    f.close();
  }
});

test('navigation during page-video lookup cannot submit a stale save or download', async () => {
  for (const action of ['onSave', 'onTemporary']) {
    const f = fixture(); let finish;
    f.w.LakomicsForumSource.findCandidate = target => target.id === 'image' ? {
      element: target, source: 'x', type: 'video', mediaUrl: null,
      postId: '2101939591297294668', overallMediaIndex: 1,
      sourceUrl: 'https://x.com/AniGodoyG/status/2101939591297294668/video/1',
    } : null;
    f.w.LakomicsXVideo = { resolve: candidate => new Promise(resolve => { finish = () => resolve({ ...candidate, mediaUrl: 'https://video.twimg.com/clip.mp4' }); }) };
    f.pointer('pointerdown', 'touch'); await f.advance(500);
    f.pointer('pointerup', 'touch'); await f.advance(1);
    const pending = f.mounts[0][action]('games');
    f.w.dispatchEvent(new f.w.Event('popstate'));
    finish(); await pending; await f.advance(1);
    assert.equal(f.requests.some(message => ['collector:save', 'collector:temporary'].includes(message.type)), false);
    f.close();
  }
});

test('an idle page runs no session watch, so a URL change alone tears nothing down', async () => {
  const f = fixture();
  await f.advance(5000);
  assert.equal(f.timers(), 0);
  f.w.history.pushState({}, '', '/idle-route');
  await f.advance(5000);
  assert.equal(f.timers(), 0);
  f.pointer('pointerdown', 'touch');
  await f.advance(500); f.pointer('pointerup', 'touch');
  await f.advance(1);
  assert.equal(f.mounts.length, 1);
  const view = f.mounts[0]._view;
  // The list dismisses itself; the watcher must stop with the session and leave
  // no permanent idle timer behind.
  f.mounts[0].onClose({});
  await f.advance(5000);
  assert.equal(view.disposed, 1);
  assert.equal(f.timers(), 0);
  f.close();
});

test('navigation bypasses the busy and input locks the guarded dismissal respects', async () => {
  const locked = fixture();
  locked.pointer('pointerdown', 'touch');
  await locked.advance(500);
  const held = locked.mounts[0];
  const view = held._view;
  assert.equal(held.inputLocked, true);
  // The controller disposes unconditionally; it never calls the ordinary guarded
  // dismissal, so the list's lock cannot block navigation.
  assert.equal(view.closeResult, 'unset');
  locked.w.dispatchEvent(new locked.w.Event('popstate'));
  await locked.advance(1);
  assert.equal(view.disposed, 1);
  assert.equal(view.closeResult, 'unset');
  assert.equal(locked.w.document.querySelector('div[id]'), null);
  assert.equal(locked.timers(), 0);
  // The pending release-time unlock must not run after the list is gone.
  locked.pointer('pointerup', 'touch');
  await locked.advance(500);
  assert.equal(view.unlocked, 0);
  locked.close();

  const saving = fixture();
  saving.pointer('pointerdown', 'touch');
  await saving.advance(500);
  const busy = saving.mounts[0];
  const busyView = busy._view;
  busy.onSave('games');
  assert.equal(busyView.disposed, 0);
  saving.w.dispatchEvent(new saving.w.Event('popstate'));
  await saving.advance(1);
  assert.equal(busyView.disposed, 1);
  // Disposal reports no save outcome, so an accepted save is not restated as a
  // cancellation and no success toast is raised for a departed session.
  assert.equal(saving.w.document.querySelector('.lakomics-list-toast'), null);
  saving.close();
});

test('a save that completed before departure keeps its side effects and is not resubmitted', async () => {
  const f = fixture();
  let release = null;
  const saved = [];
  f.w.LakomicsXGalleryRuntime = { markSaved: (url, info) => saved.push([url, info]) };
  f.w.chrome.runtime.sendMessage = (message, callback) => {
    f.requests.push(message);
    if (message.type === 'collector:save') { release = () => callback({ ok: true, status: 'captured', captureStatus: 'pending' }); return; }
    f.w.setTimeout(() => callback(f.w.lakomicsStateReply({ preferences: { autoLikeOnSave: false } })), 0);
  };
  f.pointer('pointerdown'); f.pointer('pointermove', 'mouse', 60);
  await f.advance(251); // long-press delay, then the queued worker state reply
  assert.equal(f.mounts.length, 1);
  const options = f.mounts[0];
  const pending = options.onSave('games');
  assert.equal(f.requests.filter(request => request.type === 'collector:save').length, 1);
  // The worker accepted the capture, but the page navigated before the list could
  // receive that result.
  f.w.dispatchEvent(new f.w.Event('popstate'));
  await f.advance(1);
  assert.equal(options._view.disposed, 1);
  // The already-accepted result still lands: its side effects are preserved rather
  // than being restated as a cancellation, and the save is never resubmitted.
  release();
  await f.advance(1);
  assert.equal(await pending, null);
  assert.deepEqual(saved.map(([url]) => url), ['https://example.test/image.jpg']);
  assert.equal(f.requests.filter(request => request.type === 'collector:save').length, 1);
  assert.equal(f.mounts[0]._view.disposed, 1);
  f.close();
});

test('a delayed save callback cannot report into a reopened session', async () => {
  const f = fixture();
  let release = null;
  f.w.chrome.runtime.sendMessage = (message, callback) => {
    f.requests.push(message);
    if (message.type === 'collector:save') { release = () => callback({ ok: false, code: 'offline' }); return; }
    f.w.setTimeout(() => callback(f.w.lakomicsStateReply({})), 0);
  };
  f.pointer('pointerdown'); f.pointer('pointermove', 'mouse', 60);
  await f.advance(251); // long-press delay, then the queued worker state reply
  const stale = f.mounts[0];
  const pending = stale.onSave('games');
  f.w.dispatchEvent(new f.w.Event('popstate'));
  await f.advance(1);
  // The save resolves only when the worker answers; until then it stays pending,
  // so the late answer is what must be dropped.
  release();
  await f.advance(1);
  assert.equal(await pending, null);

  f.pointer('pointerup'); await f.advance(400);
  f.pointer('pointerdown'); f.pointer('pointermove', 'mouse', 60);
  await f.advance(251); // the reopened session loads its own state
  assert.equal(f.mounts.length, 2);
  const fresh = f.mounts[1];
  assert.equal(fresh._view.disposed, 0);
  await f.advance(1);
  // The failure belongs to the departed session: no toast, no error state on the
  // freshly mounted list.
  assert.equal(f.w.document.querySelector('.lakomics-list-toast'), null);
  assert.equal(fresh._view.disposed, 0);
  assert.equal(stale._view.disposed, 1);
  f.close();
});
