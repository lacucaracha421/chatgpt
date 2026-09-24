import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sources = ['classification-tree', 'menu-settings', 'profile-store'].map(name =>
  readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const entries = ['reverse', 'mingchao', 'new'].map(id => ({ id, name: id, parentId: null }));
const empty = () => ({ schemaVersion: 1, listOrder: {}, hiddenClassificationIds: [], revision: 0 });

function fixture({ memory = {}, remote = empty(), menuRequest } = {}) {
  let now = 100_000, nextTimer = 0;
  const timers = new Map(), calls = [];
  let profile = { revision: 1, listOrder: {}, pinnedClassificationIds: [], preferences: {} };
  const classifications = { revision: 1, entries };
  const context = vm.createContext({
    structuredClone, crypto: { randomUUID: () => 'test-operation' },
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { storage: { local: {
      async get(keys) { return copy(Object.fromEntries(keys.filter(key => key in memory).map(key => [key, memory[key]]))); },
      async set(values) { Object.assign(memory, copy(values)); },
      async remove(keys) { for (const key of keys) delete memory[key]; },
    } } },
    LakomicsListApi: {
      async readConnection() { return { origin: 'https://library.example' }; },
      async request(path, options = {}) {
      calls.push(copy({ path, ...options }));
      if (path === '/v1/extension/settings') {
        if (menuRequest) return menuRequest(options, remote);
        if (options.method === 'PUT') {
          if (options.body.expectedRevision !== remote.revision) return { ok: false, status: 409 };
          const { expectedRevision, ...document } = copy(options.body);
          Object.assign(remote, document, { revision: expectedRevision + 1 });
        }
        return { ok: true, status: 200, data: copy(remote) };
      }
      if (path === '/v1/extension/bootstrap') return { ok: true, data: { profile, classifications } };
      if (path === '/v1/extension/profile') {
        profile = { ...profile, revision: profile.revision + 1,
          listOrder: { ...profile.listOrder, ...options.body.listOrderPatch },
          preferences: { ...profile.preferences, ...options.body.preferences } };
        return { ok: true, data: copy(profile) };
      }
      throw Error(`Unexpected endpoint: ${path}`);
    } },
  });
  sources.forEach(source => vm.runInContext(source, context));
  const menu = context.LakomicsMenuSettings, store = context.LakomicsProfileStore;
  return {
    memory, remote, menu, store, calls, timers,
    menuCalls: () => calls.filter(call => call.path === menu.PATH),
    async seed(value = {}) { await store.seed({ profile, classifications, ...value }); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
      await Promise.resolve();
    },
    async settle() { await menu.sync(); },
  };
}

test('order and hide changes persist locally immediately and push one debounced document', async () => {
  const f = fixture();
  await f.seed();
  await f.menu.sync();
  await f.store.patchProfile({ listOrderPatch: { __root__: ['mingchao', 'reverse'] } });
  await f.advance(500);
  await f.store.setHidden(['reverse']);
  assert.deepEqual(copy((await f.store.readState()).hiddenClassificationIds), ['reverse']);
  assert.equal(f.menuCalls().filter(call => call.method === 'PUT').length, 0);
  await f.advance(749);
  assert.equal(f.menuCalls().length, 1);
  await f.advance(1);
  await f.settle();
  const writes = f.menuCalls().filter(call => call.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { schemaVersion: 1, listOrder: { __root__: ['mingchao', 'reverse'] }, hiddenClassificationIds: ['reverse'], expectedRevision: 0 });
  assert.equal(f.memory[f.menu.KEY].dirty, false);
});

test('empty local storage restores order and hides after reinstall and bootstrap cannot undo it', async () => {
  const remote = { ...empty(), revision: 4, listOrder: { __root__: ['mingchao', 'reverse'] }, hiddenClassificationIds: ['reverse'] };
  const f = fixture({ remote });
  const result = await f.store.getState();
  assert.equal(result.ok, true);
  assert.deepEqual(copy(result.state.profile.listOrder.__root__), ['mingchao', 'reverse']);
  assert.deepEqual(copy(result.state.hiddenClassificationIds), ['reverse']);
  await f.store.refresh();
  assert.deepEqual(copy((await f.store.readState()).profile.listOrder.__root__), ['mingchao', 'reverse']);
  assert.equal(f.menuCalls().length, 1);
  assert.equal(f.menuCalls()[0].method, undefined);
});

test('unknown IDs are ignored and new folders are visible at the end', async () => {
  const f = fixture({ remote: { ...empty(), revision: 2,
    listOrder: { __root__: ['deleted', 'mingchao', 'reverse'], deleted: ['reverse'] },
    hiddenClassificationIds: ['deleted', 'reverse'] } });
  await f.seed();
  await f.menu.sync();
  const state = await f.store.readState();
  assert.deepEqual(copy(state.profile.listOrder), { __root__: ['mingchao', 'reverse'] });
  assert.deepEqual(copy(state.hiddenClassificationIds), ['reverse']);
  assert.deepEqual(copy(state.arcLayout.__root__.slots), ['mingchao', 'reverse', 'new']);
  assert.equal(state.hiddenClassificationIds.includes('new'), false);
});

test('404 preserves local behavior and suppresses repeated requests until the read interval', async () => {
  const f = fixture({ menuRequest: async () => ({ ok: false, status: 404 }) });
  await f.seed();
  await f.menu.sync();
  await f.store.setHidden(['reverse']);
  await f.store.patchProfile({ listOrderPatch: { __root__: ['mingchao', 'reverse'] } });
  await f.advance(750);
  await f.settle();
  await f.store.getState();
  assert.equal(f.menuCalls().length, 1);
  assert.deepEqual(copy((await f.store.readState()).hiddenClassificationIds), ['reverse']);
  assert.deepEqual(copy((await f.store.readState()).profile.listOrder.__root__), ['mingchao', 'reverse']);
  await f.advance(f.menu.READ_INTERVAL);
  await f.menu.sync();
  assert.equal(f.menuCalls().length, 2);
});

test('409 re-reads the revision and retries the last local document once', async () => {
  const f = fixture();
  await f.seed();
  await f.menu.sync();
  f.remote.revision = 7;
  f.remote.hiddenClassificationIds = ['mingchao'];
  await f.store.setHidden(['reverse']);
  await f.advance(750);
  await f.settle();
  assert.deepEqual(f.menuCalls().map(call => call.method || 'GET'), ['GET', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(f.menuCalls().filter(call => call.method === 'PUT').map(call => call.body.expectedRevision), [0, 7]);
  assert.deepEqual(f.remote.hiddenClassificationIds, ['reverse']);
  assert.equal(f.remote.revision, 8);
});

test('older clean local settings pull at most every five minutes and no polling is scheduled', async () => {
  const f = fixture({ remote: { ...empty(), revision: 1 } });
  await f.seed();
  await f.menu.sync();
  f.remote.revision = 2;
  f.remote.hiddenClassificationIds = ['mingchao'];
  await f.menu.sync();
  assert.equal(f.menuCalls().length, 1);
  assert.equal(f.timers.size, 0);
  await f.advance(f.menu.READ_INTERVAL);
  await f.menu.sync();
  assert.deepEqual(copy((await f.store.readState()).hiddenClassificationIds), ['mingchao']);
  assert.equal(f.menuCalls().length, 2);
  assert.equal(f.timers.size, 0);
});

test('legacy local settings migrate only when the server has no saved document', async () => {
  const f = fixture();
  await f.seed({ profile: { revision: 1, listOrder: { __root__: ['mingchao'] } } });
  f.memory[f.store.HIDDEN_KEY] = ['reverse'];
  await f.menu.sync();
  assert.deepEqual(f.remote.listOrder, { __root__: ['mingchao'] });
  assert.deepEqual(f.remote.hiddenClassificationIds, ['reverse']);
  assert.equal(f.remote.revision, 1);
});

test('unsent changes survive service-worker suspension and flush on the next startup', async () => {
  const f = fixture();
  await f.seed();
  await f.menu.sync();
  await f.store.setHidden(['reverse']);
  const restarted = fixture({ memory: copy(f.memory), remote: f.remote });
  await restarted.store.refresh();
  assert.deepEqual(f.remote.hiddenClassificationIds, ['reverse']);
  assert.equal(restarted.memory[restarted.menu.KEY].dirty, false);
});

test('edits during a PUT are not acknowledged by the older response', async () => {
  let resolveWrite;
  const f = fixture({ menuRequest: async options => {
    if (options.method !== 'PUT') return { ok: true, data: empty() };
    return new Promise(resolve => { resolveWrite = () => resolve({ ok: true, data: { ...options.body, revision: 1 } }); });
  } });
  await f.seed();
  await f.menu.sync();
  await f.store.setHidden(['reverse']);
  const pending = f.menu.sync({ push: true });
  while (!resolveWrite) await new Promise(resolve => setImmediate(resolve));
  await f.store.setHidden(['mingchao']);
  resolveWrite();
  await pending;
  assert.equal(f.memory[f.menu.KEY].dirty, true);
  assert.equal(f.memory[f.menu.KEY].revision, 1);
  assert.deepEqual(copy((await f.store.readState()).hiddenClassificationIds), ['mingchao']);
});

test('clear invalidates an in-flight restore and removes pending settings', async () => {
  let release;
  const f = fixture({ menuRequest: async () => new Promise(resolve => {
    release = () => resolve({ ok: true, data: { ...empty(), revision: 2, hiddenClassificationIds: ['reverse'] } });
  }) });
  await f.seed();
  const pending = f.menu.sync();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.store.clear();
  release();
  await pending;
  assert.equal(f.memory[f.menu.KEY], undefined);
  assert.equal(await f.store.readState(), null);
});

test('offline reads are throttled and failed writes retain the durable local document', async () => {
  const f = fixture({ menuRequest: async () => ({ ok: false, status: 0 }) });
  await f.seed();
  await f.menu.sync();
  await f.menu.sync();
  assert.equal(f.menuCalls().length, 1);
  await f.store.setHidden(['reverse']);
  await f.advance(750);
  await f.settle();
  assert.equal(f.memory[f.menu.KEY].dirty, true);
  assert.deepEqual(copy((await f.store.readState()).hiddenClassificationIds), ['reverse']);
});

test('repeated conflicts stop after one retry and preserve pending changes', async () => {
  const f = fixture({ menuRequest: async options => options.method === 'PUT'
    ? { ok: false, status: 409 } : { ok: true, data: empty() } });
  await f.seed();
  await f.menu.sync();
  await f.store.setHidden(['reverse']);
  await f.advance(750);
  await f.settle();
  assert.equal(f.menuCalls().filter(call => call.method === 'PUT').length, 2);
  assert.equal(f.memory[f.menu.KEY].dirty, true);
});

test('startup forces a fresh read even when the previous menu check was recent', async () => {
  const f = fixture({ remote: { ...empty(), revision: 1 } });
  await f.seed();
  await f.menu.sync();
  f.remote.revision = 2;
  f.remote.hiddenClassificationIds = ['mingchao'];
  await f.store.refresh({ forceMenuSettings: true });
  assert.equal(f.menuCalls().length, 2);
  assert.deepEqual(copy((await f.store.readState()).hiddenClassificationIds), ['mingchao']);
});

test('pending settings requests cannot follow a pairing change to a different server', async () => {
  let requests = 0;
  const context = vm.createContext({
    URL,
    chrome: { storage: { local: { async get() { return {
      'lakomics:list:connection': { origin: 'https://new.example', token: 'fixture-token-long-enough' },
    }; } } } },
    fetch() { requests++; throw Error('Must not send old settings to the new server'); },
  });
  vm.runInContext(readFileSync(new URL('../src/api-client.js', import.meta.url), 'utf8'), context);
  const response = await context.LakomicsListApi.request('/v1/extension/settings', {
    expectedOrigin: 'https://old.example', method: 'PUT', body: empty(),
  });
  assert.equal(response.code, 'connection_changed');
  assert.equal(requests, 0);
});

test('snapshot additions append after surviving folders even without an explicit saved order', async () => {
  const f = fixture();
  await f.seed({ classifications: { revision: 1, entries: entries.slice(0, 2) } });
  await f.menu.sync();
  await f.seed({ classifications: { revision: 2, entries: [entries[2], entries[1]] } });
  const state = await f.store.readState();
  assert.deepEqual(copy(state.arcLayout.__root__.slots), ['mingchao', 'new']);
  assert.equal(state.hiddenClassificationIds.includes('new'), false);
});
