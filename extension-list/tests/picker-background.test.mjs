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

function fixture({ key = KEY, routes = {}, api, userAgent } = {}) {
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
  return { service: createService({ storage, fetchImpl, runtime, tabs, api, userAgent }), calls, store, created, sent };
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
  assert.deepEqual(reply, { ok: true, items: [{ assetId: 'x1', width: 10, height: 20, byteSize: 300, mime: 'image/webp' }], remaining: 7, nextOffset: null });
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

test('folders also carry the characters and groups of the PC, cleaned; an older PC answers without them', async () => {
  const f = fixture({ routes: { '/v1/picker/folders': () => json(200, {
    entries: [{ id: 'f1', parentId: null, name: '리버스', path: ['리버스'], imageCount: 3, imageCountWithDescendants: 9 }],
    characters: [
      { kind: 'group', id: 'g1', name: '라플라스', seriesId: 'f1', seriesPath: ['리버스'], groupId: null, imageCount: 5, secret: 'C:\\x' },
      { kind: 'character', id: 'c1', name: '라플라스 A', seriesId: 'f1', seriesPath: ['리버스'], groupId: 'g1', imageCount: 4 },
      { kind: 'character', id: '../x', name: 'bad', seriesId: 'f1' },
    ],
  }) } });
  const reply = await f.service.handle({ type: 'picker:folders' }, page);
  assert.deepEqual(reply.characters.map(c => `${c.kind}:${c.id}:${c.imageCount}`), ['group:g1:5', 'character:c1:4']);
  assert.equal(JSON.stringify(reply).includes('secret'), false);
  assert.equal(reply.characters[1].groupId, 'g1');
  const older = fixture({ routes: { '/v1/picker/folders': () => json(200, { entries: [] }) } });
  assert.deepEqual((await older.service.handle({ type: 'picker:folders' }, page)).characters, []);
});

test('batch takes either a folder or a character/group scope, never both and never a folder-kind scope', async () => {
  const bodies = [];
  const f = fixture({ routes: { '/v1/picker/batch': init => { bodies.push(JSON.parse(init.body)); return json(200, { items: [], remaining: 0 }); } } });
  assert.equal((await f.service.handle({ type: 'picker:batch', scope: { kind: 'group', id: 'g1' }, exclude: ['a'], limit: 18 }, page)).ok, true);
  assert.equal((await f.service.handle({ type: 'picker:batch', scope: { kind: 'character', id: 'c1' } }, page)).ok, true);
  assert.deepEqual(bodies, [{ scope: { kind: 'group', id: 'g1' }, limit: 18, exclude: ['a'] }, { scope: { kind: 'character', id: 'c1' }, limit: 18, exclude: [] }]);
  assert.equal('folderId' in bodies[0] || 'includeDescendants' in bodies[0], false);
  for (const bad of [{}, { folderId: 'f1', scope: { kind: 'group', id: 'g1' } }, { scope: { kind: 'folder', id: 'f1' } }, { scope: { kind: 'series', id: 'x' } }, { scope: { kind: 'group', id: '../x' } }, { scope: 'g1' }, { scope: { kind: 'group' } }]) {
    assert.equal((await f.service.handle({ type: 'picker:batch', ...bad }, page)).kind, 'invalid', JSON.stringify(bad));
  }
  assert.equal(bodies.length, 2, 'invalid requests never reach the PC');
});

test('an unknown character or group becomes scopeGone', async () => {
  const f = fixture({ routes: { '/v1/picker/batch': () => json(404, { code: 'pickerScopeNotFound' }) } });
  const reply = await f.service.handle({ type: 'picker:batch', scope: { kind: 'character', id: 'c1' } }, page);
  assert.deepEqual([reply.ok, reply.kind, reply.status], [false, 'scopeGone', 404]);
});


test('folder and character order and pin metadata survive the service worker boundary', async () => {
  const f = fixture({ routes: { '/v1/picker/folders': () => json(200, {
    entries: [{ id: 'z', name: 'Zulu', order: 0, pinned: true, pinOrder: 2 }],
    characters: [{ kind: 'character', id: 'c', name: 'Person', seriesId: 'z', order: 7 }],
  }) } });
  const reply = await f.service.handle({ type: 'picker:folders' }, page);
  assert.equal(reply.entries[0].order, 0); assert.equal(reply.entries[0].pinned, true);
  assert.equal(reply.entries[0].pinOrder, 2); assert.equal(reply.characters[0].order, 7);
});


test('batch passes newest paging and PC inline thumbnail bytes, rejecting invalid ordering', async () => {
  const f = fixture({ routes: { '/v1/picker/batch': init => {
    assert.equal(JSON.parse(init.body).order, 'newest'); assert.equal(JSON.parse(init.body).offset, 18);
    return json(200, { items: [{ assetId: 'a', mime: 'image/png', thumbnailBase64: 'AAEC', thumbnailMime: 'image/webp' }], nextOffset: 36 });
  } } });
  const reply = await f.service.handle({ type: 'picker:batch', folderId: 'f1', order: 'newest', offset: 18 }, page);
  assert.equal(reply.nextOffset, 36); assert.equal(reply.items[0].thumbMime, 'image/webp');
  assert.deepEqual(globalThis.LakomicsPickerModel.fromBase64(reply.items[0].thumbBase64), new Uint8Array([0, 1, 2]));
  for (const bad of [{ order: 'oldest' }, { order: null }, { offset: -1 }, { offset: 1.5 }, { offset: '1' }, { offset: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await f.service.handle({ type: 'picker:batch', folderId: 'f1', ...bad }, page)).kind, 'invalid');
  }
  assert.equal(f.calls.length, 1);
});

test('server batch delivers inline thumbnails for the panel without a storage request', async () => {
  const api = { readConnection: async () => ({ origin: 'https://server.example.test', token: 'test-token' }) };
  const f = fixture({ api, userAgent: 'Android', routes: { '/v1/picker/batch': () => json(200, {
    items: [{ assetId: 'a', mime: 'image/png', thumbnailBase64: 'AAEC', thumbnailMime: 'image/webp',
      thumbnailTicket: { url: 'https://storage.example.test/cached', expiresIn: 300, contentType: 'image/webp', sizeBytes: 3 } }],
  }) } });
  const reply = await f.service.handle({ type: 'picker:batch', folderId: 'f1' }, page);
  assert.equal(reply.ok, true);
  assert.equal(reply.items[0].thumbMime, 'image/webp');
  assert.deepEqual(globalThis.LakomicsPickerModel.fromBase64(reply.items[0].thumbBase64), new Uint8Array([0, 1, 2]));
  assert.equal(f.calls.length, 1);
});

test('invalid inline MIME or oversized decoded bytes retain the server thumbnail ticket', async () => {
  const api = { readConnection: async () => ({ origin: 'https://server.example.test', token: 'test-token' }) };
  const cap = 8 * 1024 * 1024;
  // cap and cap+1 share the same encoded length; padding must count toward the bound.
  const oversized = Buffer.alloc(cap + 1).toString('base64');
  for (const inline of [
    { thumbnailBase64: 'AAEC', thumbnailMime: 'text/html' },
    { thumbnailBase64: oversized, thumbnailMime: 'image/webp' },
  ]) {
    const f = fixture({ api, userAgent: 'Android', routes: {
      '/v1/picker/batch': () => json(200, { items: [{ assetId: 'a', mime: 'image/png', ...inline,
        thumbnailTicket: { url: 'https://storage.example.test/cached', expiresIn: 300, contentType: 'image/webp', sizeBytes: 3 } }] }),
      '/cached': () => new Response(new Uint8Array([0, 1, 2]), { headers: { 'content-type': 'image/webp' } }),
    } });
    const reply = await f.service.handle({ type: 'picker:batch', folderId: 'f1' }, page);
    assert.equal(reply.ok, true);
    assert.equal(reply.items[0].thumbBase64, undefined);
    const thumb = await f.service.handle({ type: 'picker:thumb', assetId: 'a' }, page);
    assert.equal(thumb.ok, true);
    assert.equal(thumb.base64, 'AAEC');
    assert.deepEqual(f.calls.map(call => call.url), ['https://server.example.test/v1/picker/batch', 'https://storage.example.test/cached']);
  }
});
