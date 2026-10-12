import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../../_tools/app/node_modules/jsdom/lib/api.js';

const plain = value => JSON.parse(JSON.stringify(value));
const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const usageSource = await read('src/usage.js');
const core = await Promise.all(['korean-rules', 'korean', 'terms', 'deadline', 'image'].map(name => read(`src/translation/${name}.js`)));
const service = await read('src/translate-service.js');
const KEY = 'lakomics:usage:v1', TOTAL = 'lakomics:youtube:usage:total';
const immediate = () => new Promise(resolve => setImmediate(resolve));
const at = (month, day, hour = 12) => new Date(2026, month - 1, day, hour).getTime();
const NOW = at(10, 13);
const call = (feature, extra = {}) => ({feature, at: NOW, model: 'm', input: 100, output: 10, costUsd: 0.001, job: null, ...extra});

// ---------------------------------------------------------------- the module alone
function memoryStorage(initial = {}) {
  const memory = structuredClone(initial), writes = [];
  return {memory, writes, local: {
    async get(keys) { await immediate(); return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in memory).map(key => [key, memory[key]]))); },
    async set(values) { await immediate(); writes.push(plain(values)); Object.assign(memory, structuredClone(values)); },
  }};
}
function loadUsage(initial) {
  const storage = memoryStorage(initial), timers = [];
  const context = vm.createContext({chrome: {storage: {local: storage.local}},
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; }});
  vm.runInContext(usageSource, context);
  return {usage: context.LakomicsUsage, storage, timers, run: timer => !timer.cleared && timer.fn()};
}

test('Anthropic prices: Haiku tiers at 100K input, Sonnet cache reads, and no invented prices', () => {
  const {usage} = loadUsage();
  assert.equal(usage.anthropicCost('claude-haiku-5-5', {input_tokens: 1000, output_tokens: 200}), 0.0002);
  assert.equal(usage.anthropicCost('anthropic:claude-haiku-5-5', {input_tokens: 100000, output_tokens: 1000}), 0.0105, 'exactly 100K is still the small tier');
  assert.equal(usage.anthropicCost('claude-haiku-5-5', {input_tokens: 100001, output_tokens: 1000}), 0.0525005, 'above 100K both rates rise');
  assert.equal(usage.anthropicCost('claude-sonnet-5-5', {input_tokens: 1000, output_tokens: 200}), 0.004);
  assert.equal(usage.anthropicCost('claude-sonnet-5-5', {input_tokens: 1000, cache_read_input_tokens: 10000, output_tokens: 0}), 0.004);
  assert.equal(usage.anthropicCost('claude-haiku-5-5', {input_tokens: 10, cache_read_input_tokens: 10, output_tokens: 1}), null, 'no Haiku cache price is listed');
  assert.equal(usage.anthropicCost('claude-sonnet-5-5', {input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 1}), null, 'no cache write price is listed');
  assert.equal(usage.anthropicCost('claude-opus-9', {input_tokens: 10, output_tokens: 1}), null, 'unknown model');
  assert.equal(usage.anthropicCost('claude-haiku-5-5', undefined), null);
});

test('measure: Anthropic cache tokens count as input; OpenRouter cost comes from usage.cost or is unknown', () => {
  const {usage} = loadUsage();
  assert.deepEqual(plain(usage.measure('anthropic', 'anthropic:claude-sonnet-5-5', {input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5})),
    {model: 'claude-sonnet-5-5', input: 100, output: 5, costUsd: 0.000088});
  assert.deepEqual(plain(usage.measure('openrouter', 'google/gemma-4-26b-a4b-it', {prompt_tokens: 120, completion_tokens: 30, cost: 0.00004})),
    {model: 'google/gemma-4-26b-a4b-it', input: 120, output: 30, costUsd: 0.00004});
  assert.equal(usage.measure('openrouter', 'google/x', {prompt_tokens: 1, completion_tokens: 1}).costUsd, null, 'no cost reported');
  assert.equal(usage.measure('openrouter', 'google/x', {prompt_tokens: 1, completion_tokens: 1, cost: 'free'}).costUsd, null, 'only a finite number counts');
  assert.deepEqual(plain(usage.measure('anthropic', 'claude-haiku-5-5', undefined)), {model: 'claude-haiku-5-5', input: 0, output: 0, costUsd: null});
});

test('day and month buckets: today, this month and all time per feature, with unknown costs kept apart', () => {
  const {usage} = loadUsage();
  const doc = usage.readDoc(undefined); doc.legacy = null;
  usage.applyCalls(doc, [
    call('page', {at: at(10, 13, 9), input: 1000, output: 100, costUsd: 0.01}),
    call('page', {at: at(10, 13, 15), input: 500, output: 50, costUsd: null}),
    call('page', {at: at(10, 2), input: 200, output: 20, costUsd: 0.002}),
    call('page', {at: at(9, 30, 23), input: 300, output: 30, costUsd: 0.003}),
    call('x', {at: at(10, 13), costUsd: null}),
  ], NOW);
  const summary = usage.summarize(plain(doc), NOW);
  assert.deepEqual(plain(summary.rows.page.today), {requests: 2, input: 1500, output: 150, costUsd: 0.01, unknownCostRequests: 1});
  assert.deepEqual(plain(summary.rows.page.month), {requests: 3, input: 1700, output: 170, costUsd: 0.012, unknownCostRequests: 1});
  assert.deepEqual(plain(summary.rows.page.total), {requests: 4, input: 2000, output: 200, costUsd: 0.015, unknownCostRequests: 1});
  assert.equal(usage.describeCost(summary.rows.page.today), '$0.0100 · 일부 모름');
  assert.equal(usage.describeCost(summary.rows.x.today), '비용 모름', 'every request unknown');
  assert.equal(usage.describeCost(summary.rows.image.total), '-');
  assert.equal(usage.describeTokens(summary.rows.page.total), '입력 2.0k / 출력 200');
  assert.equal(summary.all.total.requests, 5);
  assert.equal(usage.formatCost(0.00004), '<$0.0001');
  assert.equal(usage.formatCost(0.0123), '$0.0123');
  assert.equal(usage.formatTokens(12345), '12.3k');
  assert.equal(usage.formatTokens(1500000), '1.50M');
});

test('days older than 400 are dropped and the job list keeps the newest 50', () => {
  const {usage} = loadUsage();
  const doc = usage.readDoc(undefined);
  usage.applyCalls(doc, [call('x', {at: NOW - 401 * 86400000}), call('x', {at: NOW - 399 * 86400000})], NOW);
  assert.equal(Object.keys(doc.days).length, 1);
  const jobs = Array.from({length: 60}, (_, index) => call('context', {at: NOW + index, job: {id: `context:${index}`, label: `job ${index}`}}));
  usage.applyCalls(doc, jobs, NOW);
  assert.equal(doc.jobs.length, 50);
  assert.equal(doc.jobs[0].id, 'context:59');
  assert.equal(doc.jobs.at(-1).id, 'context:10');
});

test('calls of one job merge into one entry that moves to the front', () => {
  const {usage} = loadUsage();
  const doc = usage.readDoc(undefined), job = {id: 'page:a', label: 'a.test · A'};
  usage.applyCalls(doc, [call('page', {job, model: 'one'}), call('image', {job: {id: 'image:b', label: 'b'}}),
    call('page', {job, model: 'two', costUsd: null, at: NOW + 5})], NOW);
  assert.deepEqual(plain(doc.jobs.map(item => item.id)), ['page:a', 'image:b']);
  const merged = plain(doc.jobs[0]);
  assert.deepEqual(merged, {id: 'page:a', feature: 'page', label: 'a.test · A', at: NOW + 5, models: ['one', 'two'], requests: 2, input: 200, output: 20, costUsd: 0.001, unknown: 1});
});

test('concurrent adds and flushes are serialized: nothing is lost, even with slow storage', async () => {
  const {usage, storage} = loadUsage();
  const feature = ['x', 'context', 'page', 'image', 'youtube'];
  const flushes = [];
  for (let round = 0; round < 6; round += 1) {
    for (let i = 0; i < 10; i += 1) usage.record(feature[(round + i) % 5], {model: 'm', input: 10, output: 1, costUsd: 0.001}, {id: `job:${round}`, label: `round ${round}`});
    flushes.push(usage.flush());
  }
  await Promise.all(flushes);
  const summary = usage.summarize(storage.memory[KEY]);
  assert.equal(summary.all.total.requests, 60);
  assert.equal(summary.all.total.input, 600);
  assert.equal(summary.all.total.costUsd, 0.06);
  assert.equal(summary.jobs.length, 6);
  assert.ok(summary.jobs.every(job => job.requests === 10));
});

test('writes are coalesced: one storage write 1.5 s after the first call, however many calls arrive', async () => {
  const {usage, storage, timers, run} = loadUsage();
  for (let i = 0; i < 25; i += 1) usage.record('x', {model: 'm', input: 1, output: 1, costUsd: 0}, {id: 'x:2026-10-13', label: 'X'});
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1500);
  assert.equal(storage.writes.length, 0, 'nothing is written before the timer');
  run(timers[0]); await usage.flush(); await immediate();
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.memory[KEY].days[usage.localDay()].x.requests, 25);
  usage.record('x', {model: 'm', input: 1, output: 1, costUsd: 0});
  assert.equal(timers.length, 2, 'a later call arms a new timer');
});

test('a failed write keeps the calls for the next try', async () => {
  const {usage, storage} = loadUsage();
  const set = storage.local.set; let fail = true;
  storage.local.set = async values => { if (fail) throw new Error('quota'); return set(values); };
  usage.record('image', {model: 'm', input: 5, output: 5, costUsd: 0.5});
  await assert.rejects(usage.flush());
  fail = false; await usage.flush();
  assert.equal(usage.summarize(storage.memory[KEY]).rows.image.total.requests, 1);
});

test('migration: the earlier YouTube total is folded in once as a separate row and keeps growing on its own', async () => {
  const total = {input_tokens: 5000, output_tokens: 500, videos: 2, byModel: {'claude-haiku-5-5': {input_tokens: 5000, output_tokens: 500}}};
  const {usage, storage} = loadUsage({[TOTAL]: total});
  await usage.ensureMigrated();
  assert.deepEqual(plain(storage.memory[KEY].legacy), {requests: 2, input: 5000, output: 500, costUsd: 0.00075, unknownCostRequests: 0});
  storage.memory[TOTAL] = {...total, input_tokens: 9000, videos: 3};
  usage.record('youtube', {model: 'claude-haiku-5-5', input: 10, output: 1, costUsd: 0.1}, {id: 'youtube:a', label: 'a'});
  await usage.flush();
  const summary = usage.summarize(storage.memory[KEY]);
  assert.equal(summary.legacy.input, 5000, 'the snapshot is not refreshed');
  assert.equal(summary.rows.youtube.total.requests, 1, 'new videos are counted in their own row');
  assert.equal(summary.all.total.requests, 3);
  await usage.clear();
  assert.deepEqual(plain(storage.memory[KEY]), {v: 1, days: {}, jobs: [], legacy: null});
  await usage.flush();
  assert.equal(usage.summarize(storage.memory[KEY]).legacy, null, 'clearing is not undone by a second migration');
});

test('migration: a model without a price makes the earlier row partly unknown; no total means no row', async () => {
  const odd = loadUsage({[TOTAL]: {input_tokens: 10, output_tokens: 10, videos: 1, byModel: {'claude-opus-9': {input_tokens: 10, output_tokens: 10}}}});
  await odd.usage.ensureMigrated();
  assert.equal(odd.usage.describeCost(odd.storage.memory[KEY].legacy), '비용 모름');
  const none = loadUsage();
  await none.usage.ensureMigrated();
  assert.equal(none.storage.memory[KEY].legacy, null);
});

// ---------------------------------------------------------------- the translation worker
const sender = {id: 'test', url: 'https://example.test/page', tab: {id: 7}};
const reply = (...pairs) => JSON.stringify({translations: pairs.map(([id, text]) => ({id, text}))});
const sonnet = (input, output) => ({input_tokens: input, output_tokens: output});

function worker({stored = {}, replies = []} = {}) {
  const memory = {'lakomics:translation:storage-v4': true, 'lakomics:translation:v1': {enabled: true, apiKey: 'or-key', anthropicApiKey: 'ant-key', model: 'google/gemini-3.1-flash-lite', fallbackModel: 'google/gemma-4-26b-a4b-it', imageModel: 'anthropic:claude-sonnet-5-5', ...stored}};
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, init, body: JSON.parse(init.body)});
    const next = replies[Math.min(calls.length, replies.length) - 1];
    if (next.status) return {ok: false, status: next.status, headers: {get: () => null}};
    const anthropic = url.includes('anthropic.com');
    return {ok: true, json: async () => anthropic
      ? {content: [{type: 'text', text: next.content}], stop_reason: 'end_turn', usage: next.usage}
      : {choices: [{message: {content: next.content}, finish_reason: 'stop'}], usage: next.usage}};
  };
  const context = vm.createContext({URL, AbortController, Blob, btoa, atob, setTimeout, clearTimeout, fetch,
    createImageBitmap: async () => ({width: 800, height: 600, close() {}}),
    chrome: {runtime: {id: 'test'}, storage: {local: {async get() { return structuredClone(memory); }, async set(value) { Object.assign(memory, structuredClone(value)); }, async remove() {}}}}});
  for (const script of [usageSource, ...core, service]) vm.runInContext(script, context);
  const usage = context.LakomicsUsage;
  return {calls, memory, usage, handle: (message, who = sender) => context.LakomicsTranslation.handle(message, who),
    log: async () => { await usage.flush(); return usage.summarize(memory[KEY]); }};
}

test('page translation: Anthropic usage is priced, grouped into the page job and reported back for the status line', async () => {
  const f = worker({stored: {contextModel: 'anthropic:claude-sonnet-5-5'}, replies: [{content: reply(['0', '안녕하세요']), usage: sonnet(1000, 200)}]});
  const job = {id: 'page:abc-1', label: 'example.test · Title'};
  const result = plain(await f.handle({type: 'translation:page', items: [{id: '0', text: 'Hello there'}], job}));
  assert.deepEqual(result.usage, {input: 1000, output: 200, costUsd: 0.004, unknown: 0, requests: 1});
  assert.equal('usage' in f.calls[0].body, false, 'the OpenRouter flag never goes to Anthropic');
  const log = await f.log();
  assert.deepEqual(plain(log.rows.page.total), {requests: 1, input: 1000, output: 200, costUsd: 0.004, unknownCostRequests: 0});
  assert.equal(log.jobs[0].id, 'page:abc-1');
  assert.equal(log.jobs[0].label, 'example.test · Title');
  assert.deepEqual(plain(log.jobs[0].models), ['claude-sonnet-5-5']);
  // Another batch of the same run (for instance after "계속 번역") joins the same job.
  f.calls.length = 0;
  const f2 = worker({stored: {contextModel: 'anthropic:claude-sonnet-5-5'}, replies: [{content: reply(['0', '하나']), usage: sonnet(1000, 200)}, {content: reply(['0', '둘']), usage: sonnet(500, 100)}]});
  await f2.handle({type: 'translation:page', items: [{id: '0', text: 'One'}], job});
  await f2.handle({type: 'translation:page', items: [{id: '0', text: 'Two'}], job});
  const both = await f2.log();
  assert.equal(both.jobs.length, 1);
  assert.deepEqual(plain(both.jobs[0]).requests, 2);
  assert.equal(both.jobs[0].costUsd, 0.006);
});

test('page translation: a billed answer that is rejected and retried is counted for every attempt', async () => {
  const f = worker({stored: {contextModel: 'anthropic:claude-haiku-5-5'}, replies: [
    {content: reply(['0', '안녕 こんにちは']), usage: {input_tokens: 2000, output_tokens: 100}},
    {content: reply(['0', '안녕 세계']), usage: {input_tokens: 2200, output_tokens: 120}}]});
  const result = plain(await f.handle({type: 'translation:page', items: [{id: '0', text: 'hello world'}], job: {id: 'page:retry', label: 'r'}}));
  assert.equal(result.items[0].text, '안녕 세계');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(result.usage, {input: 4200, output: 220, costUsd: 0.00053, unknown: 0, requests: 2});
  const log = await f.log();
  assert.equal(log.rows.page.total.requests, 2);
  assert.equal(log.jobs.length, 1);
  // A failed page request still reports what it cost.
  const bad = worker({stored: {contextModel: 'anthropic:claude-haiku-5-5'}, replies: [{content: 'not json', usage: {input_tokens: 10, output_tokens: 5}}]});
  const failed = plain(await bad.handle({type: 'translation:page', items: [{id: '0', text: 'hi'}], job: {id: 'page:bad', label: 'b'}}));
  assert.equal(failed.code, 'invalid_translation');
  assert.equal(failed.usage.requests, 1);
  assert.equal((await bad.log()).rows.page.total.requests, 1);
});

test('page translation: a bad job from the page is replaced by a fresh one and unknown OpenRouter cost is flagged', async () => {
  const f = worker({replies: [{content: reply(['0', '안녕']), usage: {prompt_tokens: 50, completion_tokens: 10}}]});
  const result = plain(await f.handle({type: 'translation:page', items: [{id: '0', text: 'Hello'}], job: {id: '../../x y', label: 'x'}}));
  assert.deepEqual(result.usage, {input: 50, output: 10, costUsd: 0, unknown: 1, requests: 1});
  const log = await f.log();
  assert.match(log.jobs[0].id, /^page:/);
  assert.equal(log.jobs[0].label, '페이지 번역');
  assert.equal(log.jobs[0].unknown, 1);
  assert.equal(f.usage.describeCost(log.rows.page.total), '비용 모름');
});

test('X translation: OpenRouter cost is read from the answer, the body asks for it, and a retry on the other model is counted too', async () => {
  const f = worker({replies: [
    {content: '', usage: {prompt_tokens: 120, completion_tokens: 0, cost: 0.00001}},
    {content: '안녕하세요', usage: {prompt_tokens: 130, completion_tokens: 30, cost: 0.00002}}]});
  const result = plain(await f.handle({type: 'translation:request', text: 'Hello'}));
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.map(call => call.body.model), ['google/gemini-3.1-flash-lite', 'google/gemma-4-26b-a4b-it']);
  assert.deepEqual(f.calls.map(call => call.body.usage), [{include: true}, {include: true}]);
  const log = await f.log(), day = f.usage.localDay();
  assert.deepEqual(plain(log.rows.x.total), {requests: 2, input: 250, output: 30, costUsd: 0.00003, unknownCostRequests: 0});
  assert.equal(log.jobs[0].id, `x:${day}`);
  assert.equal(log.jobs[0].label, 'X 자동 번역');
  assert.deepEqual(plain(log.jobs[0].models), ['google/gemini-3.1-flash-lite', 'google/gemma-4-26b-a4b-it']);
});

test('X translation batches share the per-day job; failed requests without usage add nothing', async () => {
  const f = worker({replies: [{status: 503}, {content: reply(['a', '하나'], ['b', '둘']), usage: {prompt_tokens: 80, completion_tokens: 20, cost: 0.00005}}]});
  const result = plain(await f.handle({type: 'translation:request-batch', items: [{id: 'a', text: 'One'}, {id: 'b', text: 'Two'}]}));
  assert.equal(result.ok, true);
  const log = await f.log();
  assert.equal(log.rows.x.total.requests, 1);
  assert.equal(log.jobs.length, 1);
});

test('right-click translation: one job with its quality retry, priced at the Haiku small tier', async () => {
  const f = worker({stored: {contextModel: 'anthropic:claude-haiku-5-5'}, replies: [
    {content: '안녕 こんにちは', usage: {input_tokens: 100000, output_tokens: 1000}},
    {content: '안녕하세요', usage: {input_tokens: 1000, output_tokens: 10}}]});
  const result = plain(await f.handle({type: 'translation:context', kind: 'translate.ko.inline', text: 'Hello   there, friend'}));
  assert.deepEqual(result, {ok: true, text: '안녕하세요'});
  const log = await f.log();
  assert.equal(log.rows.context.total.requests, 2);
  assert.equal(log.rows.context.total.costUsd, 0.010605);
  assert.equal(log.jobs.length, 1);
  assert.match(log.jobs[0].label, /^한국어 · Hello there, friend$/);
});

test('image text: recorded as an image job named by host and file, in the Anthropic model price', async () => {
  const f = worker({replies: [{content: JSON.stringify({lines: [{original: 'またね', korean: '또 봐', box: {x0: 0, y0: 0, x1: 10, y1: 10}}]}), usage: sonnet(1500, 100)}]});
  const bytes = Buffer.from(new Uint8Array(100).fill(7)).toString('base64');
  const result = plain(await f.handle({type: 'translation:image', dataUrl: `data:image/png;base64,${bytes}`}));
  assert.equal(result.ok, true);
  const log = await f.log();
  assert.deepEqual(plain(log.rows.image.total), {requests: 1, input: 1500, output: 100, costUsd: 0.004, unknownCostRequests: 0});
  assert.equal(log.jobs[0].label, '이미지', 'a pasted picture has no address to name it by');
});

// ---------------------------------------------------------------- YouTube
test('YouTube: each API call of a video is recorded under one job, after the old total is folded in', async t => {
  const {loadWorker} = await import('./helpers/youtube-classic.mjs');
  const original = {chrome: globalThis.chrome, fetch: globalThis.fetch, usage: globalThis.LakomicsUsage};
  t.after(() => Object.assign(globalThis, original));
  const stored = {'lakomics:translation:v1': {anthropicApiKey: 'k', userTerms: [], dictionaryRevision: 0},
    [TOTAL]: {input_tokens: 5000, output_tokens: 500, videos: 2, byModel: {'claude-haiku-5-5': {input_tokens: 5000, output_tokens: 500}}}};
  globalThis.chrome = {storage: {local: {
    get: async keys => structuredClone(keys === null ? stored : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, stored[key]]))),
    set: async values => Object.assign(stored, structuredClone(values)),
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; },
  }}, runtime: {id: 'test', getURL: path => 'chrome-extension://test/' + path, onMessage: {addListener() {}}}, tabs: {sendMessage: async () => {}}};
  vm.runInThisContext(usageSource);
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body), glossary = body.output_config.format.schema.required.includes('terms');
    return {status: 200, ok: true, json: async () => ({content: [{type: 'text', text: JSON.stringify(glossary ? {register: 'haeyo', terms: []} : {register: 'haeyo', lines: [{from: 0, to: 0, text: '제프'}]})}],
      usage: {input_tokens: 1000, output_tokens: 100}})};
  };
  const worker = loadWorker();
  const page = {id: 'test', frameId: 0, url: 'https://www.youtube.com/watch?v=video12', tab: {id: 1}};
  const result = await worker.handle({type: 'youtube:process', videoId: 'video12', trackKey: 'en:asr',
    json3: {events: [{tStartMs: 0, dDurationMs: 1000, segs: [{utf8: 'Jeff'}]}]}, meta: {videoId: 'video12', title: 'Jeff talks', author: 'A', shortDescription: '', keywords: []}}, page);
  assert.equal(result.ok, true);
  await globalThis.LakomicsUsage.flush();
  const log = globalThis.LakomicsUsage.summarize(stored[KEY]);
  assert.equal(log.legacy.requests, 2);
  assert.equal(log.legacy.input, 5000);
  assert.deepEqual(plain(log.rows.youtube.total), {requests: 2, input: 2000, output: 200, costUsd: 0.0003, unknownCostRequests: 0});
  assert.equal(log.jobs.length, 1);
  assert.equal(log.jobs[0].feature, 'youtube');
  assert.equal(log.jobs[0].label, 'Jeff talks');
  assert.equal(stored[TOTAL].input_tokens, 7000, 'the old running total keeps working');
});

// ---------------------------------------------------------------- options page
const html = await read('options/options.html');
const optionsSource = await read('options/options.js');
const classification = await read('src/classification-tree.js');
const terms = await read('src/translation/terms.js');
const drain = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };

async function optionsPage(t, initial = {}) {
  const dom = new JSDOM(html, {url: 'chrome-extension://test/options/options.html', runScripts: 'outside-only'}), w = dom.window;
  t.after(() => w.close());
  const memory = structuredClone(initial), messages = []; let onChanged;
  w.matchMedia = () => ({matches: false});
  w.IntersectionObserver = class { observe() {} };
  w.chrome = {storage: {onChanged: {addListener(fn) { onChanged = fn; }}, local: {
    async get(keys) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in memory).map(key => [key, memory[key]]))); },
    async set(values) { Object.assign(memory, structuredClone(values)); }}},
    runtime: {getManifest: () => ({version: '3.5.29'}), async sendMessage(message) {
      messages.push(message);
      if (message.type === 'usage:clear') { memory[KEY] = {v: 1, days: {}, jobs: [], legacy: null}; return {ok: true}; }
      if (message.type === 'settings:get') return {paired: false, state: null};
      if (message.type === 'translation:settings') return {ok: true, models: [], imageModels: [], userTerms: []};
      if (message.type === 'youtube:settings') return {ok: true, settings: {}};
      return {ok: true};
    }}};
  w.eval(classification); w.eval(terms); w.eval(usageSource);
  w.LakomicsArcCollector = {mount: ({container}) => (container.replaceChildren(w.document.createElement('div')), {update() {}, close() {}})};
  w.eval(optionsSource); await drain();
  const $ = id => w.document.getElementById(id);
  return {w, $, memory, messages, changed: async changes => { onChanged(changes, 'local'); await drain(); }};
}
const rowText = (page, name) => [...page.$('usage-rows').querySelectorAll('tr')].find(tr => tr.querySelector('th').textContent === name);

test('options: the usage section shows features by today, this month and all time, recent jobs, and refreshes live', async t => {
  const {usage} = loadUsage();
  const doc = usage.readDoc(undefined); doc.legacy = usage.legacyFrom({input_tokens: 2000, output_tokens: 200, videos: 1, byModel: {'claude-haiku-5-5': {input_tokens: 2000, output_tokens: 200}}});
  const now = Date.now();
  usage.applyCalls(doc, [call('page', {at: now, input: 12345, output: 678, costUsd: 0.0123, job: {id: 'page:x', label: 'blog.test · 글'}}),
    call('image', {at: now, input: 100, output: 10, costUsd: null})], now);
  const page = await optionsPage(t, {[KEY]: plain(doc)});
  assert.ok(page.w.document.querySelector('.op-nav a[href="#usage-section"]'));
  const cells = name => [...rowText(page, name).querySelectorAll('td')].map(td => td.textContent);
  assert.deepEqual(cells('페이지 번역'), ['$0.0123입력 12.3k / 출력 678', '$0.0123입력 12.3k / 출력 678', '$0.0123입력 12.3k / 출력 678']);
  assert.deepEqual(cells('이미지 글자'), ['비용 모름입력 100 / 출력 10', '비용 모름입력 100 / 출력 10', '비용 모름입력 100 / 출력 10']);
  assert.deepEqual(cells('X 번역'), ['-', '-', '-']);
  assert.deepEqual(cells('기록 시작 전 유튜브'), ['-', '-', '$0.0003입력 2.0k / 출력 200']);
  assert.deepEqual([...page.$('usage-rows').querySelectorAll('th')].map(th => th.textContent),
    ['X 번역', '우클릭 번역', '페이지 번역', '이미지 글자', '유튜브 자막', '기록 시작 전 유튜브', '합계']);
  const jobs = [...page.$('usage-jobs').querySelectorAll('li')];
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].querySelector('.jk').textContent, '페이지 번역');
  assert.equal(jobs[0].querySelector('.jl').textContent, 'blog.test · 글');
  assert.match(jobs[0].querySelector('.ja').textContent, /^\$0\.0123 · 입력 12\.3k \/ 출력 678$/);
  assert.equal(page.$('usage-jobs-empty').hidden, true);
  // A write from the worker while the page is open updates it.
  const more = usage.readDoc(plain(doc)); more.legacy = doc.legacy;
  usage.applyCalls(more, [call('x', {at: now, input: 10, output: 5, costUsd: 0.5})], now);
  page.memory[KEY] = plain(more);
  await page.changed({[KEY]: {newValue: page.memory[KEY]}});
  assert.deepEqual(cells('X 번역'), ['$0.5000입력 10 / 출력 5', '$0.5000입력 10 / 출력 5', '$0.5000입력 10 / 출력 5']);
});

test('options: clearing the usage log asks first, then empties the table', async t => {
  const {usage} = loadUsage();
  const doc = usage.readDoc(undefined); doc.legacy = null;
  usage.applyCalls(doc, [call('x', {at: Date.now(), job: {id: 'x:1', label: 'X'}})], Date.now());
  const page = await optionsPage(t, {[KEY]: plain(doc)});
  assert.equal(page.$('usage-clear').textContent, '사용량 기록 지우기');
  assert.equal(page.$('usage-jobs').children.length, 1);
  page.$('usage-clear').click(); await drain();
  assert.equal(page.messages.some(message => message.type === 'usage:clear'), false, 'the button only asks');
  const confirm = page.w.document.getElementById('confirm-usage-clear');
  assert.ok(confirm.classList.contains('open'));
  confirm.querySelector('[data-commit]').click(); await drain();
  assert.equal(page.messages.filter(message => message.type === 'usage:clear').length, 1);
  assert.equal(page.$('usage-jobs').children.length, 0);
  assert.equal(page.$('usage-jobs-empty').hidden, false);
  assert.equal(rowText(page, '합계').querySelectorAll('td')[2].textContent, '-');
});

// ---------------------------------------------------------------- background
test('background: only the options page may empty the usage log', async () => {
  const background = await read('src/background.js');
  let listener, cleared = 0;
  const context = vm.createContext({importScripts() {},
    chrome: {runtime: {id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: {addListener(fn) { listener = fn; }}}},
    LakomicsUsage: {async clear() { cleared += 1; }}});
  vm.runInContext(background, context);
  const ask = sender => new Promise(resolve => listener({type: 'usage:clear'}, sender, resolve));
  assert.equal((await ask({id: 'test', frameId: 0, url: 'https://example.test/', tab: {id: 1}})).code, 'forbidden_sender');
  assert.equal((await ask({id: 'other', frameId: 0, url: 'chrome-extension://test/options/options.html'})).code, 'forbidden_sender');
  assert.equal(cleared, 0);
  assert.equal(plain(await ask({id: 'test', frameId: 0, url: 'chrome-extension://test/options/options.html#usage-section'})).ok, true);
  assert.equal(cleared, 1);
});
