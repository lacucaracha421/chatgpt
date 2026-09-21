import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.__LAKOMICS_TEST__ = true;
await import('../src/content.js');
const content = globalThis.LakomicsListContent;

test('first invocation owns the opening state and duplicate pointer activation is rejected', () => {
  const gate = content.createInvocationGate();
  assert.equal(gate.arm(7), true);
  assert.equal(gate.arm(8), false);
  assert.equal(gate.opening(7), true);
  assert.equal(gate.opening(7), false);
  assert.equal(gate.opened(7), true);
  assert.equal(gate.phase, 'list-open');
  gate.close();
  assert.equal(gate.arm(8), true);
});

test('temporary intent accepts GIF-like images but not video', () => {
  const gif = content.temporaryIntent({type:'image',mediaUrl:'https://example.com/a.gif'});
  assert.match(gif, /^intent:\/\/temporary\?/);
  assert.equal(content.temporaryIntent({type:'video',mediaUrl:'https://example.com/a.mp4'}), null);
});


test('PC temporary X video eligibility does not widen the Android image intent', () => {
  const candidate = { type: 'video', source: 'x', mediaUrl: null, sourceUrl: 'https://x.com/i/status/123', overallMediaIndex: 2 };
  assert.equal(content.temporaryAvailable(candidate, false), true);
  assert.equal(content.temporaryAvailable(candidate, true), false);
  assert.equal(content.temporaryIntent(candidate), null);
  assert.equal(content.temporaryAvailable({ ...candidate, source: 'web' }, false), false);
  assert.equal(content.plainCandidate(candidate).overallMediaIndex, 2);
});

test('touch-owned long press suppresses native Android context UI', () => {
  assert.equal(content.shouldSuppressNativeContext({input:'touch'}, 'armed'), true);
  assert.equal(content.shouldSuppressNativeContext({input:'touch',longPressed:true}, 'opening'), true);
  assert.equal(content.shouldSuppressNativeContext({input:'mouse'}, 'idle'), false);
});

test('save result text reports real server ingestion state', () => {
  assert.equal(content.saveResultMessage({ok:true,status:'captured',captureStatus:'pending'}), '서버 저장됨 · PC 수신 대기');
  assert.equal(content.saveResultMessage({ok:true,status:'duplicate',captureStatus:'imported'}), '서버에 이미 있음 · PC 반영 완료');
  assert.equal(content.saveResultMessage({ok:true,status:'confirmed',captureStatus:'pending'}), '서버 저장 확인됨 · PC 수신 대기');
});


test('collector save waits for the server contract instead of timing out at 15 seconds', () => {
  assert.equal(content.runtimeTimeoutMs({type:'collector:state'}), 15000);
  assert.equal(content.runtimeTimeoutMs({type:'collector:save',payload:{candidate:{type:'image'}}}), 70000);
  assert.equal(content.runtimeTimeoutMs({type:'collector:save',payload:{candidate:{type:'video'}}}), 310000);
});

test('save failures expose useful server reasons', () => {
  assert.equal(content.saveFailureMessage({code:'video_unavailable'}), 'X 영상을 찾을 수 없음');
  assert.equal(content.saveFailureMessage({code:'video_info_failed'}), 'X 영상 정보 조회 실패');
  assert.equal(content.saveFailureMessage({code:'video_public_unavailable'}), 'X 공개 조회에서 영상 정보를 제공하지 않음 · 현재 방식으로 저장 불가');
  assert.equal(content.saveFailureMessage({code:'server_save_failed',httpStatus:400,serverDetail:'Invalid source URL'}), '서버 거절 · 원문 URL 검증 실패');
  assert.equal(content.saveFailureMessage({code:'server_save_failed',httpStatus:400,serverDetail:'Unsupported content type: text/html'}), '서버 거절 · 원본 형식 text/html');
  assert.equal(content.saveFailureMessage({code:'server_save_failed',httpStatus:502,serverDetail:'Media returned HTTP 403'}), '서버 원본 수신 실패 · HTTP 403');
  assert.equal(content.saveFailureMessage({code:'timeout',httpStatus:0}), '서버 응답 시간 초과');
  assert.equal(content.saveFailureMessage({code:'offline',httpStatus:0}), '서버 연결 실패');
});

test('temporary download failures expose only the safe browser reason supplied by the worker', () => {
  assert.equal(content.temporaryFailureMessage({code:'download_failed'}), '임시 다운로드 실패');
  assert.equal(content.temporaryFailureMessage({code:'download_failed',browserMessage:'Invalid URL [URL]'}), '임시 다운로드 실패 · Invalid URL [URL]');
});


test('opening release click is consumed even when it lands inside the picker', () => {
  assert.equal(content.openingClickDisposition(true, true), 'consume');
  assert.equal(content.openingClickDisposition(false, true), 'picker');
  assert.equal(content.openingClickDisposition(false, false), 'page');
  assert.equal(content.TOUCH_LONG_PRESS_MS, 500);
  assert.equal(content.MOUSE_OPEN_DELAY_MS, 250);
});


test('a session holds only its own token, so a departed session cannot claim a new one', () => {
  const sessions = content.createSessionState();
  const first = sessions.begin();
  assert.equal(sessions.holds(first), true);
  assert.equal(sessions.holds(null), false);
  assert.equal(sessions.holds({}), false);
  assert.equal(sessions.holds({ id: 1 }), false);
  const second = sessions.begin();
  assert.equal(sessions.holds(second), true);
  assert.equal(sessions.holds(first), false);
  sessions.end();
  assert.equal(sessions.holds(second), false);
});


// The watcher is pure wiring over the current browser session; these tests drive it
// with a stub window so the polling fallback is exercised without a real page.
test('the watcher reports one departure per armed session and stops cleanly', () => {
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0, now = 0, href = 'https://example.test/a';
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  // A real timer removes itself from the queue before its callback runs.
  function runTimer(entry) { timers.delete(entry[0]); entry[1].callback(); }
  const locationStub = { get href() { return href; } };
  globalThis.location = locationStub;
  globalThis.window = {
    location: locationStub,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  try {
    let departures = 0;
    const watcher = content.createSessionWatcher({ pollIntervalMs: 400 });
    watcher.watch(() => { departures += 1; });
    assert.deepEqual([...listeners.keys()].sort(), ['hashchange', 'pagehide', 'popstate']);
    assert.equal(timers.size, 1, 'an armed session schedules its liveness poll');

    // A popstate commit reports the departure and removes every listener it added.
    listeners.get('popstate')();
    assert.equal(departures, 1);
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0, 'the liveness poll stops with the session');

    // A stop()ed watcher must not keep reporting.
    listeners.get('popstate')?.();
    assert.equal(departures, 1);

    // The href poll catches an isolated-world history change that emitted no event.
    watcher.watch(() => { departures += 1; });
    href = 'https://example.test/b';
    assert.equal(timers.size, 1, 'a watch arms exactly one liveness poll');
    runTimer([...timers.entries()][0]);
    assert.equal(departures, 2);
    assert.equal(timers.size, 0, 'a reported departure stops the poll');

    // An unchanged href re-arms the poll instead of reporting.
    watcher.watch(() => { departures += 1; });
    assert.equal(timers.size, 1);
    runTimer([...timers.entries()][0]);
    assert.equal(departures, 2);
    assert.equal(timers.size, 1, 'polling re-arms only while a session is armed');
    watcher.stop();
    assert.equal(timers.size, 0);

    // pagehide ends the session and still reports the departure.
    watcher.watch(() => { departures += 1; });
    listeners.get('pagehide')();
    assert.equal(departures, 3);
    assert.equal(listeners.size, 0);
    assert.equal(timers.size, 0);
  } finally {
    globalThis.window = originalWindow;
    globalThis.location = originalLocation;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});


test('the watcher prefers the Navigation API and keeps pagehide as the unload signal', () => {
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  const listeners = new Map(), navigationListeners = new Map();
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => { throw new Error('the Navigation API path must not poll'); };
  const locationStub = { href: 'https://example.test/a' };
  globalThis.location = locationStub;
  globalThis.window = {
    location: locationStub,
    navigation: {
      addEventListener(type, listener) { navigationListeners.set(type, listener); },
      removeEventListener(type, listener) { if (navigationListeners.get(type) === listener) navigationListeners.delete(type); },
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  try {
    let departures = 0;
    const watcher = content.createSessionWatcher();
    watcher.watch(() => { departures += 1; });
    assert.deepEqual([...navigationListeners.keys()], ['currententrychange']);
    assert.deepEqual([...listeners.keys()], ['pagehide']);
    navigationListeners.get('currententrychange')();
    assert.equal(departures, 1);
    assert.equal(navigationListeners.size, 0);
    assert.equal(listeners.size, 0);
  } finally {
    globalThis.window = originalWindow;
    globalThis.location = originalLocation;
    globalThis.setTimeout = originalSetTimeout;
  }
});
