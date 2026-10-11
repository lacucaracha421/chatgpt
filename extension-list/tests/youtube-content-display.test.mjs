import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function harness() {
  class Node {
    constructor() {
      this.children = []; this.isConnected = true; this.textContent = "";
      const names = new Set();
      this.classList = { contains: (name) => names.has(name), remove: (name) => names.delete(name),
        toggle(name, on) { if (on) names.add(name); else names.delete(name); } };
      this.style = { display: "", setProperty() {} };
    }
    appendChild(node) { node.parentNode = this; this.children.push(node); }
    replaceChildren(...nodes) { this.children = []; nodes.forEach((node) => this.appendChild(node)); }
    addEventListener(name, fn) { events[name] = fn; }
    remove() { this.isConnected = false; }
    querySelector() { return video; }
    querySelectorAll() { return captionVisible ? [{ textContent: "YouTube subtitle", getClientRects: () => [1] }] : []; }
  }
  let player = new Node(), captionVisible = false;
  const video = { currentTime: 1, paused: false }, events = {}, frames = new Map();
  let nextFrame = 1, sendReply;
  const source = await readFile(new URL("../src/youtube/content.js", import.meta.url), "utf8");
  const window = { location: { href: "https://www.youtube.com/watch?v=v", origin: "https://www.youtube.com" },
    addEventListener() {}, postMessage() {} };
  const context = vm.createContext({ window, URL, crypto: globalThis.crypto, console: { info() {}, warn() {} },
    document: { getElementById: id => id === "movie_player" ? player : null, createElement: () => new Node() },
    requestAnimationFrame(fn) { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle: () => ({ visibility: "visible", opacity: "1" }),
    setTimeout: () => 1, clearTimeout() {}, ResizeObserver: class { observe() {} disconnect() {} },
    chrome: { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}) } },
      runtime: { onMessage: { addListener() {} }, sendMessage: () => new Promise((resolve) => { sendReply = resolve; }) } } });
  vm.runInContext(source.split("  // ---------------------------------------------------------------- start")[0] + `
    renderButton = showToast = hideToast = () => {};
    acquireTrack = async () => ({ trackKey: "ja:asr", text: "{}" });
    fetchMeta = async () => null;
    globalThis.hook = { state, mergePartial, applyMode, startProcessing, sync, ensureUi,
      overlay: () => overlay, stop: () => { if (rafId) cancelAnimationFrame(rafId); rafId = 0; } };
  })();`, context);
  const hook = context.hook;
  hook.state.videoId = "v"; hook.state.status = "processing"; hook.state.busyVisible = true;
  const tick = (time) => {
    video.currentTime = time;
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn());
  };
  const text = () => {
    const collect = (node) => node.textContent || node.children.map(collect).join(" ");
    return collect(hook.overlay());
  };
  return { hook, video, frames, events, tick, text, player: () => player,
    captions: (visible) => { captionVisible = visible; }, replacePlayer: () => { player = new Node(); },
    reply: (data) => sendReply(data) };
}

const cue = (startMs, endMs, text) => ({ startMs, endMs, text });
const partial = (startMs, endMs, cues) => ({ startMs, endMs, cues });

test("first and later partials render immediately while paused; replacing same-index cue invalidates cache", async () => {
  const h = await harness(); h.video.paused = true;
  h.hook.mergePartial(partial(0, 3000, [cue(0, 3000, "first")]));
  assert.equal(h.text(), "first");
  h.hook.mergePartial(partial(0, 3000, [cue(0, 3000, "replacement")]));
  assert.equal(h.text(), "replacement");
  assert.equal(h.hook.overlay().style.display, "block");
});

test("later partial restarts a stopped frame loop and advances without seek or media events", async () => {
  const h = await harness();
  h.hook.mergePartial(partial(0, 3000, [cue(0, 3000, "first")]));
  h.hook.stop();
  h.hook.mergePartial(partial(3000, 6000, [cue(3000, 6000, "next")]));
  assert.equal(h.frames.size, 1);
  h.tick(4);
  assert.equal(h.text(), "next");
  assert.equal(h.frames.size, 1);
});

test("out-of-order/adjacent ranges and half-open boundaries display current cue immediately", async () => {
  const h = await harness(); h.video.currentTime = 4;
  h.hook.mergePartial(partial(3000, 6000, [cue(3000, 6000, "later")]));
  h.hook.mergePartial(partial(0, 3000, [cue(0, 3000, "earlier")]));
  assert.equal(h.text(), "later");
  assert.equal(h.hook.state.ranges.length, 1);
  h.tick(3); assert.equal(h.text(), "later");
  h.tick(2.999); assert.equal(h.text(), "earlier");
});

test("partial reattaches overlay to replacement player and UI repair resumes playback", async () => {
  const h = await harness();
  h.hook.mergePartial(partial(0, 3000, [cue(0, 3000, "first")]));
  h.replacePlayer();
  h.hook.mergePartial(partial(0, 3000, [cue(0, 3000, "new player")]));
  assert.equal(h.hook.overlay().parentNode, h.player());
  assert.equal(h.text(), "new player");
});

test("processing note appears before/between partials only with YouTube text absent and hides on completion", async () => {
  const h = await harness();
  h.hook.applyMode();
  assert.equal(h.text(), "이 구간은 아직 처리 중이에요");
  assert.equal(h.player().classList.contains("lakomics-yt-active"), false);
  assert.equal(h.hook.overlay().classList.contains("lakomics-yt-waiting"), true);
  h.captions(true); h.tick(1);
  assert.equal(h.hook.overlay().style.display, "none");
  h.captions(false); h.tick(1);
  assert.equal(h.hook.overlay().style.display, "block");
  h.hook.mergePartial(partial(0, 3000, [cue(0, 3000, "ready part")]));
  assert.equal(h.text(), "ready part");
  h.tick(4); assert.equal(h.text(), "이 구간은 아직 처리 중이에요");
  h.hook.state.status = "ready"; h.hook.state.complete = true; h.hook.applyMode();
  assert.equal(h.hook.overlay().style.display, "none");
  h.hook.state.status = "error"; h.hook.applyMode();
  assert.equal(h.hook.overlay().style.display, "none");
});

test("final result replaces partial cue at same index immediately without seeking", async () => {
  const h = await harness(); h.video.paused = true; h.hook.state.status = "idle";
  const pending = h.hook.startProcessing({ isTrusted: true });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  h.hook.mergePartial(partial(0, 3000, [cue(0, 3000, "youtube:partial")]));
  assert.equal(h.text(), "youtube:partial");
  h.reply({ ok: true, cues: [cue(0, 3000, "final")] });
  await pending;
  assert.equal(h.text(), "final");
  assert.equal(h.hook.state.complete, true);
});
