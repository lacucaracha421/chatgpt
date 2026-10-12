import { loadWorker, parseJson3, chunkUnits, createResumeRecord } from "./helpers/youtube-classic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "../../_tools/app/node_modules/jsdom/lib/api.js";

// ---------------------------------------------------------------- worker: "fresh" re-translation

const tick = () => new Promise((resolve) => setImmediate(resolve));
const oldCues = [{ startMs: 0, endMs: 300, text: "이전 자막" }];
const cacheKey = "lakomics:youtube:subs:v2:resume-video:en:asr:translate-ko-auto+t6";
const resumeKey = "lakomics:youtube:resume:v1:resume-video:translate-ko-auto+t6";

async function setup(t) {
  const old = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => { globalThis.chrome = old.chrome; globalThis.fetch = old.fetch; });
  const stored = { "lakomics:translation:v1": { anthropicApiKey: "mock-key" },
    [cacheKey]: { cues: oldCues, model: "test", createdAt: 1 },
    "lakomics:youtube:subs:index": { "resume-video": ["en:asr|translate-ko-auto+t6"] } };
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
  // A paired server that holds an older copy of the result.
  const requests = [];
  const remote = { version: 1, video: "resume-video", track: "en:asr", mode: "translate-ko-auto+t6", model: "test", createdAt: 1,
    register: null, glossary: [], cues: [{ startMs: 0, endMs: 300, text: "서버 자막" }] };
  globalThis.LakomicsListApi = { readConnection: async () => ({}), connectionIdentity: () => "paired",
    request: async (path, options = {}) => {
      requests.push({ method: options.method || "GET", body: options.body });
      return options.method === "PUT" ? { status: 200, data: { ok: true } } : { status: 200, data: remote };
    } };
  const send = (message) => new Promise((resolve) => { listener(message, { tab: { id: 1 } }, resolve); });
  return { stored, requests, send };
}
const message = (extra = {}) => ({ type: "youtube:process", videoId: "resume-video", trackKey: "en:asr", positionMs: 0,
  json3: { events: [{ tStartMs: 0, dDurationMs: 900, segs: [0, 1, 2].map((i) => ({ utf8: `w${i}`, tOffsetMs: i * 300 })) }] }, ...extra });
const response = (value) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(value) }], usage: { input_tokens: 3, output_tokens: 2 } }) });
const isGlossary = (body) => body.output_config.format.schema.required.includes("terms");
const newResult = (body) => isGlossary(body) ? response({ register: "banmal", terms: [] })
  : response({ register: "banmal", lines: [{ from: 0, to: 2, text: "새 자막" }] });

test("fresh is validated as a boolean", async (t) => {
  const { send } = await setup(t);
  globalThis.fetch = async (_url, init) => newResult(JSON.parse(init.body));
  for (const fresh of [undefined, false, true]) assert.equal((await send(message({ fresh }))).ok, true);
  for (const fresh of ["yes", 1, {}, []]) assert.deepEqual(await send(message({ fresh })), { ok: false, code: "invalid_request" });
});

test("a normal request answers from the local result; fresh skips local, server and resume copies and replaces them", async (t) => {
  const { stored, requests, send } = await setup(t);
  const request = message();
  const chunks = chunkUnits(parseJson3(request.json3).units, 200);
  stored[resumeKey] = createResumeRecord(chunks, [{ failed: false, cues: [{ startMs: 0, endMs: 900, text: "재개 자막" }] }], [], null, "en:asr");
  const calls = [];
  globalThis.fetch = async (_url, init) => { const body = JSON.parse(init.body); calls.push(body); return newResult(body); };

  const normal = await send(request);
  assert.equal(normal.cached, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(requests, []);

  const fresh = await send({ ...request, fresh: true });
  await tick();
  assert.equal(fresh.ok, true);
  assert.equal(fresh.cached, false);
  assert.deepEqual(fresh.cues.map((cue) => cue.text), ["새 자막"]);
  assert.ok(calls.some(isGlossary) && calls.length >= 2, "the glossary and the chunk are requested again");
  assert.deepEqual(requests.map((r) => r.method), ["PUT"]);
  assert.deepEqual(requests[0].body.cues.map((cue) => cue.text), ["새 자막"]);
  assert.deepEqual(stored[cacheKey].cues.map((cue) => cue.text), ["새 자막"]);
  assert.ok(stored[cacheKey].createdAt > 1);
  assert.equal(stored[resumeKey], undefined);
  assert.equal(stored["lakomics:youtube:usage:total"].videos, 1);
  assert.ok(stored["lakomics:youtube:usage:total"].input_tokens >= 6);

  const again = await send(request);
  assert.equal(again.cached, true);
  assert.deepEqual(again.cues.map((cue) => cue.text), ["새 자막"]);
});

test("a failed fresh run leaves the stored result alone", async (t) => {
  const { stored, requests, send } = await setup(t);
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const failed = await send(message({ fresh: true }));
  await tick();
  assert.equal(failed.ok, false);
  assert.deepEqual(stored[cacheKey].cues, oldCues);
  assert.deepEqual(requests, []);
});

test("a fresh run is not merged into a normal one and does not hold it back", async (t) => {
  const { stored, send } = await setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fetches = 0;
  globalThis.fetch = async (_url, init) => { fetches++; await gate; return newResult(JSON.parse(init.body)); };
  const fresh = send(message({ fresh: true }));
  await tick(); await tick();
  assert.ok(fetches > 0);
  const normal = await send(message());
  assert.equal(normal.cached, true);
  assert.deepEqual(normal.cues.map((cue) => cue.text), ["이전 자막"]);
  const twin = send(message({ fresh: true }));
  const before = fetches;
  await tick(); await tick();
  assert.equal(fetches, before, "a second fresh request for the same video joins the running one");
  release();
  assert.deepEqual((await fresh).cues, (await twin).cues);
  assert.deepEqual(stored[cacheKey].cues.map((cue) => cue.text), ["새 자막"]);
});

// ---------------------------------------------------------------- content: prompt and second press

const source = await readFile(new URL("../src/youtube/content.js", import.meta.url), "utf8");

async function harness() {
  const timers = [], toasts = [], messages = [];
  let clock = 1000, answer;
  const window = { location: { origin: "https://www.youtube.com", href: "https://www.youtube.com/watch?v=v" }, addEventListener() {}, postMessage() {} };
  const context = vm.createContext({ window, URL, crypto: globalThis.crypto, Element: class {}, timers, record: (text, ms) => toasts.push([text, ms]),
    Date: { now: () => clock }, console: { info() {}, warn() {} },
    document: { getElementById: () => null, activeElement: null, querySelector: () => null },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); },
    chrome: { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: (message) => { messages.push(message); return new Promise((resolve) => { answer = resolve; }); } } } });
  vm.runInContext(source.split("  // ---------------------------------------------------------------- start")[0] + `
    renderButton = applyMode = hideToast = () => {};
    showToast = record;
    acquireTrack = async () => ({ trackKey: "en:asr", text: "{}" });
    fetchMeta = async () => null;
    globalThis.hook = { state, onButtonClick, onButtonContextMenu, mergePartial, resetForVideo };
  })();`, context);
  const hook = context.hook;
  const cue = (startMs, endMs, text) => ({ startMs, endMs, text });
  const old = [cue(0, 3000, "old a"), cue(3000, 6000, "old b")];
  Object.assign(hook.state, { videoId: "v", status: "ready", cues: old, complete: true, showClean: true, fromCache: true });
  const event = (trusted = true) => ({ isTrusted: trusted, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { hook, timers, toasts, messages, old, cue, event, flush, reply: (value) => answer(value),
    advance: (ms) => { clock += ms; } };
}
const PROMPT = "이 영상 다시 번역 — 한 번 더 누르면 시작";

test("right click shows the prompt, keeps the menus closed and starts nothing", async () => {
  const h = await harness();
  const event = h.event();
  await h.hook.onButtonContextMenu(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.deepEqual(h.toasts, [[PROMPT, 4000]]);
  assert.deepEqual(h.messages, []);
  assert.equal(h.hook.state.status, "ready");
});

test("a second press after the prompt starts a fresh run for this video, from the context menu or a click", async () => {
  for (const second of ["contextmenu", "click"]) {
    const h = await harness();
    await h.hook.onButtonContextMenu(h.event());
    h.advance(800);
    const press = second === "click" ? h.hook.onButtonClick(h.event()) : h.hook.onButtonContextMenu(h.event());
    await h.flush();
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].type, "youtube:process");
    assert.equal(h.messages[0].videoId, "v");
    assert.equal(h.messages[0].fresh, true);
    // The old subtitles stay until new ones arrive; a finished chunk replaces only its own range.
    assert.equal(h.hook.state.status, "processing");
    assert.deepEqual(h.hook.state.cues, h.old);
    h.hook.mergePartial({ startMs: 0, endMs: 3000, cues: [h.cue(0, 3000, "new a")] });
    assert.deepEqual(h.hook.state.cues.map((c) => c.text), ["new a", "old b"]);
    assert.equal(h.hook.state.complete, true);
    h.reply({ ok: true, cues: [h.cue(0, 3000, "new a"), h.cue(3000, 6000, "new b")] });
    await press;
    assert.deepEqual(h.hook.state.cues.map((c) => c.text), ["new a", "new b"]);
    assert.equal(h.hook.state.status, "ready");
    assert.deepEqual(h.toasts.at(-1), ["다시 번역했어요", 2000]);
    // One more press is an ordinary click again.
    await h.hook.onButtonClick(h.event());
    assert.equal(h.hook.state.showClean, false);
    assert.equal(h.messages.length, 1);
  }
});

test("without a second press the prompt expires and a click behaves as before", async () => {
  const h = await harness();
  await h.hook.onButtonContextMenu(h.event());
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 4000);
  h.timers[0].fn();
  h.advance(5000);
  await h.hook.onButtonClick(h.event());
  assert.deepEqual(h.messages, []);
  assert.equal(h.hook.state.showClean, false);
  // The next right click asks again instead of starting.
  await h.hook.onButtonContextMenu(h.event());
  assert.deepEqual(h.messages, []);
  assert.equal(h.toasts.filter(([text]) => text === PROMPT).length, 2);
});

test("a click or press right behind the long press that raised the prompt does not confirm it", async () => {
  const h = await harness();
  await h.hook.onButtonContextMenu(h.event());
  h.advance(100);
  await h.hook.onButtonClick(h.event());
  await h.hook.onButtonContextMenu(h.event());
  assert.deepEqual(h.messages, []);
  assert.equal(h.hook.state.showClean, true);
  h.advance(600);
  const press = h.hook.onButtonClick(h.event());
  await h.flush();
  assert.equal(h.messages.length, 1);
  h.reply({ ok: true, cues: h.old });
  await press;
});

test("only trusted events count, and nothing is offered without subtitles or during a run", async () => {
  const h = await harness();
  const synthetic = h.event(false);
  await h.hook.onButtonContextMenu(synthetic);
  assert.equal(synthetic.prevented, false);
  assert.deepEqual(h.toasts, []);

  for (const patch of [{ cues: null, status: "idle" }, { status: "processing" }]) {
    const other = await harness();
    Object.assign(other.hook.state, patch);
    const event = other.event();
    await other.hook.onButtonContextMenu(event);
    assert.equal(event.prevented, true, "the menus stay closed over our button");
    assert.deepEqual(other.toasts, []);
    assert.deepEqual(other.messages, []);
  }
});

test("a failed or incomplete fresh run keeps the old subtitles and shows why", async () => {
  for (const failure of [{ ok: false, error: "API 오류가 났어요 (500). 잠시 후 다시 시도해 주세요." },
    { ok: true, partialFailure: true, cues: [{ startMs: 0, endMs: 3000, text: "원문" }] }]) {
    const h = await harness();
    await h.hook.onButtonContextMenu(h.event());
    h.advance(800);
    const press = h.hook.onButtonContextMenu(h.event());
    await h.flush();
    h.hook.mergePartial({ startMs: 0, endMs: 3000, cues: [h.cue(0, 3000, "new a")] });
    h.reply(failure);
    await press;
    assert.deepEqual(h.hook.state.cues, h.old);
    assert.equal(h.hook.state.status, "ready");
    assert.equal(h.hook.state.complete, true);
    assert.equal(h.hook.state.partialFailure, false);
    assert.equal(h.toasts.at(-1)[1], 8000);
    assert.match(h.toasts.at(-1)[0], failure.ok ? /이전 자막을 그대로/ : /API 오류/);
  }
});

test("a normal run sends no fresh flag", async () => {
  const h = await harness();
  Object.assign(h.hook.state, { cues: null, status: "idle", complete: false, fromCache: false });
  const press = h.hook.onButtonClick(h.event());
  await h.flush();
  assert.equal(h.messages.length, 1);
  assert.equal(Object.hasOwn(h.messages[0], "fresh"), false);
  h.reply({ ok: true, cues: h.old });
  await press;
});

// ---------------------------------------------------------------- tooltip

test("the button tooltip names the gesture once subtitles exist: right click on desktop, long press on mobile", async (t) => {
  const mount = async (html, url) => {
    const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const w = dom.window;
    w.console.info = () => {};
    w.ResizeObserver = class { observe() {} disconnect() {} };
    w.chrome = { storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true,
        cached: { trackKey: "en:asr", cues: [{ startMs: 0, endMs: 1000, text: "자막" }] } }) } };
    w.eval(source);
    for (let i = 0; i < 6; i++) await tick();
    return w.document.getElementById("lakomics-yt-button");
  };
  const desktop = await mount('<div id="movie_player"><div class="ytp-right-controls"><button class="ytp-settings-button"></button></div></div>',
    "https://www.youtube.com/watch?v=video12");
  assert.match(desktop.title, /우클릭: 다시 번역$/);
  assert.equal(desktop.getAttribute("aria-label"), desktop.title);
  const mobile = await mount('<div id="movie_player"><div class="player-controls-top"><button class="player-settings-icon"></button></div></div>',
    "https://m.youtube.com/watch?v=video12");
  assert.match(mobile.title, /길게 누르기: 다시 번역$/);
});
