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

// ---- characters and groups -----------------------------------------------------------------
const SERIES_FOLDERS = M.cleanFolders([
  { id: 'root', parentId: null, name: '캐릭터', path: ['캐릭터'], imageCount: 0, imageCountWithDescendants: 90 },
  { id: 'ser', parentId: 'root', name: '리버스', path: ['캐릭터', '리버스'], imageCount: 5, imageCountWithDescendants: 90 },
  { id: 'sub', parentId: 'ser', name: '기계', path: ['캐릭터', '리버스', '기계'], imageCount: 4, imageCountWithDescendants: 4 },
  { id: 'other', parentId: null, name: '풍경', path: ['풍경'], imageCount: 3, imageCountWithDescendants: 3 },
]);
const PEOPLE = M.cleanCharacters([
  { kind: 'group', id: 'g1', name: '라플라스', seriesId: 'ser', seriesPath: ['캐릭터', '리버스'], groupId: null, imageCount: 30 },
  { kind: 'character', id: 'c1', name: '라플라스 A', seriesId: 'ser', seriesPath: ['캐릭터', '리버스'], groupId: 'g1', imageCount: 20 },
  { kind: 'character', id: 'c2', name: '아로나', seriesId: 'ser', seriesPath: ['캐릭터', '리버스'], groupId: null, imageCount: 8 },
  { kind: 'character', id: 'c3', name: '낯선 이', seriesId: 'gone', seriesPath: [], groupId: null, imageCount: 1 },
  { kind: 'character', id: 'c1', name: '중복', seriesId: 'ser', seriesPath: [], groupId: null, imageCount: 1 },
  { kind: 'series', id: 'c9', name: 'x', seriesId: 'ser' },
  { kind: 'character', id: 'bad id', name: 'x', seriesId: 'ser' },
  { kind: 'character', id: 'c4', name: ' ', seriesId: 'ser' },
]);

test('characters from the PC are cleaned like folders (kind, ids, names, counts)', () => {
  assert.deepEqual(PEOPLE.map(e => `${e.kind}:${e.id}`), ['group:g1', 'character:c1', 'character:c2', 'character:c3']);
  assert.equal(PEOPLE[1].groupId, 'g1'); assert.equal(PEOPLE[0].groupId, null);
  assert.deepEqual(M.cleanCharacters(undefined), []); assert.deepEqual(M.cleanCharacters('x'), []);
  assert.deepEqual(M.cleanScope({ kind: 'group', id: 'g1', extra: 1 }), { kind: 'group', id: 'g1' });
  assert.equal(M.cleanScope({ kind: 'series', id: 'g1' }), null); assert.equal(M.cleanScope({ kind: 'group', id: '../x' }), null); assert.equal(M.cleanScope(null), null);
  assert.equal(M.mapFailure({ status: 404, code: 'pickerScopeNotFound' }), 'scopeGone');
});

test('popover tree: groups first, loose characters next, then sub-folders; groups expand to their characters', () => {
  const rows = (options) => M.treeRows(SERIES_FOLDERS, PEOPLE, options).map(r => `${r.kind}:${r.entry.id}@${r.depth}`);
  assert.deepEqual(rows(), ['folder:root@0', 'folder:other@0']);
  assert.deepEqual(rows({ expanded: new Set(['root']) }), ['folder:root@0', 'folder:ser@1', 'folder:other@0']);
  assert.deepEqual(rows({ expanded: new Set(['root', 'ser']) }), ['folder:root@0', 'folder:ser@1', 'group:g1@2', 'character:c2@2', 'folder:sub@2', 'folder:other@0']);
  assert.deepEqual(rows({ expanded: new Set(['root', 'ser', 'g1']) }), ['folder:root@0', 'folder:ser@1', 'group:g1@2', 'character:c1@3', 'character:c2@2', 'folder:sub@2', 'folder:other@0']);
  const all = M.treeRows(SERIES_FOLDERS, PEOPLE, { expanded: new Set(['root', 'ser', 'g1']) });
  const byId = Object.fromEntries(all.map(r => [r.entry.id, r]));
  assert.equal(byId.g1.hasChildren, true); assert.equal(byId.g1.open, true);
  assert.equal(byId.c2.hasChildren, false); assert.equal(byId.ser.hasChildren, true);
  assert.equal(byId.sub.hasChildren, false, 'a plain sub-folder has no children of its own');
  assert.equal(byId.g1.entry.imageCount, 30); assert.equal(byId.c1.secondary, '', 'no secondary text outside of a search');
  // a character of a series that does not exist (corrupt data) is never shown
  assert.equal(all.some(r => r.entry.id === 'c3'), false);
});

test('popover search finds characters and groups by name, keeps the path above them and shows the series path', () => {
  const found = M.treeRows(SERIES_FOLDERS, PEOPLE, { query: '라플라스' });
  assert.deepEqual(found.map(r => `${r.kind}:${r.entry.id}@${r.depth}`), ['folder:root@0', 'folder:ser@1', 'group:g1@2', 'character:c1@3']);
  assert.deepEqual(found.map(r => r.ancestorOnly), [true, true, false, false]);
  assert.deepEqual(found[2].match, [0, 4]);
  assert.equal(found[2].secondary, '캐릭터 › 리버스'); assert.equal(found[3].secondary, '캐릭터 › 리버스');
  assert.equal(found[0].secondary, '', 'folders have no secondary text');
  // a character inside a group keeps its group visible, the group does not open its other members
  const one = M.treeRows(SERIES_FOLDERS, PEOPLE, { query: 'a' });
  assert.ok(one.some(r => r.entry.id === 'g1'));
  const loose = M.treeRows(SERIES_FOLDERS, PEOPLE, { query: '아로나' });
  assert.deepEqual(loose.map(r => r.entry.id), ['root', 'ser', 'c2']);
  assert.equal(loose[2].secondary, '캐릭터 › 리버스');
  // folders still match as before and do not pull in their characters
  const folder = M.treeRows(SERIES_FOLDERS, PEOPLE, { query: '기계' });
  assert.deepEqual(folder.map(r => r.entry.id), ['root', 'ser', 'sub']);
  assert.deepEqual(M.treeRows(SERIES_FOLDERS, PEOPLE, { query: '없는 이름' }), []);
  // without characters the tree equals the old folder rows
  assert.deepEqual(M.treeRows(SERIES_FOLDERS, [], { expanded: new Set(['root']) }).map(r => r.entry.id), M.folderRows(SERIES_FOLDERS, { expanded: new Set(['root']) }).map(r => r.entry.id));
});

test('scope helpers: lookup, breadcrumb, request shape and counts per scope kind', () => {
  const group = { kind: 'group', id: 'g1' }, member = { kind: 'character', id: 'c1' }, loose = { kind: 'character', id: 'c2' }, folder = { kind: 'folder', id: 'sub' };
  assert.equal(M.findScope(SERIES_FOLDERS, PEOPLE, group).name, '라플라스');
  assert.equal(M.findScope(SERIES_FOLDERS, PEOPLE, folder).name, '기계');
  assert.equal(M.findScope(SERIES_FOLDERS, PEOPLE, { kind: 'group', id: 'c1' }), null, 'ids do not cross kinds');
  assert.equal(M.findScope(SERIES_FOLDERS, PEOPLE, null), null);
  assert.deepEqual(M.scopeParts(SERIES_FOLDERS, PEOPLE, folder), ['캐릭터', '리버스', '기계']);
  assert.deepEqual(M.scopeParts(SERIES_FOLDERS, PEOPLE, group), ['캐릭터', '리버스', '라플라스']);
  assert.deepEqual(M.scopeParts(SERIES_FOLDERS, PEOPLE, member), ['캐릭터', '리버스', '라플라스', '라플라스 A']);
  assert.deepEqual(M.scopeParts(SERIES_FOLDERS, PEOPLE, loose), ['캐릭터', '리버스', '아로나']);
  assert.deepEqual(M.scopeParts(SERIES_FOLDERS, PEOPLE, { kind: 'group', id: 'zz' }), []);
  assert.deepEqual(M.batchTarget(folder, true), { folderId: 'sub', includeDescendants: true });
  assert.deepEqual(M.batchTarget(folder, false), { folderId: 'sub', includeDescendants: false });
  assert.deepEqual(M.batchTarget(group, true), { scope: { kind: 'group', id: 'g1' } }, 'no folder fields for a group');
  assert.deepEqual(M.batchTarget(member, false), { scope: { kind: 'character', id: 'c1' } });
  const ser = SERIES_FOLDERS.find(e => e.id === 'ser');
  assert.equal(M.scopeCount(ser, 'folder', true), 90); assert.equal(M.scopeCount(ser, 'folder', false), 5);
  assert.equal(M.scopeCount(PEOPLE[0], 'group', true), 30); assert.equal(M.scopeCount(PEOPLE[1], 'character', false), 20);
});


test('PC ranks order every sibling list and search; pins are ordered duplicate shortcuts', () => {
  const folders = M.cleanFolders([
    { id: 'a', name: 'match Alpha', order: 3, pinned: true, pinOrder: 0 },
    { id: 'z', name: 'match Zulu', order: 0, pinned: true, pinOrder: 1 },
    { id: 'sa', parentId: 'z', name: 'match Alpha child', order: 2 },
    { id: 'sz', parentId: 'z', name: 'match Zulu child', order: 1 },
  ]);
  const people = M.cleanCharacters([
    { kind: 'group', id: 'ga', name: 'match Alpha group', seriesId: 'z', order: 1 },
    { kind: 'group', id: 'gz', name: 'match Zulu group', seriesId: 'z', order: 0 },
    { kind: 'character', id: 'ca', name: 'match Alpha member', seriesId: 'z', groupId: 'ga', order: 3 },
    { kind: 'character', id: 'cz', name: 'match Zulu member', seriesId: 'z', groupId: 'ga', order: 2 },
    { kind: 'character', id: 'la', name: 'match Alpha loose', seriesId: 'z', order: 5 },
    { kind: 'character', id: 'lz', name: 'match Zulu loose', seriesId: 'z', order: 4 },
  ]);
  const expected = ['a', 'z', 'z', 'gz', 'ga', 'cz', 'ca', 'lz', 'la', 'sz', 'sa', 'a'];
  const all = M.treeRows(folders, people, { expanded: new Set(['z', 'ga']) });
  assert.deepEqual(all.map(r => r.entry.id), expected);
  assert.deepEqual(all.slice(0, 2).map(r => [r.section, r.hasChildren]), [['pinned', false], ['pinned', false]]);
  assert.deepEqual(M.treeRows(folders, people, { query: 'match' }).map(r => r.entry.id), expected);
  assert.deepEqual(M.treeRows(folders, people, { query: 'member' }).map(r => r.entry.id), ['z', 'ga', 'cz', 'ca']);
  assert.deepEqual(folders.map(e => e.id), ['a', 'z', 'sa', 'sz'], 'does not mutate inputs');
  assert.equal(M.cleanFolders([{ id: 'old', name: 'Old' }])[0].pinned, false);
  assert.equal(M.cleanFolders([{ id: 'bad', name: 'Bad', order: -1, pinOrder: '1', pinned: 'true' }])[0].order, null);
});
