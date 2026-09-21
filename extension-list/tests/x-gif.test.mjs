import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../../_tools/app/node_modules/jsdom/lib/api.js';
await import('../src/api-client.js');
await import('../src/save-client.js');
await import('../src/x-source.js');

const ANIMATED_MP4 = 'https://video.twimg.com/tweet_video/GIFEXAMPLE.mp4';
const ANIMATED_TS = 'https://video.twimg.com/tweet_video/GIFEXAMPLE.ts';
const ANIMATED_MANIFEST = 'https://video.twimg.com/tweet_video/GIFEXAMPLE.m3u8';
const VIDEO_MANIFEST = 'https://video.twimg.com/amplify_video/1234/pl/Pf4vgaenmAJ9yxn8.m3u8?tag=14';
const VIDEO_MP4 = 'https://video.twimg.com/amplify_video/1234/vid/avc1/480x854/clip.mp4?tag=14';
const VIDEO_MP4_HASH = `${VIDEO_MP4}#fragment`;
const POSTER = 'https://pbs.twimg.com/amplify_video_thumb/1234/img/poster.jpg';
const STILL_A = 'https://pbs.twimg.com/media/STILLA.jpg';
const STILL_B = 'https://pbs.twimg.com/media/STILLB.jpg';
const AVATAR = 'https://pbs.twimg.com/profile_images/99/avatar_normal.jpg';
const EMOJI = 'https://abs.twimg.com/emoji/v2/svg/1f600.svg';
const STATUS = 'https://x.com/example/status/2100596455262331116';

function fixture(markup, {author = 'example', postId = '2100596455262331116'} = {}) {
  const dom = new JSDOM(`<!doctype html><body><article data-testid="tweet">
    <time datetime="2026-09-21T00:00:00.000Z"></time>
    ${markup}
  </article></body>`, {url: `https://x.com/${author}/status/${postId}`});
  // parseStatusLink reads the page location for relative permalinks.
  globalThis.location = dom.window.location;
  return dom.window.document;
}

function stubChrome() {
  globalThis.chrome = {storage: {local: {get: async () => ({}), set: async () => {}}}};
}

function mediaEndpoint(details) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ok: true, json: async () => ({mediaDetails: details})});
  return () => { globalThis.fetch = original; };
}

async function backgroundFixture() {
  const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  let listener; const calls = [];
  const runtime = {onMessage: {addListener(fn) { listener = fn; }}};
  const ctx = vm.createContext({
    URL, importScripts() {},
    chrome: {runtime, downloads: {download(options, callback) { calls.push(options); callback(42); }}},
    LakomicsSaveClient: globalThis.LakomicsSaveClient,
    LakomicsListApi: globalThis.LakomicsListApi,
  });
  vm.runInContext(source, ctx);
  return {calls, send: (message) => new Promise((resolve) => listener(message, {}, resolve))};
}

const animated = (url = ANIMATED_MP4) => ({type: 'animated_gif', video_info: {variants: [{content_type: 'video/mp4', url}]}});
const realVideo = (url = VIDEO_MP4) => ({type: 'video', video_info: {variants: [{content_type: 'video/mp4', url}]}});
const photo = () => ({type: 'photo', media_url_https: STILL_A});
const candidateFor = (overrides = {}) => ({
  type: 'video', source: 'x', mediaUrl: null,
  sourceUrl: `${STATUS}/video/1`, postId: '2100596455262331116', ...overrides,
});

test('avatars and emoji are not media and never shift the ordinal', () => {
  const document = fixture(`
    <a href="/example/status/2100596455262331116/photo/1"><img src="${AVATAR}" alt="avatar"></a>
    <a href="/example/status/2100596455262331116/photo/1"><img src="${EMOJI}" alt="emoji"></a>
    <a href="/example/status/2100596455262331116/photo/1"><img src="${STILL_A}"></a>
    <div data-testid="videoPlayer"><video src="${ANIMATED_MP4}"></video></div>
    <a href="/example/status/2100596455262331116">permalink</a>`);
  // The tweet has one real still then one video, so the video is media 2.
  assert.equal(globalThis.LakomicsXSource.inferOverallMediaIndex(document.querySelector('video'), 'video'), 2);
  const candidate = globalThis.LakomicsXSource.findCandidate(document.querySelector('video'));
  assert.equal(candidate.overallMediaIndex, 2);
});

test('an explicit /video/N permalink outranks DOM inference', () => {
  const document = fixture(`
    <a href="/example/status/2100596455262331116/photo/1"><img src="${STILL_A}"></a>
    <div data-testid="videoPlayer"><video src="${ANIMATED_MP4}"></video></div>
    <a href="/example/status/2100596455262331116/video/2">v2</a>`);
  // The DOM agrees here, so the permalink is the authority that must be used.
  assert.equal(globalThis.LakomicsXSource.inferOverallMediaIndex(document.querySelector('video'), 'video'), 2);
  // Without the permalink the DOM still yields the same ordinal.
  const noPermalink = fixture(`
    <a href="/example/status/2100596455262331116/photo/1"><img src="${STILL_A}"></a>
    <div data-testid="videoPlayer"><video src="${ANIMATED_MP4}"></video></div>
    <a href="/example/status/2100596455262331116">permalink</a>`);
  assert.equal(globalThis.LakomicsXSource.inferOverallMediaIndex(noPermalink.querySelector('video'), 'video'), 2);
});

test('an explicit permalink wins even when the DOM would disagree', () => {
  // The permalink says media 4; the DOM cannot see the other cells.
  const document = fixture(`
    <div data-testid="videoPlayer"><video src="${ANIMATED_MP4}"></video></div>
    <a href="/example/status/2100596455262331116/video/4">v4</a>`);
  const candidate = globalThis.LakomicsXSource.findCandidate(document.querySelector('video'));
  assert.equal(candidate.overallMediaIndex, 4);
  assert.equal(candidate.mediaIndex, 4);
});

test('inference works for videoComponent and a direct video element', () => {
  const component = fixture(`
    <a href="/example/status/2100596455262331116/photo/1"><img src="${STILL_A}"></a>
    <div data-testid="videoComponent"><video id="v" src="${ANIMATED_MP4}"></video></div>
    <a href="/example/status/2100596455262331116">permalink</a>`);
  assert.equal(globalThis.LakomicsXSource.inferOverallMediaIndex(component.querySelector('#v'), 'video'), 2);

  const direct = fixture(`
    <a href="/example/status/2100596455262331116/photo/1"><img src="${STILL_A}"></a>
    <video id="v" src="${ANIMATED_MP4}"></video>
    <a href="/example/status/2100596455262331116/photo/1">p1</a>
    <a href="/example/status/2100596455262331116/video/3">v3</a>`);
  assert.equal(globalThis.LakomicsXSource.inferOverallMediaIndex(direct.querySelector('#v'), 'video'), 3);
});

test('quoted players do not count toward this post ordinal', () => {
  const document = fixture(`
    <a href="/example/status/2100596455262331116/photo/1"><img src="${STILL_A}"></a>
    <div data-testid="quoteTweet" role="link">
      <div data-testid="videoPlayer"><video src="${ANIMATED_MP4}"></video></div>
      <a href="/inner/status/222/video/1">inner</a>
    </div>
    <div data-testid="videoPlayer"><video id="outer" src="${VIDEO_MP4}"></video></div>
    <a href="/example/status/2100596455262331116/video/2">v2</a>`);
  // One real still then this post's video: media 2, and the quote adds nothing.
  assert.equal(globalThis.LakomicsXSource.inferOverallMediaIndex(document.querySelector('#outer'), 'video'), 2);
});

test('a poster never becomes an image candidate, and an animated poster routes to its player', () => {
  const posterOnly = fixture(`<a href="/example/status/2100596455262331116/video/1"><img
    src="${POSTER}" alt="poster"></a>`);
  // The video CDN poster is not a media still, and there is no player to attribute it.
  assert.equal(globalThis.LakomicsXSource.findCandidate(posterOnly.querySelector('img')), null);

  const posterInPlayer = fixture(`<div data-testid="videoPlayer"><img id="poster" src="${POSTER}"></div>
    <a href="/example/status/2100596455262331116/video/1">v1</a>`);
  const candidate = globalThis.LakomicsXSource.findCandidate(posterInPlayer.querySelector('#poster'));
  // The animated player says which media the still stands for, so it resolves there.
  assert.equal(candidate.type, 'video');
  assert.equal(candidate.mediaUrl, null);
  assert.equal(candidate.sourceUrl, `${STATUS}/video/1`);
});

test('a mounted progressive MP4 is retained and a manifest or fragment is not', () => {
  const mounted = fixture(`<div data-testid="videoPlayer"><video src="${ANIMATED_MP4}" poster="${POSTER}"></video></div>
    <a href="/example/status/2100596455262331116/video/1">v</a>`);
  const kept = globalThis.LakomicsXSource.findCandidate(mounted.querySelector('video'));
  assert.equal(kept.type, 'video');
  assert.equal(kept.mediaUrl, ANIMATED_MP4);

  for (const url of [VIDEO_MANIFEST, ANIMATED_MANIFEST, ANIMATED_TS, VIDEO_MP4_HASH]) {
    const document = fixture(`<div data-testid="videoPlayer"><video src="${url}"></video></div>
      <a href="/example/status/2100596455262331116/video/1">v</a>`);
    const candidate = globalThis.LakomicsXSource.findCandidate(document.querySelector('video'));
    assert.equal(candidate.mediaUrl, null, url);
  }
});

test('a direct source child progressive MP4 is used without a lookup', () => {
  const document = fixture(`<div data-testid="videoComponent"><video>
    <source src="${ANIMATED_MP4}" type="video/mp4">
  </video></div><a href="/example/status/2100596455262331116/video/1">v</a>`);
  const candidate = globalThis.LakomicsXSource.findCandidate(document.querySelector('video'));
  assert.equal(candidate.type, 'video');
  assert.equal(candidate.mediaUrl, ANIMATED_MP4);
});

test('the resolver indexes a mixed list by the explicit overall ordinal', async () => {
  stubChrome();
  // Media 1 is a photo, media 2 is animated. The explicit ordinal selects media 2.
  const restore = mediaEndpoint([photo(), animated()]);
  try {
    const candidate = await globalThis.LakomicsSaveClient.resolveXVideoCandidate(
      candidateFor({overallMediaIndex: 2, sourceUrl: `${STATUS}/video/2`}));
    assert.equal(candidate.mediaUrl, ANIMATED_MP4);
    assert.equal(candidate.animatedMedia, true);
    // The MP4 keeps the video transport, so nothing claims GIF bytes.
    assert.equal(globalThis.LakomicsSaveClient.mediaType(candidate), 'video');
  } finally { restore(); }
});

test('a video-only ordinal is projected onto video media, not the mixed list', async () => {
  stubChrome();
  // Two videos with no photo between them, so the video-only ordinal and the overall
  // ordinal coincide. A candidate that knows only the video-only ordinal must still
  // pick the second video rather than mis-indexing a video media list.
  const second = 'https://video.twimg.com/tweet_video/GIFEXAMPLE.mp4';
  const restore = mediaEndpoint([realVideo(), animated(second)]);
  try {
    const candidate = await globalThis.LakomicsSaveClient.resolveXVideoCandidate(
      candidateFor({mediaIndex: 2, sourceUrl: `${STATUS}/video/2`}));
    assert.equal(candidate.mediaUrl, second);
  } finally { restore(); }
});

test('a legacy video ordinal maps correctly past photos even with only one video', async () => {
  stubChrome();
  // Project the ordinal onto media types, not usable URLs or the full list.
  const restore = mediaEndpoint([photo(), realVideo()]);
  try {
    const videoOnly = await globalThis.LakomicsSaveClient.resolveXVideoCandidate(
      candidateFor({mediaIndex: 1, sourceUrl: `${STATUS}/video/1`}));
    assert.equal(videoOnly.mediaUrl, VIDEO_MP4);
    const explicit = await globalThis.LakomicsSaveClient.resolveXVideoCandidate(
      candidateFor({overallMediaIndex: 2, sourceUrl: `${STATUS}/video/2`}));
    assert.equal(explicit.mediaUrl, VIDEO_MP4);
  } finally { restore(); }
});

test('a video-only ordinal picks the matching video when a tweet has several', async () => {
  stubChrome();
  // Two video-media entries, so this list is video media and the ordinal applies.
  const restore = mediaEndpoint([realVideo(VIDEO_MP4), animated()]);
  try {
    const second = await globalThis.LakomicsSaveClient.resolveXVideoCandidate(
      candidateFor({mediaIndex: 2, sourceUrl: `${STATUS}/video/2`}));
    assert.equal(second.mediaUrl, ANIMATED_MP4);
    const first = await globalThis.LakomicsSaveClient.resolveXVideoCandidate(
      candidateFor({mediaIndex: 1, sourceUrl: `${STATUS}/video/1`}));
    assert.equal(first.mediaUrl, VIDEO_MP4);
  } finally { restore(); }
});

test('unavailable earlier videos do not shift a legacy video ordinal', async () => {
  const restore = mediaEndpoint([realVideo(VIDEO_MANIFEST), animated()]);
  try {
    const first = await LakomicsSaveClient.resolveXVideoCandidate(candidateFor({ mediaIndex: 1 }));
    const second = await LakomicsSaveClient.resolveXVideoCandidate(candidateFor({ mediaIndex: 2 }));
    assert.equal(first.mediaUrl, null);
    assert.equal(second.mediaUrl, ANIMATED_MP4);
  } finally { restore(); }
});

test('nested player wrappers and direct videos share one all-media sequence', () => {
  const document = fixture(`<a href="${STATUS}">post</a><img src="${AVATAR}">
    <img src="${STILL_A}"><div data-testid="videoComponent"><div data-testid="videoPlayer"><video id="first"></video></div></div>
    <img src="${STILL_B}"><video id="second"></video>`);
  for (const [id, index] of [['first', 2], ['second', 4]]) {
    const candidate = LakomicsXSource.findCandidate(document.querySelector('#' + id));
    assert.equal(candidate.overallMediaIndex, index);
    assert.equal(candidate.mediaIndex, index);
    assert.equal(candidate.sourceUrl, `${STATUS}/video/${index}`);
  }
});

test('a sibling video link cannot redirect another player to its media', () => {
  const document = fixture(`<a href="${STATUS}">post</a><img src="${STILL_A}">
    <div data-testid="videoPlayer"><video id="first"></video></div>
    <a href="${STATUS}/video/3"><div data-testid="videoPlayer"><video id="second"></video></div></a>`);
  assert.equal(LakomicsXSource.findCandidate(document.querySelector('#first')).overallMediaIndex, 2);
  assert.equal(LakomicsXSource.findCandidate(document.querySelector('#second')).overallMediaIndex, 3);
});

test('photo anchors and quoted permalinks do not override an outer video ordinal', () => {
  const document = fixture(`<a href="${STATUS}">post</a><img src="${STILL_A}">
    <div data-testid="quoteTweet"><a href="/quoted/status/222/video/1"><video></video></a></div>
    <a href="${STATUS}/photo/1"><div data-testid="videoPlayer"><video id="outer"></video></div></a>`);
  const candidate = LakomicsXSource.findCandidate(document.querySelector('#outer'));
  assert.equal(candidate.overallMediaIndex, 2);
  assert.equal(candidate.postId, '2100596455262331116');
  assert.equal(candidate.sourceUrl, `${STATUS}/video/2`);
});

test('an invalid ordinal fails instead of capturing a different media', async () => {
  stubChrome();
  const saved = [];
  const originalRequest = globalThis.LakomicsListApi.request;
  globalThis.LakomicsListApi.request = async (path, options) => {
    saved.push(options.body);
    return {ok: true, status: 200, data: {created: true, capture: {id: 'c1', status: 'pending'}}};
  };
  const restore = mediaEndpoint([photo(), realVideo()]);
  try {
    // Ordinal 3 of a 2-media tweet, and video-only ordinal 2 of a 1-video tweet.
    for (const override of [{overallMediaIndex: 3}, {mediaIndex: 2}]) {
      const candidate = await globalThis.LakomicsSaveClient.resolveXVideoCandidate(candidateFor(override));
      assert.equal(candidate.mediaUrl, null, JSON.stringify(override));
      const result = await globalThis.LakomicsSaveClient.save({
        candidate: candidateFor(override), classificationId: 'games',
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'video_unavailable');
    }
    assert.equal(saved.length, 0);
  } finally {
    restore();
    globalThis.LakomicsListApi.request = originalRequest;
  }
});

test('an animated original already mounted needs no public lookup', async () => {
  stubChrome();
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not be called'); };
  const originalRequest = globalThis.LakomicsListApi.request;
  const sent = [];
  globalThis.LakomicsListApi.request = async (path, options) => {
    sent.push(options.body);
    return {ok: true, status: 200, data: {created: true, capture: {id: 'c1', status: 'pending'}}};
  };
  try {
    const result = await globalThis.LakomicsSaveClient.save({
      candidate: candidateFor({mediaUrl: ANIMATED_MP4}), classificationId: 'games',
    });
    assert.equal(result.ok, true);
    assert.equal(called, false);
    assert.equal(sent[0].media_url, ANIMATED_MP4);
  } finally {
    globalThis.fetch = original;
    globalThis.LakomicsListApi.request = originalRequest;
  }
});

test('real .gif bytes keep animated_gif and an MP4 payload never claims it', () => {
  const save = globalThis.LakomicsSaveClient;
  assert.equal(save.mediaType({type: 'image', mediaUrl: 'https://pbs.twimg.com/media/ABCD.gif'}), 'animated_gif');
  assert.equal(save.mediaType({type: 'image', filename: 'animation.gif', mediaUrl: 'https://example.com/download?id=1'}), 'animated_gif');
  assert.equal(save.mediaType({type: 'image', mediaUrl: 'https://pbs.twimg.com/media/A?format=gif&name=orig'}), 'animated_gif');
  assert.equal(save.mediaType({type: 'video', mediaUrl: ANIMATED_MP4, animatedMedia: true}), 'video');
  assert.equal(save.mediaType({type: 'video', mediaUrl: VIDEO_MP4}), 'video');
});

test('a video payload is never sent as animated_gif', async () => {
  stubChrome();
  const originalRequest = globalThis.LakomicsListApi.request;
  const sent = [];
  globalThis.LakomicsListApi.request = async (path, options) => {
    sent.push(options.body);
    return {ok: true, status: 200, data: {created: true, capture: {id: 'c1', status: 'pending'}}};
  };
  const restore = mediaEndpoint([photo(), animated()]);
  try {
    const result = await globalThis.LakomicsSaveClient.save({
      candidate: candidateFor({overallMediaIndex: 2, sourceUrl: `${STATUS}/video/2`}),
      classificationId: 'games',
    });
    assert.equal(result.ok, true);
    assert.equal(sent[0].media_type, 'video');
    assert.equal(sent[0].media_url, ANIMATED_MP4);
    assert.equal(sent.some((payload) => payload.media_type === 'animated_gif'), false);
  } finally {
    restore();
    globalThis.LakomicsListApi.request = originalRequest;
  }
});

test('temporary save downloads only a validated progressive MP4', async t => {
  t.after(mediaEndpoint([]));
  const {calls, send: send2} = await backgroundFixture();

  const animatedResult = await send2({type: 'collector:temporary', candidate: candidateFor({mediaUrl: ANIMATED_MP4})});
  assert.equal(animatedResult.ok, true);
  assert.equal(calls[0].url, ANIMATED_MP4);

  const videoResult = await send2({type: 'collector:temporary', candidate: candidateFor({mediaUrl: VIDEO_MP4})});
  assert.equal(videoResult.ok, true);
  assert.equal(calls[1].url, VIDEO_MP4);

  for (const mediaUrl of [VIDEO_MANIFEST, ANIMATED_MANIFEST, VIDEO_MP4_HASH, ANIMATED_TS, POSTER]) {
    const result = await send2({type: 'collector:temporary', candidate: candidateFor({mediaUrl})});
    assert.equal(result.ok, false, mediaUrl);
    assert.equal(result.code, 'media_unsupported', mediaUrl);
  }

  const foreign = await send2({type: 'collector:temporary', candidate: {
    type: 'video', source: 'web', mediaUrl: null, sourceUrl: 'https://blog.example.com/post/1',
  }});
  assert.equal(foreign.ok, false);
  assert.equal(foreign.code, 'media_unsupported');
  assert.equal(calls.length, 2);
});

test('temporary save resolves an unknown video candidate before download', async () => {
  stubChrome();
  const restore = mediaEndpoint([photo(), animated()]);
  try {
    const {calls, send} = await backgroundFixture();
    const result = await send({type: 'collector:temporary', candidate: candidateFor({overallMediaIndex: 2})});
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, ANIMATED_MP4);
  } finally { restore(); }
});
