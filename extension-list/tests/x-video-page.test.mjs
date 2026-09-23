import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';

const pageSource = await readFile(new URL('../src/x-video-page.js', import.meta.url), 'utf8');
const clientSource = await readFile(new URL('../src/x-video-client.js', import.meta.url), 'utf8');
const saveSource = await readFile(new URL('../src/save-client.js', import.meta.url), 'utf8');
const ID = '2101939591297294668', QUOTE_ID = '2101939591297294669';
const LOW = 'https://video.twimg.com/amplify_video/123/vid/480x854/low.mp4';
const HIGH = 'https://video.twimg.com/amplify_video/123/vid/1080x1920/high.mp4?tag=14';
const ENDPOINT = 'https://x.com/i/api/graphql/query/TweetDetail';
const candidate = { source: 'x', type: 'video', postId: ID, overallMediaIndex: 1, mediaIndex: 1,
  sourceUrl: 'https://x.com/AniGodoyG/status/' + ID + '/video/1', mediaUrl: null };
const variant = (url, bitrate = 1000, content_type = 'video/mp4') => ({ url, bitrate, content_type });
const video = (variants = [variant(HIGH)]) => ({ type: 'video', video_info: { variants } });
const tweet = (id, media) => ({ __typename: 'Tweet', rest_id: id,
  legacy: { id_str: id, full_text: 'Do not expose tweet text or credentials', extended_entities: { media } } });
const windows = [];
afterEach(() => { for (const w of windows) w.close(); windows.length = 0; });
function fixture({ page = true, fetchFn } = {}) {
  const w = new JSDOM('<body></body>', { url: 'https://x.com/AniGodoyG/status/' + ID, runScripts: 'outside-only' }).window;
  windows.push(w);
  w.__LAKOMICS_TEST__ = true;
  class XHR extends w.EventTarget {
    open(...args) { this.openArgs = args; return 'opened'; }
    respond(body, { url = ENDPOINT, type = 'text', status = 200 } = {}) {
      this.responseURL = url; this.responseType = type; this.status = status;
      this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      this.response = type === 'json' ? body : this.responseText;
      this.dispatchEvent(new w.Event('load'));
    }
  }
  w.XMLHttpRequest = XHR;
  w.fetch = fetchFn || (() => { throw new Error('No unsolicited request allowed'); });
  if (page) w.eval(pageSource);
  w.eval(clientSource);
  return w;
}
function ingest(w, body) { w.LakomicsXVideoPage.ingestText(JSON.stringify(body)); }
function response(body, url = ENDPOINT) {
  const value = new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  Object.defineProperty(value, 'url', { value: url });
  return value;
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 5)); }

test('page metadata retains all-media ordinals and chooses only the highest bitrate progressive MP4', async () => {
  const w = fixture();
  ingest(w, { data: { tweetResult: { result: tweet(ID, [{ type: 'photo' }, video([
    variant(LOW, 500), variant(HIGH, 2000),
    variant('https://video.twimg.com/123/pl/video.m3u8', 9000, 'application/x-mpegURL'),
  ])]) } } });
  assert.equal(w.LakomicsXVideoPage.lookup(ID, 1), null);
  assert.equal(w.LakomicsXVideoPage.lookup(ID, 2), HIGH);
  assert.equal(w.LakomicsXVideoPage.lookup(ID, 3), null);
  const selected = { ...candidate, overallMediaIndex: 2, mediaIndex: 2, sourceUrl: candidate.sourceUrl.replace('/video/1', '/video/2') };
  assert.equal((await w.LakomicsXVideo.resolve(selected)).mediaUrl, HIGH);
  assert.equal((await w.LakomicsXVideo.resolve(candidate)).mediaUrl, null);
});

test('nested quote and visibility results keep their own exact post identity', async () => {
  const w = fixture();
  const outer = tweet(ID, [video([variant(LOW)])]);
  outer.quoted_status_result = { result: { __typename: 'TweetWithVisibilityResults', tweet: tweet(QUOTE_ID, [video()]) } };
  ingest(w, { data: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: outer } } } }] }] } });
  assert.equal(w.LakomicsXVideoPage.lookup(ID, 1), LOW);
  assert.equal(w.LakomicsXVideoPage.lookup(QUOTE_ID, 1), HIGH);
  assert.equal((await w.LakomicsXVideo.resolve(candidate)).mediaUrl, LOW);
});

test('conflicting identity and unavailable earlier variants never shift selection', () => {
  const w = fixture();
  const mismatch = tweet(ID, [video()]); mismatch.legacy.id_str = QUOTE_ID;
  ingest(w, mismatch);
  assert.equal(w.LakomicsXVideoPage.lookup(ID, 1), null);
  ingest(w, tweet(ID, [{ type: 'video', video_info: { variants: [variant('https://video.twimg.com/1/pl/a.m3u8', 1, 'application/x-mpegURL')] } }, video([variant(LOW)])]));
  assert.equal(w.LakomicsXVideoPage.lookup(ID, 1), null);
  assert.equal(w.LakomicsXVideoPage.lookup(ID, 2), LOW);
});

test('a quoted post whose video was re-shared from another post resolves at its own ordinal', async () => {
  const w = fixture();
  const outer = tweet(ID, [video([variant(LOW)])]);
  outer.quoted_status_result = { result: tweet(QUOTE_ID, [{ ...video(), source_status_id_str: '1999999999999999999' }]) };
  ingest(w, { data: { tweetResult: { result: outer } } });
  assert.equal(w.LakomicsXVideoPage.lookup(QUOTE_ID, 1), HIGH);
  const quoted = { ...candidate, postId: QUOTE_ID, sourceUrl: 'https://x.com/quoted/status/' + QUOTE_ID + '/video/1' };
  assert.equal((await w.LakomicsXVideo.resolve(quoted)).mediaUrl, HIGH);
});

test('a quoted post deep inside a reply-heavy response is still found', () => {
  const w = fixture();
  const replies = Array.from({ length: 400 }, (_, i) => ({ content: { itemContent: { tweet_results: { result: {
    ...tweet(String(3000000000000000000n + BigInt(i)), [{ type: 'photo' }]),
    core: { user_results: { result: { legacy: Object.fromEntries(Array.from({ length: 60 }, (_, k) => ['field' + k, { value: k }])) } } } } } } } }));
  const outer = tweet(ID, [{ type: 'photo' }]);
  outer.quoted_status_result = { result: tweet(QUOTE_ID, [video()]) };
  const body = { data: { threaded_conversation_with_injections_v2: { instructions: [{ entries: [
    { content: { itemContent: { tweet_results: { result: outer } } } }, ...replies] }] } } };
  ingest(w, body);
  assert.equal(w.LakomicsXVideoPage.lookup(QUOTE_ID, 1), HIGH);
});

test('unsafe, manifest and still-image URLs cannot become a page video', () => {
  const w = fixture();
  const urls = ['https://evil.test/video.mp4', 'http://video.twimg.com/video.mp4',
    'https://user:secret@video.twimg.com/video.mp4', HIGH + '#fragment',
    'https://video.twimg.com/video.m3u8', 'https://pbs.twimg.com/poster.jpg'];
  ingest(w, tweet(ID, urls.map(url => video([variant(url)]))));
  for (let i = 1; i <= urls.length; i++) assert.equal(w.LakomicsXVideoPage.lookup(ID, i), null);
});

test('metadata parsing and retained post count are bounded; malformed input does not break the page', () => {
  const w = fixture();
  w.LakomicsXVideoPage.ingestText('not json');
  w.LakomicsXVideoPage.ingestText(' '.repeat(2_000_001));
  for (let i = 1; i <= 201; i++) ingest(w, tweet(String(i), [video()]));
  assert.equal(w.LakomicsXVideoPage.lookup('1', 1), null);
  assert.equal(w.LakomicsXVideoPage.lookup('201', 1), HIGH);
  assert.equal(w.LakomicsXVideoPage.lookup('201', 0), null);
  assert.equal(w.LakomicsXVideoPage.lookup('201', 17), null);
});

test('fetch observation preserves the original promise and body and makes no additional requests', async () => {
  let requests = 0;
  const body = { data: { tweetResult: { result: tweet(ID, [video()]) } } };
  const originalResponse = response(body), pending = Promise.resolve(originalResponse);
  const w = fixture({ fetchFn(...args) { requests++; assert.deepEqual(args, [ENDPOINT]); return pending; } });
  assert.equal(w.fetch(ENDPOINT), pending);
  await settle();
  assert.equal(originalResponse.bodyUsed, false);
  assert.deepEqual(await originalResponse.json(), body);
  assert.equal(w.LakomicsXVideoPage.lookup(ID, 1), HIGH);
  assert.equal(requests, 1);
});

test('fetch ignores other origins, non-GraphQL responses, oversized and failed responses', async () => {
  for (const url of ['https://other.test/i/api/graphql/query/TweetDetail', 'https://x.com/settings']) {
    const w = fixture({ fetchFn: () => Promise.resolve(response(tweet(ID, [video()]), url)) });
    await w.fetch(url); await settle();
    assert.equal(w.LakomicsXVideoPage.lookup(ID, 1), null);
  }
  for (const value of [
    { ok: false, url: ENDPOINT, headers: new Headers() },
    { ok: true, url: ENDPOINT, headers: new Headers({ 'content-length': '2000001' }) },
  ]) {
    value.clone = () => { throw new Error('Must not clone this body'); };
    const w = fixture({ fetchFn: () => Promise.resolve(value) });
    await w.fetch(ENDPOINT); await settle();
    assert.equal(w.LakomicsXVideoPage.lookup(ID, 1), null);
  }
});

test('XHR observation handles text and JSON responses and does not confuse a reused request', () => {
  const w = fixture(), xhr = new w.XMLHttpRequest();
  assert.equal(xhr.open('GET', ENDPOINT), 'opened');
  xhr.respond({ data: tweet(ID, [video()]) });
  assert.equal(w.LakomicsXVideoPage.lookup(ID, 1), HIGH);
  xhr.open('GET', ENDPOINT);
  xhr.respond({ data: tweet(QUOTE_ID, [video([variant(LOW)])]) }, { type: 'json' });
  assert.equal(w.LakomicsXVideoPage.lookup(QUOTE_ID, 1), LOW);
  xhr.open('GET', 'https://other.test/');
  xhr.respond(tweet('999', [video()]), { url: 'https://other.test/i/api/graphql/query/TweetDetail' });
  assert.equal(w.LakomicsXVideoPage.lookup('999', 1), null);
});

test('bridge emits only the requested identity and URL, not the raw tweet or credentials', async () => {
  const w = fixture(); ingest(w, tweet(ID, [video()]));
  let reply;
  w.document.addEventListener('lakomics:x-video:response', event => { reply = JSON.parse(event.detail); });
  const result = await w.LakomicsXVideo.resolve(candidate);
  assert.equal(result.mediaUrl, HIGH);
  assert.deepEqual(Object.keys(reply).sort(), ['mediaIndex', 'mediaUrl', 'postId', 'requestId']);
  assert.equal(JSON.stringify(reply).includes('credentials'), false);
});

test('client rejects conflicting source identity and ignores mismatched bridge responses', async () => {
  const w = fixture({ page: false }); let requests = 0;
  w.document.addEventListener('lakomics:x-video:request', event => {
    requests++;
    const request = JSON.parse(event.detail);
    const reply = fields => w.document.dispatchEvent(new w.CustomEvent('lakomics:x-video:response', { detail: JSON.stringify({ ...request, mediaUrl: HIGH, ...fields }) }));
    reply({ postId: QUOTE_ID, mediaUrl: LOW });
    reply({ mediaIndex: 2, mediaUrl: LOW });
    reply({ requestId: 'wrong', mediaUrl: LOW });
    reply({});
  });
  const wrong = { ...candidate, sourceUrl: candidate.sourceUrl.replace(ID, QUOTE_ID) };
  assert.equal(await w.LakomicsXVideo.resolve(wrong), wrong);
  assert.equal(requests, 0);
  assert.equal((await w.LakomicsXVideo.resolve(candidate)).mediaUrl, HIGH);
  assert.equal(requests, 1);
});

test('client validates bridge URLs and falls back unchanged when the page bridge is absent', async () => {
  const w = fixture({ page: false });
  const unsafe = event => {
    const request = JSON.parse(event.detail);
    w.document.dispatchEvent(new w.CustomEvent('lakomics:x-video:response', { detail: JSON.stringify({ ...request, mediaUrl: 'https://evil.test/file.mp4' }) }));
  };
  w.document.addEventListener('lakomics:x-video:request', unsafe);
  assert.equal(await w.LakomicsXVideo.resolve(candidate), candidate);
  w.document.removeEventListener('lakomics:x-video:request', unsafe);
  assert.equal(await w.LakomicsXVideo.resolve(candidate), candidate);
  assert.equal(await w.LakomicsXVideo.resolve({ ...candidate, mediaUrl: HIGH }).then(result => result.mediaUrl), HIGH);
});

test('page metadata supplies the selected MP4 when anonymous syndication returns a tombstone', async () => {
  const w = fixture(); ingest(w, { data: { tweetResult: { result: tweet(ID, [video()]) } } });
  let publicRequests = 0, capture;
  const ctx = vm.createContext({ URL, URLSearchParams, AbortSignal,
    chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
    fetch: async () => { publicRequests++; return { ok: true, json: async () => ({ __typename: 'TweetTombstone', tombstone: {} }) }; },
    LakomicsListApi: { request: async (_path, options) => { capture = options.body; return { ok: true, data: { created: true, capture: { status: 'pending' } } }; } },
  });
  vm.runInContext(saveSource, ctx);
  assert.equal((await ctx.LakomicsSaveClient.save({ candidate, classificationId: 'games' })).code, 'video_public_unavailable');
  const resolved = await w.LakomicsXVideo.resolve(candidate);
  const result = await ctx.LakomicsSaveClient.save({ candidate: resolved, classificationId: 'games' });
  assert.equal(result.ok, true);
  assert.equal(publicRequests, 1, 'the page-resolved save must not call anonymous syndication again');
  assert.equal(capture.media_url, HIGH);
  assert.equal(capture.source_url, candidate.sourceUrl);
  assert.equal(capture.media_type, 'video');
});
