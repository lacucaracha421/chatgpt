import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const scripts = await Promise.all(['translation/korean-rules', 'translation/korean', 'translation/terms', 'translation/deadline', 'translation/image', 'translate-service']
  .map(name => readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8')));
const sender = {id: 'test', url: 'https://example.test/', tab: {id: 1}};
const gemini35 = 'google/gemini-3.5-flash-lite';
const json = JSON.stringify({lines: [{original: 'Hello', korean: '안녕', kind: 'dialogue', box: [100, 200, 300, 400]}]});
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(model = gemini35, answer = () => ({choices: [{message: {content: json}, finish_reason: 'stop'}]})) {
  const calls = [];
  const memory = {'lakomics:translation:storage-v4': true, 'lakomics:translation:v1': {
    enabled: false, apiKey: 'fixture-only', anthropicApiKey: 'fixture-only', model: gemini35, imageModel: model, fallbackModel: '',
  }};
  const ctx = vm.createContext({URL, AbortController, Blob, btoa, atob, setTimeout, clearTimeout,
    createImageBitmap: async () => ({width: 800, height: 600, close() {}}),
    chrome: {runtime: {id: 'test'}, storage: {local: {
      async get() {return memory;}, async set(value) {Object.assign(memory, value);}, async remove() {},
    }}},
    fetch: async (url, init) => {
      const body = JSON.parse(init.body); calls.push({url, body});
      return {ok: true, json: async () => answer(body)};
    },
  });
  for (const script of scripts) vm.runInContext(script, ctx);
  return {calls, handle: message => ctx.LakomicsTranslation.handle(message, sender),
    translate: () => ctx.LakomicsTranslation.handle({type: 'translation:image', dataUrl: 'data:image/png;base64,AA=='}, sender)};
}

test('3.5 image request leaves room for mandatory reasoning and the structured translation', async () => {
  // Synthetic exhaustion: reasoning and JSON together exceed the old 4096 cap.
  // This models the failure path; it is not a captured provider response.
  const f = fixture(gemini35, body => ({
    choices: [{message: {reasoning: 'fixture reasoning', content: body.max_tokens >= 8192 ? json : ''},
      finish_reason: body.max_tokens >= 8192 ? 'stop' : 'length'}],
    usage: {completion_tokens: 6000, completion_tokens_details: {reasoning_tokens: 4500}},
  }));
  const result = await f.translate();
  assert.equal(result.ok, true);
  assert.equal(result.model, gemini35);
  assert.deepEqual(plain(result.lines), [{original: 'Hello', korean: '안녕', kind: 'dialogue', box: {x0: 200, y0: 100, x1: 400, y1: 300}}]);
  const {body} = f.calls[0];
  assert.equal(body.max_tokens, 16384);
  assert.deepEqual(body.reasoning, {effort: 'minimal'});
  assert.deepEqual(body.provider, {require_parameters: true, sort: 'latency'});
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(body.response_format.json_schema.schema.properties.lines.items.properties.box, {type: 'array', items: {type: 'integer'}});
  assert.equal(f.calls.length, 1);
});

test('3.5 truncated, reasoning-only and malformed answers report image reading failure', async () => {
  for (const choice of [
    {message: {content: json}, finish_reason: 'length'},
    {message: {content: null, reasoning: json}, finish_reason: 'length'},
    {message: {content: null, reasoning: json}, finish_reason: 'stop'},
    {message: {content: 'not JSON'}, finish_reason: 'stop'},
    {message: {content: '{"text":"안녕"}'}, finish_reason: 'stop'},
  ]) {
    const f = fixture(gemini35, () => ({choices: [choice]}));
    assert.deepEqual(plain(await f.translate()), {ok: false, code: 'image_unreadable'});
    assert.equal(f.calls.length, 1, 'an unexpected answer is not retried blindly');
  }
});

test('3.5 empty lines remain a successful no-text answer', async () => {
  const f = fixture(gemini35, () => ({choices: [{message: {content: '{"lines":[]}'}, finish_reason: 'stop'}]}));
  assert.deepEqual(plain((await f.translate()).lines), []);
});

test('3.1 and Claude image requests retain their token caps and response handling', async () => {
  for (const model of ['google/gemini-3.1-flash-lite', 'anthropic:claude-haiku-5-5', 'anthropic:claude-sonnet-5-5']) {
    const anthropic = model.startsWith('anthropic:');
    const f = fixture(model, () => anthropic ? {content: [{type: 'text', text: json}], stop_reason: 'end_turn'}
      : {choices: [{message: {content: json}, finish_reason: 'stop'}]});
    assert.equal((await f.translate()).ok, true);
    assert.equal(f.calls[0].body.max_tokens, 4096);
    if (!anthropic) assert.deepEqual(f.calls[0].body.reasoning, {enabled: false});
    const bad = fixture(model, () => anthropic ? {content: [{type: 'text', text: json}], stop_reason: 'max_tokens'}
      : {choices: [{message: {content: json}, finish_reason: 'length'}]});
    assert.equal((await bad.translate()).code, 'invalid_translation');
  }
});

test('3.5 selected-text translation keeps the existing request cap', async () => {
  const f = fixture(gemini35, () => ({choices: [{message: {content: 'Hello'}, finish_reason: 'stop'}]}));
  assert.equal((await f.handle({type: 'translation:context', kind: 'replace.en', text: '안녕'})).text, 'Hello');
  assert.equal(f.calls[0].body.max_tokens, 4096);
  assert.deepEqual(f.calls[0].body.reasoning, {effort: 'minimal'});
});
