import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "../../_tools/app/node_modules/jsdom/lib/api.js";
import {
  loadWorker, DEFAULTS, normalize, parseJson3, chunkUnits, chunkContexts, chunkFollowing, buildPrompt,
  buildChunkPrompt, applyResult, fallbackSegment, splitDisplayCues, finalizeTimings, translateSystemPrompt,
  SPEAKER_INSTRUCTION,
} from "./helpers/youtube-classic.mjs";

const AUDIO_SPEAKER_INSTRUCTION = globalThis.LakomicsYouTube.prompts.AUDIO_SPEAKER_INSTRUCTION;
const serverCache = globalThis.LakomicsYouTube.serverCache;
const localAsr = globalThis.LakomicsYouTube.localAsr;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A Kotoba-shaped json3: one event per unit with a start, a real length and the audio-based speaker.
const event = (tStartMs, dDurationMs, utf8, lkSpk) => ({ tStartMs, dDurationMs, segs: [{ utf8 }], ...(lkSpk === undefined ? {} : { lkSpk }) });
const talk = [event(0, 800, "こんにちは", 0), event(800, 700, "元気です", 0), event(1600, 600, "うん", 1), event(2200, 900, "そうだね", 1), event(3200, 700, "ありがとう", 0)];
const talkJson3 = { wireMagic: "pb3", lkDiar: true, events: talk };

// ---------------------------------------------------------------- parse

test("parseJson3 keeps the speaker of a unit when the event has one, and nothing otherwise", () => {
  const { units } = parseJson3(talkJson3);
  assert.deepEqual(units.map((u) => u.speaker), [0, 0, 1, 1, 0]);
  assert.deepEqual(units[0], { text: "こんにちは", startMs: 0, endMs: 800, speaker: 0 });
  // A YouTube track never carries lkSpk: units look exactly as before.
  const plain = parseJson3({ events: [event(0, 500, "hello"), event(500, 500, "world")] }).units;
  assert.deepEqual(plain, [{ text: "hello", startMs: 0, endMs: 500 }, { text: "world", startMs: 500, endMs: 1000 }]);
  // Not a plausible speaker number: ignored.
  const odd = parseJson3({ events: [event(0, 500, "a", -1), event(500, 500, "b", 1.5), event(1000, 500, "c", "1"), event(1500, 500, "d", 100)] }).units;
  assert.ok(odd.every((u) => !("speaker" in u)));
});

// ---------------------------------------------------------------- prompt

const speakerUnits = parseJson3(talkJson3).units;
const plainUnits = speakerUnits.map(({ speaker, ...unit }) => unit);

test("the numbered list shows speakers as [S1], [S2] in front of the word without disturbing the indices", () => {
  assert.equal(buildPrompt(speakerUnits, [], [], { labels: true }),
    "0\t[S1] こんにちは\n1\t[S1] 元気です\n2\t[S2] うん\n3\t[S2] そうだね\n4\t[S1] ありがとう");
  // Without the labels flag (or without speakers) the list is the plain one.
  assert.equal(buildPrompt(speakerUnits), "0\tこんにちは\n1\t元気です\n2\tうん\n3\tそうだね\n4\tありがとう");
  assert.equal(buildPrompt(plainUnits, [], [], { labels: true }), buildPrompt(plainUnits));
});

test("translation prompts with speakers use the audio instruction; without speakers nothing changes", () => {
  const withSpeakers = buildChunkPrompt({ chunk: speakerUnits, mode: "translate-ko" });
  assert.match(withSpeakers.userText, /^0\t\[S1\] こんにちは\n/);
  assert.ok(withSpeakers.system.endsWith(AUDIO_SPEAKER_INSTRUCTION));
  assert.match(withSpeakers.system, /never put words of two different labels into one line/);
  assert.match(withSpeakers.system, /Never write the labels, speaker names or dialogue dashes such as "- "/);
  assert.equal(withSpeakers.system.includes(SPEAKER_INSTRUCTION), false);
  // The audio labels also win over the inferred-speaker setting.
  const both = buildChunkPrompt({ chunk: speakerUnits, mode: "translate-ko", speakers: true });
  assert.equal(both.system.includes(SPEAKER_INSTRUCTION), false);
  assert.ok(both.system.includes(AUDIO_SPEAKER_INSTRUCTION));

  const plain = buildChunkPrompt({ chunk: plainUnits, mode: "translate-ko" });
  assert.equal(plain.system, translateSystemPrompt(null, [], null));
  assert.equal(plain.userText, "0\tこんにちは\n1\t元気です\n2\tうん\n3\tそうだね\n4\tありがとう");
  const inferred = buildChunkPrompt({ chunk: plainUnits, mode: "translate-ko", speakers: true });
  assert.equal(inferred.system, `${translateSystemPrompt(null, [], null)}\n${SPEAKER_INSTRUCTION}`);
  // Cleaning (translation off) never shows labels, even when the units have speakers.
  const clean = buildChunkPrompt({ chunk: speakerUnits, mode: "clean" });
  assert.equal(clean.userText, "0\tこんにちは\n1\t元気です\n2\tうん\n3\tそうだね\n4\tありがとう");
  assert.equal(clean.system.includes("speaker label"), false);
});

test("context blocks carry the labels at the start and wherever the speaker changes", () => {
  const chunks = [speakerUnits.slice(0, 2), speakerUnits.slice(2, 4), speakerUnits.slice(4)];
  assert.deepEqual(chunkContexts(chunks)[1], ["[S1]", "こんにちは", "元気です"]);
  assert.deepEqual(chunkContexts(chunks)[2], ["[S1]", "こんにちは", "元気です", "[S2]", "うん", "そうだね"]);
  assert.deepEqual(chunkFollowing(chunks)[0], ["[S2]", "うん", "そうだね", "[S1]", "ありがとう"]);
  assert.deepEqual(chunkFollowing(chunks)[2], []);
  // Context length counts words, not labels.
  assert.deepEqual(chunkContexts(chunks, 2)[2], ["[S2]", "うん", "そうだね"]);
  const prompt = buildChunkPrompt({ chunk: chunks[2], mode: "translate-ko", context: chunkContexts(chunks)[2], following: [] });
  assert.match(prompt.userText, /Previous context[^\n]*\n\[S1\] こんにちは 元気です \[S2\] うん そうだね\n\nNumbered words to process:\n0\t\[S1\] ありがとう$/);
  // Without speakers the context is the plain words, as before.
  const plainChunks = [plainUnits.slice(0, 2), plainUnits.slice(2)];
  assert.deepEqual(chunkContexts(plainChunks)[1], ["こんにちは", "元気です"]);
  assert.deepEqual(chunkFollowing(plainChunks)[0], ["うん", "そうだね", "ありがとう"]);
});

// ---------------------------------------------------------------- cue speaker

test("a cue takes the speaker who talks longest in it; split fragments and merged timing keep it", () => {
  const lines = [{ from: 0, to: 1, text: "안녕, 잘 지내" }, { from: 2, to: 3, text: "응, 그러게" }, { from: 4, to: 4, text: "고마워" }];
  const cues = applyResult(speakerUnits, lines, { mode: "translate-ko" });
  assert.deepEqual(cues.map((cue) => cue.speaker), [0, 1, 0]);
  // One line over both speakers: the one with more speech time wins (2 x ~0.8 s of speaker 1 against 0.8 + 0.7 s of speaker 0 -> 0).
  const mixed = applyResult(speakerUnits, [{ from: 0, to: 4, text: "전부 한 줄" }], { mode: "translate-ko" });
  assert.equal(mixed[0].speaker, 0);
  const second = applyResult(speakerUnits, [{ from: 0, to: 1, text: "인사" }, { from: 2, to: 4, text: "うん, そうだね, ありがとう를 한 줄로" }], { mode: "translate-ko" });
  assert.deepEqual(second.map((cue) => cue.speaker), [0, 1]); // うん + そうだね (speaker 1) outweigh ありがとう (speaker 0)
  // A long line is split for display: every fragment inherits the speaker.
  const long = splitDisplayCues([{ startMs: 0, endMs: 9000, text: "가나다라마바사 ".repeat(8).trim(), speaker: 2 }]);
  assert.ok(long.length > 1);
  assert.ok(long.every((cue) => cue.speaker === 2));
  // Final timing keeps it too.
  assert.ok(finalizeTimings(cues).every((cue, i) => cue.speaker === [0, 1, 0][i]));
  // Units without speakers produce cues without the field.
  assert.ok(applyResult(plainUnits, lines, { mode: "translate-ko" }).every((cue) => !("speaker" in cue)));
});

test("fallback segmentation breaks where the speaker changes, and the same words stay one line without speakers", () => {
  // Quick speech (no pause between words), so only a change of speaker can end a line.
  const quick = [["a", 0], ["b", 0], ["c", 1], ["d", 1], ["e", 0]].map(([text, speaker], i) => ({ text, startMs: i * 300, endMs: i * 300 + 300, speaker }));
  assert.deepEqual(fallbackSegment(quick, { mode: "translate-ko" }).map((cue) => [cue.speaker, cue.orig]),
    [[0, "a b"], [1, "c d"], [0, "e"]]);
  const quickPlain = quick.map(({ speaker, ...unit }) => unit);
  assert.deepEqual(fallbackSegment(quickPlain, { mode: "translate-ko" }).map((cue) => cue.orig), ["a b c d e"]);
});

test("a speaker label the model echoes is removed from translations that had labels", () => {
  const lines = [{ from: 0, to: 1, text: "[S1] 안녕, 잘 지내" }, { from: 2, to: 3, text: "[S2]응, 그러게 [S2]" }, { from: 4, to: 4, text: "고마워" }];
  assert.deepEqual(applyResult(speakerUnits, lines, { mode: "translate-ko" }).map((cue) => cue.text), ["안녕, 잘 지내", "응, 그러게", "고마워"]);
  // Chunks without labels are left exactly as the model wrote them.
  assert.equal(applyResult(plainUnits, [{ from: 0, to: 4, text: "[S1] 안녕" }], { mode: "translate-ko" })[0].text, "[S1] 안녕");
  // A line that was only a label falls back to the original words.
  assert.equal(applyResult(speakerUnits, [{ from: 0, to: 4, text: "[S1]" }], { mode: "translate-ko" })[0].text, "こんにちは 元気です うん そうだね ありがとう");
});

// ---------------------------------------------------------------- settings, local ASR

test("the speaker colour setting defaults on and is a boolean", () => {
  assert.equal(DEFAULTS.speakerColors, true);
  assert.equal(normalize({}).speakerColors, true);
  assert.equal(normalize({ speakerColors: false }).speakerColors, false);
  assert.equal(normalize({ speakerColors: "no" }).speakerColors, true);
});

test("the diarizing state of the PC server is a known state", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ state: "diarizing", progress: 0.93 }) });
  try {
    assert.deepEqual(await localAsr.handle({ op: "status", videoId: "dDPmbj_mgUg" }), { ok: true, state: "diarizing", progress: 0.93 });
  } finally { globalThis.fetch = old; }
});

// ---------------------------------------------------------------- server cache

const entry = (cues) => ({ version: 1, video: "dDPmbj_mgUg", track: "kotoba:ja", mode: "translate-ko-auto+t6", model: "m", createdAt: 1,
  register: null, glossary: [], cues });

test("server cache validation accepts a plausible speaker and drops nothing else", () => {
  const ok = serverCache.validate(entry([{ startMs: 5, endMs: 9, text: "나중", speaker: 1 }, { startMs: 0, endMs: 4, text: "먼저" }]));
  assert.deepEqual(ok.cues, [{ startMs: 0, endMs: 4, text: "먼저" }, { startMs: 5, endMs: 9, text: "나중", speaker: 1 }]);
  for (const speaker of [-1, 1.5, "1", null, 100])
    assert.equal(serverCache.validate(entry([{ startMs: 0, endMs: 4, text: "x", speaker }])), null, String(speaker));
});

test("the upload carries the speaker so other devices show the colours too", async () => {
  const old = globalThis.LakomicsListApi;
  const requests = [];
  globalThis.LakomicsListApi = { request: async (path, options) => { requests.push({ path, options }); return { status: 200, data: { ok: true } }; } };
  try {
    serverCache.put(entry([{ startMs: 0, endMs: 4, text: "먼저", orig: "まず", speaker: 1 }]), {}, () => true);
    await tick(); await tick();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, "PUT");
    assert.deepEqual(requests[0].options.body.cues, [{ startMs: 0, endMs: 4, text: "먼저", orig: "まず", speaker: 1 }]);
  } finally { globalThis.LakomicsListApi = old; }
});

// ---------------------------------------------------------------- worker, end to end

async function workerSetup(t) {
  const old = { chrome: globalThis.chrome, fetch: globalThis.fetch, api: globalThis.LakomicsListApi };
  t.after(() => { globalThis.chrome = old.chrome; globalThis.fetch = old.fetch; globalThis.LakomicsListApi = old.api; });
  const stored = { "lakomics:translation:v1": { anthropicApiKey: "mock-key" } };
  let listener;
  globalThis.chrome = {
    storage: { local: {
      get: async (keys) => structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in stored).map((key) => [key, stored[key]]))),
      set: async (values) => Object.assign(stored, structuredClone(values)),
      remove: async (key) => { delete stored[key]; },
    } },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, getPlatformInfo: () => {} },
    tabs: { sendMessage: async () => {} },
  };
  loadWorker();
  const uploads = [];
  globalThis.LakomicsListApi = { readConnection: async () => ({}), connectionIdentity: () => "paired",
    request: async (_path, options = {}) => {
      if (options.method === "PUT") { uploads.push(options.body); return { status: 200, data: { ok: true } }; }
      return { status: 404, data: {} };
    } };
  const send = (message) => new Promise((resolve) => { listener(message, { tab: { id: 1 } }, resolve); });
  return { stored, uploads, send };
}

test("a Kotoba track with speakers: labels reach the model, cues keep the speaker locally and in the upload", async (t) => {
  const { stored, uploads, send } = await workerSetup(t);
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const glossary = body.output_config.format.schema.required.includes("terms");
    const payload = glossary ? { register: "banmal", terms: [] }
      : { register: "banmal", lines: [{ from: 0, to: 1, text: "[S1] 안녕, 잘 지내?" }, { from: 2, to: 3, text: "응, 그러게." }, { from: 4, to: 4, text: "고마워" }] };
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(payload) }], usage: { input_tokens: 3, output_tokens: 2 } }) };
  };
  const result = await send({ type: "youtube:process", videoId: "dDPmbj_mgUg", trackKey: "kotoba:ja", positionMs: 0, json3: talkJson3 });
  await tick(); await tick();
  assert.equal(result.ok, true);
  const chunkRequest = bodies.find((body) => !body.output_config.format.schema.required.includes("terms"));
  assert.match(chunkRequest.messages[0].content, /^0\t\[S1\] こんにちは\n1\t\[S1\] 元気です\n2\t\[S2\] うん/);
  assert.ok(chunkRequest.system.includes(AUDIO_SPEAKER_INSTRUCTION));
  assert.deepEqual(result.cues.map((cue) => [cue.text, cue.speaker]), [["안녕, 잘 지내?", 0], ["응, 그러게.", 1], ["고마워", 0]]);
  const local = Object.entries(stored).find(([key]) => key.startsWith("lakomics:youtube:subs:v2:dDPmbj_mgUg:kotoba:ja:"));
  assert.deepEqual(local[1].cues.map((cue) => cue.speaker), [0, 1, 0]);
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].cues.map((cue) => cue.speaker), [0, 1, 0]);
});

// ---------------------------------------------------------------- display

const contentSource = await readFile(new URL("../src/youtube/content.js", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../src/youtube/content.css", import.meta.url), "utf8");
const KEY = "lakomics:youtube:settings:";

async function mount(t, { stored = {} } = {}) {
  const dom = new JSDOM('<div id="movie_player"><video></video></div>', {
    url: "https://www.youtube.com/watch?v=v", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  let changed = null;
  w.console.info = () => {};
  w.ResizeObserver = class { observe() {} disconnect() {} };
  w.matchMedia = () => ({ matches: true });
  w.chrome = { storage: { onChanged: { addListener(fn) { changed = fn; } }, local: { get: async () => ({ ...stored }) } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) } };
  const video = w.document.querySelector("video");
  let now = 0;
  Object.defineProperty(video, "currentTime", { get: () => now, configurable: true });
  Object.defineProperty(video, "paused", { get: () => true, configurable: true });
  vm.runInContext(contentSource.split("  // ---------------------------------------------------------------- start")[0] + `
    renderButton = showToast = hideToast = () => {};
    globalThis.hook = { state, mergePartial, applyMode, sync, overlay: () => overlay };
  })();`, dom.getInternalVMContext());
  await tick(); await tick();
  const hook = w.hook;
  hook.state.videoId = "v"; hook.state.status = "ready";
  return { w, hook,
    load: (cues) => hook.mergePartial({ startMs: 0, endMs: 60000, cues }),
    at: (seconds) => { now = seconds; hook.sync(); },
    setting: (key, value) => changed({ [KEY + key]: { newValue: value } }, "local") };
}
const cue = (startMs, endMs, text, speaker, orig) => ({ startMs, endMs, text, ...(speaker === undefined ? {} : { speaker }), ...(orig ? { orig } : {}) });
// [class, text] of every translation span in the overlay.
const spans = (h) => [...h.hook.overlay().querySelectorAll("span:not(.lakomics-yt-orig)")].map((node) => [node.className, node.textContent]);

test("speakers get their colour class when the setting is on (the default): 0 plain, 1 yellow, 2 blue, 3 and up plain", async (t) => {
  const h = await mount(t);
  h.load([cue(0, 900, "영", 0), cue(1000, 1900, "일", 1), cue(2000, 2900, "이", 2), cue(3000, 3900, "삼", 3), cue(4000, 4900, "없음")]);
  const classes = [];
  for (const seconds of [0.5, 1.5, 2.5, 3.5, 4.5]) { h.at(seconds); classes.push(spans(h)); }
  assert.deepEqual(classes, [[["", "영"]], [["lakomics-yt-spk1", "일"]], [["lakomics-yt-spk2", "이"]], [["", "삼"]], [["", "없음"]]]);
  assert.match(cssSource, /#lakomics-yt-overlay \.lakomics-yt-spk1 \{\s*color: #ffe58a;\s*\}/);
  assert.match(cssSource, /#lakomics-yt-overlay \.lakomics-yt-spk2 \{\s*color: #a8e4ff;\s*\}/);
  // Text colour only: the new rules set nothing but the colour.
  const rules = cssSource.match(/\.lakomics-yt-spk[12] \{[^}]*\}/g);
  assert.equal(rules.length, 2);
  assert.ok(rules.every((rule) => rule.replace(/\.lakomics-yt-spk[12] \{|\}/g, "").trim().split(";").filter(Boolean).every((d) => d.trim().startsWith("color:"))));
});

test("with colours the '- ' speaker marks are not shown; without the setting the cue looks exactly as before", async (t) => {
  const h = await mount(t, { stored: { [KEY + "speakerColors"]: false } });
  h.load([cue(0, 900, "- 안녕\n- 응", 1), cue(1000, 1900, "일", 1)]);
  h.at(0.5);
  assert.deepEqual(spans(h), [["", "- 안녕\n- 응"]]);
  h.at(1.5);
  assert.deepEqual(spans(h), [["", "일"]]);
  // Turned on live: the line is redrawn in place with its colour and without marks.
  h.setting("speakerColors", true);
  h.at(0.5);
  assert.deepEqual(spans(h), [["lakomics-yt-spk1", "안녕\n응"]]);
  // And off again: back to the plain look, marks included.
  h.setting("speakerColors", false);
  h.at(0.5);
  assert.deepEqual(spans(h), [["", "- 안녕\n- 응"]]);
  // A cue without a speaker keeps its marks even with colours on.
  h.setting("speakerColors", true);
  const marks = await mount(t);
  marks.load([cue(0, 900, "- 안녕\n- 응")]);
  marks.at(0.5);
  assert.deepEqual(spans(marks), [["", "- 안녕\n- 응"]]);
});

test("rolling display: the previous line keeps its own colour; the original-text line stays dimmed and uncoloured", async (t) => {
  const h = await mount(t, { stored: { [KEY + "rolling"]: true, [KEY + "showOriginal"]: true } });
  h.load([cue(0, 1000, "첫 줄", 1, "最初"), cue(1100, 3000, "둘째 줄", 2, "次")]);
  h.at(1.5);
  const lines = [...h.hook.overlay().children];
  assert.deepEqual(lines.map((node) => node.className.split(" ")[1]), ["lakomics-yt-prev", "lakomics-yt-cur"]);
  assert.equal(lines[0].querySelector("span").className, "lakomics-yt-spk1");
  const current = lines[1];
  assert.equal(current.querySelector(".lakomics-yt-orig").className, "lakomics-yt-orig");
  assert.equal(current.querySelector(".lakomics-yt-orig-line span").className, "lakomics-yt-orig");
  assert.equal(current.querySelector("div:not(.lakomics-yt-orig-line) > span").className, "lakomics-yt-spk2");
  // A speaker change for the same cue start redraws the line in place.
  h.hook.mergePartial({ startMs: 1100, endMs: 3000, cues: [cue(1100, 3000, "둘째 줄", 1, "次")] });
  h.at(1.5);
  assert.equal([...h.hook.overlay().children][1].querySelector("div:not(.lakomics-yt-orig-line) > span").className, "lakomics-yt-spk1");
});
