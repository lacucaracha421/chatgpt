import test from 'node:test';
import assert from 'node:assert/strict';

const memory = {};
globalThis.chrome = { storage: { local: {
  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((key) => key in memory).map((key) => [key, memory[key]]));
  },
  async set(values) { Object.assign(memory, structuredClone(values)); },
  async remove(keys) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete memory[key]; },
} } };

await import('../src/classification-tree.js');
let requestImpl = async () => ({ ok: false, status: 0, code: 'offline' });
globalThis.LakomicsListApi = { request: (...args) => requestImpl(...args) };
await import('../src/profile-store.js');
const store = globalThis.LakomicsProfileStore;

const classifications = { revision: 1, entries: [
  { id: 'games', name: '게임', parentId: null },
  { id: 'blue', name: '블루 아카이브', parentId: 'games' },
] };
test('snapshot refresh preserves local arc positions across reopening without sending them to the server', async () => {
  for (const key of Object.keys(memory)) delete memory[key];
  const profile = { revision: 1, pinnedClassificationIds: [], listOrder: {}, preferences: {} };
  await store.seed({ classifications: { revision: 1, entries: ['a', 'b', 'c'].map(id => ({ id, name: id, parentId: null })) }, profile });
  await store.seed({ classifications: { revision: 2, entries: ['c', 'a'].map(id => ({ id, name: id, parentId: null })) }, profile });
  const restored = await store.readState();
  assert.deepEqual(restored.arcLayout.__root__.slots, ['a', null, 'c']);
  assert.equal(restored.profile.arcLayout, undefined);
});
test('profile conflict refetches the current revision and reapplies only the local patch', async () => {
  for (const key of Object.keys(memory)) delete memory[key];
  await store.seed({ classifications, profile: { revision: 1, pinnedClassificationIds: [], listOrder: {}, preferences: {} } });
  const revisions = [];
  requestImpl = async (_path, options) => {
    revisions.push(options.body.expectedRevision);
    if (revisions.length === 1) return { ok: false, status: 409, data: { detail: { profile: {
      revision: 2, pinnedClassificationIds: ['blue'], listOrder: {},
      preferences: { autoLikeOnSave: true, xTranslateEnabled: true },
    } } } };
    return { ok: true, status: 200, data: {
      revision: 3, pinnedClassificationIds: ['blue'], listOrder: {},
      preferences: { autoLikeOnSave: false, xTranslateEnabled: true },
    } };
  };
  const result = await store.patchProfile({ preferences: { autoLikeOnSave: false } });
  assert.equal(result.ok, true);
  assert.deepEqual(revisions, [1, 2]);
  assert.deepEqual(result.state.profile.pinnedClassificationIds, ['blue']);
  assert.equal(result.state.profile.preferences.autoLikeOnSave, false);
});
test('offline profile edits remain visible and flush from the durable outbox later', async () => {
  for (const key of Object.keys(memory)) delete memory[key];
  await store.seed({ classifications, profile: { revision: 1, pinnedClassificationIds: [], listOrder: {}, preferences: {} } });
  requestImpl = async () => ({ ok: false, status: 0, code: 'offline' });
  const pending = await store.patchProfile({ listOrderPatch: { games: ['blue'] } });
  assert.equal(pending.ok, true);
  assert.equal(pending.pending, true);
  assert.deepEqual(pending.state.profile.listOrder.games, ['blue']);
  const queued = memory[store.OUTBOX_KEY];
  assert.equal(queued.length, 1);

  requestImpl = async (_path, options) => ({ ok: true, status: 200, data: {
    revision: 2, pinnedClassificationIds: [], listOrder: { games: ['blue'] },
    preferences: { autoLikeOnSave: true, xTranslateEnabled: true },
    expectedSeen: options.body.expectedRevision,
  } });
  const flushed = await store.flush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.completed, 1);
  assert.deepEqual(memory[store.OUTBOX_KEY], []);
  const final = await store.readState();
  assert.deepEqual(final.profile.listOrder.games, ['blue']);
  assert.equal(final.profile.revision, 2);
});

test('hidden folders survive refresh and reopening locally without patching the server profile', async () => {
  for (const key of Object.keys(memory)) delete memory[key];
  const profile = { revision: 1, pinnedClassificationIds: ['blue'], listOrder: {}, preferences: {} };
  await store.seed({ classifications, profile });
  let requests = 0;
  requestImpl = async () => { requests++; return { ok: true, data: { classifications, profile } }; };
  const result = await store.setHidden(['games', 'games']);
  assert.deepEqual(result.state.hiddenClassificationIds, ['games']);
  assert.equal(requests, 0);
  await store.refresh();
  assert.deepEqual((await store.readState()).hiddenClassificationIds, ['games']);
  assert.equal((await store.readState()).profile.hiddenClassificationIds, undefined);
  assert.deepEqual((await store.readState()).profile.pinnedClassificationIds, ['blue']);
  await store.setHidden([]);
  assert.deepEqual((await store.readState()).hiddenClassificationIds, []);
  await store.clear();
  assert.equal(memory[store.HIDDEN_KEY], undefined);
});

const baseProfile = () => ({ revision: 1, pinnedClassificationIds: [], listOrder: {}, preferences: { autoLikeOnSave: true } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function resetStore() { await store.clear(); await store.seed({ classifications, profile: baseProfile() }); }

test('a newer successful edit cannot be overwritten by an older offline edit', async () => {
  await resetStore();
  requestImpl = async () => ({ ok: false, status: 0, code: 'offline' });
  await store.patchProfile({ preferences: { autoLikeOnSave: false } });
  let remote = baseProfile();
  requestImpl = async (_path, { body }) => {
    remote = { ...remote, revision: remote.revision + 1, preferences: { ...remote.preferences, ...body.preferences } };
    return { ok: true, data: remote };
  };
  await store.patchProfile({ preferences: { autoLikeOnSave: true } });
  await store.flush();
  assert.equal(remote.preferences.autoLikeOnSave, true);
});

test('an edit arriving while a flush is in flight stays queued and visible', async () => {
  await resetStore();
  requestImpl = async () => ({ ok: false, status: 0, code: 'offline' });
  await store.patchProfile({ pinnedClassificationIds: ['games'] });
  const entered = deferred(), response = deferred(); let calls = 0;
  requestImpl = async () => {
    if (++calls === 1) { entered.resolve(); return response.promise; }
    return { ok: false, status: 0, code: 'offline' };
  };
  const flushing = store.flush(); await entered.promise;
  const editing = store.patchProfile({ preferences: { autoLikeOnSave: false } });
  // Let the local edit reach storage while the network response is held.
  await new Promise(resolve => setTimeout(resolve, 10));
  response.resolve({ ok: true, data: { ...baseProfile(), revision: 2, pinnedClassificationIds: ['games'] } });
  await Promise.all([flushing, editing]);
  assert.equal((await store.readState()).profile.preferences.autoLikeOnSave, false);
  assert.ok(memory[store.OUTBOX_KEY].some(item => item.patch.preferences?.autoLikeOnSave === false));
});

test('coalescing preserves every field of mixed patches and the last value per key', async () => {
  await resetStore(); requestImpl = async () => ({ ok: false, status: 0, code: 'offline' });
  await store.patchProfile({ listOrderPatch: { games: ['blue'] }, preferences: { autoLikeOnSave: true } });
  await store.patchProfile({ listOrderPatch: { games: null }, preferences: { autoLikeOnSave: false }, pinnedClassificationIds: ['blue'] });
  let sent;
  requestImpl = async (_path, { body }) => { sent = body; return { ok: true, data: baseProfile() }; };
  await store.flush();
  assert.equal(sent.preferences.autoLikeOnSave, false);
  assert.equal(sent.listOrderPatch.games, null);
  assert.deepEqual(sent.pinnedClassificationIds, ['blue']);
});

test('old bootstrap and PATCH responses cannot overwrite a newly seeded connection', async () => {
  for (const operation of ['refresh', 'patch']) {
    await resetStore(); const entered = deferred(), response = deferred();
    requestImpl = async () => { entered.resolve(); return response.promise; };
    const pending = operation === 'refresh' ? store.refresh() : store.patchProfile({ pinnedClassificationIds: ['games'] });
    await entered.promise;
    await store.clear();
    await store.seed({ classifications, profile: { ...baseProfile(), revision: 99, pinnedClassificationIds: ['blue'] } });
    response.resolve({ ok: true, data: operation === 'refresh' ? { classifications, profile: baseProfile() } : baseProfile() });
    await pending;
    assert.equal((await store.readState()).profile.revision, 99, operation);
    assert.deepEqual((await store.readState()).profile.pinnedClassificationIds, ['blue']);
  }
});

test('refresh overlays offline edits and a new connection refresh never waits for an old request', async () => {
  await resetStore();
  requestImpl = async () => ({ ok: false, status: 0, code: 'offline' });
  await store.patchProfile({ pinnedClassificationIds: ['blue'], preferences: { autoLikeOnSave: false } });
  requestImpl = async path => path.endsWith('/bootstrap')
    ? { ok: true, data: { classifications, profile: baseProfile() } } : { ok: false, status: 0, code: 'offline' };
  const refreshed = await store.refresh();
  assert.deepEqual(refreshed.state.profile.pinnedClassificationIds, ['blue']);
  assert.equal(refreshed.state.profile.preferences.autoLikeOnSave, false);
  await resetStore();
  const entered = deferred(), response = deferred();
  requestImpl = async () => { entered.resolve(); return response.promise; };
  const old = store.refresh(); await entered.promise;
  await store.clear();
  requestImpl = async () => ({ ok: true, data: { classifications, profile: { ...baseProfile(), revision: 77 } } });
  assert.equal((await store.refresh()).state.profile.revision, 77);
  response.resolve({ ok: true, data: { classifications, profile: baseProfile() } });
  assert.equal((await old).code, 'connection_changed');
  assert.equal((await store.readState()).profile.revision, 77);
});
