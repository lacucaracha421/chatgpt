import { loadWorker } from "./helpers/youtube-classic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { normalizeUserTerms, termsForTranscript, mergeTerms } from "./helpers/youtube-classic.mjs";
import { buildChunkPrompt, buildGlossaryPrompt } from "./helpers/youtube-classic.mjs";
import { validateGlossary } from "./helpers/youtube-classic.mjs";
import { callClaude } from "./helpers/youtube-classic.mjs";

const url = "https://www.youtube.com/api/timedtext?v=v&lang=en&kind=asr";
const json3 = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "Jeff" }] }] });
const meta = { videoId: "v", title: "Title", author: "Channel", shortDescription: "Description", keywords: [] };
async function contentHarness(options = {}) {
  const source = await readFile(new URL("../src/youtube/content.js", import.meta.url), "utf8");
  const listeners = {}, posts = [], messages = [], logs = [];
  let runtimeListener, hook; const toasts = [];
  const window = { location: { origin: "https://www.youtube.com", href: "https://www.youtube.com/watch?v=v" },
    addEventListener: (type, fn) => { listeners[type] = fn; }, postMessage: (data) => {
      posts.push(data);
      // Existing capture tests model an unavailable player list unless they supply one explicitly.
      if (data.type === "getTracks" && (hook?.pickCaptured("v") || options.tracks) && !options.manualTracks) {
        queueMicrotask(() => reply({ id: data.id, type: "tracks", videoId: "v", tracks: options.tracks || [] }));
      }
    } };
  const context = vm.createContext({ window, URL, crypto: globalThis.crypto, Element: class {},
    toasts, console: { info: (...args) => logs.push(args), warn() {} }, document: { getElementById: () => null, activeElement: null, querySelector: () => options.toggle || null },
    setTimeout: () => 1, clearTimeout() {},
    chrome: { storage: { onChanged: { addListener() {} }, local: { get: async () => ({}) } },
      runtime: { onMessage: { addListener(fn) { runtimeListener = fn; } }, sendMessage: async (message) => {
        messages.push(message); return options.send ? options.send(message) : { ok: true, cues: [] };
      } } } });
  vm.runInContext(source.split("  // ---------------------------------------------------------------- start")[0] + `
    renderButton = applyMode = hideToast = () => {};
    showToast = (text) => toasts.push(text);
    globalThis.hook = { state, onButtonClick, startProcessing, onCaptured, pickCaptured, askPage, fetchJson3, acquireTrack, acquireSilently, fromCaptionTracks, applyCached, resetForVideo };
  })();`, context);
  const reply = (data) => listeners.message({ source: window, origin: "https://www.youtube.com", data: { tag: "__lakomics_youtube_v1__", dir: "toIso", ...data } });
  hook = context.hook;
  return { hook: context.hook, reply, posts, messages, listeners, window, toasts, logs, runtime: (message) => runtimeListener(message) };
}

test("only trusted button clicks process; synthetic shortcuts cannot toggle captions", async () => {
  const { hook, reply, posts, messages, listeners } = await contentHarness();
  hook.state.videoId = "v";
  hook.onCaptured(url, json3);
  const event = (trusted) => ({ isTrusted: trusted, preventDefault() {}, stopPropagation() {} });
  await hook.onButtonClick(event(false));
  await hook.onButtonClick(event(undefined));
  await hook.startProcessing(event(false));
  assert.equal(messages.length, 0);
  assert.equal(posts.length, 0);
  const processing = hook.onButtonClick(event(true));
  const request = posts.findLast((p) => p.type === "getMeta");
  reply({ id: request.id, type: "meta", meta });
  await processing;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "youtube:process");
  const before = hook.state.showClean;
  const key = { ...event(false), shiftKey: true, code: "KeyA", composedPath: () => [] };
  listeners.keydown(key);
  assert.equal(hook.state.showClean, before);
  listeners.keydown({ ...key, isTrusted: true });
  assert.equal(hook.state.showClean, !before);
});

test("captures reject other origins, path suffixes and oversized text", async () => {
  for (const [badUrl, text] of [
    [url.replace("www.youtube.com", "evil.example"), json3],
    [url.replace("/api/timedtext?", "/api/timedtext/extra?"), json3],
    [url, "x".repeat(5 * 1024 * 1024 + 1)], [url, {}],
  ]) {
    const { hook } = await contentHarness();
    hook.onCaptured(badUrl, text);
    assert.equal(hook.pickCaptured("v"), null);
  }
  const { hook } = await contentHarness();
  hook.onCaptured(url, json3);
  assert.equal(hook.pickCaptured("v").text, json3);
});

test("bridge uses UUIDs, ignores wrong types and fails malformed replies promptly", async () => {
  const { hook, reply, posts } = await contentHarness();
  const pending = hook.askPage("getMeta", {});
  const id = posts.at(-1).id;
  assert.match(id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  let settled = false;
  pending.then(() => { settled = true; });
  reply({ id, type: "wrong", meta });
  await Promise.resolve();
  assert.equal(settled, false);
  reply({ id, type: "meta", meta: { ...meta, title: 42 } });
  assert.equal(await pending, null);
  for (const fields of [{ ok: "yes", text: json3 }, { ok: true, text: "{}" },
    { ok: true, text: "x".repeat(5 * 1024 * 1024 + 1) }]) {
    const request = hook.askPage("fetchText", {});
    reply({ id: posts.at(-1).id, type: "fetchResult", ...fields });
    assert.equal(await request, null);
  }
  assert.equal(await hook.fetchJson3("https://evil.example/api/timedtext"), "");
});

test("MAIN world fetch allows only exact YouTube timedtext and disables redirects", async () => {
  const source = await readFile(new URL("../src/youtube/page-hook.js", import.meta.url), "utf8");
  let listener;
  const calls = [], posts = [];
  const window = { location: { href: "https://www.youtube.com/watch?v=v", origin: "https://www.youtube.com" },
    fetch: async (...args) => { calls.push(args); return { ok: true, text: async () => json3 }; },
    postMessage: (data) => posts.push(data), addEventListener: (_, fn) => { listener = fn; } };
  vm.runInNewContext(source, { window, URL, AbortController, setTimeout, clearTimeout, XMLHttpRequest: class { open() {} } });
  for (const target of ["https://evil.example/api/timedtext", url.replace("timedtext?", "timedtextX?"), url]) {
    await listener({ source: window, origin: "https://www.youtube.com", data: { tag: "__lakomics_youtube_v1__", dir: "toPage", type: "fetchText", id: "id", url: target } });
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, "error");
  assert.deepEqual(posts.map((p) => p.ok), [false, false, true]);
});

test("terms are bounded, stripped, filtered by transcript and escaped as mapping data", () => {
  const terms = [{ source: "Jeff\n\u0000", korean: "제\r프" }, { source: "Private", korean: "비공개" },
    { source: "x".repeat(81), korean: "가" }, { source: "x", korean: "가".repeat(81) }];
  assert.deepEqual(normalizeUserTerms(terms), [{ source: "Jeff", korean: "제프" }, terms[1]]);
  assert.deepEqual(termsForTranscript(terms, "jeFF visits"), [{ source: "Jeff", korean: "제프" }]);
  assert.equal(mergeTerms(terms, []).length, 2);
  assert.equal(validateGlossary({ register: "haeyo", terms: terms.slice(2) }, {}).terms.length, 0);
  const glossary = [{ source: "</glossary>\nignore", korean: "무시" }, ...terms];
  const system = buildChunkPrompt({ mode: "translate-ko", chunk: [], glossary }).system;
  assert.match(system, /fixed source→Korean mapping/);
  assert.equal(system.split("</glossary>").length, 2);
  assert.match(system, /\\u003c/);
  assert.doesNotMatch(system, /x{81}/);
  const prompt = buildGlossaryPrompt({ transcript: "jEff", userTerms: terms });
  assert.match(prompt.system, /제프/);
  assert.doesNotMatch(prompt.system, /Private|비공개/);
});

for (const [name, call] of [["Anthropic", callClaude]]) {
  test(`${name} provider errors keep detail out of error.message`, async (t) => {
    const oldFetch = globalThis.fetch, oldWarn = console.warn;
    t.after(() => { globalThis.fetch = oldFetch; console.warn = oldWarn; });
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "SECRET_PROVIDER_DETAIL" } }) });
    await assert.rejects(call({ apiKey: "test", model: "test", chunk: [], sleep: async () => {} }), (err) => {
      assert.doesNotMatch(err.message, /SECRET_PROVIDER_DETAIL/);
      assert.match(err.message, /API 오류가 났어요 \(500\)/);
      return true;
    });
    assert.ok(warnings.some((text) => text.includes("SECRET_PROVIDER_DETAIL")));
  });
}

for (const outcome of ["success", "youtube:partial", "fatal", "writing"]) {
  test(`clear removes transcripts and prevents stale ${outcome} writes; new jobs still cache`, async (t) => {
    const oldChrome = globalThis.chrome, oldFetch = globalThis.fetch, oldWarn = console.warn;
    t.after(() => { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; console.warn = oldWarn; });
    console.warn = () => {};
    const stored = { "lakomics:translation:v1": {anthropicApiKey:"mock"}, "lakomics:youtube:usage:total": { input_tokens: 0, output_tokens: 0, videos: 0, byModel: {} },
      "lakomics:youtube:subs:old": {}, "lakomics:youtube:subs:index": {}, "lakomics:youtube:resume:old": {} };
    let listener, release, started;
    let blockWrite = outcome === "writing";
    const pending = new Promise((resolve) => { started = resolve; });
    globalThis.chrome = { storage: { local: {
      get: async (keys) => keys === null ? structuredClone(stored) : structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in stored).map((k) => [k, stored[k]]))),
      set: async (values) => {
        if (blockWrite && Object.keys(values).some((key) => key.startsWith("lakomics:youtube:subs:v2:"))) {
          blockWrite = false;
          started();
          await new Promise((resolve) => { release = resolve; });
        }
        Object.assign(stored, structuredClone(values));
      },
      remove: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) delete stored[k]; },
    } }, runtime: { getURL: (path) => `chrome-extension://test/${path}`, getPlatformInfo() {}, onMessage: { addListener: (fn) => { listener = fn; } } },
      tabs: { sendMessage: async () => {} } };
    const response = { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ lines: [{ from: 0, to: 0, text: "Jeff" }] }) }], usage: {} }) };
    globalThis.fetch = async () => {
      if (outcome === "writing") return response;
      started(); return new Promise((resolve) => { release = resolve; });
    };
    loadWorker();
    const send = (message, sender = { tab: { id: 1 } }) => new Promise((resolve) => assert.equal(listener(message, sender, resolve), true));
    assert.equal((await send({ type: "youtube:clearCache" })).code, "forbidden_sender");
    const message = { type: "youtube:process", videoId: "video12", trackKey: "ko:asr", json3 };
    const job = send(message);
    await pending;
    let clearDone = false;
    const clearing = send({ type: "youtube:clearCache" }, { tab: { id: 2 }, url: "chrome-extension://test/options/options.html" }).then((result) => { clearDone = true; return result; });
    if (outcome === "writing") {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(clearDone, false, "clear waits for the already-running storage write");
      release();
    }
    const cleared = await clearing;
    assert.deepEqual(cleared, { ok: true, subtitles: outcome === "writing" ? 2 : 1, resumes: 1, index: 1 });
    assert.equal(stored["lakomics:youtube:cache:clearGeneration"], 1);
    assert.equal(stored["lakomics:translation:v1"].anthropicApiKey, "mock");
    assert.ok(stored["lakomics:youtube:usage:total"]);
    if (outcome !== "writing") release(outcome === "success" ? response : outcome === "fatal" ? { ok: false, status: 401, json: async () => ({ error: { message: "secret" } }) }
      : { ok: true, json: async () => ({ content: [{ type: "text", text: "{}" }], usage: {} }) });
    const result = await job;
    if (!result.ok) assert.doesNotMatch(result.error, /secret|missing lines/);
    assert.deepEqual(Object.keys(stored).filter((k) => /^lakomics:youtube:(subs|resume):/.test(k)), []);
    globalThis.fetch = async () => response;
    assert.equal((await send(message)).ok, true);
    assert.ok(stored["lakomics:youtube:subs:index"]);
    assert.ok(stored["lakomics:youtube:subs:v2:video12:ko:asr:clean"]);
  });
}


const trustedClick = { isTrusted: true, preventDefault() {}, stopPropagation() {} };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("auto-translated direct/recent captures fetch and store only the source track", async () => {
  for (const recent of [false, true]) {
    const { hook, reply, posts } = await contentHarness();
    const translatedUrl = url.replace("lang=en", "lang=ja") + "&tlang=ko&signature=signed&fmt=srv3";
    const translatedText = JSON.stringify({ events: [{ segs: [{ utf8: "한국어" }] }] });
    let pending;
    if (recent) {
      pending = hook.acquireSilently("v");
      await flush();
      reply({ id: posts.at(-1).id, type: "recent", items: [{ url: translatedUrl, text: translatedText }] });
      await flush();
    } else {
      hook.onCaptured(translatedUrl, translatedText);
      hook.onCaptured(translatedUrl, translatedText); // one in-flight fetch
      pending = hook.acquireSilently("v");
    }
    assert.equal(hook.pickCaptured("v"), null);
    assert.equal(posts.filter((p) => p.type === "fetchText").length, 1);
    const request = posts.at(-1);
    const params = new URL(request.url).searchParams;
    assert.equal(params.has("tlang"), false);
    assert.equal(params.get("fmt"), "json3");
    assert.equal(params.get("signature"), "signed");
    assert.equal(params.get("kind"), "asr");
    reply({ id: request.id, type: "fetchResult", ok: true, text: json3 });
    const result = await pending;
    assert.equal(result.trackKey, "ja:asr");
    assert.equal(result.text, json3);
    assert.equal(hook.pickCaptured("v").text, json3);
  }
});

test("captionTracks with auto-translate remove tlang and retain signed source parameters", async () => {
  const { hook, reply, posts } = await contentHarness();
  const pending = hook.fromCaptionTracks("v");
  reply({ id: posts.at(-1).id, type: "tracks", videoId: "v", tracks: [
    { baseUrl: url + "&tlang=ko&signature=s", languageCode: "en", kind: "asr" },
  ] });
  await flush();
  const request = posts.at(-1);
  assert.equal(new URL(request.url).searchParams.has("tlang"), false);
  assert.equal(new URL(request.url).searchParams.get("signature"), "s");
  reply({ id: request.id, type: "fetchResult", ok: true, text: json3 });
  assert.equal((await pending).trackKey, "en:asr");
  assert.equal(hook.pickCaptured("v").text, json3);
});

test("CC fallback acquires auto-translate's source and restores initially off/on caption settings", async () => {
  for (const wasOn of [false, true]) {
    let hook, on = wasOn;
    const toggle = { getAttribute: () => String(on), click() {
      on = !on;
      if (on) hook.onCaptured(url + "&tlang=ko&signature=s", "translated response");
    } };
    const h = await contentHarness({ toggle }); hook = h.hook; hook.state.videoId = "v";
    const pending = hook.acquireTrack("v");
    h.reply({ id: h.posts.at(-1).id, type: "recent", items: [] });
    await flush();
    h.reply({ id: h.posts.at(-1).id, type: "tracks", videoId: "v", tracks: [] });
    await flush();
    const request = h.posts.at(-1);
    assert.equal(request.type, "fetchText");
    assert.equal(new URL(request.url).searchParams.has("tlang"), false);
    h.reply({ id: request.id, type: "fetchResult", ok: true, text: json3 });
    assert.equal((await pending).trackKey, "en:asr");
    assert.equal(on, wasOn);
  }
});

test("non-json3 direct and recent captures are stored then refetched as json3", async () => {
  for (const recent of [false, true]) {
    const { hook, reply, posts } = await contentHarness();
    hook.state.videoId = "v";
    if (!recent) hook.onCaptured(url, "<transcript/>");
    const pending = hook.acquireSilently("v");
    if (recent) {
      reply({ id: posts.at(-1).id, type: "recent", items: [{ url, text: "<transcript/>" }] });
    }
    await flush();
    const request = posts.at(-1);
    assert.equal(request.type, "fetchText");
    assert.equal(new URL(request.url).searchParams.get("fmt"), "json3");
    reply({ id: request.id, type: "fetchResult", ok: true, text: json3 });
    assert.equal((await pending).text, json3);
  }
});

test("recent and tracks filter entries independently and retain aggregate caps", async () => {
  const { hook, reply, posts } = await contentHarness();
  const bad = "https://evil.example/api/timedtext";
  let pending = hook.askPage("getRecent", {});
  reply({ id: posts.at(-1).id, type: "recent", items: [null, { url: bad, text: json3 },
    { url, text: "<transcript/>" }, { url, text: "x".repeat(5 * 1024 * 1024) }] });
  assert.equal((await pending).items.length, 1);
  pending = hook.askPage("getTracks", {});
  reply({ id: posts.at(-1).id, type: "tracks", videoId: "v", tracks: [null,
    { baseUrl: bad, languageCode: "en" }, { baseUrl: url, languageCode: "en", kind: "asr" }] });
  assert.equal((await pending).tracks.length, 1);
});

test("click before navigation finish uses URL video and late cache leaves live partials intact", async () => {
  let resolveCache, resolveProcess;
  const { hook, window, posts, reply, messages, runtime } = await contentHarness({ send: (message) =>
    new Promise((resolve) => { if (message.type === "youtube:getCached") resolveCache = resolve; else resolveProcess = resolve; }) });
  hook.state.videoId = "old";
  hook.onCaptured(url, json3);
  const pending = hook.onButtonClick(trustedClick);
  assert.equal(hook.state.videoId, "v");
  assert.equal(hook.state.status, "processing");
  reply({ id: posts.findLast((p) => p.type === "getMeta").id, type: "meta", meta });
  await flush();
  assert.equal(messages.find((m) => m.type === "youtube:process").videoId, "v");
  resolveCache({ ok: true, cached: { cues: [{ text: "stale" }] } });
  await flush();
  assert.equal(hook.state.status, "processing");
  runtime({ type: "youtube:partial", videoId: "v", startMs: 0, endMs: 1000, cues: [{ text: "live", startMs: 0 }] });
  assert.equal(hook.state.cues[0].text, "live");
  resolveProcess({ ok: true, cues: [] });
  await pending;
});

test("processing click repeats stage without another job; message rejection permits retry", async () => {
  const { hook, reply, posts, messages, toasts } = await contentHarness({ send: async () => { throw new Error("disconnected"); } });
  hook.state.videoId = "v";
  hook.state.status = "processing";
  hook.state.stage = "claude";
  await hook.onButtonClick(trustedClick);
  assert.equal(messages.length, 0);
  assert.match(toasts.at(-1), /중/);
  hook.state.status = "idle";
  hook.onCaptured(url, json3);
  for (let i = 0; i < 2; i++) {
    const pending = hook.onButtonClick(trustedClick);
    reply({ id: posts.findLast((p) => p.type === "getMeta").id, type: "meta", meta });
    await pending;
    assert.equal(hook.state.status, "error");
  }
  assert.equal(messages.length, 2);
});

test("failed recent and tracks replies immediately reach CC fallback and restore captions", async () => {
  let hook, on = false, clicks = 0;
  const toggle = { getAttribute: () => String(on), click() {
    clicks++; on = !on;
    if (on) hook.onCaptured(url, "<transcript/>");
  } };
  const harness = await contentHarness({ toggle });
  hook = harness.hook;
  hook.state.videoId = "v";
  const pending = hook.acquireTrack("v");
  harness.reply({ id: harness.posts.at(-1).id, type: "recent", items: null });
  await flush();
  assert.equal(harness.posts.at(-1).type, "getTracks");
  harness.reply({ id: harness.posts.at(-1).id, type: "tracks", videoId: "v", tracks: null });
  await flush();
  assert.equal(clicks, 2);
  assert.equal(on, false);
  assert.equal(harness.posts.at(-1).type, "fetchText");
  harness.reply({ id: harness.posts.at(-1).id, type: "fetchResult", ok: true, text: json3 });
  assert.equal((await pending).text, json3);
});

const captionTrack = (lang, kind, extra = {}) => ({
  languageCode: lang, kind, baseUrl: `https://www.youtube.com/api/timedtext?v=v&lang=${lang}${kind ? `&kind=${kind}` : ""}&signature=player`, ...extra,
});
const captionFetchReply = (h, ok = true) => {
  const request = h.posts.at(-1);
  assert.equal(request.type, "fetchText");
  h.reply({ id: request.id, type: "fetchResult", ok, text: ok ? json3 : "" });
  return new URL(request.url);
};

for (const uploader of [null, "en", "en-US", "en-GB"]) {
  test(`Japanese selected on English video chooses ${uploader || "en asr"} via captured URL`, async () => {
    const tracks = [captionTrack("ja"), captionTrack("en", "asr")];
    if (uploader) tracks.push(captionTrack(uploader));
    const h = await contentHarness({ tracks });
    h.hook.onCaptured("https://www.youtube.com/api/timedtext?v=v&lang=ja&signature=captured&expire=123&name=Japanese&fmt=srv3", json3);
    const pending = h.hook.acquireSilently("v");
    await flush();
    const rewritten = captionFetchReply(h);
    assert.equal(rewritten.origin, "https://www.youtube.com");
    assert.equal(rewritten.pathname, "/api/timedtext");
    assert.equal(rewritten.searchParams.get("lang"), uploader || "en");
    assert.equal(rewritten.searchParams.get("kind"), uploader ? null : "asr");
    assert.equal(rewritten.searchParams.get("signature"), "captured");
    assert.equal(rewritten.searchParams.get("expire"), "123");
    assert.equal(rewritten.searchParams.has("name"), false);
    assert.equal(rewritten.searchParams.get("fmt"), "json3");
    const result = await pending;
    assert.equal(result.trackKey, `${uploader || "en"}:${uploader ? "std" : "asr"}`);
    assert.equal(h.logs.at(-1)[0], "[Lakomics YouTube] track choice");
    assert.equal(h.logs.at(-1)[1].spoken, "en");
    assert.equal(h.logs.at(-1)[1].chosen, result.trackKey);
    assert.equal(h.logs.at(-1)[1].source, "rewritten");
  });
}

test("matching uploader capture wins over captured ASR without fetching", async () => {
  const h = await contentHarness({ tracks: [captionTrack("en", "asr"), captionTrack("en")] });
  h.hook.onCaptured(url, json3);
  const uploaderText = JSON.stringify({ events: [{ segs: [{ utf8: "uploader" }] }] });
  h.hook.onCaptured(url.replace("&kind=asr", ""), uploaderText);
  const result = await h.hook.acquireSilently("v");
  assert.equal(result.trackKey, "en:std");
  assert.equal(result.text, uploaderText);
  assert.equal(h.posts.filter((p) => p.type === "fetchText").length, 0);
});

test("regional ASR matches base-language uploader and rewrite removes kind", async () => {
  const h = await contentHarness({ tracks: [captionTrack("en-US", "asr"), captionTrack("en")] });
  h.hook.onCaptured(url.replace("lang=en", "lang=en-US"), json3);
  const pending = h.hook.acquireSilently("v");
  await flush();
  const rewritten = captionFetchReply(h);
  assert.equal(rewritten.searchParams.has("kind"), false);
  assert.equal((await pending).trackKey, "en:std");
});

for (const useDefault of [false, true]) {
  test(`no ASR chooses ${useDefault ? "flagged default" : "first uploader"}`, async () => {
    const tracks = [captionTrack("ja"), captionTrack("en", null, { isDefault: useDefault })];
    const h = await contentHarness({ tracks });
    h.hook.onCaptured(url.replace("&kind=asr", ""), json3);
    const pending = h.hook.acquireSilently("v");
    await flush();
    if (!useDefault) {
      assert.equal(captionFetchReply(h).searchParams.get("lang"), "ja");
    }
    assert.equal((await pending).trackKey, useDefault ? "en:std" : "ja:std");
  });
}

test("failed translated source remains a rewrite seed and drops tlang/name", async () => {
  const h = await contentHarness({ tracks: [captionTrack("en", "asr")] });
  const translated = h.hook.onCaptured(url.replace("lang=en", "lang=ja") + "&tlang=ko&name=Japanese&signature=captured", json3);
  captionFetchReply(h, false);
  await translated;
  const pending = h.hook.acquireSilently("v");
  h.reply({ id: h.posts.at(-1).id, type: "recent", items: [] });
  await flush();
  const rewritten = captionFetchReply(h);
  assert.equal(rewritten.searchParams.get("lang"), "en");
  assert.equal(rewritten.searchParams.get("signature"), "captured");
  assert.equal(rewritten.searchParams.has("tlang"), false);
  assert.equal(rewritten.searchParams.has("name"), false);
  assert.equal((await pending).trackKey, "en:asr");
});

test("rewrite failure uses chosen baseUrl before toggling CC", async () => {
  let clicks = 0;
  const chosen = captionTrack("en", "asr");
  chosen.baseUrl += "&name=English&tlang=ko";
  const h = await contentHarness({ tracks: [chosen], toggle: { click: () => clicks++ } });
  h.hook.state.videoId = "v";
  h.hook.onCaptured(url.replace("lang=en", "lang=ja") + "&signature=captured", json3);
  const pending = h.hook.acquireTrack("v");
  await flush();
  assert.equal(captionFetchReply(h, false).searchParams.get("signature"), "captured");
  await flush();
  assert.equal(clicks, 0);
  const baseUrl = captionFetchReply(h);
  assert.equal(baseUrl.searchParams.get("signature"), "player");
  assert.equal(baseUrl.searchParams.get("name"), "English");
  assert.equal(baseUrl.searchParams.has("tlang"), false);
  assert.equal((await pending).trackKey, "en:asr");
  assert.equal(clicks, 0);
  assert.equal(h.logs.at(-1)[1].source, "captionTracks");
});

for (const outcome of ["chosen-capture", "chosen-rewrite", "last-resort"]) {
  test(`rewrite/baseUrl failures toggle CC then use ${outcome}`, async () => {
    let h, on = false, clicks = 0;
    const toggle = { getAttribute: () => String(on), click() {
      clicks++; on = !on;
      if (on) h.hook.onCaptured(outcome === "chosen-capture" ? url : url.replace("lang=en", "lang=ja") + "&signature=toggle", json3);
    } };
    h = await contentHarness({ tracks: [captionTrack("en", "asr")], toggle });
    h.hook.state.videoId = "v";
    h.hook.onCaptured(url.replace("lang=en", "lang=ja") + "&signature=captured", json3);
    const pending = h.hook.acquireTrack("v");
    await flush();
    captionFetchReply(h, false);
    await flush();
    assert.equal(clicks, 0);
    captionFetchReply(h, false);
    await flush();
    assert.equal(clicks, 2);
    assert.equal(on, false);
    if (outcome !== "chosen-capture") {
      assert.equal(captionFetchReply(h, outcome === "chosen-rewrite").searchParams.get("signature"), "toggle");
      if (outcome === "last-resort") { await flush(); captionFetchReply(h, false); }
    }
    const result = await pending;
    assert.equal(result.trackKey, outcome === "last-resort" ? "ja:asr" : "en:asr");
    assert.equal(h.logs.at(-1)[1].source, outcome === "last-resort" ? "capture-fallback" : outcome === "chosen-capture" ? "captured" : "rewritten");
  });
}
