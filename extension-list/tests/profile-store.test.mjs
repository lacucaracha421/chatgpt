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
