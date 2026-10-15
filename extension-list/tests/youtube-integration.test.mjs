import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from '../../_tools/app/node_modules/jsdom/lib/api.js';
import { loadWorker, buildRequestBody, buildGlossaryBody, callChunk, createResumeRecord, matchesResumeRecord, mergeTerms, buildChunkPrompt } from './helpers/youtube-classic.mjs';

const apiSource = await readFile(new URL('../src/api-client.js', import.meta.url), 'utf8');
const contentSource = await readFile(new URL('../src/youtube/content.js', import.meta.url), 'utf8');
const optionsSource = await readFile(new URL('../options/options.js', import.meta.url), 'utf8');
const optionsHtml = await readFile(new URL('../options/options.html', import.meta.url), 'utf8');
const TOKEN = 'paired-token-that-must-stay-in-the-worker';
const KEY = 'anthropic-key-that-must-stay-in-the-worker';
const PAGE = { id: 'test', frameId: 0, url: 'https://www.youtube.com/watch?v=video12', tab: { id: 1 } };
const OPTIONS = { id: 'test', frameId: 0, url: 'chrome-extension://test/options/options.html' };
const request = { type: 'youtube:process', videoId: 'video12', trackKey: 'en:asr',
  json3: { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Jeff' }] }] } };
const entry = () => ({ version: 1, video: 'video12', track: 'en:asr', mode: 'translate-ko-auto+t6',
  model: 'claude-haiku-5-5', createdAt: 123, register: 'haeyo', glossary: [],
  cues: [{ startMs: 0, endMs: 1000, text: '제프', orig: 'Jeff' }] });
const response = (status, data) => ({ status, ok: status === 200, json: async () => data });
const apiResponse = body => response(200, { content: [{ type: 'text', text: JSON.stringify(
  body.output_config.format.schema.required.includes('terms') ? { register: 'haeyo', terms: [] }
    : { register: 'haeyo', lines: [{ from: 0, to: 0, text: '제프' }] }) }], usage: {} });
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t, { paired = true } = {}) {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => Object.assign(globalThis, original));
  const stored = { 'lakomics:translation:v1': { anthropicApiKey: KEY, userTerms: [{ source: 'Jeff', korean: '제프' }], dictionaryRevision: 0 },
    ...(paired ? { 'lakomics:list:connection': { origin: 'https://server.test', token: TOKEN, clientId: 'client', pairedAt: 1, connectionId: 'pair-1' } } : {}) };
  const delivered = [];
  globalThis.chrome = { storage: { local: {
    get: async keys => structuredClone(keys === null ? stored : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]]))),
    set: async values => Object.assign(stored, structuredClone(values)),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; },
  } }, runtime: { id: 'test', getURL: path => 'chrome-extension://test/' + path,
    onMessage: { addListener() {} }, getPlatformInfo() {} },
    tabs: { sendMessage: async (_id, message) => delivered.push(structuredClone(message)) } };
  const service = loadWorker();
  vm.runInThisContext(apiSource);
  const calls = [];
  let serve = async (url, init) => url.startsWith('https://api.anthropic.com/')
    ? apiResponse(JSON.parse(init.body)) : response(404, { code: 'not_found' });
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return serve(url, init); };
  return { stored, calls, delivered, service, serve: fn => { serve = fn; },
    send: (message, sender = PAGE) => service.handle(message, sender) };
}

test('manifest registers only YouTube MAIN/start hook and isolated/idle UI without changing version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('unlimitedStorage'));
  assert.equal(manifest.version, '3.5.49');
  assert.equal(manifest.background.type, undefined);
  const hook = manifest.content_scripts.find(item => item.js?.includes('src/youtube/page-hook.js'));
  const ui = manifest.content_scripts.find(item => item.js?.includes('src/youtube/content.js'));
  assert.deepEqual(hook.matches, ['https://www.youtube.com/*', 'https://m.youtube.com/*']);
  assert.deepEqual(ui.matches, hook.matches);
  assert.equal(hook.world, 'MAIN'); assert.equal(hook.run_at, 'document_start');
  assert.notEqual(ui.world, 'MAIN'); assert.equal(ui.run_at, 'document_idle');
  assert.deepEqual(ui.css, ['src/youtube/content.css']);
  // Evaluate the actual classic entrypoint/importScripts graph, not only the test loader.
  const sources = new Map();
  const worker = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
  for (const [, file] of worker.split('\n')[0].matchAll(/"([^"]+)"/g))
    sources.set(file, await readFile(new URL('../src/' + file, import.meta.url), 'utf8'));
  const context = vm.createContext({ URL, console, setTimeout, clearTimeout, AbortController,
    chrome: { runtime: { onMessage: { addListener() {} } } } });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(sources.get(file), context));
  vm.runInContext(worker, context);
  assert.equal(typeof context.LakomicsYouTubeService.handle, 'function');
  assert.equal(typeof context.LakomicsTranslation.handle, 'function');
});

test('local miss GET precedes Anthropic, complete local write precedes PUT, upload retries once', async t => {
  const h = setup(t); let puts = 0;
  h.serve(async (url, init) => {
    if (url.startsWith('https://api.anthropic.com/')) return apiResponse(JSON.parse(init.body));
    if (init.method === 'PUT') {
      assert.ok(h.stored['lakomics:youtube:subs:v2:video12:en:asr:translate-ko-auto+t6']);
      assert.equal(JSON.parse(init.body).version, undefined);
      return response(++puts === 1 ? 503 : 200, { ok: true });
    }
    return response(404, { code: 'not_found' });
  });
  const result = await h.send(request); await tick();
  assert.equal(result.ok, true);
  assert.match(h.calls[0].url, /\/v1\/extension\/subtitles\?video=video12&track=en%3Aasr&mode=translate-ko-auto%2Bt6$/);
  assert.equal(h.calls[0].init.headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(puts, 2);
  assert.equal(h.calls.filter(call => call.url.startsWith('https://api.anthropic.com/')).length, 2);
  assert.doesNotMatch(JSON.stringify([result, h.delivered]), new RegExp(TOKEN + '|' + KEY));
  h.calls.length = 0;
  assert.equal((await h.send(request)).cached, true);
  assert.equal(h.calls.length, 0);
});

test('valid server result is stored and shown before requiring an API key, extra server fields stay private', async t => {
  const h = setup(t);
  delete h.stored['lakomics:translation:v1'].anthropicApiKey;
  h.serve(async () => response(200, { ...entry(), token: TOKEN, apiKey: KEY }));
  const result = await h.send(request);
  assert.equal(result.cached, true); assert.equal(result.cues[0].text, '제프');
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(JSON.stringify([result, await h.send({ type: 'youtube:getCached', videoId: 'video12' })]), new RegExp(TOKEN + '|' + KEY));
  assert.equal(h.stored['lakomics:youtube:subs:v2:video12:en:asr:translate-ko-auto+t6'].token, undefined);
});

for (const failure of ['offline', 404, 401, 403, 500, 201, 'invalid']) {
  test(`server ${failure} behaves like local-only`, async t => {
    const h = setup(t);
    h.serve(async (url, init) => {
      if (url.startsWith('https://api.anthropic.com/')) return apiResponse(JSON.parse(init.body));
      if (init.method === 'PUT') return response(200, { ok: true });
      if (failure === 'offline') throw new Error('network unavailable');
      return response(failure === 'invalid' ? 200 : failure,
        failure === 'invalid' ? { ...entry(), video: 'different' } : { code: 'not_found' });
    });
    assert.equal((await h.send(request)).ok, true);
    await tick();
    assert.equal(h.calls.filter(call => call.url.startsWith('https://api.anthropic.com/')).length, 2);
  });
}

test('unpaired skips server, partial failures never PUT and resumed completion does', async t => {
  const h = setup(t, { paired: false });
  assert.equal((await h.send(request)).ok, true);
  assert.ok(h.calls.every(call => call.url.startsWith('https://api.anthropic.com/')));
  h.stored['lakomics:list:connection'] = { origin: 'https://server.test', token: TOKEN, connectionId: 'pair-1' };
  let fail = true;
  h.serve(async (url, init) => {
    if (!url.startsWith('https://api.anthropic.com/')) return response(init.method === 'PUT' ? 200 : 404, { ok: true });
    const body = JSON.parse(init.body);
    if (fail && body.messages[0].content.includes('0\tw200')) return response(400, { error: { message: 'private' } });
    if (body.output_config.format.schema.required.includes('terms')) return apiResponse(body);
    const count = body.messages[0].content.split('\n').filter(line => /^\d+\t/.test(line)).length;
    return response(200, { content: [{ type: 'text', text: JSON.stringify({ register: 'haeyo', lines: [{ from: 0, to: count - 1, text: '번역' }] }) }], usage: {} });
  });
  const long = { ...request, videoId: 'longvid', json3: { events: [{ tStartMs: 0, dDurationMs: 135000,
    segs: Array.from({ length: 450 }, (_, i) => ({ utf8: 'w' + i, tOffsetMs: i * 300 })) }] } };
  h.calls.length = 0;
  assert.equal((await h.send(long)).partialFailure, true); await tick();
  assert.equal(h.calls.filter(call => call.init.method === 'PUT').length, 0);
  fail = false;
  assert.equal((await h.send(long)).ok, true); await tick();
  const put = h.calls.find(call => call.init.method === 'PUT'); assert.ok(put);
  assert.ok(JSON.parse(put.init.body).cues.every(cue => Number.isInteger(cue.startMs) && Number.isInteger(cue.endMs)));
});

test('sender checks protect settings and clear operations; malformed processing never reaches fetch', async t => {
  const h = setup(t);
  for (const type of ['youtube:update', 'youtube:clearCache', 'youtube:clearServerCache']) {
    assert.equal((await h.send({ type, patch: { enabled: false } })).code, 'forbidden_sender');
    assert.equal((await h.send({ type }, { ...OPTIONS, id: 'wrong' })).code, 'forbidden_sender');
    assert.equal((await h.send({ type }, { ...OPTIONS, frameId: 1 })).code, 'forbidden_sender');
  }
  for (const value of [{ ...request, videoId: '../bad' }, { ...request, trackKey: 'a:b:c' },
    { ...request, json3: 'x'.repeat(5 * 1024 * 1024 + 1) },
    { ...request, json3: { events: [{ tStartMs: -1, segs: [{ utf8: 'text' }] }] } }])
    assert.equal((await h.send(value)).code, 'invalid_request');
  assert.equal((await h.send(request, { ...PAGE, url: 'https://evil.test/' })).code, 'forbidden_sender');
  assert.equal(h.calls.length, 0);
  const safe = await h.send({ type: 'youtube:settings' });
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(TOKEN + '|' + KEY));
  assert.equal((await h.send({ type: 'youtube:update', patch: { enabled: false } },
    { id: 'test', url: OPTIONS.url })).ok, true, 'options senders may omit frameId');
});

test('server cache validates the shared contract bounds and removes unknown fields', () => {
  const validate = globalThis.LakomicsYouTube.serverCache.validate;
  assert.ok(validate(entry()));
  for (const change of [{ version: 2 }, { track: 'x'.repeat(41) + ':asr' }, { mode: 'bad\nmode' },
    { model: 'm'.repeat(81) }, { register: 'auto' }, { cues: [] },
    { glossary: Array(241).fill({ source: 'a', korean: 'b' }) },
    { cues: [{ startMs: 0, endMs: 1.5, text: 'text' }] },
    { cues: [{ startMs: 2, endMs: 1, text: 'text' }] },
    { cues: [{ startMs: 0, endMs: 1, text: 't'.repeat(501) }] },
    { cues: [{ startMs: 0, endMs: 1, text: 'text', orig: 't'.repeat(501) }] }])
    assert.equal(validate({ ...entry(), ...change }), null);
  assert.equal(validate({ ...entry(), cues: Array(5000).fill({ startMs: 0, endMs: 1, text: '가'.repeat(500) }) }), null);
  assert.equal(validate({ ...entry(), token: TOKEN }).token, undefined);
});

test('clearing both caches deletes the paired library with worker auth and preserves X settings', async t => {
  const h = setup(t);
  h.stored['lakomics:youtube:subs:old'] = entry();
  h.serve(async () => response(200, { ok: true, deleted: 3 }));
  assert.deepEqual(await h.send({ type: 'youtube:clearServerCache' }, OPTIONS), { ok: true, deleted: 3 });
  assert.equal(h.calls[0].init.method, 'DELETE');
  assert.equal(h.calls[0].init.headers.authorization, 'Bearer ' + TOKEN);
  assert.equal(h.stored['lakomics:youtube:subs:old'], undefined);
  assert.equal(h.stored['lakomics:translation:v1'].anthropicApiKey, KEY);
});

test('local clear notifies open pages after data removal and valid prototype-like video IDs cache normally', async t => {
  const h = setup(t, { paired: false });
  for (const videoId of ['__proto__', 'constructor', 'toString']) {
    assert.equal((await h.send({ ...request, videoId })).ok, true);
    assert.ok((await h.send({ type: 'youtube:getCached', videoId })).cached);
  }
  const set = chrome.storage.local.set;
  let observed;
  chrome.storage.local.set = async values => {
    await set(values);
    if (Object.hasOwn(values, 'lakomics:youtube:cache:clearGeneration'))
      observed = await h.send({ type: 'youtube:getCached', videoId: 'constructor' });
  };
  await h.send({ type: 'youtube:clearCache' }, OPTIONS);
  assert.equal(observed.cached, null);
});

test('subtitle requests have their own global limit of eight and never call the X queue', async t => {
  const h = setup(t, { paired: false }); let active = 0, peak = 0;
  const pending = [];
  globalThis.LakomicsTranslation.handle = () => { throw new Error('X queue must not be used'); };
  h.serve(async (_url, init) => {
    active++; peak = Math.max(peak, active);
    return new Promise(resolve => pending.push(() => { active--; resolve(apiResponse(JSON.parse(init.body))); }));
  });
  const jobs = Array.from({ length: 12 }, () => callChunk('anthropic', { apiKey: KEY, model: 'claude-haiku-5-5', chunk: [{ text: 'Jeff' }] }));
  await tick(); assert.equal(pending.length, 8);
  pending.splice(0).forEach(resolve => resolve());
  await tick(); assert.equal(pending.length, 4);
  pending.splice(0).forEach(resolve => resolve());
  await Promise.all(jobs); assert.equal(peak, 8);
});

test('Haiku and Sonnet use existing Anthropic request conventions', () => {
  for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
    for (const build of [buildRequestBody, buildGlossaryBody]) {
      const body = build({ model, chunk: [], transcript: '' });
      assert.equal(body.thinking.type, model === 'claude-haiku-5-5' ? 'disabled' : 'between_tools');
      assert.equal(body.output_config.effort, 'low'); assert.equal(body.temperature, undefined);
    }
  }
});

test('full shared dictionary plus glossary remains prompt-safe and resumable beyond forty entries', () => {
  const glossary = mergeTerms(Array.from({ length: 40 }, (_, i) => ({ source: 'model' + i, korean: '용어' + i })),
    Array.from({ length: 200 }, (_, i) => ({ source: 'user' + i, korean: '내 용어' + i })));
  assert.equal(glossary.length, 240);
  const chunks = [[{ text: 'Jeff', startMs: 0, endMs: 1000 }]];
  const record = createResumeRecord(chunks, [], glossary, 'haeyo', 'en:asr');
  assert.equal(matchesResumeRecord(record, chunks, 'en:asr'), true);
  assert.match(buildChunkPrompt({ chunk: chunks[0], mode: 'translate-ko', glossary }).system, /user199/);
});

test('options save/load every YouTube field, share dictionary, and show server clearing only when paired', async t => {
  const h = setup(t);
  let paired = false;
  async function open() {
    const dom = new JSDOM(optionsHtml, { url: OPTIONS.url, runScripts: 'outside-only' });
    const w = dom.window;
    w.chrome = { runtime: { sendMessage: async message => {
      if (message.type.startsWith('youtube:')) return h.send(message, OPTIONS);
      if (message.type === 'settings:get') return { paired };
      return { ok: false };
    } } };
    w.eval(optionsSource); await tick();
    return dom;
  }
  const first = await open(); t.after(() => first.window.close());
  const doc = first.window.document;
  assert.equal(doc.getElementById('youtube-clear-server-row').hidden, true);
  const fields = { enabled: false, model: 'claude-sonnet-5-5', translate: false, register: 'banmal',
    speakers: true, glossarySonnet: true, fontScale: 1.3, position: 'raised', showOriginal: true, rolling: false, localAsr: false, speakerColors: false };
  for (const [key, value] of Object.entries(fields)) {
    const node = doc.getElementById('youtube-' + key);
    if (typeof value === 'boolean') node.checked = value; else node.value = String(value);
    node.dispatchEvent(new first.window.Event('change')); await tick();
  }
  assert.deepEqual((await h.send({ type: 'youtube:settings' }, OPTIONS)).settings, fields);
  assert.equal((await h.service.readSettings()).userTerms[0].source, 'Jeff');
  paired = true;
  const second = await open(); t.after(() => second.window.close());
  assert.equal(second.window.document.getElementById('youtube-clear-server-row').hidden, false);
  for (const [key, value] of Object.entries(fields)) {
    const node = second.window.document.getElementById('youtube-' + key);
    assert.equal(typeof value === 'boolean' ? node.checked : node.value, typeof value === 'boolean' ? value : String(value));
  }
  second.window.document.getElementById('youtube-clear').click(); await tick();
  second.window.document.querySelector('#confirm-youtube-clear [data-commit]').click(); await tick();
  assert.match(second.window.document.getElementById('storage-status').textContent, /자막 지움/);
  assert.equal(h.calls.length, 0);
});

test('standalone button suppresses our UI and logs once; enabled switch removes and restores UI', async t => {
  const dom = new JSDOM('<div id="movie_player"><div class="ytp-right-controls"></div></div><button id="ytsf-button">AI</button>',
    { url: PAGE.url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, logs = [], changes = []; let enabled = true;
  w.console.info = (...args) => logs.push(args.join(' '));
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.chrome = { storage: { local: { get: async () => ({ 'lakomics:youtube:settings:enabled': enabled }) },
    onChanged: { addListener: fn => changes.push(fn) } }, runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true, cached: null }) } };
  w.eval(contentSource); await tick();
  assert.equal(w.document.getElementById('lakomics-yt-button'), null);
  w.document.dispatchEvent(new w.Event('yt-navigate-finish'));
  w.document.dispatchEvent(new w.Event('yt-navigate-finish'));
  assert.equal(logs.filter(line => /standalone/.test(line)).length, 1);
  w.document.getElementById('ytsf-button').remove();
  w.document.dispatchEvent(new w.Event('yt-navigate-finish'));
  assert.ok(w.document.getElementById('lakomics-yt-button'));
  enabled = false; changes[0]({ 'lakomics:youtube:settings:enabled': { newValue: false } }, 'local');
  assert.equal(w.document.getElementById('lakomics-yt-button'), null);
  changes[0]({ 'lakomics:youtube:settings:enabled': { newValue: true } }, 'local');
  assert.ok(w.document.getElementById('lakomics-yt-button'));
  assert.match(contentSource, /if \(event\.isTrusted !== true/);
  // Page bridge only carries caption/metadata requests, never worker credentials.
  assert.doesNotMatch(contentSource, /anthropicApiKey|authorization|connection\.token/);
});

test('processing version t4: results stored under the old mode key are never matched', async t => {
  const h = setup(t);
  const oldKey = 'lakomics:youtube:subs:v2:video12:en:asr:translate-ko-auto';
  const newKey = oldKey + '+t6';
  h.stored[oldKey] = { ...entry(), cues: [{ startMs: 0, endMs: 1500, text: '옛 결과', orig: 'Jeff' }] };
  h.stored['lakomics:youtube:subs:index'] = { video12: ['en:asr|translate-ko-auto'] };
  assert.equal((await h.send({ type: 'youtube:getCached', videoId: 'video12' })).cached, null);
  h.serve(async (url, init) => {
    if (url.startsWith('https://api.anthropic.com/')) return apiResponse(JSON.parse(init.body));
    if (init.method === 'PUT') return response(200, { ok: true });
    const mode = new URL(url).searchParams.get('mode');
    return mode === 'translate-ko-auto' ? response(200, entry()) : response(404, { code: 'not_found' });
  });
  const result = await h.send(request); await tick();
  assert.equal(result.ok, true);
  assert.notEqual(result.cached, true);
  assert.ok(h.calls.some(call => call.url.startsWith('https://api.anthropic.com/')));
  assert.ok(h.stored[newKey]);
  assert.doesNotMatch(JSON.stringify(h.stored[newKey]), /wordStarts|wordChars/);
  assert.equal(h.stored[oldKey].cues[0].text, '옛 결과');
  assert.equal((await h.send({ type: 'youtube:getCached', videoId: 'video12' })).cached.cues[0].text, '제프');
});
