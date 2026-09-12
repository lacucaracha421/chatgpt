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

test('X videos resolve their highest bitrate MP4 before server capture', async () => {
  const originalFetch = globalThis.fetch;
  const originalRequest = globalThis.LakomicsListApi.request;
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  const cases = [
    {
      postId: '2098250372536320134',
      sourceUrl: 'https://x.com/fNvEV6azRs43929/status/2098250372536320134/video/1',
      variants: [
        { content_type: 'video/mp4', bitrate: 632000, url: 'https://video.twimg.com/amplify_video/2098250347441721344/vid/avc1/320x568/gUkAo-A595lQLMvN.mp4?tag=14' },
        { content_type: 'video/mp4', bitrate: 950000, url: 'https://video.twimg.com/amplify_video/2098250347441721344/vid/avc1/480x854/goKtqW04wNdI7Fmi.mp4?tag=14' },
      ],
      expectedUrl: 'https://video.twimg.com/amplify_video/2098250347441721344/vid/avc1/480x854/goKtqW04wNdI7Fmi.mp4?tag=14',
    },
    {
      postId: '2098313503996330231',
      sourceUrl: 'https://x.com/sichinotuki/status/2098313503996330231/video/1',
      variants: [
        { content_type: 'video/mp4', bitrate: 632000, url: 'https://video.twimg.com/amplify_video/2098313439999627264/vid/avc1/320x568/FiTbti0_D1cklRC0.mp4?tag=14' },
        { content_type: 'video/mp4', bitrate: 950000, url: 'https://video.twimg.com/amplify_video/2098313439999627264/vid/avc1/500x888/SULanDsFhKTtyzDL.mp4?tag=14' },
      ],
      expectedUrl: 'https://video.twimg.com/amplify_video/2098313439999627264/vid/avc1/500x888/SULanDsFhKTtyzDL.mp4?tag=14',
    },
    {
      postId: '2098233612873466205',
      sourceUrl: 'https://x.com/yatagarasu_meru/status/2098233612873466205/video/1',
      variants: [
        { content_type: 'video/mp4', bitrate: 632000, url: 'https://video.twimg.com/amplify_video/2098232216275038209/vid/avc1/320x568/gvo8U12GakNlsLJs.mp4' },
        { content_type: 'video/mp4', bitrate: 950000, url: 'https://video.twimg.com/amplify_video/2098232216275038209/vid/avc1/480x852/W2uua16PYyvCwC8O.mp4' },
        { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/amplify_video/2098232216275038209/vid/avc1/720x1280/PLZSA7V3lXcWUiOU.mp4' },
        { content_type: 'video/mp4', bitrate: 10368000, url: 'https://video.twimg.com/amplify_video/2098232216275038209/vid/avc1/1080x1920/9hbJ2sqJMsevV7w4.mp4' },
      ],
      expectedUrl: 'https://video.twimg.com/amplify_video/2098232216275038209/vid/avc1/1080x1920/9hbJ2sqJMsevV7w4.mp4',
    },
  ];
  const captured = [];
  try {
    let fixture = null;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ mediaDetails: [{ type: 'video', video_info: { variants: fixture.variants } }] }),
    });
    globalThis.LakomicsListApi.request = async (path, options) => {
      if (path !== '/v1/captures') return { ok: false, status: 404 };
      captured.push(options.body);
      return options.body.media_url
        ? { ok: true, status: 200, data: { created: true, capture: { id: `capture-${captured.length}`, status: 'pending' } } }
        : { ok: false, status: 422, data: { detail: [{ loc: ['body', 'media_url'], type: 'string_type' }] } };
    };

    for (fixture of cases) {
      const result = await globalThis.LakomicsSaveClient.save({
        candidate: { type: 'video', source: 'web', sourceUrl: fixture.sourceUrl, postId: fixture.postId, mediaIndex: 1, mediaUrl: null },
        classificationId: 'games',
      });
      assert.equal(result.ok, true);
    }
    assert.deepEqual(captured.map((payload) => payload.media_url), cases.map((fixture) => fixture.expectedUrl));
    assert.deepEqual(captured.map((payload) => payload.media_type), ['video', 'video', 'video']);
    assert.deepEqual(captured.map((payload) => payload.source), ['x', 'x', 'x']);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.LakomicsListApi.request = originalRequest;
  }
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


test('server failure preserves a safe diagnostic without leaking URLs or bearer values', async () => {
  const originalRequest = globalThis.LakomicsListApi.request;
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  globalThis.LakomicsListApi.request = async () => ({
    ok: false, status: 400,
    data: { detail: 'Unsupported content type: text/html https://secret.example/a Bearer abcdefghijklmnopqrstuvwxyz' },
  });
  try {
    const result = await globalThis.LakomicsSaveClient.save({
      candidate: { type: 'image', source: 'x', sourceUrl: 'https://x.com/a/status/1/photo/1', mediaUrl: 'https://pbs.twimg.com/media/A.jpg' },
      classificationId: 'games',
    });
    assert.equal(result.httpStatus, 400);
    assert.match(result.serverDetail, /^Unsupported content type: text\/html/);
    assert.equal(result.serverDetail.includes('secret.example'), false);
    assert.equal(result.serverDetail.includes('abcdefghijklmnopqrstuvwxyz'), false);
  } finally { globalThis.LakomicsListApi.request = originalRequest; }
});
