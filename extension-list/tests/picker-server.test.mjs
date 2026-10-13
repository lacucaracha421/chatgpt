import test from 'node:test';
import assert from 'node:assert/strict';
await import('../src/picker/model.js');
globalThis.chrome = undefined;
await import('../src/picker/background.js');
const { createService } = globalThis.LakomicsPickerBackground;
const TOKEN = 'server-token-test';
const SIGNED = 'https://storage.example.test/image?secret=signed';
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function fixture({ ua = '', key = true, pc = () => json(200, { entries: [] }), server, media,
  now = () => Date.now(), readConnection = async () => ({ origin: 'https://server.example.test', token: TOKEN }) } = {}) {
  const calls = [];
  const service = createService({
    storage: { async get() { return key ? { 'lakomics:picker:pc-key:v1': 'a1'.repeat(16) } : {}; } },
    runtime: { id: 'ext' }, tabs: {}, userAgent: ua,
    api: { readConnection }, now,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith('http://127.0.0.1:32145')) return pc();
      if (url === SIGNED) return media();
      return server ? server(url, init) : json(200, { entries: [] });
    },
  });
  return { service, calls };
}

test('Android/Helium and a missing PC key use server pairing directly', async () => {
  for (const options of [{ ua: 'Android' }, { ua: 'Helium' }, { key: false }]) {
    const f = fixture(options);
    assert.equal((await f.service.folders()).ok, true);
    assert.equal(f.calls.length, 1);
    assert.ok(f.calls[0].url.startsWith('https://server.example.test/'));
    assert.equal(f.calls[0].init.headers.authorization, 'Bearer ' + TOKEN);
  }
});

test('desktop stays on a reachable PC and refuses to bypass any HTTP refusal', async () => {
  const success = fixture();
  assert.equal((await success.service.folders()).ok, true);
  assert.equal(success.calls.length, 1);
  for (const status of [401, 403, 423, 404, 500]) {
    const f = fixture({ pc: () => json(status, { code: 'refused' }) });
    assert.equal((await f.service.folders()).status, status);
    assert.equal(f.calls.length, 1);
  }
});

test('desktop falls back only after transport failure or timeout', async () => {
  for (const error of [new TypeError('connection refused'), Object.assign(new Error(), { name: 'AbortError' })]) {
    const f = fixture({ pc: () => { throw error; } });
    assert.equal((await f.service.folders()).ok, true);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[1].url.startsWith('https://server.example.test/'));
  }
});

test('ticket downloads carry no bearer and neither token nor URL reaches the panel', async () => {
  const f = fixture({ ua: 'Android', server: () => json(200, { url: SIGNED, expiresIn: 300, contentType: 'image/png', sizeBytes: 3 }),
    media: () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }) });
  const reply = await f.service.original({ assetId: 'a' });
  assert.deepEqual(reply, { ok: true, mime: 'image/png', size: 3, base64: 'AQID' });
  assert.equal(f.calls[1].init.headers, undefined);
  assert.equal(f.calls[1].init.redirect, 'error');
  assert.equal(f.calls[1].init.credentials, 'omit');
  assert.equal(JSON.stringify(reply).includes(TOKEN), false);
  assert.equal(JSON.stringify(reply).includes(SIGNED), false);
});

test('ticket size, Content-Length and streamed size each enforce the original cap', async () => {
  const cap = 20 * 1024 * 1024;
  for (const mode of ['ticket', 'length', 'stream']) {
    const f = fixture({ key: false,
      server: () => json(200, { url: SIGNED, contentType: 'image/png', sizeBytes: mode === 'ticket' ? cap + 1 : 1 }),
      media: () => new Response(mode === 'stream' ? new Uint8Array(cap + 1) : new Uint8Array([1]),
        { headers: { 'content-type': 'image/png', ...(mode === 'length' ? { 'content-length': String(cap + 1) } : {}) } }),
    });
    assert.equal((await f.service.original({ assetId: 'a' })).kind, 'tooLarge');
    assert.equal(f.calls.length, mode === 'ticket' ? 1 : 2);
  }
});

test('server error codes in FastAPI detail are mapped without exposing payloads', async () => {
  const f = fixture({ key: false, server: () => json(404, { detail: { code: 'pickerScopeNotFound' } }) });
  assert.equal((await f.service.batch({ scope: { kind: 'group', id: 'g' } })).code, 'pickerScopeNotFound');
});

const inlineTicket = { url: SIGNED, expiresIn: 300, contentType: 'image/png', sizeBytes: 3 };
const inlineBatch = (ticket = inlineTicket, assetId = 'a') => ({ items: [{ assetId, mime: 'image/png', thumbnailTicket: ticket }], remaining: 0 });
const picture = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });

test('first batch reuses all 18 inline tickets with no thumbnail ticket requests or secret leakage', async () => {
  const f = fixture({ ua: 'Android', media: picture, server: url => {
    assert.ok(url.endsWith('/v1/picker/batch'), 'only the batch should contact the server');
    return json(200, { items: Array.from({ length: 18 }, (_, i) => inlineBatch(inlineTicket, 'a' + i).items[0]), remaining: 0 });
  } });
  const batch = await f.service.batch({ folderId: 'f' });
  assert.equal(batch.items.length, 18);
  const thumbnails = await Promise.all(batch.items.map(item => f.service.thumbnail(item)));
  for (const thumb of thumbnails) assert.deepEqual(thumb, { ok: true, mime: 'image/png', base64: 'AQID' });
  assert.equal(f.calls.length, 19, 'one server batch and 18 direct storage GETs');
  assert.equal(f.calls.filter(call => call.url === SIGNED).length, 18);
  for (const call of f.calls.slice(1)) {
    assert.equal(call.init.headers, undefined);
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
  }
  assert.equal(JSON.stringify([batch, thumbnails]).includes(TOKEN), false);
  assert.equal(JSON.stringify([batch, thumbnails]).includes(SIGNED), false);
});

test('tickets from successive batches are retained until the 30-second safety margin', async () => {
  let clock = 1000, batches = 0, ticketRequests = 0;
  const f = fixture({ ua: 'Helium', now: () => clock, media: picture, server: url => {
    if (url.endsWith('/batch')) return json(200, inlineBatch(inlineTicket, batches++ ? 'b' : 'a'));
    ticketRequests++;
    assert.ok(url.endsWith('/thumbnail/a'));
    return json(200, inlineTicket);
  } });
  await f.service.batch({ folderId: 'f' });
  await f.service.batch({ folderId: 'g' });
  clock = 270999;
  assert.equal((await f.service.thumbnail({ assetId: 'a' })).ok, true);
  assert.equal(ticketRequests, 0);
  clock = 271000;
  assert.equal((await f.service.thumbnail({ assetId: 'a' })).ok, true);
  assert.equal(ticketRequests, 1);
});

test('ticket lifetime includes time spent waiting for the batch', async () => {
  let clock = 0, ticketRequests = 0;
  const f = fixture({ ua: 'Android', now: () => clock, media: picture, server: url => {
    if (url.endsWith('/batch')) { clock = 20000; return json(200, inlineBatch({ ...inlineTicket, expiresIn: 45 })); }
    ticketRequests++;
    return json(200, inlineTicket);
  } });
  await f.service.batch({ folderId: 'f' });
  assert.equal((await f.service.thumbnail({ assetId: 'a' })).ok, true);
  assert.equal(ticketRequests, 1);
});

test('missing or invalid inline tickets use the existing ticket route', async () => {
  for (const ticket of [undefined, { ...inlineTicket, expiresIn: 30 }, { ...inlineTicket, expiresIn: '300' },
    { ...inlineTicket, url: 'http://storage.example.test/image' }, { ...inlineTicket, sizeBytes: 9 * 1024 * 1024 }]) {
    let ticketRequests = 0;
    const data = inlineBatch(ticket);
    if (ticket === undefined) delete data.items[0].thumbnailTicket;
    const f = fixture({ ua: 'Android', media: picture, server: url => {
      if (url.endsWith('/batch')) return json(200, data);
      ticketRequests++;
      return json(200, inlineTicket);
    } });
    await f.service.batch({ folderId: 'f' });
    assert.equal((await f.service.thumbnail({ assetId: 'a' })).ok, true);
    assert.equal(ticketRequests, 1);
  }
});

test('failed inline downloads fall back once and discard the failed ticket', async () => {
  for (const mode of ['http', 'transport', 'stream']) {
    let downloads = 0, ticketRequests = 0;
    const f = fixture({ ua: 'Android', server: url => {
      if (url.endsWith('/batch')) return json(200, inlineBatch());
      ticketRequests++;
      return json(200, inlineTicket);
    }, media: () => {
      if (++downloads > 1) return picture();
      if (mode === 'http') return new Response('', { status: 403 });
      if (mode === 'stream') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken stream')); } }));
      throw new TypeError('storage unavailable');
    } });
    await f.service.batch({ folderId: 'f' });
    assert.equal((await f.service.thumbnail({ assetId: 'a' })).ok, true, mode);
    assert.equal(downloads, 2);
    assert.equal(ticketRequests, 1);
    assert.equal((await f.service.thumbnail({ assetId: 'a' })).ok, true);
    assert.equal(ticketRequests, 2, 'failed inline ticket was discarded');
  }
});

test('inline tickets are never reused across pairings or delivered after a pairing change', async () => {
  for (const duringDownload of [false, true]) {
    let connection = { origin: 'https://server.example.test', token: TOKEN }, downloads = 0, ticketRequests = 0;
    const replace = () => { connection = { ...connection, token: 'new-token' }; };
    const f = fixture({ ua: 'Android', readConnection: async () => connection, server: url => {
      if (url.endsWith('/batch')) return json(200, inlineBatch());
      ticketRequests++;
      return json(200, inlineTicket);
    }, media: () => { downloads++; if (duringDownload) replace(); return picture(); } });
    await f.service.batch({ folderId: 'f' });
    if (!duringDownload) replace();
    const reply = await f.service.thumbnail({ assetId: 'a' });
    assert.equal(reply.ok, !duringDownload);
    assert.equal(ticketRequests, duringDownload ? 0 : 1);
    assert.equal(downloads, 1);
    if (duringDownload) assert.equal(reply.code, 'connection_changed');
  }
});

test('a cached server ticket cannot bypass a desktop PC privacy refusal', async () => {
  let reachable = false;
  const f = fixture({ pc: () => {
    if (!reachable) throw new TypeError('connection refused');
    return json(423, { code: 'pickerLibraryLocked' });
  }, server: () => json(200, inlineBatch()), media: () => { assert.fail('storage must not be contacted'); } });
  assert.equal((await f.service.batch({ folderId: 'f' })).ok, true);
  reachable = true;
  assert.equal((await f.service.thumbnail({ assetId: 'a' })).kind, 'locked');
  assert.equal(f.calls.length, 3);
});

test('desktop server fallback reuses inline tickets only after an unreachable PC', async () => {
  const f = fixture({ pc: () => { throw new TypeError('connection refused'); }, server: url => {
    assert.ok(url.endsWith('/batch'));
    return json(200, inlineBatch());
  }, media: picture });
  await f.service.batch({ folderId: 'f' });
  assert.equal((await f.service.thumbnail({ assetId: 'a' })).ok, true);
  assert.equal(f.calls.length, 4, 'PC batch attempt, server batch, PC thumbnail attempt, direct storage');
});

test('a reachable desktop PC takes precedence over an inline server ticket', async () => {
  let reachable = false;
  const f = fixture({ pc: () => {
    if (!reachable) throw new TypeError('connection refused');
    return picture();
  }, server: () => json(200, inlineBatch()), media: () => { assert.fail('PC response should be used'); } });
  await f.service.batch({ folderId: 'f' });
  reachable = true;
  assert.equal((await f.service.thumbnail({ assetId: 'a' })).ok, true);
  assert.equal(f.calls.length, 3);
});
