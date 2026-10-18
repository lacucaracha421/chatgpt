import { loadWorker, buildChunkPrompt, buildGlossaryPrompt } from "./helpers/youtube-classic.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { matchStyleRule, STYLE_RULES } = globalThis.LakomicsYouTube.prompts;

const avgnByTitle = { videoId: "avgn-video", title: "Ghostbusters (NES) - Angry Video Game Nerd (AVGN)", author: "Some Reupload" };
const avgnByChannel = { videoId: "avgn-video", title: "Ep 12", author: "Cinemassacre" };
const other = { videoId: "avgn-video", title: "Retro games tour", author: "Retro Channel" };

async function setup(t, settings = {}) {
  const old = { chrome: globalThis.chrome, fetch: globalThis.fetch, warn: console.warn };
  t.after(() => { globalThis.chrome = old.chrome; globalThis.fetch = old.fetch; console.warn = old.warn; });
  const stored = { "lakomics:translation:v1": { anthropicApiKey: "mock-key" }, ...settings };
  console.warn = () => {};
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
  const send = (message) => new Promise((resolve) => { assert.equal(listener(message, { tab: { id: 1 } }, resolve), true); });
  return { stored, send };
}
const response = (value) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(value) }], usage: { input_tokens: 3, output_tokens: 2 } }) });
const isGlossary = (body) => body.output_config.format.schema.required.includes("terms");
const translated = (body) => {
  const numbered = body.messages[0].content.split("\n").filter((line) => /^\d+\t/.test(line));
  return { register: "banmal", lines: [{ from: 0, to: numbered.length - 1, text: "번역한 자막" }] };
};
const request = (meta) => ({ type: "youtube:process", videoId: "avgn-video", trackKey: "en:asr", positionMs: 0, meta,
  json3: { events: [{ tStartMs: 0, dDurationMs: 90000, segs: Array.from({ length: 150 }, (_, i) => ({ utf8: `w${i}`, tOffsetMs: i * 300 })) }] } });

test("AVGN is detected by title and by channel, and only those", () => {
  assert.equal(matchStyleRule(avgnByTitle)?.id, "avgn1");
  assert.equal(matchStyleRule(avgnByChannel)?.id, "avgn1");
  assert.equal(matchStyleRule({ title: "the avgn movie trailer", author: "x" })?.id, "avgn1");
  assert.equal(matchStyleRule({ title: "x", author: "JamesNintendoNerd" })?.id, "avgn1");
  assert.equal(matchStyleRule({ title: "Review of Navgnation", author: "x" }), null);
  assert.equal(matchStyleRule(other), null);
  assert.equal(matchStyleRule(null), null);
  assert.equal(matchStyleRule({ title: 5, author: {} }), null);
  assert.ok(STYLE_RULES.every((rule) => /^[a-z]+\d+$/.test(rule.id)));
});

test("the AVGN instructions reach the chunk and overview prompts only for matching videos", () => {
  const chunk = [{ text: "hi", startMs: 0, endMs: 100 }];
  for (const meta of [avgnByTitle, avgnByChannel]) {
    const system = buildChunkPrompt({ chunk, mode: "translate-ko", register: { follow: "haeyo" }, meta }).system;
    assert.match(system, /Angry Video Game Nerd, AVGN/);
    assert.match(system, /해요체 \(~요\) and 합니다체 \(~니다\)/);
    assert.match(system, /Skits and role-play use 반말/);
    assert.match(system, /욕은 찰지게/);
    assert.doesNotMatch(system, /chosen once for the whole video from the source's tone/);
    assert.match(buildGlossaryPrompt({ transcript: "hi", meta }).system, /Channel style rule \(AVGN\)/);
  }
  const plain = buildChunkPrompt({ chunk, mode: "translate-ko", register: { follow: "haeyo" }, meta: other }).system;
  assert.doesNotMatch(plain, /AVGN|찰지게|Skits/);
  assert.match(plain, /chosen once for the whole video/);
  assert.doesNotMatch(buildGlossaryPrompt({ transcript: "hi", meta: other }).system, /AVGN/);
  assert.doesNotMatch(buildChunkPrompt({ chunk, mode: "translate-ko", register: { follow: "haeyo" } }).system, /AVGN/);
  assert.doesNotMatch(buildChunkPrompt({ chunk, mode: "clean", meta: avgnByTitle }).system, /AVGN|찰지게/);
});

test("fixed registers keep their register and still get the profanity line", () => {
  const chunk = [{ text: "hi", startMs: 0, endMs: 100 }];
  const system = buildChunkPrompt({ chunk, mode: "translate-ko", register: "hapnida", meta: avgnByTitle }).system;
  assert.match(system, /exactly this Korean speech register for every line: hapnida/);
  assert.match(system, /욕은 찰지게/);
  assert.doesNotMatch(system, /Skits and role-play use 반말/);
});

test("the cache key gets the rule id only for matching translated videos", async (t) => {
  await setup(t);
  const { storedModeFor } = globalThis.LakomicsYouTubeService;
  const base = { translate: true, speakers: false, glossarySonnet: false, model: "claude-haiku-5-5", registerSetting: "auto" };
  assert.equal(storedModeFor("en:asr", base), "translate-ko-auto+t8");
  assert.equal(storedModeFor("en:asr", base, "avgn1"), "translate-ko-auto+avgn1+t8");
  assert.equal(storedModeFor("en:asr", { ...base, registerSetting: "haeyo" }, "avgn1"), "translate-ko-haeyo+avgn1+t8");
  assert.equal(storedModeFor("ko:asr", base, "avgn1"), "clean+t8");
});

test("follow mode: the rule decides the register, ignoring the overview; non-matching videos still use it", async (t) => {
  for (const [meta, expectRule] of [[avgnByTitle, true], [other, false]]) {
    const { send, stored } = await setup(t);
    const systems = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (isGlossary(body)) return response({ register: "hapnida", terms: [] });
      systems.push(body.system);
      return response(translated(body));
    };
    assert.equal((await send(request(meta))).ok, true);
    assert.ok(systems.length > 0);
    for (const system of systems) {
      if (expectRule) {
        assert.match(system, /Angry Video Game Nerd, AVGN/);
        assert.match(system, /Return the default register \("haeyo"\)/);
        assert.doesNotMatch(system, /hapnida = 합니다체/);
      } else {
        assert.match(system, /default Korean speech register[^\n]*hapnida = 합니다체/);
      }
    }
    const keys = Object.keys(stored).filter((key) => key.startsWith("lakomics:youtube:subs:v2:avgn-video:"));
    assert.deepEqual(keys, [`lakomics:youtube:subs:v2:avgn-video:en:asr:translate-ko-auto${expectRule ? "+avgn1" : ""}+t8`]);
    assert.equal(stored[keys[0]].register, expectRule ? "haeyo" : "hapnida");
  }
});

test("fixed register setting is kept for an AVGN video and the cache key carries the rule id", async (t) => {
  const { send, stored } = await setup(t, { "lakomics:youtube:settings:register": "hapnida" });
  const systems = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isGlossary(body)) return response({ register: "banmal", terms: [] });
    systems.push(body.system);
    return response(translated(body));
  };
  assert.equal((await send(request(avgnByChannel))).ok, true);
  assert.ok(systems.length > 0);
  for (const system of systems) {
    assert.match(system, /exactly this Korean speech register for every line: hapnida/);
    assert.match(system, /욕은 찰지게/);
  }
  assert.ok(stored["lakomics:youtube:subs:v2:avgn-video:en:asr:translate-ko-hapnida+avgn1+t8"]);
});

test("getCached: an old plain result is not served to a rule-matching video once its metadata is known", async (t) => {
  const plainKey = "lakomics:youtube:subs:v2:avgn-video:en:asr:translate-ko-auto+t8";
  const styledKey = "lakomics:youtube:subs:v2:avgn-video:en:asr:translate-ko-auto+avgn1+t8";
  const result = (text) => ({ cues: [{ startMs: 0, endMs: 100, text }], model: "m", createdAt: 1 });
  const { send, stored } = await setup(t, {
    "lakomics:youtube:subs:index": { "avgn-video": ["en:asr|translate-ko-auto+t8"] },
    [plainKey]: result("옛 결과"),
  });
  const get = (meta) => send({ type: "youtube:getCached", videoId: "avgn-video", ...(meta ? { meta } : {}) });
  assert.equal((await get()).cached.cues[0].text, "옛 결과");
  assert.deepEqual([(await get(other)).cached.cues[0].text, (await get(other)).styled], ["옛 결과", false]);
  const styled = await get(avgnByTitle);
  assert.equal(styled.cached, null);
  assert.equal(styled.styled, true);
  stored[styledKey] = result("새 결과");
  stored["lakomics:youtube:subs:index"]["avgn-video"].push("en:asr|translate-ko-auto+avgn1+t8");
  assert.equal((await get()).cached.cues[0].text, "새 결과");
  assert.equal((await get(avgnByTitle)).cached.cues[0].text, "새 결과");
  assert.equal((await get(other)).cached.cues[0].text, "옛 결과");
});

test("content: once the metadata is known, a stale cached result of a rule-matching video is dropped, an exact one replaces it", async () => {
  const { readFile } = await import("node:fs/promises");
  const vm = await import("node:vm");
  const source = await readFile(new URL("../src/youtube/content.js", import.meta.url), "utf8");
  for (const [reply, expected] of [[{ ok: true, styled: true, cached: null }, "idle"], [{ ok: true, styled: true, cached: { cues: [{ startMs: 0, endMs: 1, text: "new" }] } }, "ready"],
    [{ ok: true, styled: false, cached: null }, "ready"]]) {
    const sent = [];
    const window = { location: { origin: "https://www.youtube.com", href: "https://www.youtube.com/watch?v=v" }, addEventListener: () => {}, postMessage: () => {} };
    const chrome = { storage: { onChanged: { addListener: () => {} }, local: { get: async () => ({}) } },
      runtime: { onMessage: { addListener: () => {} }, sendMessage: async (message) => { sent.push(message); return reply; } } };
    const context = vm.createContext({ window, chrome, URL, crypto: globalThis.crypto, console: { info: () => {}, warn: () => {} },
      document: { getElementById: () => null }, setTimeout: () => 1, clearTimeout: () => {} });
    vm.runInContext(source.split("  // ---------------------------------------------------------------- start")[0] + `
      renderButton = applyMode = showStage = hideToast = showToast = () => {};
      globalThis.hook = { state, recheckCached };
    })();`, context);
    const { hook } = context;
    hook.state.videoId = "v";
    await hook.recheckCached(hook.state.token, "v", avgnByTitle);
    assert.equal(sent.length, 0, "nothing is asked while no cached result is shown");
    Object.assign(hook.state, { status: "ready", fromCache: true, complete: true, showClean: true, cues: [{ startMs: 0, endMs: 1, text: "old" }] });
    await hook.recheckCached(hook.state.token, "v", avgnByTitle);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].meta, avgnByTitle);
    assert.equal(hook.state.status, expected);
    assert.equal(hook.state.cues?.[0].text, expected === "ready" && reply.styled ? "new" : expected === "ready" ? "old" : undefined);
  }
});
