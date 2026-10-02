import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

function harness() {
  const memory = {}, calls = [], tabs = [];
  let fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const runtime = { id: 'collector', getURL: p => `chrome-extension://collector/${p}`, onMessage: { addListener() {} } };
  const ctx = vm.createContext({ URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout, structuredClone, crypto: webcrypto, console,
    __LAKOMICS_TEST__: true, importScripts() {},
    fetch: async (url, init) => { calls.push(url); return fetchImpl(url, init); },
    chrome: { runtime, tabs: { create: async value => tabs.push(value) }, storage: { local: {
      get: async keys => Object.fromEntries(keys.map(k => [k, structuredClone(memory[k])])),
      set: async values => Object.assign(memory, structuredClone(values)),
      remove: async keys => { for (const k of Array.isArray(keys) ? keys : [keys]) delete memory[k]; },
    } } },
    LakomicsMenuSettings: { project: state => state, clear: async () => {}, sync: async () => {} },
  });
  for (const file of ['classification-tree', 'api-client', 'profile-store', 'save-client', 'background']) vm.runInContext(readFileSync(new URL(`../src/${file}.js`, import.meta.url), 'utf8'), ctx);
  const connect = (origin, pairedAt = 1) => { memory[ctx.LakomicsListApi.CONNECTION_KEY] = { origin, token: 'test-token-with-enough-length', pairedAt, clientId: 'test' }; };
  return { ctx, memory, calls, tabs, connect, setFetch: f => { fetchImpl = f; }, handle: ctx.LakomicsAvLookupBackground.handleMessage };
}
const json = data => ({ ok: true, status: 200, json: async () => data });
const link = 'https://attacker.example/extension-pair#abcdefghijklmnop123456';
const profile = { revision: 1, pinnedClassificationIds: [], listOrder: {}, preferences: {} };
const bootstrap = { profile, classifications: { revision: 1, entries: [] } };
const paired = origin => json({ clientToken: 'replacement-token-with-enough-length', serverOrigin: origin, ...bootstrap });

test('web pages cannot pair, even when they claim confirmation; review only opens an extension page', async () => {
  const h = harness(); h.connect('https://original.example');
  h.setFetch(async () => paired('https://attacker.example'));
  const sender = { id: 'collector', url: link, tab: { id: 10 }, frameId: 0 };
  const result = await h.handle({ type: 'pair', value: link, confirmedOrigin: 'https://attacker.example' }, sender);
  assert.equal(result.ok, false);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.ctx.LakomicsListApi.readConnection()).origin, 'https://original.example');
  const review = await h.handle({ type: 'pair:review', value: link }, sender);
  assert.equal(review.ok, true);
  assert.ok(h.tabs[0].url.startsWith('chrome-extension://collector/options/pairing.html#'));
  assert.equal(h.calls.length, 0);
});

test('pair API requires explicit target confirmation and rejects a substituted server origin', async () => {
  const h = harness(); h.setFetch(async () => paired('https://other.example'));
  assert.equal((await h.ctx.LakomicsListApi.pair(link)).ok, false);
  assert.equal(h.calls.length, 0);
  const result = await h.ctx.LakomicsListApi.pair(link, { confirmedOrigin: 'https://attacker.example', expectedConnection: null });
  assert.equal(result.ok, false);
  assert.equal(await h.ctx.LakomicsListApi.readConnection(), null);
});

test('recent saved markers belong to a connection, including same-server re-pairing', async () => {
  const h = harness(); h.connect('https://first.example');
  h.setFetch(async url => url.endsWith('/v1/captures') ? json({ created: true }) : ({ ok: false, status: 503, json: async () => ({}) }));
  await h.ctx.LakomicsSaveClient.save({ candidate: { type: 'image', sourceUrl: 'https://x.com/a/status/123/photo/1', mediaUrl: 'https://pbs.twimg.com/a.jpg' }, classificationId: 'a' });
  assert.deepEqual(Array.from((await h.ctx.LakomicsSaveClient.savedIndex()).savedKeys), ['123:1']);
  h.connect('https://second.example');
  const other = await h.ctx.LakomicsSaveClient.savedIndex();
  assert.equal(other.savedKeys?.includes('123:1') ?? false, false);
  h.connect('https://first.example', 2);
  const repaired = await h.ctx.LakomicsSaveClient.savedIndex();
  assert.equal(repaired.savedKeys?.includes('123:1') ?? false, false);
});

test('late saved-index responses are discarded after connection change', async () => {
  const h = harness(); h.connect('https://first.example');
  let reply, entered; const waiting = new Promise(r => { entered = r; });
  h.setFetch(async () => { entered(); return new Promise(r => { reply = r; }); });
  const pending = h.ctx.LakomicsSaveClient.savedIndex(); await waiting;
  h.connect('https://second.example'); reply(json({ keys: ['123:1'] }));
  const result = await pending;
  assert.equal(result.savedKeys?.includes('123:1') ?? false, false);
});

test('only the confirmation page can replace a pairing and a stale confirmation is refused', async () => {
  const h = harness(); h.connect('https://original.example');
  const previous = h.ctx.LakomicsListApi.connectionIdentity(await h.ctx.LakomicsListApi.readConnection());
  const sender = { id: 'collector', url: 'chrome-extension://collector/options/pairing.html', frameId: 0 };
  h.memory['lakomics:list:recent-saved-x:v1'] = [{ key: '123:1', expiresAt: Date.now() + 10000 }];
  h.setFetch(async () => paired('https://attacker.example'));
  const result = await h.handle({ type: 'pair', value: link, confirmedOrigin: 'https://attacker.example', expectedConnection: previous }, sender);
  assert.equal(result.ok, true);
  assert.equal((await h.ctx.LakomicsListApi.readConnection()).origin, 'https://attacker.example');
  assert.equal(h.memory['lakomics:list:recent-saved-x:v1'], undefined);
  const calls = h.calls.length;
  const stale = await h.handle({ type: 'pair', value: link, confirmedOrigin: 'https://attacker.example', expectedConnection: previous }, sender);
  assert.equal(stale.code, 'connection_changed');
  assert.equal(h.calls.length, calls);
  h.memory['lakomics:list:recent-saved-x:v1'] = { connection: 'old', items: [] };
  await h.handle({ type: 'disconnect' }, sender);
  assert.equal(h.memory['lakomics:list:recent-saved-x:v1'], undefined);
  assert.equal(await h.ctx.LakomicsListApi.readConnection(), null);
});

test('confirmation screen shows target and existing server, sends no pair before a click', async () => {
  const { JSDOM } = await import('../../_tools/app/node_modules/jsdom/lib/api.js');
  const html = readFileSync(new URL('../options/pairing.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://extension.test/options/pairing.html#' + encodeURIComponent(link), runScripts: 'outside-only' });
  const messages = [];
  dom.window.chrome = { runtime: { async sendMessage(message) {
    messages.push(message);
    return message.type === 'settings:get' ? { ok: true, paired: true, origin: 'https://original.example', connectionIdentity: 'old-session' } : { ok: true };
  } } };
  dom.window.eval(readFileSync(new URL('../src/api-client.js', import.meta.url), 'utf8'));
  dom.window.eval(readFileSync(new URL('../options/pairing.js', import.meta.url), 'utf8'));
  try {
    await new Promise(r => setTimeout(r, 0));
    const doc = dom.window.document;
    assert.deepEqual(messages.map(m => m.type), ['settings:get']);
    assert.equal(dom.window.location.hash, '');
    assert.equal(doc.querySelector('#target').textContent, 'https://attacker.example');
    assert.equal(doc.querySelector('#current').textContent, 'https://original.example');
    assert.equal(doc.querySelector('#existing').hidden, false);
    assert.match(doc.querySelector('#confirm').textContent, /교체/);
    doc.querySelector('#confirm').click(); doc.querySelector('#confirm').click();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(messages.filter(m => m.type === 'pair').length, 1);
    assert.equal(messages[1].confirmedOrigin, 'https://attacker.example');
    assert.equal(messages[1].expectedConnection, 'old-session');
    assert.match(doc.querySelector('#status').textContent, /연결됨/);
  } finally { dom.window.close(); }
});

test('a late capture cannot seed saved markers for the next connection', async () => {
  const h = harness(); h.connect('https://first.example');
  let reply, entered; const waiting = new Promise(r => { entered = r; });
  h.setFetch(async () => { entered(); return new Promise(r => { reply = r; }); });
  const pending = h.ctx.LakomicsSaveClient.save({ candidate: { type: 'image', sourceUrl: 'https://x.com/a/status/123/photo/1', mediaUrl: 'https://pbs.twimg.com/a.jpg' }, classificationId: 'a' });
  await waiting; h.connect('https://second.example'); reply(json({ created: true }));
  assert.equal((await pending).code, 'connection_changed');
  assert.equal(h.memory['lakomics:list:recent-saved-x:v1'], undefined);
});

test('requests cannot use the old connection during local pairing reset', async () => {
  const h = harness(); h.connect('https://first.example');
  let release, entered; const waiting = new Promise(r => { entered = r; });
  h.ctx.LakomicsProfileStore.clear = async () => { entered(); await new Promise(r => { release = r; }); };
  const pending = h.ctx.LakomicsListApi.clearConnection(); await waiting;
  const result = await h.ctx.LakomicsListApi.request('/v1/extension/bootstrap');
  assert.equal(result.code, 'connection_changed');
  assert.equal(h.calls.length, 0);
  release(); await pending;
});
