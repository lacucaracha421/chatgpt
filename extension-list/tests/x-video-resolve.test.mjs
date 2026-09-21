import test from 'node:test';
import assert from 'node:assert/strict';
await import('../src/api-client.js');
await import('../src/save-client.js');

const candidate = {
  type: 'video', source: 'x', mediaUrl: null,
  sourceUrl: 'https://x.com/AniGodoyG/status/2101939591297294668/video/1',
  postId: '2101939591297294668', mediaIndex: 1, overallMediaIndex: 1,
};

// The public endpoint returned this exact shape for the reported post. It carries
// no media or reason, so it cannot establish deletion or a particular access gate.
test('a public tombstone reports unavailable public metadata without submitting a capture', async () => {
  const originalFetch = globalThis.fetch, originalRequest = globalThis.LakomicsListApi.request;
  let requests = 0, captures = 0;
  globalThis.fetch = async url => {
    requests++;
    assert.equal(new URL(url).searchParams.get('id'), candidate.postId);
    return { ok: true, json: async () => ({ __typename: 'TweetTombstone', tombstone: {} }) };
  };
  globalThis.LakomicsListApi.request = async () => { captures++; throw new Error('Unexpected capture'); };
  try {
    const result = await globalThis.LakomicsSaveClient.save({ candidate, classificationId: 'games' });
    assert.deepEqual(result, { ok: false, code: 'video_public_unavailable' });
    assert.equal(requests, 1);
    assert.equal(captures, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.LakomicsListApi.request = originalRequest;
  }
});

test('a mounted progressive MP4 remains usable without the public lookup', async () => {
  const originalFetch = globalThis.fetch;
  let lookups = 0;
  globalThis.fetch = async () => { lookups++; throw new Error('Public lookup must not be needed'); };
  const mounted = { ...candidate, mediaUrl: 'https://video.twimg.com/amplify_video/123/vid/clip.mp4' };
  try {
    const resolved = await globalThis.LakomicsSaveClient.resolveXVideoCandidate(mounted);
    assert.equal(resolved.mediaUrl, mounted.mediaUrl);
    assert.equal(lookups, 0);
  } finally { globalThis.fetch = originalFetch; }
});
