import { loadWorker } from "./helpers/youtube-classic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJson3 } from "./helpers/youtube-classic.mjs";
import { chunkUnits } from "./helpers/youtube-classic.mjs";
import { createResumeRecord } from "./helpers/youtube-classic.mjs";

let serial = 0;
async function setup(t, settings = {}) {
  const old = { chrome: globalThis.chrome, fetch: globalThis.fetch, warn: console.warn };
  t.after(() => { globalThis.chrome = old.chrome; globalThis.fetch = old.fetch; console.warn = old.warn; });
  const stored = { "lakomics:translation:v1": {anthropicApiKey:"mock-key"}, ...settings };
  const messages = [];
  const removed = [];
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  let listener;
  globalThis.chrome = {
    storage: { local: {
      get: async (keys) => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in stored).map((key) => [key, stored[key]]))),
      set: async (values) => Object.assign(stored, structuredClone(values)),
      remove: async (key) => { removed.push(key); delete stored[key]; },
    } },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, getPlatformInfo: () => {} },
    tabs: { sendMessage: async (_tab, message) => { messages.push(structuredClone(message)); } },
  };
  loadWorker();
  const send = (message) => new Promise((resolve) => {
    assert.equal(listener(message, { tab: { id: 1 } }, resolve), true);
  });
  return { stored, messages, removed, warnings, send };
}

const response = (value, input_tokens = 3, output_tokens = 2) => ({ ok: true, json: async () => ({
  content: [{ type: "text", text: JSON.stringify(value) }], usage: { input_tokens, output_tokens },
}) });
const isGlossary = (body) => body.output_config.format.schema.required.includes("terms");

for (const provider of ["anthropic"]) {
  for (const failGlossary of [false, true]) {
    test(`${provider} background forwards metadata and fixed dictionary; glossary failure=${failGlossary}`, async (t) => {
      const userTerms = [{ source: "Jeff", korean: "내 제프" }, { source: "Niche", korean: "니치" }];
      const { send, stored } = await setup(t, { "lakomics:youtube:settings:provider": provider, "lakomics:youtube:settings:geminiKey": "mock-key", "lakomics:translation:v1": {anthropicApiKey:"mock-key", userTerms} });
      const calls = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        const system = body.system || body.systemInstruction.parts[0].text;
        const schema = body.output_config?.format.schema || body.generationConfig.responseJsonSchema;
        const glossary = schema.required.includes("terms");
        calls.push({ system, glossary });
        const value = glossary ? (failGlossary ? { invalid: true } : { register: "banmal", terms: [
          { source: "jeff", korean: "모델 제프" }, { source: "Jef", korean: "내 제프" },
        ] }) : { register: "banmal", lines: [{ from: 0, to: 0, text: "내 제프" }] };
        return provider === "anthropic" ? response(value) : { ok: true, json: async () => ({
          candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
        }) };
      };
      const request = { ...message("en:asr", 1), meta: { videoId: "resume-video", title: "Jeff visit", author: "Niche Channel", shortDescription: "Jeff is here", keywords: ["Jeff"] } };
      request.json3.events[0].segs[0].utf8 = "JEFF";
      assert.equal((await send(request)).ok, true);
      assert.equal(calls.length, 2);
      assert.match(calls[0].system, /Jeff visit/);
      assert.match(calls[0].system, /Niche Channel/);
      assert.match(calls[0].system, /user_dictionary/);
      assert.match(calls[0].system, /내 제프/);
      assert.match(calls[1].system, /Title: Jeff visit; Channel: Niche Channel/);
      assert.match(calls[1].system, /"source":"Jeff","korean":"내 제프"/);
      assert.doesNotMatch(calls[0].system, /니치/);
      assert.doesNotMatch(calls[1].system, /니치/);
      assert.doesNotMatch(calls[1].system, /모델 제프/);
      const saved = stored["lakomics:youtube:subs:v2:resume-video:en:asr:translate-ko-auto+t6"];
      assert.ok(saved);
      assert.deepEqual(saved.glossary, failGlossary ? [userTerms[0]] : [userTerms[0], { source: "Jef", korean: "내 제프" }]);
      calls.length = 0;
      assert.equal((await send({ ...request, trackKey: "ko:asr" })).ok, true);
      assert.equal(calls.length, 1);
      assert.doesNotMatch(calls[0].system, /video_context|Jeff visit|내 제프|user_dictionary/);
      calls.length = 0;
      assert.equal((await send({ ...request, videoId: "other-video" })).ok, true);
      assert.ok(calls.every(({ system }) => !/video_context|video_information|Jeff visit/.test(system)));
    });
  }
}
function message(trackKey = "en:asr", count = 450) {
  return { type: "youtube:process", videoId: "resume-video", trackKey, positionMs: 65000,
    json3: { events: [{ tStartMs: 0, dDurationMs: count * 300,
      segs: Array.from({ length: count }, (_, i) => ({ utf8: `w${i}`, tOffsetMs: i * 300 })) }] } };
}
function translated(body) {
  const numbered = body.messages[0].content.split("\n").filter((line) => /^\d+\t/.test(line));
  return { register: "banmal", lines: [{ from: 0, to: numbered.length - 1, text: "번역한 자막" }] };
}

test("large coverage gap retries instead of stretching a translation and logs why", async (t) => {
  const { send, messages, warnings } = await setup(t, { "lakomics:youtube:settings:register": "banmal" });
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isGlossary(body)) return response({ register: "banmal", terms: [] });
    calls.push(body);
    return response({ register: "banmal", lines: calls.length === 1
      ? [{ from: 0, to: 0, text: "처음" }, { from: 6, to: 9, text: "마지막" }]
      : [{ from: 0, to: 4, text: "앞부분을 번역했어요." }, { from: 5, to: 9, text: "뒷부분을 번역했어요." }] });
  };
  const result = await send(message("en:asr", 10));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /coverage problem/);
  assert.ok(warnings.some((text) => /more than 3 words.*retrying/.test(text)));
  assert.deepEqual(result.cues.map((cue) => cue.text), ["앞부분을 번역했어요.", "뒷부분을 번역했어요."]);
  assert.ok(messages.some((message) => message.type === "youtube:partial"));
});

test("existing cached long cues are display-safe on both cache reply paths without API calls", async (t) => {
  const cached = { cues: [{ startMs: 0, endMs: 18000, text: "긴 자막을 나눠 보여줘요. ".repeat(10) }], model: "test", createdAt: 1 };
  const { send } = await setup(t, { "lakomics:youtube:subs:v2:resume-video:ko:asr:clean+t6": cached,
    "lakomics:youtube:subs:index": { "resume-video": ["ko:asr|clean+t6"] } });
  globalThis.fetch = () => { throw new Error("cache must not fetch"); };
  const processed = await send(message("ko:asr", 1));
  const lookup = await send({ type: "youtube:getCached", videoId: "resume-video" });
  assert.equal(processed.ok, true);
  assert.ok(processed.cached);
  assert.ok(lookup.cached);
  for (const cues of [processed.cues, lookup.cached.cues]) {
    assert.ok(cues.length > 1);
    assert.ok(cues.every((cue) => cue.text.length <= 44 && cue.endMs - cue.startMs <= 7000.000001));
  }
});

test("glossary runs once upfront, then all chunks start concurrently; retry restores successes only", async (t) => {
  const { stored, messages, send } = await setup(t);
  const request = message();
  const chunks = chunkUnits(parseJson3(request.json3).units, 200);
  assert.equal(chunks.length, 3);
  const calls = [];
  const pending = [];
  let ready;
  const allStarted = new Promise((resolve) => { ready = resolve; });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (isGlossary(body)) return response({ register: "banmal", terms: [{ source: "Jeff", korean: "제프" }] }, 10, 5);
    return new Promise((resolve) => { pending.push({ body, resolve }); if (pending.length === chunks.length) ready(); });
  };
  const processing = send(request);
  await allStarted;
  assert.equal(calls.length, 4);
  assert.equal(calls[0].messages[0].content, chunks.flat().map((u) => u.text).join(" "));
  assert.ok(pending[0].body.messages[0].content.includes("0\tw200"));
  for (const { body, resolve } of pending) {
    // One stored register (the overview's) goes to every chunk as the default.
    assert.match(body.system, /default Korean speech register[^\n]*banmal = 반말/);
    assert.doesNotMatch(body.system, /exactly this Korean speech register/);
    assert.match(body.system, /"source":"Jeff","korean":"제프"/);
    if (body.messages[0].content.includes("0\tw200")) resolve({ ok: false, status: 400, json: async () => ({}) });
    else resolve(response(translated(body)));
  }
  const first = await processing;
  assert.equal(first.partialFailure, true);
  assert.ok(first.cues.every((c) => typeof c.orig === "string"));
  assert.ok(first.cues.slice(1).every((c, i) => first.cues[i].endMs <= c.startMs));
  const resumeKey = "lakomics:youtube:resume:v1:resume-video:translate-ko-auto+t6";
  const cacheKey = "lakomics:youtube:subs:v2:resume-video:en:asr:translate-ko-auto+t6";
  assert.deepEqual(Object.keys(stored[resumeKey].successful), ["0", "2"]);
  assert.equal(stored[resumeKey].register, "banmal");
  assert.equal(stored[cacheKey], undefined);
  assert.equal(stored["lakomics:youtube:usage:total"].input_tokens, 16);
  assert.equal(stored["lakomics:youtube:usage:total"].output_tokens, 9);
  messages.length = 0;
  let retries = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(isGlossary(body), false);
    assert.deepEqual(messages.filter((m) => m.type === "youtube:partial").map((m) => m.chunkIndex), [0, 2]);
    assert.deepEqual(messages.find((m) => m.type === "youtube:progress"), { type: "youtube:progress", videoId: request.videoId, done: 2, total: 3, mode: "translate-ko" });
    assert.ok(body.messages[0].content.includes("0\tw200"));
    assert.match(body.system, /"source":"Jeff","korean":"제프"/);
    // Resume skips the overview but keeps the register chosen in the first run.
    assert.match(body.system, /default Korean speech register[^\n]*banmal = 반말/);
    retries++;
    return response(translated(body));
  };
  const retried = await send(request);
  assert.equal(retries, 1);
  assert.equal(retried.ok, true);
  assert.equal(retried.partialFailure, undefined);
  assert.equal(stored[resumeKey], undefined);
  assert.deepEqual(stored[cacheKey].glossary, [{ source: "Jeff", korean: "제프" }]);
  assert.equal(stored[cacheKey].register, "banmal");
  assert.equal(stored["lakomics:youtube:usage:total"].input_tokens, 19);
  assert.equal(messages.filter((m) => m.type === "youtube:progress").at(-1).done, 3);
  assert.equal((await send(request)).cached, true);
  assert.equal(retries, 1);
});

for (const setting of ["auto", "haeyo", "hapnida", "banmal"]) {
  test(`glossary register respects ${setting} and its failures fall back without blocking chunks`, async (t) => {
    const { send, stored, warnings } = await setup(t, { "lakomics:youtube:settings:register": setting });
    let failGlossary = false;
    const calls = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (isGlossary(body)) return response(failGlossary ? { register: "invalid", terms: [] } : { register: "hapnida", terms: [] });
      return response(translated(body));
    };
    assert.equal((await send(message("en:asr", 1))).ok, true);
    // "auto" follows the speaker with the overview's register as the one default for the whole video.
    if (setting === "auto") assert.match(calls[1].system, /default Korean speech register[^\n]*hapnida = 합니다체/);
    else assert.match(calls[1].system, new RegExp(`exactly this Korean speech register.*${setting}`));
    assert.doesNotMatch(calls[1].system, /Use these Korean renderings/);
    failGlossary = true;
    const next = { ...message("en:asr", 1), videoId: "failed-glossary" };
    assert.equal((await send(next)).ok, true);
    // Overview failed: follow mode falls back to 해요체.
    if (setting === "auto") assert.match(calls[3].system, /default Korean speech register[^\n]*haeyo = 해요체/);
    else assert.match(calls[3].system, new RegExp(`exactly this Korean speech register.*${setting}`));
    assert.ok(warnings.some((s) => s.includes("glossary failed")));
    assert.equal(stored["lakomics:youtube:usage:total"].input_tokens, 12); // invalid glossary response still consumed tokens
  });
}

test("mismatched resume is deleted and clean mode skips glossary while polishing partial and final timings", async (t) => {
  const { stored, removed, messages, send } = await setup(t);
  const request = message("ko:asr", 1);
  const chunks = chunkUnits(parseJson3(request.json3).units, 200);
  const resumeKey = "lakomics:youtube:resume:v1:resume-video:clean+t6";
  stored[resumeKey] = createResumeRecord(chunks, [{ failed: false, cues: [{ startMs: 0, endMs: 300, text: "old" }] }], [], null, "ko:asr");
  request.json3.events[0].segs[0].utf8 = "changed";
  let count = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(isGlossary(body), false);
    assert.ok(removed.includes(resumeKey));
    count++;
    return response({ lines: [{ from: 0, to: 0, text: "changed" }] });
  };
  const result = await send(request);
  assert.equal(count, 1);
  assert.deepEqual(result.cues, [{ startMs: 0, endMs: 1200, text: "changed" }]);
  assert.deepEqual(messages.find((m) => m.type === "youtube:partial").cues, result.cues);
});

test("all failed chunks retain glossary for retry and count consumed usage", async (t) => {
  const { send, stored } = await setup(t);
  let fail = true;
  let glossaries = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isGlossary(body)) { glossaries++; return response({ register: "banmal", terms: [] }); }
    if (fail) return response({ bad: "missing lines" });
    return response(translated(body));
  };
  assert.equal((await send(message("en:asr", 1))).ok, false);
  assert.deepEqual(stored["lakomics:youtube:resume:v1:resume-video:translate-ko-auto+t6"].successful, {});
  assert.equal(stored["lakomics:youtube:usage:total"].input_tokens, 6);
  fail = false;
  assert.equal((await send(message("en:asr", 1))).ok, true);
  assert.equal(glossaries, 1);
  assert.equal(stored["lakomics:youtube:usage:total"].input_tokens, 9);
});

test("fatal errors wait for active chunks and preserve their success and usage for retry", async (t) => {
  const { stored, send } = await setup(t);
  let fatal = true;
  let glossaries = 0;
  let chunkCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isGlossary(body)) { glossaries++; return response({ register: "haeyo", terms: [] }); }
    chunkCalls++;
    if (fatal && body.messages[0].content.includes("0\tw200")) {
      return { ok: false, status: 401, json: async () => ({}) };
    }
    await new Promise((resolve) => setImmediate(resolve));
    return response(translated(body));
  };
  assert.equal((await send(message())).ok, false);
  assert.deepEqual(Object.keys(stored["lakomics:youtube:resume:v1:resume-video:translate-ko-auto+t6"].successful), ["0", "2"]);
  assert.equal(stored["lakomics:youtube:usage:total"].input_tokens, 9);
  fatal = false;
  assert.equal((await send(message())).ok, true);
  assert.equal(glossaries, 1);
  assert.equal(chunkCalls, 4);
});

for (const [label, initial, retry, expected] of [
  ['cleaner retry', [{ from: 0, to: 0, text: '링(りんご) 주스' }, { from: 1, to: 1, text: '風害' }],
    [{ from: 0, to: 0, text: '사과 주스' }, { from: 1, to: 1, text: '바람 피해' }], ['사과 주스', '바람 피해']],
  ['partly cleaner retry', [{ from: 0, to: 0, text: 'りんご' }, { from: 1, to: 1, text: '風害' }],
    [{ from: 0, to: 0, text: '사과 주스' }, { from: 1, to: 1, text: '風害' }], ['사과 주스', '風害']],
  ['equal retry rejected', [{ from: 0, to: 1, text: 'りんご' }],
    [{ from: 0, to: 1, text: 'カナ' }], ['りんご']],
  ['worse retry rejected', [{ from: 0, to: 1, text: 'りんご' }],
    [{ from: 0, to: 0, text: 'カナ' }, { from: 1, to: 1, text: '風害' }], ['りんご']],
  ['combined coverage and kana', [{ from: 1, to: 1, text: 'りんご' }],
    [{ from: 0, to: 1, text: '사과 주스' }], ['사과 주스']],
  ['combined still dirty retry rejected', [{ from: 1, to: 1, text: 'りんご' }],
    [{ from: 0, to: 1, text: 'カナ' }], ['りんご']],
  ['empty translation detects fallback text', [{ from: 0, to: 1, text: ' ' }],
    [{ from: 0, to: 1, text: '사과 주스' }], ['사과 주스']],
]) {
  test(`Japanese check after applyResult: ${label}, one retry and both usages counted`, async (t) => {
    const { send, stored, warnings } = await setup(t);
    const calls = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isGlossary(body)) return response({ register: 'banmal', terms: [{ source: 'りんご', korean: '사과' }] }, 10, 5);
      calls.push(body);
      return response({ lines: calls.length === 1 ? initial : retry, register: 'banmal' }, 3, 2);
    };
    const request = message('ja-JP:asr', 2);
    request.json3.events[0].segs[0].utf8 = 'りんご';
    const result = await send(request);
    assert.equal(result.ok, true);
    assert.deepEqual(result.cues.map((cue) => cue.text), expected);
    assert.equal(calls.length, 2);
    assert.match(calls[1].messages[0].content, /Korean Hangul only/);
    assert.match(calls[1].messages[0].content, /りんご/);
    assert.ok(calls[1].messages[0].content.startsWith(calls[0].messages[0].content + '\n\n'));
    assert.equal(calls[1].system, calls[0].system);
    assert.equal(calls[1].model, calls[0].model);
    assert.deepEqual(calls[1].output_config, calls[0].output_config);
    if (label.startsWith('combined')) assert.match(calls[1].messages[0].content, /coverage problem/);
    assert.ok(warnings.some((warning) => /kana\/CJK/.test(warning)));
    assert.deepEqual(stored['lakomics:youtube:usage:total'].byModel['claude-haiku-5-5'], { input_tokens: 16, output_tokens: 9 });
    assert.equal(stored['lakomics:youtube:usage:total'].videos, 1);
  });
}

test('coverage-only retry preserves Korean; clean mode does not retry kana', async (t) => {
  const { send } = await setup(t);
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isGlossary(body)) return response({ register: 'haeyo', terms: [] });
    calls.push(body);
    if (body.system.includes('natural, fluent Korean translation')) {
      return response({ lines: [{ from: calls.length === 1 ? 1 : 0, to: 1, text: '사과 주스' }] });
    }
    return response({ lines: [{ from: 0, to: 0, text: 'りんご' }] });
  };
  assert.equal((await send(message('ja:asr', 2))).ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[0].content, /coverage problem/);
  assert.doesNotMatch(calls[1].messages[0].content, /Korean Hangul only/);
  const clean = message('ko:asr', 1);
  clean.json3.events[0].segs[0].utf8 = 'りんご';
  assert.equal((await send(clean)).cues[0].text, 'りんご');
  assert.equal(calls.length, 3);
});

for (const on of [false, true]) {
  test(`Sonnet glossary option ${on}: model usage and all cache lookups follow effective flag`, async (t) => {
    const { send, stored } = await setup(t, { 'lakomics:youtube:settings:glossarySonnet': on });
    const calls = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return isGlossary(body) ? response({ register: 'banmal', terms: [] }, 10, 5) : response(translated(body), 3, 2);
    };
    const request = message('ja:asr', 1);
    assert.equal((await send(request)).ok, true);
    assert.equal(calls[0].model, on ? 'claude-sonnet-5-5' : 'claude-haiku-5-5');
    assert.equal(calls[1].model, 'claude-haiku-5-5');
    const usage = stored['lakomics:youtube:usage:total'];
    assert.deepEqual(usage.byModel['claude-haiku-5-5'], { input_tokens: on ? 3 : 13, output_tokens: on ? 2 : 7 });
    if (on) assert.deepEqual(usage.byModel['claude-sonnet-5-5'], { input_tokens: 10, output_tokens: 5 });
    assert.equal(usage.videos, 1);
    assert.equal(usage.input_tokens, 13);
    const cacheKey = `lakomics:youtube:subs:v2:resume-video:ja:asr:translate-ko-auto${on ? "+gs" : ""}+t6`;
    assert.ok(stored[cacheKey]);
    assert.equal((await send({ type: 'youtube:getCached', videoId: request.videoId })).cached.cues[0].text, '번역한 자막');
    assert.equal((await send(request)).cached, true);
    assert.equal(calls.length, 2);
    stored['lakomics:youtube:settings:glossarySonnet'] = !on;
    assert.equal((await send({ type: 'youtube:getCached', videoId: request.videoId })).cached, null);
    assert.equal((await send(request)).cached, false);
    assert.equal(calls.length, 4);
    assert.equal(calls[2].model, on ? 'claude-haiku-5-5' : 'claude-sonnet-5-5');
    assert.equal(calls[3].model, 'claude-haiku-5-5');
  });
}

test('failed Sonnet glossary keeps consumed usage under Sonnet and chunks under selected model', async (t) => {
  const { send, stored } = await setup(t, { 'lakomics:youtube:settings:glossarySonnet': true });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    return isGlossary(body) ? response({ register: 'invalid', terms: [] }, 10, 5) : response(translated(body), 3, 2);
  };
  assert.equal((await send(message('ja:asr', 1))).ok, true);
  assert.deepEqual(stored['lakomics:youtube:usage:total'].byModel, {
    'claude-sonnet-5-5': { input_tokens: 10, output_tokens: 5 },
    'claude-haiku-5-5': { input_tokens: 3, output_tokens: 2 },
  });
});

test('failed Japanese cleanup retry keeps first response and counts invalid response usage', async (t) => {
  const { send, stored, warnings } = await setup(t);
  let chunks = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isGlossary(body)) return response({ register: 'haeyo', terms: [] }, 10, 5);
    chunks++;
    return response(chunks === 1 ? { lines: [{ from: 0, to: 0, text: 'りんご' }] } : { invalid: true }, 3, 2);
  };
  assert.equal((await send(message('ja:asr', 1))).cues[0].text, 'りんご');
  assert.equal(chunks, 2);
  assert.ok(warnings.some((warning) => /retry failed/.test(warning)));
  assert.deepEqual(stored['lakomics:youtube:usage:total'].byModel['claude-haiku-5-5'], { input_tokens: 16, output_tokens: 9 });
});

test('Sonnet glossary resume uses +gs and clean mode skips glossary', async (t) => {
  const { send, stored } = await setup(t, { 'lakomics:youtube:settings:glossarySonnet': true });
  let fail = true;
  let glossaries = 0;
  let chunks = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isGlossary(body)) { glossaries++; assert.equal(body.model, 'claude-sonnet-5-5'); return response({ register: 'haeyo', terms: [] }); }
    chunks++;
    assert.equal(body.model, 'claude-haiku-5-5');
    return response(fail ? { invalid: true } : translated(body));
  };
  assert.equal((await send(message('ja:asr', 1))).ok, false);
  assert.ok(stored['lakomics:youtube:resume:v1:resume-video:translate-ko-auto+gs+t6']);
  fail = false;
  assert.equal((await send(message('ja:asr', 1))).ok, true);
  assert.equal(glossaries, 1);
  assert.equal(stored['lakomics:youtube:resume:v1:resume-video:translate-ko-auto+gs+t6'], undefined);
  assert.equal((await send(message('ko:asr', 1))).ok, true);
  assert.equal(glossaries, 1);
  assert.equal(chunks, 3);
  assert.ok(stored['lakomics:youtube:subs:v2:resume-video:ko:asr:clean+t6']);
});

test("stored mode differs by register setting and carries the +t6 processing version", async (t) => {
  await setup(t);
  const { storedModeFor } = globalThis.LakomicsYouTubeService;
  const base = { translate: true, speakers: false, glossarySonnet: false, model: "claude-haiku-5-5" };
  const follow = storedModeFor("en:asr", { ...base, registerSetting: "auto" });
  const fixed = storedModeFor("en:asr", { ...base, registerSetting: "haeyo" });
  assert.equal(follow, "translate-ko-auto+t6");
  assert.equal(fixed, "translate-ko-haeyo+t6");
  assert.notEqual(follow, fixed);
  assert.equal(storedModeFor("ko:asr", { ...base, registerSetting: "haeyo" }), "clean+t6");
});

test("follow mode gives every chunk the same stored register; fixed modes are unaffected", async (t) => {
  for (const [setting, overview] of [["auto", "hapnida"], ["haeyo", "banmal"], ["banmal", "hapnida"]]) {
    const { send, stored } = await setup(t, { "lakomics:youtube:settings:register": setting });
    const chunkSystems = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isGlossary(body)) return response({ register: overview, terms: [] });
      chunkSystems.push(body.system);
      return response({ ...translated(body), register: "banmal" });
    };
    const request = { ...message("en:asr"), videoId: `register-${setting}` };
    assert.equal((await send(request)).ok, true);
    assert.equal(chunkSystems.length, 3);
    for (const system of chunkSystems) {
      if (setting === "auto") {
        assert.match(system, /default Korean speech register[^\n]*hapnida = 합니다체/);
        assert.match(system, /Switch only for a clearly different speaker or for quoted speech/);
        assert.doesNotMatch(system, /exactly this Korean speech register/);
      } else {
        assert.match(system, new RegExp(`exactly this Korean speech register for every line: ${setting}`));
        assert.doesNotMatch(system, /default Korean speech register/);
      }
    }
    // The saved record keeps the choice, not whatever a chunk reported.
    const [entry] = Object.entries(stored).filter(([key]) => key.startsWith(`lakomics:youtube:subs:v2:register-${setting}:`));
    assert.equal(entry[1].register, setting === "auto" ? "hapnida" : setting);
  }
});

test("follow mode resume keeps a stored register without asking the overview again, and falls back to haeyo when none was stored", async (t) => {
  const { send, stored } = await setup(t);
  const request = { ...message("en:asr"), videoId: "register-resume" };
  const chunks = chunkUnits(parseJson3(request.json3).units, 200);
  const resumeKey = "lakomics:youtube:resume:v1:register-resume:translate-ko-auto+t6";
  const record = createResumeRecord(chunks, [{ failed: false, cues: [{ startMs: 0, endMs: 300, text: "a" }] }], [], "hapnida", "en:asr");
  stored[resumeKey] = record;
  const systems = [];
  let glossaries = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isGlossary(body)) { glossaries++; return response({ register: "banmal", terms: [] }); }
    systems.push(body.system);
    return response(translated(body));
  };
  assert.equal((await send(request)).ok, true);
  assert.equal(glossaries, 0);
  assert.equal(systems.length, 2);
  for (const system of systems) assert.match(system, /default Korean speech register[^\n]*hapnida = 합니다체/);

  // A resume record without a register (the overview never answered) gets the 해요체 fallback.
  const second = { ...request, videoId: "register-resume-null" };
  stored["lakomics:youtube:resume:v1:register-resume-null:translate-ko-auto+t6"] = { ...record, register: null };
  systems.length = 0;
  assert.equal((await send(second)).ok, true);
  assert.equal(glossaries, 0);
  for (const system of systems) assert.match(system, /default Korean speech register[^\n]*haeyo = 해요체/);
});

test("each translate chunk request carries the previous and the following words as read-only context", async (t) => {
  const { send } = await setup(t, { "lakomics:youtube:settings:register": "banmal" });
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isGlossary(body)) return response({ register: "banmal", terms: [] });
    bodies.push(body);
    return response(translated(body));
  };
  const request = message();
  const chunks = chunkUnits(parseJson3(request.json3).units, 200);
  assert.equal((await send(request)).ok, true);
  assert.equal(bodies.length, chunks.length);
  const users = chunks.map((chunk) => bodies.find((body) => body.messages[0].content.includes(`0\t${chunk[0].text}\n`)).messages[0].content);
  const following = (user) => user.split("Following context (do not translate, not numbered):\n")[1];
  const nextWords = (index, count) => chunks.slice(index + 1).flat().slice(0, count).map((unit) => unit.text).join(" ");
  assert.doesNotMatch(users[0], /Previous context/);
  assert.equal(following(users[0]), nextWords(0, 80));
  assert.match(users[1], /Previous context/);
  assert.equal(following(users[1]), nextWords(1, 80));
  assert.match(users[2], /Previous context/);
  assert.doesNotMatch(users[2], /Following context/);
  for (const body of bodies) assert.match(body.system, /Following context \(do not translate, not numbered\)/);
});
