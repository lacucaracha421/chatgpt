import test from 'node:test';
import assert from 'node:assert/strict';
await import('../src/picker/model.js');
globalThis.chrome = undefined;
await import('../src/picker/background.js');
const { createService } = globalThis.LakomicsPickerBackground;
const KEY = 'a1'.repeat(16);
const page = { id: 'ext', frameId: 0, tab: { id: 5 }, url: 'https://arca.live/b/channel/write' };
const options = { id: 'ext', frameId: 0, url: 'chrome-extension://ext/options/options.html#pair-section' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fixture({ key = KEY, routes = {} } = {}) {
  const store = key ? { 'lakomics:picker:pc-key:v1': key } : {};
  const calls = [], created = [], sent = [];
  const storage = { async get(keys) { return Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])); }, async set(v) { Object.assign(store, v); }, async remove(keys) { for (const k of keys) delete store[k]; } };
  const runtime = { id: 'ext', getURL: path => 'chrome-extension://ext/' + path, lastError: undefined };
  const tabs = { async create(value) { created.push(value); }, async query() { return [{ id: 9, url: fixture.activeUrl }]; }, sendMessage(id, message, opts, cb) { sent.push({ id, message, opts }); cb(); } };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[new URL(url).pathname];
    if (route instanceof Error) throw route;
    return route ? route(init) : json(404, { code: 'not_found' });
  };
  return { service: createService({ storage, fetchImpl, runtime, tabs }), calls, store, created, sent };
}
fixture.activeUrl = 'https://arca.live/b/channel/write';

test('requests carry the key and extension id to the loopback service only', async () => {
  const f = fixture({ routes: { '/v1/picker/folders': () => json(200, { entries: [{ id: 'f1', parentId: null, name: '캐릭터', path: ['캐릭터'], imageCount: 3, imageCountWithDescendants: 9 }, { id: '../x', name: 'bad' }] }) } });
  const reply = await f.service.handle({ type: 'picker:folders' }, page);
  assert.equal(reply.ok, true); assert.deepEqual(reply.entries.map(e => e.id), ['f1']);
  const call = f.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:32145/v1/picker/folders');
  assert.equal(call.init.headers.authorization, 'Bearer ' + KEY);
  assert.equal(call.init.headers['x-lakomics-extension-id'], 'ext');
  assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.redirect, 'error');
  assert.equal(JSON.stringify(reply).includes(KEY), false);
});

test('batch validates the request, posts JSON and strips unknown fields from the answer', async () => {
  let body;
  const f = fixture({ routes: { '/v1/picker/batch': init => { body = JSON.parse(init.body); return json(200, { items: [{ assetId: 'x1', width: 10, height: 20, byteSize: 300, mime: 'image/webp', thumbnailUrl: '/v1/picker/thumbnail/x1', path: 'C:\\secret' }, { assetId: 'x2', mime: 'text/html' }], remaining: 7 }); } } });
  const reply = await f.service.handle({ type: 'picker:batch', folderId: 'f1', includeDescendants: true, exclude: ['a', 'b'], limit: 18 }, page);
  assert.deepEqual(body, { folderId: 'f1', includeDescendants: true, limit: 18, exclude: ['a', 'b'] });
  assert.deepEqual(reply, { ok: true, items: [{ assetId: 'x1', width: 10, height: 20, byteSize: 300, mime: 'image/webp' }], remaining: 7 });
  for (const bad of [{ folderId: '../x' }, { folderId: 'f1', limit: 25 }, { folderId: 'f1', exclude: ['ok', 'no good'] }, { folderId: 'f1', exclude: Array.from({ length: 2001 }, (_, i) => 'a' + i) }]) {
    assert.equal((await f.service.handle({ type: 'picker:batch', ...bad }, page)).kind, 'invalid');
  }
  assert.equal(f.calls.length, 1);
});

test('PC errors become kinds the panel can show', async () => {
  const cases = [[401, { code: 'unauthorized' }, 'unpaired'], [403, { code: 'forbidden_origin' }, 'forbidden'], [409, { code: 'library_not_open' }, 'library'], [423, { code: 'pickerLibraryLocked' }, 'locked'], [423, { code: 'pickerPrivacyUnavailable' }, 'privacyUnavailable'], [404, { code: 'classification_not_found' }, 'folderGone']];
  for (const [status, body, kind] of cases) {
    const f = fixture({ routes: { '/v1/picker/folders': () => json(status, body) } });
    const reply = await f.service.handle({ type: 'picker:folders' }, page);
    assert.equal(reply.ok, false); assert.equal(reply.kind, kind); assert.equal(reply.status, status);
  }
  const down = fixture({ routes: { '/v1/picker/folders': () => { throw new TypeError('fetch failed'); } } });
  assert.equal((await down.service.handle({ type: 'picker:folders' }, page)).kind, 'offline');
  const none = fixture({ key: null });
  assert.equal((await none.service.handle({ type: 'picker:folders' }, page)).kind, 'unpaired');
  assert.equal(none.calls.length, 0);
});

test('thumbnails and originals come back as base64 with the real type and size limits', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const f = fixture({ routes: {
    '/v1/picker/thumbnail/t1': () => new Response(png, { headers: { 'content-type': 'image/webp' } }),
    '/v1/picker/original/o1': () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } }),
    '/v1/picker/original/big': () => new Response('', { status: 413, headers: { 'content-type': 'application/json' } }),
    '/v1/picker/original/huge': () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(30 * 1024 * 1024) } }),
    '/v1/picker/original/odd': () => new Response(png, { headers: { 'content-type': 'image/svg+xml' } }),
  } });
  const thumb = await f.service.handle({ type: 'picker:thumb', assetId: 't1' }, page);
  assert.equal(thumb.mime, 'image/webp'); assert.deepEqual(globalThis.LakomicsPickerModel.fromBase64(thumb.base64), png);
  const original = await f.service.handle({ type: 'picker:original', assetId: 'o1' }, page);
  assert.equal(original.mime, 'image/png'); assert.equal(original.size, png.length);
  assert.equal((await f.service.handle({ type: 'picker:original', assetId: 'big' }, page)).kind, 'tooLarge');
  assert.equal((await f.service.handle({ type: 'picker:original', assetId: 'huge' }, page)).kind, 'tooLarge');
  assert.equal((await f.service.handle({ type: 'picker:original', assetId: 'odd' }, page)).kind, 'unsupported');
  assert.equal((await f.service.handle({ type: 'picker:original', assetId: '../etc' }, page)).kind, 'invalid');
});

test('only the Arca write page may read pictures and only the options page may touch the key', async () => {
  const f = fixture({ routes: { '/v1/picker/folders': () => json(200, { entries: [] }) } });
  for (const who of [{ ...page, url: 'https://arca.live/b/channel/123' }, { ...page, url: 'https://evil.test/b/c/write' }, { ...page, id: 'other' }, { ...page, frameId: 3 }, { id: 'ext', url: page.url }]) {
    assert.equal((await f.service.handle({ type: 'picker:folders' }, who)).code, 'forbidden_sender');
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.handle({ type: 'picker:key-set', value: KEY }, page)).code, 'forbidden_sender');
  assert.equal((await f.service.handle({ type: 'picker:key-state' }, page)).code, 'forbidden_sender');
});

test('the options page saves, validates and clears the key without ever returning it', async () => {
  const f = fixture({ key: null });
  assert.deepEqual(await f.service.handle({ type: 'picker:key-state' }, options), { ok: true, hasKey: false });
  assert.equal((await f.service.handle({ type: 'picker:key-set', value: 'not a key' }, options)).code, 'invalid_key');
  const saved = await f.service.handle({ type: 'picker:key-set', value: ' ' + KEY.toUpperCase() + ' ' }, options);
  assert.deepEqual(saved, { ok: true, hasKey: true });
  assert.equal(f.store['lakomics:picker:pc-key:v1'], KEY);
  assert.deepEqual(await f.service.handle({ type: 'picker:key-state' }, options), { ok: true, hasKey: true });
  assert.deepEqual(await f.service.handle({ type: 'picker:key-clear' }, options), { ok: true, hasKey: false });
  assert.equal('lakomics:picker:pc-key:v1' in f.store, false);
});

test('the settings request opens the connection section', async () => {
  const f = fixture();
  assert.equal((await f.service.handle({ type: 'picker:settings' }, page)).ok, true);
  assert.deepEqual(f.created, [{ url: 'chrome-extension://ext/options/options.html#pair-section' }]);
});

test('Alt+Shift+L is routed to the active Arca write tab only', async () => {
  const f = fixture();
  fixture.activeUrl = 'https://arca.live/b/channel/write';
  assert.equal(await f.service.routeCommand('toggle-arca-picker'), true);
  assert.deepEqual(f.sent, [{ id: 9, message: { type: 'picker:toggle' }, opts: { frameId: 0 } }]);
  assert.equal(await f.service.routeCommand('something-else'), false);
  fixture.activeUrl = 'https://example.test/';
  assert.equal(await f.service.routeCommand('toggle-arca-picker'), false);
  assert.equal(f.sent.length, 1);
  fixture.activeUrl = 'https://arca.live/b/channel/write';
});
