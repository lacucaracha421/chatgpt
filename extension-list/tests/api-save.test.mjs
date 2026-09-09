import test from 'node:test';
import assert from 'node:assert/strict';
await import('../src/api-client.js');
await import('../src/save-client.js');

test('pairing link keeps the secret in the URL fragment', () => {
  const parsed = globalThis.LakomicsListApi.parsePairing('https://laku.example/extension-pair#abcdefghijklmnop123456');
  assert.deepEqual(parsed, {origin:'https://laku.example',secret:'abcdefghijklmnop123456'});
  assert.equal(globalThis.LakomicsListApi.parsePairing('https://laku.example/extension-pair?secret=abcdefghijklmnop123456'), null);
});

test('GIF identity is explicit instead of falling through image/video routing', () => {
  const save = globalThis.LakomicsSaveClient;
  assert.equal(save.mediaType({type:'image',mediaUrl:'https://pbs.twimg.com/media/A.gif'}), 'animated_gif');
  assert.equal(save.mediaType({type:'image',mediaUrl:'https://pbs.twimg.com/media/A?format=gif&name=orig'}), 'animated_gif');
  assert.equal(save.mediaType({type:'image',filename:'animation.gif',mediaUrl:'https://example.com/download?id=1'}), 'animated_gif');
  assert.equal(save.mediaType({type:'video',mediaUrl:'https://video.twimg.com/A.mp4'}), 'video');
});


test('server save failure never falls back to Android browser downloads', async () => {
  const originalRequest = globalThis.LakomicsListApi.request;
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  globalThis.LakomicsListApi.request = async (path) => path.startsWith('/v1/extension/captures/confirm')
    ? { ok: true, status: 200, data: { found: false } }
    : { ok: false, status: 502, data: null };
  try {
    const result = await globalThis.LakomicsSaveClient.save({
      candidate: { type: 'image', source: 'x', sourceUrl: 'https://x.com/a/status/1/photo/1', mediaUrl: 'https://pbs.twimg.com/media/A.jpg' },
      classificationId: 'games',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'server_save_failed');
  } finally {
    globalThis.LakomicsListApi.request = originalRequest;
  }
});

test('server saved index is authoritative for existing image checks', async () => {
  const originalRequest = globalThis.LakomicsListApi.request;
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  globalThis.LakomicsListApi.request = async () => ({ ok: true, status: 200, data: { keys: ['123:1'] } });
  try {
    const result = await globalThis.LakomicsSaveClient.savedIndex();
    assert.equal(result.authoritative, true);
    assert.deepEqual(result.savedKeys, ['123:1']);
  } finally {
    globalThis.LakomicsListApi.request = originalRequest;
  }
});
