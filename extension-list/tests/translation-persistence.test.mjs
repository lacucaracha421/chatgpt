import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {memoryCache} from './translation-cache-fixture.mjs';

const scripts = await Promise.all(['translation/korean-rules', 'translation/korean', 'translation/terms', 'translation/deadline', 'translate-service']
  .map(name => readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')));
const PREFIX = 'lakomics:translation-cache:v4:', MIGRATED = 'lakomics:translation:cache-indexeddb-v1';
const request = {type: 'translation:request', text: 'Hello world'};
const sender = {id: 'test', url: 'chrome-extension://test/options/options.html'};
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({memory = {'lakomics:translation:v1': {enabled: true, apiKey: 'test', fallbackModel: ''}}, store = memoryCache(), indexedDB} = {}) {
  const writes = [], timers = new Map();
  let calls = 0, nextTimer = 0;
  const context = vm.createContext({AbortController, indexedDB, LakomicsTranslationCacheStore: store,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: {runtime: {id: 'test'}, storage: {local: {
      async get(keys) { return structuredClone(keys == null ? memory : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in memory).map(key => [key, memory[key]]))); },
      async set(values) { writes.push(structuredClone(values)); Object.assign(memory, structuredClone(values)); },
      async remove(keys) { for (const key of keys) delete memory[key]; },
    }}},
    fetch: async () => { calls++; return {ok: true, json: async () => ({choices: [{message: {content: '안녕하세요'}}]})}; },
  });
  for (const script of scripts) vm.runInContext(script, context);
  return {memory, writes, store, get calls() { return calls; }, handle: message => context.LakomicsTranslation.handle(message, sender),
    async flush() { for (const [id, timer] of timers) if (timer.ms < 3000) { timers.delete(id); timer.fn(); } await tick(); },
  };
}

test('v4 migration commits before removal, preserves hits and never broadcasts new cache entries', async () => {
  const f = fixture();
  await f.handle(request); await f.flush();
  const legacy = structuredClone(f.store.cache);
  const memory = {...structuredClone(f.memory), ...legacy}; delete memory[MIGRATED];
  const store = memoryCache();
  const write = store.write;
  store.write = async shards => {
    assert.ok(Object.keys(memory).some(key => key.startsWith(PREFIX)), 'legacy data survives until import commits');
    await write(shards);
  };
  const migrated = fixture({memory, store});
  assert.equal((await migrated.handle(request)).text, '안녕하세요');
  assert.equal(migrated.calls, 0);
  assert.equal(Object.keys(memory).some(key => key.startsWith(PREFIX)), false);
  assert.equal(memory[MIGRATED], true);
  assert.equal(migrated.writes.some(values => Object.keys(values).some(key => key.startsWith(PREFIX))), false);
  const restarted = fixture({memory, store});
  assert.equal((await restarted.handle(request)).text, '안녕하세요');
  assert.equal(restarted.calls, 0);
});

test('failed IndexedDB open leaves translation and memory hits working, and migration retries next wake', async () => {
  const f = fixture({store: null, indexedDB: {open() { throw new Error('unavailable'); }}});
  assert.equal((await f.handle(request)).text, '안녕하세요');
  await f.flush();
  assert.equal((await f.handle(request)).text, '안녕하세요');
  assert.equal(f.calls, 1);
  assert.equal(f.memory[MIGRATED], undefined);
  assert.equal(f.writes.some(values => Object.keys(values).some(key => key.startsWith(PREFIX))), false);
  await f.handle({type: 'translation:clear'});
  assert.equal(typeof f.memory['lakomics:translation-cache-cleared'], 'number');
  await f.handle(request); assert.equal(f.calls, 2);
  const restarted = fixture({memory: f.memory});
  await restarted.handle({type: 'translation:settings'});
  assert.equal(f.memory[MIGRATED], true);
});

test('clear follows an in-flight cache flush and cannot resurrect translations on worker restart', async () => {
  const store = memoryCache(), write = store.write;
  const f = fixture({store});
  await f.handle(request);
  let release;
  store.write = shards => new Promise(resolve => { release = async () => { await write(shards); resolve(); }; });
  await f.flush();
  const cleared = f.handle({type: 'translation:clear'}); await tick();
  await release(); await cleared;
  assert.deepEqual(store.cache, {});
  assert.equal(typeof f.memory['lakomics:translation-cache-cleared'], 'number');
  const restarted = fixture({memory: f.memory, store});
  await restarted.handle(request); assert.equal(restarted.calls, 1);
});

test('clear in memory-only mode also removes legacy shards so a later migration cannot restore them', async () => {
  const memory = {'lakomics:translation:v1': {enabled: true, apiKey: 'test'}, [PREFIX + '0']: [['0\nold', '이전 번역']]};
  const f = fixture({memory, store: null});
  await f.handle({type: 'translation:settings'});
  assert.ok(memory[PREFIX + '0'], 'failed migration keeps its source for retry');
  await f.handle({type: 'translation:clear'});
  assert.equal(memory[PREFIX + '0'], undefined);
});

test('a clear while IndexedDB is unavailable is applied before cached data can return on next wake', async () => {
  const first = fixture();
  await first.handle(request); await first.flush();
  const unavailable = fixture({memory: first.memory, store: {...first.store, read: async () => { throw new Error('unavailable'); }}});
  await unavailable.handle(request);
  await unavailable.handle({type: 'translation:clear'});
  assert.ok(Object.keys(first.store.cache).length, 'the inaccessible database still holds old data');
  const restarted = fixture({memory: first.memory, store: first.store});
  await restarted.handle(request);
  assert.equal(restarted.calls, 1, 'the pending clear prevents an old cache hit');
});
