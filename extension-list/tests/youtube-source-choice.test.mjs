import { loadWorker } from "./helpers/youtube-classic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "../../_tools/app/node_modules/jsdom/lib/api.js";

// The per-video caption-source choice of the retranslate prompt (content.js, source-pref.js, service.js).

const tick = () => new Promise((resolve) => setImmediate(resolve));
const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
const contentSource = await read("../src/youtube/content.js");
const choiceSource = await read("../src/youtube/asr-choice.js");
const prefSource = await read("../src/youtube/source-pref.js");
const cssSource = await read("../src/youtube/content.css");
const fixtureText = await read("./fixtures/youtube/kotoba-ja-first-minute.json3");
const sourcePref = globalThis.LakomicsYouTube.sourcePref;

const VIDEO = "zuMy38hC5eU";
const PREF_KEY = `lakomics:youtube:source:${VIDEO}`;
const SINGLE = "이 영상 다시 번역 — 한 번 더 누르면 시작";
const ja = (kind) => ({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=ja${kind ? `&kind=${kind}` : ""}`, languageCode: "ja", kind });
const en = (kind) => ({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=en${kind ? `&kind=${kind}` : ""}`, languageCode: "en", kind });
const cue = (startMs, endMs, text) => ({ startMs, endMs, text });

const DESKTOP = '<div id="movie_player"><video></video><div class="ytp-right-controls"><button class="ytp-settings-button"></button></div></div>';

// A content script in a real DOM with a fake page bridge, extension storage and PC server.
//  tracks/spoken: what the player reports; health: "up" | "down" | a promise to wait for (then up);
//  stored: extension storage; processReply: answer to youtube:process.
async function mount(t, { tracks = [ja("asr")], health = "up", stored = {}, mobile = false, processReply } = {}) {
  const dom = new JSDOM(DESKTOP, { url: `https://www.youtube.com/watch?v=${VIDEO}`, runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.console.info = () => {};
  w.console.warn = () => {};
  w.ResizeObserver = class { observe() {} disconnect() {} };
  const timers = [];
  w.setTimeout = (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; };
  w.clearTimeout = (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); };
  let clock = 1000;
  w.Date.now = () => clock;
  // Every listener the page script adds, so a handler can be called with a trusted event (real dispatches are untrusted).
  const handlers = [];
  const add = w.EventTarget.prototype.addEventListener;
  w.EventTarget.prototype.addEventListener = function (type, fn, options) { handlers.push({ target: this, type, fn }); return add.call(this, type, fn, options); };

  const store = { ...stored };
  const messages = [];
  const server = { health };
  const keysOf = (keys) => keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
  w.chrome = {
    storage: { onChanged: { addListener() {} }, local: {
      get: async (keys) => structuredClone(Object.fromEntries(keysOf(keys).filter((key) => key in store).map((key) => [key, store[key]]))),
      set: async (values) => { Object.assign(store, structuredClone(values)); },
      remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
    } },
    runtime: { onMessage: { addListener() {} }, sendMessage: async (message) => {
      messages.push(message);
      if (message.type === "youtube:asr") {
        if (message.op === "health") {
          if (server.health instanceof Promise) { await server.health; return { ok: true, available: true }; }
          return { ok: true, available: server.health === "up" };
        }
        if (message.op === "start") return { ok: true, state: "done", progress: 1 };
        if (message.op === "json3") return { ok: true, text: fixtureText };
        return { ok: false };
      }
      if (message.type === "youtube:process") return processReply ? processReply(message) : { ok: true, cues: [cue(0, 1000, "새 자막")] };
      return { ok: true, cached: null };
    } },
  };
  w.eval(choiceSource);
  w.eval(prefSource);
  w.eval(contentSource.split("  // ---------------------------------------------------------------- start")[0] + `
    askPage = async (type) => type === "getTracks" ? { type: "tracks", videoId: "${VIDEO}", tracks: ${JSON.stringify(tracks)} } : null;
    fetchMeta = async () => null;
    acquireCaptionTrack = async () => { window.__captionCalls = (window.__captionCalls || 0) + 1; return { trackKey: "ja:asr", text: "{\\"events\\":[]}" }; };
    globalThis.hook = { state, onButtonContextMenu, onButtonClick, getTrackChoice, acquireTrack, setButton: (b) => { button = b; },
      setLocalAsr: (on) => { localAsrEnabled = on; } };
  })();`);
  await tick(); await tick(); // the initial settings read
  const hook = w.hook;
  Object.assign(hook.state, { videoId: VIDEO, status: "ready", cues: [cue(0, 3000, "이전")], complete: true, showClean: true, fromCache: true });
  if (mobile) {
    const ai = w.document.createElement("button");
    ai.className = "lakomics-yt-mobile";
    hook.setButton(ai);
  }
  const doc = w.document;
  const event = (trusted = true) => ({ isTrusted: trusted, preventDefault() {}, stopPropagation() {} });
  const flush = async () => { for (let i = 0; i < 20; i++) await tick(); };
  const ui = {
    choice: () => doc.getElementById("lakomics-yt-choice"),
    choiceShown: () => Boolean(ui.choice()?.classList.contains("lakomics-yt-show")),
    toast: () => doc.getElementById("lakomics-yt-toast"),
    toastShown: () => Boolean(ui.toast()?.classList.contains("lakomics-yt-show")),
    button: (source) => ui.choice().querySelector(`.lakomics-yt-choice-button:nth-child(${source === "kotoba" ? 1 : 2})`),
    // Clicks a choice button the way the browser would: its click handler with a (trusted or not) event.
    press: async (source, trusted = true) => {
      const target = ui.button(source);
      for (const h of handlers.filter((item) => item.target === target && item.type === "click")) await h.fn(event(trusted));
      await flush();
    },
    key: (key) => w.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
  };
  return { w, hook, doc, ui, timers, messages, store, server, handlers, event, flush, advance: (ms) => { clock += ms; },
    asrOps: () => messages.filter((m) => m.type === "youtube:asr").map((m) => m.op),
    processes: () => messages.filter((m) => m.type === "youtube:process"),
    fire: (ms) => { const timer = timers.find((item) => item.ms === ms); assert.ok(timer, `a ${ms} ms timer`); timers.splice(timers.indexOf(timer), 1); timer.fn(); } };
}

// ---------------------------------------------------------------- when the choice is shown

test("choice: a Japanese video without a human track, with the server up, turns the prompt into two buttons", async (t) => {
  const h = await mount(t);
  await h.hook.onButtonContextMenu(h.event());
  // The track list was not read yet: today's prompt shows at once, then becomes the choice.
  assert.equal(h.ui.toast().textContent, SINGLE);
  assert.equal(h.ui.toastShown(), true);
  assert.equal(h.ui.choiceShown(), false);
  await h.flush();
  assert.equal(h.ui.choiceShown(), true);
  assert.equal(h.ui.toastShown(), false);
  assert.equal(h.ui.choice().firstChild.textContent, "이 영상 다시 번역");
  assert.equal(h.ui.button("kotoba").textContent, "PC 받아쓰기(Kotoba)");
  assert.equal(h.ui.button("youtube").textContent, "YouTube 자막");
  assert.equal(h.ui.button("kotoba").disabled, false);
  assert.equal(h.ui.choice().getAttribute("role"), "group");
  assert.equal(h.timers.some((timer) => timer.ms === 6000), true);
  assert.equal(h.processes().length, 0);
});

test("choice: with the track list already known the choice is there at once; the PC button waits, dimmed, for the server", async (t) => {
  let release;
  const h = await mount(t, { health: new Promise((resolve) => { release = resolve; }) });
  await h.hook.getTrackChoice(VIDEO);
  await h.hook.onButtonContextMenu(h.event());
  assert.equal(h.ui.choiceShown(), true, "no single prompt first");
  assert.equal(h.ui.toastShown(), false);
  assert.equal(h.ui.button("kotoba").disabled, true);
  assert.equal(h.ui.button("youtube").disabled, false);
  await h.ui.press("kotoba"); // not available yet
  assert.equal(h.processes().length, 0);
  release();
  await h.flush();
  assert.equal(h.ui.button("kotoba").disabled, false);
  assert.equal(h.ui.choiceShown(), true);
});

test("choice: the server being down turns the choice back into today's single prompt", async (t) => {
  for (const known of [true, false]) {
    const h = await mount(t, { health: "down" });
    if (known) await h.hook.getTrackChoice(VIDEO);
    await h.hook.onButtonContextMenu(h.event());
    await h.flush();
    assert.equal(h.ui.choiceShown(), false);
    assert.equal(h.ui.toast().textContent, SINGLE);
    assert.equal(h.ui.toastShown(), true);
    assert.ok(h.timers.some((timer) => timer.ms === 4000), "the single prompt's own timer runs");
    assert.equal(h.timers.some((timer) => timer.ms === 6000), false);
    // A second press still starts the re-translation, as before.
    h.advance(800);
    await h.hook.onButtonContextMenu(h.event());
    await h.flush();
    assert.equal(h.processes().length, 1);
    assert.equal(h.processes()[0].fresh, true);
    assert.equal(h.processes()[0].trackKey, "ja:asr");
  }
});

test("choice: other videos, a human Japanese track and the setting off keep the single prompt and never ask the server", async (t) => {
  const cases = [
    { tracks: [en("asr")] },
    { tracks: [ja("asr"), ja(undefined)] },
    { tracks: [ja("asr")], off: true },
  ];
  for (const { off, ...options } of cases) {
    const h = await mount(t, options);
    if (off) h.hook.setLocalAsr(false);
    await h.hook.getTrackChoice(VIDEO);
    await h.hook.onButtonContextMenu(h.event());
    await h.flush();
    assert.equal(h.ui.choice(), null, JSON.stringify(options));
    assert.equal(h.ui.toast().textContent, SINGLE);
    assert.deepEqual(h.asrOps(), []);
  }
  // Same when the track list is only read by the prompt itself.
  const h = await mount(t, { tracks: [en("asr")] });
  await h.hook.onButtonContextMenu(h.event());
  await h.flush();
  assert.equal(h.ui.choice(), null);
  assert.equal(h.ui.toast().textContent, SINGLE);
  assert.deepEqual(h.asrOps(), []);
});

test("choice: nothing is offered without subtitles or during a run", async (t) => {
  for (const patch of [{ cues: null, status: "idle" }, { status: "processing" }]) {
    const h = await mount(t);
    Object.assign(h.hook.state, patch);
    await h.hook.onButtonContextMenu(h.event());
    await h.flush();
    assert.equal(h.ui.choice(), null);
    assert.equal(h.ui.toast(), null);
    assert.deepEqual(h.asrOps(), []);
  }
});

test("choice: the source of the subtitles on screen is marked with a suffix and aria-pressed, no coloured mark", async (t) => {
  for (const [trackKey, shown] of [["kotoba:ja", "kotoba"], ["ja:asr", "youtube"], [null, null]]) {
    const h = await mount(t);
    h.hook.state.trackKey = trackKey;
    await h.hook.onButtonContextMenu(h.event());
    await h.flush();
    for (const source of ["kotoba", "youtube"]) {
      const button = h.ui.button(source);
      const pressed = source === shown;
      assert.equal(button.getAttribute("aria-pressed"), String(pressed));
      assert.equal(button.textContent.endsWith(" · 지금"), pressed);
    }
  }
  // The styles: weight for the current one; no border-left/-bottom/-top accent stripes on the choice.
  assert.match(cssSource, /lakomics-yt-choice-button\[aria-pressed="true"\]\s*\{\s*font-weight: 700;/);
  const choiceCss = cssSource.slice(cssSource.indexOf("#lakomics-yt-choice {"), cssSource.indexOf("@media (prefers-reduced-motion"));
  assert.doesNotMatch(choiceCss, /border-(left|right|top|bottom)\b|box-shadow|text-decoration|underline/);
});

// ---------------------------------------------------------------- the buttons

test("choice: the PC button starts a fresh run with the PC's recognition and remembers it for the video", async (t) => {
  const h = await mount(t, { stored: { [PREF_KEY]: "youtube" } });
  await h.hook.onButtonContextMenu(h.event());
  await h.flush();
  h.advance(600);
  await h.ui.press("kotoba");
  assert.equal(h.ui.choiceShown(), false);
  assert.equal(h.processes().length, 1);
  assert.equal(h.processes()[0].fresh, true);
  assert.equal(h.processes()[0].trackKey, "kotoba:ja");
  assert.equal(h.processes()[0].videoId, VIDEO);
  assert.equal("source" in h.processes()[0], false, "the worker message keeps its strict shape");
  assert.equal(h.w.__captionCalls, undefined);
  assert.equal(h.store[PREF_KEY], "kotoba");
  assert.deepEqual(h.store["lakomics:youtube:source:order"], [VIDEO]);
  assert.equal(h.hook.state.trackKey, "kotoba:ja");
});

test("choice: the YouTube button starts a fresh run with YouTube's track and never asks the server for a job", async (t) => {
  const h = await mount(t);
  await h.hook.onButtonContextMenu(h.event());
  await h.flush();
  h.advance(600);
  await h.ui.press("youtube");
  assert.equal(h.processes().length, 1);
  assert.equal(h.processes()[0].fresh, true);
  assert.equal(h.processes()[0].trackKey, "ja:asr");
  assert.equal(h.w.__captionCalls, 1);
  assert.deepEqual(h.asrOps().filter((op) => op !== "health"), []);
  assert.equal(h.store[PREF_KEY], "youtube");
  assert.equal(h.hook.state.trackKey, "ja:asr");
});

test("choice: a press right behind the long press that raised it, or an untrusted press, starts nothing", async (t) => {
  const h = await mount(t);
  await h.hook.onButtonContextMenu(h.event());
  await h.flush();
  await h.ui.press("youtube"); // within 500 ms of the prompt appearing
  assert.equal(h.processes().length, 0);
  assert.equal(h.ui.choiceShown(), true);
  h.advance(600);
  await h.ui.press("youtube", false);
  assert.equal(h.processes().length, 0);
  assert.equal(h.ui.choiceShown(), true);
  assert.equal(h.store[PREF_KEY], undefined);
});

test("choice: Kotoba chosen but the server dies falls back to YouTube's track with the usual notice", async (t) => {
  const h = await mount(t);
  await h.hook.onButtonContextMenu(h.event());
  await h.flush();
  h.advance(600);
  h.server.health = "down"; // gone between the prompt and the run
  await h.ui.press("kotoba");
  assert.equal(h.processes().length, 1);
  assert.equal(h.processes()[0].trackKey, "ja:asr");
  assert.equal(h.store[PREF_KEY], "kotoba", "the choice stays; the fallback is only for this run");
});

test("choice: the AI button answers the choice by closing it, and costs nothing", async (t) => {
  for (const gesture of ["contextmenu", "click"]) {
    const h = await mount(t);
    await h.hook.onButtonContextMenu(h.event());
    await h.flush();
    h.advance(800);
    if (gesture === "click") await h.hook.onButtonClick(h.event()); else await h.hook.onButtonContextMenu(h.event());
    await h.flush();
    assert.equal(h.ui.choiceShown(), false);
    assert.equal(h.processes().length, 0);
    assert.equal(h.hook.state.showClean, true);
  }
});

// ---------------------------------------------------------------- closing without cost

test("choice: the timeout and Escape close it with no run and nothing stored", async (t) => {
  const timeout = await mount(t);
  await timeout.hook.onButtonContextMenu(timeout.event());
  await timeout.flush();
  timeout.fire(6000);
  assert.equal(timeout.ui.choiceShown(), false);
  assert.equal(timeout.processes().length, 0);
  assert.equal(timeout.store[PREF_KEY], undefined);
  // The next right click asks again.
  await timeout.hook.onButtonContextMenu(timeout.event());
  await timeout.flush();
  assert.equal(timeout.ui.choiceShown(), true);

  const escape = await mount(t);
  await escape.hook.onButtonContextMenu(escape.event());
  await escape.flush();
  escape.ui.key("x");
  assert.equal(escape.ui.choiceShown(), true);
  escape.ui.key("Escape");
  assert.equal(escape.ui.choiceShown(), false);
  assert.equal(escape.timers.some((timer) => timer.ms === 6000), false, "the timeout is cancelled");
  assert.equal(escape.processes().length, 0);
  assert.equal(escape.store[PREF_KEY], undefined);
  // The listener is gone with the prompt.
  escape.ui.key("Escape");
});

test("choice: the timeout waits while the pointer is over the prompt or focus is inside it", async (t) => {
  const h = await mount(t);
  await h.hook.onButtonContextMenu(h.event());
  await h.flush();
  const over = (type) => h.ui.choice().dispatchEvent(new h.w.Event(type));
  over("pointerenter");
  assert.equal(h.timers.some((timer) => timer.ms === 6000), false, "paused");
  h.advance(20000);
  over("pointerleave");
  const resumed = h.timers.find((timer) => timer.ms >= 1500 && timer.ms < 6000 || timer.ms === 6000);
  assert.ok(resumed && resumed.ms >= 1500, "it resumes with at least 1.5 s left");
  assert.equal(h.ui.choiceShown(), true);
  over("focusin");
  assert.equal(h.timers.length, 0, "focus inside holds it too");
  over("pointerenter");
  over("pointerleave");
  assert.equal(h.timers.length, 0, "still held by focus");
  over("focusout");
  assert.equal(h.timers.length, 1);
  h.timers[0].fn();
  assert.equal(h.ui.choiceShown(), false);
});

test("choice: a new video closes the prompt", async (t) => {
  const h = await mount(t);
  await h.hook.onButtonContextMenu(h.event());
  await h.flush();
  assert.equal(h.ui.choiceShown(), true);
  h.w.history.pushState({}, "", "/watch?v=otherVideo1");
  await h.hook.onButtonContextMenu(h.event()); // resets for the new video, then asks again only with subtitles
  assert.equal(h.ui.choiceShown(), false);
});

// ---------------------------------------------------------------- the player must not notice

test("choice: clicks, taps and keys inside it never reach the player; the buttons are real focusable buttons", async (t) => {
  const h = await mount(t);
  await h.hook.onButtonContextMenu(h.event());
  await h.flush();
  const player = h.doc.getElementById("movie_player");
  const seen = [];
  const events = ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup"];
  for (const type of events) player.addEventListener(type, () => seen.push(type));
  for (const target of [h.ui.choice(), h.ui.choice().firstChild, h.ui.button("kotoba"), h.ui.button("youtube")]) {
    for (const type of events) target.dispatchEvent(new h.w.Event(type, { bubbles: true, cancelable: true }));
  }
  assert.deepEqual(seen, []);
  // Outside the prompt the same events do reach the player (the guard is not a global one).
  h.doc.getElementById("lakomics-yt-toast").dispatchEvent(new h.w.Event("click", { bubbles: true }));
  assert.deepEqual(seen, ["click"]);
  for (const source of ["kotoba", "youtube"]) {
    const button = h.ui.button(source);
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.type, "button");
    assert.equal(button.tabIndex, 0);
  }
});

test("choice: on mobile the prompt sits below the icon row with 40 px targets; on desktop it keeps the toast spot", async (t) => {
  const mobile = await mount(t, { mobile: true });
  await mobile.hook.onButtonContextMenu(mobile.event());
  await mobile.flush();
  assert.equal(mobile.ui.choice().classList.contains("lakomics-yt-choice-mobile"), true);
  const desktop = await mount(t);
  await desktop.hook.onButtonContextMenu(desktop.event());
  await desktop.flush();
  assert.equal(desktop.ui.choice().classList.contains("lakomics-yt-choice-mobile"), false);
  assert.match(cssSource, /#lakomics-yt-choice\.lakomics-yt-choice-mobile \.lakomics-yt-choice-button \{\s*min-height: 40px;/);
  assert.match(cssSource, /#lakomics-yt-choice\.lakomics-yt-choice-mobile \{ top: 56px; \}/);
  // Hidden means gone for pointer and keyboard (visibility), and it fades like the toast; reduced motion switches that off.
  assert.match(cssSource, /#lakomics-yt-choice \{[^}]*visibility: hidden;[^}]*pointer-events: none;[^}]*transition: opacity 0\.2s ease/);
  assert.match(cssSource, /prefers-reduced-motion: reduce[^}]*#lakomics-yt-choice,/);
});

// ---------------------------------------------------------------- the saved choice

test("source-pref: stores one entry per video, newest last, and drops the oldest beyond 500", async (t) => {
  const old = globalThis.chrome;
  t.after(() => { globalThis.chrome = old; });
  const store = {};
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in store).map((key) => [key, structuredClone(store[key])])),
    set: async (values) => { Object.assign(store, structuredClone(values)); },
    remove: async (keys) => { for (const key of keys) delete store[key]; },
  } } };
  const id = (n) => `vid${String(n).padStart(5, "0")}`;
  for (let n = 0; n < 505; n++) assert.equal(await sourcePref.set(id(n), n % 2 ? "kotoba" : "youtube"), true);
  const order = store[sourcePref.ORDER_KEY];
  assert.equal(order.length, 500);
  assert.equal(order[0], id(5));
  assert.equal(order.at(-1), id(504));
  assert.equal(Object.keys(store).filter((key) => key !== sourcePref.ORDER_KEY).length, 500);
  assert.equal(await sourcePref.get(id(0)), null, "the oldest were dropped");
  assert.equal(await sourcePref.get(id(5)), "kotoba");
  // Setting it again moves it to the newest end instead of adding a second entry.
  await sourcePref.set(id(5), "youtube");
  assert.equal(store[sourcePref.ORDER_KEY].at(-1), id(5));
  assert.equal(store[sourcePref.ORDER_KEY].length, 500);
  assert.equal(await sourcePref.get(id(5)), "youtube");
  await sourcePref.set(id(600), "kotoba");
  assert.equal(await sourcePref.get(id(6)), null);
  assert.equal(await sourcePref.get(id(5)), "youtube");
  // Bad input and bad stored values are ignored.
  assert.equal(await sourcePref.set("../x", "kotoba"), false);
  assert.equal(await sourcePref.set(id(7), "other"), false);
  store[`${sourcePref.PREFIX}${id(8)}`] = { x: 1 };
  assert.equal(await sourcePref.get(id(8)), null);
  assert.equal(await sourcePref.get(sourcePref.ORDER_KEY.slice(sourcePref.PREFIX.length)), null);
  globalThis.chrome = { storage: { local: { get: async () => { throw new Error("storage gone"); }, set: async () => { throw new Error("storage gone"); } } } };
  assert.equal(await sourcePref.get(id(5)), null);
  assert.equal(await sourcePref.set(id(5), "kotoba"), false);
});

test("saved choice: a normal run follows it - YouTube never uses the PC, Kotoba uses it when it runs, no choice is automatic", async (t) => {
  const run = async (stored, health = "up") => {
    const h = await mount(t, { stored, health });
    Object.assign(h.hook.state, { cues: null, status: "idle", complete: false });
    const track = await h.hook.acquireTrack(VIDEO);
    return { h, track };
  };
  const none = await run({});
  assert.equal(none.track.trackKey, "kotoba:ja");
  assert.deepEqual(none.h.asrOps(), ["health", "start", "json3"]);
  const kotoba = await run({ [PREF_KEY]: "kotoba" });
  assert.equal(kotoba.track.trackKey, "kotoba:ja");
  const youtube = await run({ [PREF_KEY]: "youtube" });
  assert.equal(youtube.track.trackKey, "ja:asr");
  assert.deepEqual(youtube.h.asrOps(), [], "the server is not even asked");
  assert.equal(youtube.h.w.__captionCalls, 1);
  const down = await run({ [PREF_KEY]: "kotoba" }, "down");
  assert.equal(down.track.trackKey, "ja:asr");
  assert.deepEqual(down.h.asrOps(), ["health"]);
  // A choice for another video does not matter, and a junk value counts as no choice.
  const other = await run({ "lakomics:youtube:source:otherVideo1": "youtube", [PREF_KEY]: "banana" });
  assert.equal(other.track.trackKey, "kotoba:ja");
});

function workerSetup(t, extra = {}) {
  const old = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  t.after(() => { globalThis.chrome = old.chrome; globalThis.fetch = old.fetch; });
  const stored = { "lakomics:translation:v1": { anthropicApiKey: "mock-key" }, ...extra };
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
  loadWorker();
  const send = (message) => new Promise((resolve) => { listener(message, { tab: { id: 1 } }, resolve); });
  return { stored, send };
}

const MODE = "translate-ko-auto+t8";
const entry = (text) => ({ cues: [{ startMs: 0, endMs: 900, text }], model: "m", createdAt: 1 });
function cachedSetup(t, tracks, pref) {
  const stored = { "lakomics:youtube:subs:index": { [VIDEO]: tracks.map((trackKey) => `${trackKey}|${MODE}`) } };
  for (const trackKey of tracks) stored[`lakomics:youtube:subs:v2:${VIDEO}:${trackKey}:${MODE}`] = entry(trackKey);
  if (pref) stored[PREF_KEY] = pref;
  return workerSetup(t, stored);
}
const cachedTrack = async (send) => (await send({ type: "youtube:getCached", videoId: VIDEO })).cached?.trackKey;

test("saved choice: the cached result shown first follows it when both the PC's and YouTube's exist", async (t) => {
  const both = ["ja:asr", "kotoba:ja"];
  assert.equal(await cachedTrack(cachedSetup(t, both).send), "kotoba:ja", "no choice: the PC's result first, as before");
  assert.equal(await cachedTrack(cachedSetup(t, both, "kotoba").send), "kotoba:ja");
  assert.equal(await cachedTrack(cachedSetup(t, both, "youtube").send), "ja:asr");
  assert.equal(await cachedTrack(cachedSetup(t, [...both, "ja:std"], "youtube").send), "ja:asr");
  assert.equal(await cachedTrack(cachedSetup(t, ["ja:std", "kotoba:ja"], "youtube").send), "ja:std");
  // Only one kind exists: it is still shown whatever was chosen.
  assert.equal(await cachedTrack(cachedSetup(t, ["kotoba:ja"], "youtube").send), "kotoba:ja");
  assert.equal(await cachedTrack(cachedSetup(t, ["ja:asr"], "kotoba").send), "ja:asr");
  assert.equal(await cachedTrack(cachedSetup(t, both, "banana").send), "kotoba:ja");
});

test("clearing the browser's subtitles also clears the saved choices", async (t) => {
  const { stored, send } = cachedSetup(t, ["ja:asr", "kotoba:ja"], "youtube");
  stored[sourcePref.ORDER_KEY] = [VIDEO];
  stored["lakomics:youtube:settings:enabled"] = true;
  const result = await new Promise((resolve) => {
    // The options page is the only sender allowed to clear.
    const handle = globalThis.LakomicsYouTubeService.handle;
    handle({ type: "youtube:clearCache" }, { id: "test", frameId: 0, url: "chrome-extension://test/options/options.html" }).then(resolve);
  });
  assert.equal(result.ok, true);
  assert.equal(PREF_KEY in stored, false);
  assert.equal(sourcePref.ORDER_KEY in stored, false);
  assert.equal(stored["lakomics:youtube:settings:enabled"], true, "settings stay");
  assert.equal(await cachedTrack(send), undefined);
});

test("youtube:process needs no source field and still validates fresh strictly", async (t) => {
  const { send } = workerSetup(t);
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const message = { type: "youtube:process", videoId: VIDEO, trackKey: "kotoba:ja", positionMs: 0, fresh: true,
    json3: { events: [{ tStartMs: 0, dDurationMs: 900, segs: [{ utf8: "あ" }] }] } };
  assert.notEqual((await send(message)).code, "invalid_request");
  assert.deepEqual(await send({ ...message, fresh: "yes" }), { ok: false, code: "invalid_request" });
});
