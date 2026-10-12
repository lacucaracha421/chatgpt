import { loadWorker } from "./helpers/youtube-classic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { callChunk, callGlossaryFor } from "./helpers/youtube-classic.mjs";
import { buildGlossaryPrompt, sampleTranscript, EXCERPT_SEPARATOR } from "./helpers/youtube-classic.mjs";

function fakeClock() {
  let time = 0, id = 0;
  const timers = new Map();
  const clock = {
    now: () => time,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: time + ms }); return key; },
    clearTimeout(key) { timers.delete(key); },
  };
  async function finish(promise) {
    let settled = false, value, error;
    promise.then((result) => { value = result; settled = true; }, (err) => { error = err; settled = true; });
    for (let i = 0; i < 40 && !settled; i++) {
      for (let j = 0; j < 60; j++) await Promise.resolve();
      if (settled) break;
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, "pending work must have a deadline");
      timers.delete(next[0]); time = next[1].at; next[1].fn();
    }
    assert.ok(settled, "work must terminate within its budget");
    assert.equal(timers.size, 0, "no leaked deadline timers");
    if (error) throw error;
    return value;
  }
  return { clock, finish, sleep: async (ms) => { time += ms; } };
}

for (const provider of ["anthropic"]) {
  for (const kind of ["chunk", "glossary"]) {
    for (const phase of ["fetch", "body", "error body"]) {
      test(`${provider} ${kind} aborts stalled ${phase} and caps all retries`, async (t) => {
        const oldFetch = globalThis.fetch;
        t.after(() => { globalThis.fetch = oldFetch; });
        const { clock, finish, sleep } = fakeClock();
        const starts = [], signals = [];
        globalThis.fetch = async (_, init) => {
          starts.push(clock.now()); signals.push(init.signal);
          if (phase === "fetch") return new Promise(() => {});
          return { ok: phase === "body", status: 500, json: () => new Promise(() => {}) };
        };
        const call = kind === "chunk" ? callChunk : callGlossaryFor;
        const job = call(provider, { apiKey: "fake", model: "fake", chunk: [], transcript: "hello", clock, sleep });
        await assert.rejects(finish(job), (err) => err.code === "timeout" && err.retryable && /시간/.test(err.message));
        assert.deepEqual(starts, kind === "chunk" ? [0, 91000] : [0, 26000]);
        assert.equal(clock.now(), kind === "chunk" ? 150000 : 30000);
        assert.ok(signals.every((signal) => signal.aborted));
      });
    }
  }
  test(`${provider} normalizes external AbortError and retries`, async (t) => {
    const oldFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = oldFetch; });
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw Object.assign(new Error("private"), { name: "AbortError" }); };
    await assert.rejects(callChunk(provider, { apiKey: "fake", model: "fake", chunk: [], sleep: async () => {} }),
      (err) => err.code === "timeout" && !err.message.includes("private"));
    assert.equal(calls, 3);
  });
}

test("glossary transcript is limited to about 8000 words in evenly spread excerpts with existing metadata caps", () => {
  const words = Array.from({ length: 24000 }, (_, i) => `word${i}`);
  const prompt = buildGlossaryPrompt({ transcript: words.join(" "), meta: { title: "x".repeat(2000) } });
  const excerpts = prompt.userText.split(EXCERPT_SEPARATOR);
  assert.ok(excerpts.length > 1);
  assert.equal(excerpts.flatMap((excerpt) => excerpt.split(" ")).length, 8000);
  assert.equal(excerpts[0].split(" ")[0], "word0");
  assert.equal(excerpts.at(-1).split(" ").at(-1), "word23999");
  assert.match(prompt.system, /several excerpts/);
  assert.ok(!prompt.system.includes("x".repeat(501)));
});

test("sampleTranscript returns a short transcript unchanged", () => {
  const short = Array.from({ length: 8000 }, (_, i) => `w${i}`).join(" ");
  assert.equal(sampleTranscript(short), short);
  assert.equal(sampleTranscript("  two  words \n"), "  two  words \n");
  assert.doesNotMatch(buildGlossaryPrompt({ transcript: short }).system, /several excerpts/);
});

test("sampleTranscript takes contiguous excerpts spread over the whole video, deterministically", () => {
  for (const length of [8001, 10000, 24000, 100000]) {
    const words = Array.from({ length }, (_, i) => `w${i}`);
    const transcript = words.join(" ");
    const sampled = sampleTranscript(transcript);
    assert.equal(sampled, sampleTranscript(transcript));
    const excerpts = sampled.split(EXCERPT_SEPARATOR).map((excerpt) => excerpt.split(" "));
    const total = excerpts.reduce((sum, excerpt) => sum + excerpt.length, 0);
    assert.ok(total <= 8000 && total >= 7900, `total ${total}`);
    assert.ok(excerpts.length >= 10);
    assert.equal(excerpts[0][0], "w0");
    assert.equal(excerpts.at(-1).at(-1), `w${length - 1}`);
    let previousEnd = -1;
    for (const excerpt of excerpts) {
      assert.ok(excerpt.length >= 300 && excerpt.length <= 500);
      const start = Number(excerpt[0].slice(1));
      // a contiguous run of the original, in order and without overlap
      excerpt.forEach((word, i) => assert.equal(word, words[start + i]));
      assert.ok(start > previousEnd);
      previousEnd = start + excerpt.length - 1;
    }
    // evenly spread: the starts are one stride apart, give or take rounding
    const starts = excerpts.map((excerpt) => Number(excerpt[0].slice(1)));
    const gaps = starts.slice(1).map((start, i) => start - starts[i]);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1);
  }
});

for (const provider of ["anthropic"]) {
  test(`${provider} glossary deadline continues to chunks with user terms and the follow-the-speaker register`, async (t) => {
    const original = { fetch: globalThis.fetch, chrome: globalThis.chrome, setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout, now: Date.now };
    t.after(() => {
      globalThis.fetch = original.fetch; globalThis.chrome = original.chrome;
      globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout; Date.now = original.now;
    });
    const { clock, finish } = fakeClock();
    let listener;
    const stored = { "lakomics:youtube:settings:provider": provider, "lakomics:translation:v1": {anthropicApiKey:"fake"}, "lakomics:youtube:settings:geminiKey": "fake",
      "lakomics:translation:v1": {anthropicApiKey:"fake", userTerms:[{ source: "Jeff", korean: "제프" }]} };
    globalThis.chrome = { storage: { local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]])),
      set: async (values) => Object.assign(stored, values), remove: async () => {},
    } }, runtime: { getPlatformInfo() {}, onMessage: { addListener(fn) { listener = fn; } } }, tabs: { sendMessage: async () => {} } };
    loadWorker();
    globalThis.setTimeout = clock.setTimeout; globalThis.clearTimeout = clock.clearTimeout; Date.now = clock.now;
    const chunks = [], glossarySignals = [];
    globalThis.fetch = async (_, init) => {
      const body = JSON.parse(init.body);
      const schema = body.output_config?.format.schema || body.generationConfig.responseJsonSchema || body.generationConfig.responseFormat.text.schema;
      if (schema.required.includes("terms")) { glossarySignals.push(init.signal); return new Promise(() => {}); }
      chunks.push(body);
      const text = JSON.stringify({ lines: [{ from: 0, to: 0, text: "제프" }], register: "haeyo" });
      return { ok: true, json: async () => provider === "anthropic" ? { content: [{ type: "text", text }], usage: {} }
        : { candidates: [{ content: { parts: [{ text }] } }] } };
    };
    const job = new Promise((resolve) => listener({ type: "youtube:process", videoId: "deadline-video", trackKey: "en:asr",
      json3: { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Jeff" }] }] } }, {}, resolve));
    assert.equal((await finish(job)).ok, true);
    assert.equal(chunks.length, 1);
    assert.equal(clock.now(), 30000);
    assert.ok(glossarySignals.every((signal) => signal.aborted));
    const system = chunks[0].system || chunks[0].systemInstruction.parts[0].text;
    // The overview never answered: follow mode falls back to 해요체 as the video's default register.
    assert.match(system, /default Korean speech register[^\n]*haeyo = 해요체/);
    assert.match(system, /Return the default register \("haeyo"\)/);
    assert.doesNotMatch(system, /exactly this Korean speech register/);
    assert.match(system, /"source":"Jeff","korean":"제프"/);
  });
}
