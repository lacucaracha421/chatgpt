import { loadWorker, parseJson3, applyResult, fallbackSegment, chunkUnits, finalizeTimings } from "./helpers/youtube-classic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const choice = globalThis.LakomicsYouTube.asrChoice;
const localAsr = globalThis.LakomicsYouTube.localAsr;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const fixtureText = await readFile(new URL("./fixtures/youtube/kotoba-ja-first-minute.json3", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../src/youtube/content.js", import.meta.url), "utf8");
const choiceSource = await readFile(new URL("../src/youtube/asr-choice.js", import.meta.url), "utf8");

// ---------------------------------------------------------------- which videos get the PC's recognition

const ja = (kind) => ({ languageCode: "ja", kind });
const jaMeta = { videoId: "v", title: "【マイクラ】初めての建築ゲーム実況", author: "ゆっくり実況", shortDescription: "今日はみんなで家を建てます", keywords: [] };
const enMeta = { videoId: "v", title: "How to build a house", author: "Builder", shortDescription: "Today we build a house together", keywords: [] };

test("track choice: human Japanese captions always win; Japanese auto-captions or no captions use the PC", () => {
  const wants = (input) => choice.wantsLocalAsr({ enabled: true, ...input });
  // YouTube only has the automatic Japanese track.
  assert.equal(wants({ tracks: [ja("asr")], spoken: "ja" }), true);
  assert.equal(wants({ tracks: [{ languageCode: "ja-JP", kind: "asr" }], spoken: "ja-JP" }), true);
  // A human Japanese track (std, or no kind) wins, with or without the automatic one.
  assert.equal(wants({ tracks: [ja("asr"), ja("std")], spoken: "ja" }), false);
  assert.equal(wants({ tracks: [ja(null)], spoken: null }), false);
  // A human track in another language does not stop it: the speech is still Japanese.
  assert.equal(wants({ tracks: [ja("asr"), { languageCode: "en", kind: "std" }], spoken: "ja" }), true);
  // Other spoken languages, or a human-only list without an automatic track, are left alone.
  assert.equal(wants({ tracks: [{ languageCode: "en", kind: "asr" }], spoken: "en" }), false);
  assert.equal(wants({ tracks: [{ languageCode: "en", kind: "std" }], spoken: null, meta: jaMeta }), false);
  // No captions at all: the page metadata decides.
  assert.equal(wants({ tracks: [], spoken: null, meta: jaMeta }), true);
  assert.equal(wants({ tracks: [], spoken: null, meta: enMeta }), false);
  assert.equal(wants({ tracks: [], spoken: null, meta: null }), false);
  // Unknown track list (the player had none to tell), or the setting off.
  assert.equal(wants({ tracks: null, spoken: null, meta: jaMeta }), false);
  assert.equal(choice.wantsLocalAsr({ enabled: false, tracks: [ja("asr")], spoken: "ja" }), false);
});

test("the Kotoba track key fits the server cache and is not a human or ':asr' key", () => {
  assert.equal(choice.TRACK_KEY, "kotoba:ja");
  assert.equal(globalThis.LakomicsYouTube.serverCache.validIdentity("zuMy38hC5eU", choice.TRACK_KEY, "translate-ko-auto+t8"), true);
  assert.equal(choice.TRACK_KEY.endsWith(":asr"), false);
});

// ---------------------------------------------------------------- the server's json3 through parseJson3

test("a Kotoba json3 fixture parses into units that all carry a start and most a real end", () => {
  const { units, endMs } = parseJson3(fixtureText);
  const events = JSON.parse(fixtureText).events;
  assert.equal(units.length, events.length);
  assert.ok(units.length > 40);
  assert.deepEqual(units.slice(0, 3).map((u) => [u.text, u.startMs, u.endMs]), [["あ、", 0, 220], ["そうじゃん、", 660, 1100], ["配信前にやって", 1100, 2100]]);
  assert.ok(units.every((u, i) => u.endMs >= u.startMs && (i === 0 || u.startMs >= units[i - 1].startMs)));
  assert.ok(units.filter((u) => u.endMs > u.startMs).length >= units.length * 0.9);
  assert.equal(endMs, Math.max(...units.map((u) => u.endMs)));
  // Many units, each about a few characters: chunks stay near the intended size.
  assert.ok(chunkUnits(units, 200).every((chunk) => chunk.length <= 200));
});

test("Kotoba units follow the word rule: a stretched last word is capped, a human track keeps it", () => {
  const stretched = { events: [{ tStartMs: 1000, dDurationMs: 9000, segs: [{ utf8: "こんにちは" }] }] };
  const { units } = parseJson3(stretched);
  assert.deepEqual([units[0].startMs, units[0].endMs], [1000, 10000]);
  const lines = [{ from: 0, to: 0, text: "안녕하세요" }];
  const word = applyResult(units, lines, { mode: "translate-ko", human: false });
  const human = applyResult(units, lines, { mode: "translate-ko", human: true });
  assert.equal(word[0].endMs, 1000 + 250 + 60 * 5);
  assert.equal(human.at(-1).endMs, 10000);
  assert.ok(finalizeTimings(word)[0].endMs < 3000);
  assert.equal(fallbackSegment(units, { mode: "clean" })[0].endMs, 1000 + 250 + 60 * 5);
});

// ---------------------------------------------------------------- worker: processing and cache ranking

function workerSetup(t) {
  const old = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => { globalThis.chrome = old.chrome; globalThis.fetch = old.fetch; });
  const stored = { "lakomics:translation:v1": { anthropicApiKey: "mock-key" } };
  let listener;
  globalThis.chrome = {
    storage: { local: {
      get: async (keys) => structuredClone(Object.fromEntries((keys === null ? Object.keys(stored) : Array.isArray(keys) ? keys : [keys]).filter((key) => key in stored).map((key) => [key, stored[key]]))),
      set: async (values) => Object.assign(stored, structuredClone(values)),
      remove: async (key) => { for (const k of Array.isArray(key) ? key : [key]) delete stored[k]; },
    } },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, getPlatformInfo: () => {} },
    tabs: { sendMessage: async () => {} },
  };
  const service = loadWorker();
  const send = (message, sender = {}) => new Promise((resolve) => { listener(message, { tab: { id: 1 }, ...sender }, resolve); });
  return { stored, send, service };
}
const reply = (value) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(value) }], usage: { input_tokens: 3, output_tokens: 2 } }) });
const isGlossary = (body) => body.output_config.format.schema.required.includes("terms");
const answer = (_url, init) => {
  const body = JSON.parse(init.body);
  return reply(isGlossary(body) ? { register: "banmal", terms: [] } : { register: "banmal", lines: [{ from: 0, to: 0, text: "안녕하세요" }] });
};
const process = (trackKey) => ({ type: "youtube:process", videoId: "zuMy38hC5eU", trackKey, positionMs: 0,
  json3: { events: [{ tStartMs: 1000, dDurationMs: 9000, segs: [{ utf8: "こんにちは" }] }] } });

test("a kotoba:ja track is translated, stored under its own key, and ends its cue with the word rule", async (t) => {
  const { stored, send } = workerSetup(t);
  globalThis.fetch = async (url, init) => answer(url, init);
  const result = await send(process("kotoba:ja"));
  await tick();
  assert.equal(result.ok, true);
  assert.ok(result.cues.at(-1).endMs < 4000, `ends at ${result.cues.at(-1).endMs}`);
  assert.ok(stored["lakomics:youtube:subs:v2:zuMy38hC5eU:kotoba:ja:translate-ko-auto+t8"]);
  assert.deepEqual(stored["lakomics:youtube:subs:index"].zuMy38hC5eU, ["kotoba:ja|translate-ko-auto+t8"]);
  const human = await send(process("ja:std"));
  assert.ok(human.cues.at(-1).endMs >= 7000, `human track ends at ${human.cues.at(-1).endMs}`);
});

test("getCached shows the PC's result before YouTube's automatic one", async (t) => {
  const { stored, send } = workerSetup(t);
  const entry = (text) => ({ cues: [{ startMs: 0, endMs: 900, text }], model: "m", createdAt: 1 });
  const mode = "translate-ko-auto+t8";
  stored["lakomics:youtube:subs:index"] = { zuMy38hC5eU: [`ja:asr|${mode}`, `kotoba:ja|${mode}`, `ja:std|${mode}`] };
  stored[`lakomics:youtube:subs:v2:zuMy38hC5eU:ja:asr:${mode}`] = entry("자동 자막");
  stored[`lakomics:youtube:subs:v2:zuMy38hC5eU:kotoba:ja:${mode}`] = entry("PC 받아쓰기");
  stored[`lakomics:youtube:subs:v2:zuMy38hC5eU:ja:std:${mode}`] = entry("사람 자막");
  const page = { id: "test", frameId: 0, url: "https://www.youtube.com/watch?v=zuMy38hC5eU", tab: { id: 1 } };
  let cached = (await send({ type: "youtube:getCached", videoId: "zuMy38hC5eU" }, page)).cached;
  assert.equal(cached.trackKey, "kotoba:ja");
  delete stored[`lakomics:youtube:subs:v2:zuMy38hC5eU:kotoba:ja:${mode}`];
  stored["lakomics:youtube:subs:index"] = { zuMy38hC5eU: [`ja:asr|${mode}`, `ja:std|${mode}`] };
  cached = (await send({ type: "youtube:getCached", videoId: "zuMy38hC5eU" }, page)).cached;
  assert.equal(cached.trackKey, "ja:asr");
});

test("the setting defaults on, is a boolean, and an old stored value set never needs it", async () => {
  const { DEFAULTS, normalize } = await import("./helpers/youtube-classic.mjs");
  assert.equal(DEFAULTS.localAsr, true);
  assert.equal(normalize({}).localAsr, true);
  assert.equal(normalize({ localAsr: false }).localAsr, false);
  assert.equal(normalize({ localAsr: "no" }).localAsr, true);
});

// ---------------------------------------------------------------- worker: talking to the PC server

const PAGE = { id: "test", frameId: 0, url: "https://www.youtube.com/watch?v=zuMy38hC5eU", tab: { id: 1 } };
const OPTIONS = { id: "test", frameId: 0, url: "chrome-extension://test/options/options.html" };
const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) });

function serverSetup(t, serve) {
  const old = globalThis.fetch;
  t.after(() => { globalThis.fetch = old; });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers, body: init.body, signal: init.signal });
    return serve(new URL(url).pathname, init);
  };
  return calls;
}

test("health: a running server is available; refusal, a bad answer and a timeout mean not available, quickly", async (t) => {
  let mode = "up";
  const calls = serverSetup(t, async (path, init) => {
    if (mode === "refused") throw new TypeError("Failed to fetch");
    if (mode === "bad") return json({ ok: false });
    if (mode === "status") return json({}, 500);
    if (mode === "hang") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    return json({ ok: true, model: "kotoba", busy: false });
  });
  assert.deepEqual(await localAsr.handle({ op: "health" }), { ok: true, available: true });
  assert.equal(calls[0].url, "http://127.0.0.1:39125/health");
  assert.equal(calls[0].headers["X-Lakomics-Asr"], "1");
  for (const failure of ["refused", "bad", "status"]) {
    mode = failure;
    assert.deepEqual(await localAsr.handle({ op: "health" }), { ok: true, available: false }, failure);
  }
  mode = "hang";
  const started = Date.now();
  assert.deepEqual(await localAsr.handle({ op: "health" }), { ok: true, available: false });
  assert.ok(Date.now() - started < 2500, "the health probe gives up after about 800 ms");
});

test("start, status and json3 are forwarded for a valid video id only; results are checked", async (t) => {
  const calls = serverSetup(t, async (path, init) => {
    if (path === "/jobs" && init.method === "POST") return json({ state: "queued", progress: 0 });
    if (path === "/jobs/zuMy38hC5eU") return json({ state: "transcribing", progress: 0.42 });
    if (path === "/jobs/zuMy38hC5eU/json3") return { ok: true, text: async () => fixtureText };
    if (path === "/jobs/errorvideo1") return json({ state: "error", progress: 0.1, error: "x".repeat(500) });
    if (path === "/jobs/weirdvideo1") return json({ state: "exploded" });
    if (path === "/jobs/emptyvideo1/json3") return { ok: true, text: async () => "{\"nope\":1}" };
    return json({}, 404);
  });
  assert.deepEqual(await localAsr.handle({ op: "start", videoId: "zuMy38hC5eU" }), { ok: true, state: "queued", progress: 0 });
  assert.deepEqual(JSON.parse(calls[0].body), { videoId: "zuMy38hC5eU" });
  assert.deepEqual(await localAsr.handle({ op: "status", videoId: "zuMy38hC5eU" }), { ok: true, state: "transcribing", progress: 0.42 });
  const result = await localAsr.handle({ op: "json3", videoId: "zuMy38hC5eU" });
  assert.equal(result.ok, true);
  assert.equal(result.text, fixtureText);
  const failed = await localAsr.handle({ op: "status", videoId: "errorvideo1" });
  assert.equal(failed.state, "error");
  assert.equal(failed.error.length, 200);
  assert.deepEqual(await localAsr.handle({ op: "status", videoId: "weirdvideo1" }), { ok: false });
  assert.deepEqual(await localAsr.handle({ op: "json3", videoId: "emptyvideo1" }), { ok: false });
  assert.deepEqual(await localAsr.handle({ op: "status", videoId: "unknownvid1" }), { ok: false });
  const before = calls.length;
  for (const message of [{ op: "start", videoId: "../x" }, { op: "start", videoId: "a b c d e f" }, { op: "status" }, { op: "other", videoId: "zuMy38hC5eU" }, { op: "start", videoId: "https://youtu.be/abcdefghijk" }])
    assert.deepEqual(await localAsr.handle(message), { ok: false, code: "invalid_request" });
  assert.equal(calls.length, before);
});

test("youtube:asr only answers YouTube pages, never the options page or other senders", async (t) => {
  const { send } = workerSetup(t);
  const calls = serverSetup(t, async () => json({ ok: true, model: "kotoba", busy: false }));
  assert.deepEqual(await send({ type: "youtube:asr", op: "health" }, PAGE), { ok: true, available: true });
  assert.deepEqual(await send({ type: "youtube:asr", op: "health" }, OPTIONS), { ok: false, code: "invalid_request" });
  assert.deepEqual(await send({ type: "youtube:asr", op: "health" }, { id: "other", frameId: 0, url: "https://example.com/" }), { ok: false, code: "forbidden_sender" });
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- content: choosing and following the PC's job

function contentHarness({ tracks = [ja("asr")], spoken = "ja", meta = null, setting, replies, noCaptions = false, videoId = "v" } = {}) {
  const toasts = [], messages = [], calls = { captions: 0 };
  let currentId = videoId;
  const window = { location: { origin: "https://www.youtube.com", get href() { return `https://www.youtube.com/watch?v=${currentId}`; } },
    addEventListener() {}, postMessage() {} };
  const context = vm.createContext({ window, URL, crypto: globalThis.crypto, Element: class {}, toasts, messages, calls, replies, console: { info() {}, warn() {} },
    document: { getElementById: () => null, activeElement: null, querySelector: () => null },
    setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout() {},
    chrome: { storage: { onChanged: { addListener() {} }, local: { get: async () => (setting === undefined ? {} : { "lakomics:youtube:settings:localAsr": setting }) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } } });
  vm.runInContext(choiceSource, context);
  vm.runInContext(contentSource.split("  // ---------------------------------------------------------------- start")[0] + `
    renderButton = applyMode = hideToast = () => {};
    showToast = (text) => toasts.push(text);
    getTrackChoice = async () => ({ spoken: ${JSON.stringify(spoken)}, track: null, tracks: ${JSON.stringify(tracks)} });
    fetchMeta = async () => (${JSON.stringify(meta)});
    acquireCaptionTrack = async () => { calls.captions++; if (${noCaptions}) throw new UserError(NO_CAPTIONS); return { trackKey: "ja:asr", text: "{\\"events\\":[]}" }; };
    sendToBackground = async (message) => { messages.push(message); return replies(message); };
    globalThis.hook = { state, acquireTrack, UserError };
  })();`, context);
  const hook = context.hook;
  hook.state.videoId = videoId; hook.state.status = "processing"; hook.state.busyVisible = true;
  return { hook, toasts, messages, calls, changeVideo: (id) => { currentId = id; }, ready: tick() };
}

// A server that reports the given states in turn, then the finished result.
const script = (states, extra = {}) => {
  const queue = [...states];
  return (message) => {
    if (message.op === "health") return { ok: true, available: true };
    if (message.op === "start") return queue.shift();
    if (message.op === "status") return queue.shift() || { ok: false };
    if (message.op === "json3") return extra.json3 || { ok: true, text: fixtureText };
    return { ok: false };
  };
};
const job = (state, progress = 0) => ({ ok: true, state, progress });

test("content: Japanese auto-captions go to the PC, progress shows as a percentage without repeats, then the Kotoba track is used", async () => {
  const h = contentHarness({ replies: script([job("queued"), job("downloading", 0), job("transcribing", 0.1), job("transcribing", 0.1), job("transcribing", 0.5), job("done", 1)]) });
  await h.ready;
  const track = await h.hook.acquireTrack("v");
  assert.equal(track.trackKey, "kotoba:ja");
  assert.equal(track.text, fixtureText);
  assert.equal(h.calls.captions, 0);
  assert.deepEqual(h.messages.map((m) => m.op), ["health", "start", "status", "status", "status", "status", "status", "json3"]);
  assert.ok(h.messages.every((m) => m.type === "youtube:asr" && (m.op === "health" || m.videoId === "v")));
  assert.deepEqual(h.toasts, ["PC에서 받아쓰는 중… 0%", "PC에서 받아쓰는 중… 10%", "PC에서 받아쓰는 중… 50%"]);
});

test("content: a result the PC already holds (also a re-translation) is fetched without polling", async () => {
  const h = contentHarness({ replies: script([job("done", 1)]) });
  await h.ready;
  const track = await h.hook.acquireTrack("v");
  assert.equal(track.trackKey, "kotoba:ja");
  assert.deepEqual(h.messages.map((m) => m.op), ["health", "start", "json3"]);
  assert.deepEqual(h.toasts, ["PC에서 받아쓰는 중… 0%"]);
});

test("content: an unreachable server falls back to YouTube's captions silently", async () => {
  for (const unavailable of [{ ok: true, available: false }, { ok: false }, null]) {
    const h = contentHarness({ replies: () => unavailable });
    await h.ready;
    const track = await h.hook.acquireTrack("v");
    assert.equal(track.trackKey, "ja:asr");
    assert.deepEqual(h.messages.map((m) => m.op), ["health"]);
    assert.deepEqual(h.toasts, []);
  }
});

test("content: the setting off, a human Japanese track or another language keep today's behaviour", async () => {
  const cases = [
    { setting: false, replies: script([job("done", 1)]) },
    { tracks: [ja("asr"), ja("std")], replies: script([job("done", 1)]) },
    { tracks: [{ languageCode: "en", kind: "asr" }], spoken: "en", replies: script([job("done", 1)]) },
    { tracks: [], spoken: null, meta: enMeta, replies: script([job("done", 1)]) },
  ];
  for (const options of cases) {
    const h = contentHarness(options);
    await h.ready;
    const track = await h.hook.acquireTrack("v");
    assert.equal(track.trackKey, "ja:asr");
    assert.equal(h.calls.captions, 1);
    assert.deepEqual(h.messages, [], JSON.stringify(options.setting ?? options.tracks));
  }
});

test("content: a video without captions uses the PC when the page looks Japanese", async () => {
  const h = contentHarness({ tracks: [], spoken: null, meta: jaMeta, replies: script([job("done", 1)]) });
  await h.ready;
  assert.equal((await h.hook.acquireTrack("v")).trackKey, "kotoba:ja");
  assert.equal(h.calls.captions, 0);
});

test("content: a job that fails halfway falls back to YouTube's captions with a short notice", async () => {
  const h = contentHarness({ replies: script([job("queued"), job("transcribing", 0.3), { ok: true, state: "error", progress: 0.3, error: "boom" }]) });
  await h.ready;
  const track = await h.hook.acquireTrack("v");
  assert.equal(track.trackKey, "ja:asr");
  assert.equal(h.calls.captions, 1);
  assert.equal(h.toasts.at(-1), "PC 받아쓰기에 실패해서 YouTube 자막으로 번역해요");
  assert.equal(h.hook.state.stage, "track");
});

test("content: three failed status calls in a row, or a missing result, also fall back", async () => {
  const lost = contentHarness({ replies: script([job("queued")]) });
  await lost.ready;
  assert.equal((await lost.hook.acquireTrack("v")).trackKey, "ja:asr");
  assert.equal(lost.messages.filter((m) => m.op === "status").length, 3);
  assert.equal(lost.toasts.at(-1), "PC 받아쓰기에 실패해서 YouTube 자막으로 번역해요");
  const empty = contentHarness({ replies: script([job("done", 1)], { json3: { ok: false } }) });
  await empty.ready;
  assert.equal((await empty.hook.acquireTrack("v")).trackKey, "ja:asr");
  assert.equal(empty.toasts.at(-1), "PC 받아쓰기에 실패해서 YouTube 자막으로 번역해요");
});

test("content: a failed PC run on a video with no YouTube captions says so", async () => {
  const h = contentHarness({ tracks: [], spoken: null, meta: jaMeta,
    replies: script([{ ok: true, state: "error", progress: 0, error: "no speech found" }]), noCaptions: true });
  await h.ready;
  await assert.rejects(h.hook.acquireTrack("v"), (err) => err.message === "PC 받아쓰기에 실패했고 YouTube 자막도 없어요");
  assert.equal(h.calls.captions, 1);
});

test("content: switching videos while the PC works ends the run without a fallback", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = script([job("queued")]);
  const h = contentHarness({ replies: (message) => message.op === "status" ? gate.then(() => job("transcribing", 0.2)) : base(message) });
  await h.ready;
  const running = h.hook.acquireTrack("v");
  await tick();
  h.changeVideo("other-video");
  release();
  await assert.rejects(running, (err) => err.message === "영상이 변경됐어요");
  assert.equal(h.calls.captions, 0);
  assert.ok(!h.toasts.includes("PC 받아쓰기에 실패해서 YouTube 자막으로 번역해요"));
});
