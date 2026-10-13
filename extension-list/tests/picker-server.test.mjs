import test from 'node:test';
import assert from 'node:assert/strict';
await import('../src/picker/model.js');
globalThis.chrome = undefined;
await import('../src/picker/background.js');
const { createService } = globalThis.LakomicsPickerBackground;
const TOKEN = 'server-token-test';
const SIGNED = 'https://storage.example.test/image?secret=signed';
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function fixture({ ua = '', key = true, pc = () => json(200, { entries: [] }), server, media } = {}) {
  const calls = [];
  const service = createService({
    storage: { async get() { return key ? { 'lakomics:picker:pc-key:v1': 'a1'.repeat(16) } : {}; } },
    runtime: { id: 'ext' }, tabs: {}, userAgent: ua,
    api: { async readConnection() { return { origin: 'https://server.example.test', token: TOKEN }; } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith('http://127.0.0.1:32145')) return pc();
      if (url === SIGNED) return media();
      return server ? server() : json(200, { entries: [] });
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
