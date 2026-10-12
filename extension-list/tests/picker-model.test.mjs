import test from 'node:test';
import assert from 'node:assert/strict';
await import('../src/picker/model.js');
const M = globalThis.LakomicsPickerModel;
const key = (name, extra = {}) => ({ key: name, ...extra });

test('only a new Arca Live post page may use the picker', () => {
  for (const url of ['https://arca.live/b/channel/write', 'https://arca.live/b/channel/write?category=a', 'https://arca.live/b/channel/write/']) assert.equal(M.isArcaWriteUrl(url), true, url);
  for (const url of ['https://arca.live/b/channel', 'https://arca.live/b/channel/123456', 'http://arca.live/b/channel/write', 'https://evil.test/b/channel/write', 'https://arca.live.evil.test/b/c/write', 'https://user@arca.live/b/c/write', 'not a url', '']) assert.equal(M.isArcaWriteUrl(url), false, url);
});

test('selection keeps click order and renumbers when one is removed', () => {
  const selection = M.createSelection();
  for (const id of ['c', 'a', 'b']) selection.toggle(id);
  assert.deepEqual(selection.ids(), ['c', 'a', 'b']);
  assert.equal(selection.numberOf('a'), 2);
  assert.equal(selection.toggle('c'), false);
  assert.deepEqual(selection.ids(), ['a', 'b']);
  assert.equal(selection.numberOf('a'), 1); assert.equal(selection.numberOf('b'), 2); assert.equal(selection.numberOf('c'), 0);
  assert.equal(selection.size, 2);
  selection.toggle('c'); assert.equal(selection.numberOf('c'), 3);
  selection.clear(); assert.equal(selection.size, 0);
});

test('"다른 그림" excludes what was shown and fills from the least recently seen', () => {
  const seen = M.createSeen();
  seen.add(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(seen.exclude(), ['a', 'b', 'c', 'd', 'e']);
  seen.add(['b']);
  assert.deepEqual(seen.list(), ['a', 'c', 'd', 'e', 'b']);
  // 1 new picture chosen ('x'); two more are needed -> the two oldest seen (a, c) may come back.
  const exclude = seen.fillExclude(['x'], 2);
  assert.deepEqual(new Set(exclude), new Set(['d', 'e', 'b', 'x']));
  assert.equal(exclude.includes('a') || exclude.includes('c'), false);
  const long = M.createSeen();
  long.add(Array.from({ length: 2500 }, (_, i) => 'id' + i));
  assert.equal(long.size, 1900); assert.ok(long.exclude().length <= M.MAX_EXCLUDE);
  assert.ok(long.fillExclude(Array.from({ length: 18 }, (_, i) => 'n' + i), 18).length <= M.MAX_EXCLUDE);
});

test('jobs track per-image states, failures and the stop flag', () => {
  const jobs = M.createJobs();
  jobs.start(['a', 'b', 'c']);
  assert.deepEqual(jobs.rows().map(r => r.state), ['wait', 'wait', 'wait']);
  jobs.set('a', 'up'); assert.equal(jobs.running(), true);
  jobs.set('a', 'ok'); jobs.set('b', 'bad', 'timeout');
  assert.deepEqual(jobs.counts(), { done: 2, total: 3, failed: 1, ok: 1 });
  assert.deepEqual(jobs.failed(), ['b']);
  assert.equal(jobs.pending(), true);
  jobs.stop(); assert.equal(jobs.stopped, true);
  jobs.start(['b']); assert.equal(jobs.stopped, false);
});

test('keyboard map: roving grid, preview, refresh, insert; modifiers are ignored', () => {
  const at = (name, index, count = 18, extra = {}) => M.gridKey(key(name, extra), { index, count, columns: 3 });
  assert.deepEqual(at('ArrowRight', 0), { type: 'move', index: 1 });
  assert.deepEqual(at('ArrowRight', 17), { type: 'move', index: 17 });
  assert.deepEqual(at('ArrowLeft', 0), { type: 'move', index: 0 });
  assert.deepEqual(at('ArrowDown', 4), { type: 'move', index: 7 });
  assert.deepEqual(at('ArrowDown', 16), { type: 'move', index: 16 });
  assert.deepEqual(at('ArrowUp', 4), { type: 'move', index: 1 });
  assert.deepEqual(at('ArrowUp', 1), { type: 'move', index: 1 });
  assert.deepEqual(at('Home', 9), { type: 'move', index: 0 });
  assert.deepEqual(at('End', 3), { type: 'move', index: 17 });
  assert.deepEqual(at(' ', 2), { type: 'toggle' });
  assert.deepEqual(at('Enter', 2), { type: 'insert' });
  assert.deepEqual(at('p', 2), { type: 'preview' });
  assert.deepEqual(at('R', 2), { type: 'refresh' });
  assert.equal(at('r', 2, 18, { ctrlKey: true }), null);
  assert.equal(at('a', 2), null);
  assert.equal(M.gridKey(key('ArrowRight'), { index: 0, count: 0 }), null);
  assert.deepEqual(M.trayKey(key('Delete'), { index: 1, count: 3 }), { type: 'remove', index: 1 });
  assert.deepEqual(M.trayKey(key('ArrowRight'), { index: 2, count: 3 }), { type: 'move', index: 2 });
});

test('PC failures map to panel states and job reasons in Korean', () => {
  assert.equal(M.mapFailure({ status: 0, code: 'offline' }), 'offline');
  assert.equal(M.mapFailure({ status: 0, code: 'timeout' }), 'timeout');
  assert.equal(M.mapFailure({ status: 401, code: 'unauthorized' }), 'unpaired');
  assert.equal(M.mapFailure({ status: 403, code: 'forbidden_origin' }), 'forbidden');
  assert.equal(M.mapFailure({ status: 409, code: 'library_not_open' }), 'library');
  assert.equal(M.mapFailure({ status: 423, code: 'pickerLibraryLocked' }), 'locked');
  assert.equal(M.mapFailure({ status: 423, code: 'pickerPrivacyUnavailable' }), 'privacyUnavailable');
  assert.equal(M.mapFailure({ status: 404, code: 'classification_not_found' }), 'folderGone');
  assert.equal(M.mapFailure({ status: 404, code: 'pickerAssetNotFound' }), 'missing');
  assert.equal(M.mapFailure({ status: 413, code: 'pickerOriginalTooLarge' }), 'tooLarge');
  assert.equal(M.mapFailure({ status: 400, code: 'pickerInvalidRequest' }), 'invalid');
  assert.equal(M.mapFailure({ status: 500 }), 'server');
  assert.equal(M.stateFor('offline').title, 'PC Lakomics에 연결되지 않음');
  assert.equal(M.stateFor('offline').hint, 'PC에서 Lakomics를 켜면 바로 이어집니다');
  assert.equal(M.stateFor('locked').hint, 'PC에서 비공개 모드가 켜져 있어 그림을 보여줄 수 없습니다');
  assert.equal(M.stateFor('unpaired').title, '연결 설정 필요'); assert.equal(M.stateFor('unpaired').action, 'settings');
  assert.equal(M.stateFor('nonsense').title, '그림을 불러오지 못함');
  assert.deepEqual(['timeout', 'tooLarge', 'unsupported', 'missing', 'offline'].map(M.jobReason), ['시간 초과', '용량 초과', '형식 미지원', '원본 없음', 'PC 연결 끊김']);
});

test('folder rows: expand state, search with ancestors, highlight, counts', () => {
  const entries = M.cleanFolders([
    { id: 'a', parentId: null, name: '캐릭터', path: ['캐릭터'], imageCount: 2, imageCountWithDescendants: 40 },
    { id: 'b', parentId: 'a', name: '블루 아카이브', path: ['캐릭터', '블루 아카이브'], imageCount: 10, imageCountWithDescendants: 30 },
    { id: 'c', parentId: 'b', name: '아로나', path: ['캐릭터', '블루 아카이브', '아로나'], imageCount: 20, imageCountWithDescendants: 20 },
    { id: 'd', parentId: null, name: '풍경', path: ['풍경'], imageCount: 5, imageCountWithDescendants: 5 },
    { id: 'a', parentId: null, name: '중복', path: [], imageCount: 0, imageCountWithDescendants: 0 },
    { id: 'bad id', name: 'x' },
  ]);
  assert.deepEqual(entries.map(e => e.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(M.folderRows(entries).map(r => r.entry.id), ['a', 'd']);
  assert.deepEqual(M.folderRows(entries, { expanded: new Set(['a']) }).map(r => [r.entry.id, r.depth]), [['a', 0], ['b', 1], ['d', 0]]);
  const found = M.folderRows(entries, { query: '아로' });
  assert.deepEqual(found.map(r => r.entry.id), ['a', 'b', 'c']);
  assert.deepEqual(found.map(r => r.ancestorOnly), [true, true, false]);
  assert.deepEqual(found[2].match, [0, 2]);
  assert.deepEqual(M.ancestorIds(entries, 'c'), ['b', 'a']);
  assert.equal(M.formatCount(1284), '1,284');
});

test('busy label appears after 400 ms and then stays at least 300 ms', () => {
  let clock = 0, next = 0; const timers = new Map(); const log = [];
  const api = M.createDelayedBusy({ show: () => log.push('show@' + clock), hide: () => log.push('hide@' + clock), now: () => clock, setTimer: (fn, ms) => { timers.set(++next, { at: clock + ms, fn }); return next; }, clearTimer: id => timers.delete(id) });
  const advance = to => { while (true) { const due = [...timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; clock = due[1].at; timers.delete(due[0]); due[1].fn(); } clock = to; };
  api.begin(); advance(399); api.end(); advance(1000);
  assert.deepEqual(log, [], 'a fast load never shows the label');
  api.begin(); advance(1400); assert.deepEqual(log, ['show@1400']);
  advance(1500); api.end(); assert.deepEqual(log, ['show@1400'], 'still held');
  advance(1700); assert.deepEqual(log, ['show@1400', 'hide@1700']);
});

test('bytes survive the base64 hop through the extension messages', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => i % 251);
  assert.deepEqual(M.fromBase64(M.toBase64(bytes)), bytes);
});
