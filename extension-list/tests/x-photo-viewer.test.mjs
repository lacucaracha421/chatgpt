import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../../_tools/app/node_modules/jsdom/lib/api.js';
await import('../src/x-source.js');
await import('../src/api-client.js');
await import('../src/save-client.js');

const status = 'https://x.com/artist/status/222';
const publishedAt = '2026-10-17T01:00:00Z';
const image = name => `https://pbs.twimg.com/media/${name}?format=jpg&name=small`;
const source = globalThis.LakomicsXSource;

function viewer() {
  const dom = new JSDOM(`<body>
    <article><a href="/behind/status/111/photo/1"><img src="${image('behind')}"></a></article>
    <div role="dialog"><img id="slide" src="${image('second')}">
      <article><a href="/reply/status/333"><time datetime="2026-10-17T03:00:00Z"></time></a>
        <a href="${status}">Replying to the original post</a></article>
      <article><a href="${status}"><time datetime="${publishedAt}"></time></a>
        <a href="${status}/photo/2"><img id="thumbnail" src="${image('second')}"></a></article>
    </div></body>`, {url: `${status}/photo/2`});
  return {dom, slide: dom.window.document.querySelector('#slide'), doc: dom.window.document};
}

test('modal and normal tweet images yield identical save candidates and capture payloads', async () => {
  const f = viewer();
  const request = globalThis.LakomicsListApi.request;
  const chrome = globalThis.chrome;
  const bodies = [];
  globalThis.chrome = {storage: {local: {get: async () => ({}), set: async () => {}}}};
  globalThis.LakomicsListApi.request = async (path, options) => {
    assert.equal(path, '/v1/captures');
    bodies.push(options.body);
    return {ok: true, data: {created: true, capture: {status: 'pending'}}};
  };
  try {
    const modal = source.findCandidate(f.slide);
    const normal = source.findCandidate(f.doc.querySelector('#thumbnail'));
    assert.ok(modal);
    for (const key of ['source', 'type', 'sourceUrl', 'mediaUrl', 'author', 'postId', 'mediaIndex', 'publishedAt']) {
      assert.equal(modal[key], normal[key], key);
    }
    for (const candidate of [modal, normal]) {
      const result = await globalThis.LakomicsSaveClient.save({candidate, classificationId: 'art'});
      assert.equal(result.ok, true);
      assert.equal(result.status, 'captured');
    }
    for (const body of bodies) {
      assert.equal(body.source_url, `${status}/photo/2`);
      assert.equal(body.media_url, 'https://pbs.twimg.com/media/second?format=jpg&name=orig');
      assert.equal(body.published_at, publishedAt);
      assert.equal(body.classification_id, 'art');
      assert.equal(body.source, 'x');
      assert.equal(body.media_type, 'image');
      assert.ok(body.save_intent.request_id);
      assert.ok(Number.isFinite(Date.parse(body.save_intent.requested_at)));
    }
    assert.notEqual(bodies[0].save_intent.request_id, bodies[1].save_intent.request_id);
  } finally {
    globalThis.LakomicsListApi.request = request;
    globalThis.chrome = chrome;
    f.dom.window.close();
  }
});

test('viewer navigation uses the current original image and route ordinal even with a single mounted slide', () => {
  const f = viewer();
  try {
    for (const n of [2, 3, 1]) {
      f.dom.window.history.replaceState(null, '', `${status}/photo/${n}`);
      f.slide.src = image(`photo${n}`);
      const candidate = source.findCandidate(f.slide);
      assert.equal(candidate.mediaIndex, n);
      assert.equal(candidate.sourceUrl, `${status}/photo/${n}`);
      assert.equal(candidate.mediaUrl, `https://pbs.twimg.com/media/photo${n}?format=jpg&name=orig`);
      assert.equal(candidate.publishedAt, publishedAt);
    }
  } finally { f.dom.window.close(); }
});

test('reply images retain their own post and the viewer never borrows a different post timestamp', () => {
  const f = viewer();
  try {
    const reply = f.doc.querySelector('a[href="/reply/status/333"]');
    reply.insertAdjacentHTML('beforeend', `<img src="${image('reply')}">`);
    const candidate = source.findCandidate(reply.querySelector('img'));
    assert.equal(candidate.postId, '333');
    assert.equal(candidate.sourceUrl, 'https://x.com/reply/status/333/photo/1');
    f.doc.querySelector(`time[datetime="${publishedAt}"]`).closest('a').remove();
    assert.equal(source.findCandidate(f.slide).publishedAt, null);
    f.doc.body.append(f.slide);
    assert.equal(source.findCandidate(f.slide), null, 'the route alone cannot attribute images outside the viewer');
  } finally { f.dom.window.close(); }
});
