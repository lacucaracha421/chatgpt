import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  callClaude,
  buildRequestBody,
  translateSystemPrompt,
  SYSTEM_PROMPT,
  SPEAKER_INSTRUCTION,
  TRANSLATE_KO_SYSTEM_PROMPT,
  RESPONSE_SCHEMA,
  TRANSLATE_RESPONSE_SCHEMA,
  callGlossary, buildGlossaryBody, GLOSSARY_SCHEMA,
} from "./helpers/youtube-classic.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("glossary body uses the whole plain transcript and structured output", async () => {
  const body = buildGlossaryBody({ model: "m", transcript: "Jeff visits Seoul" });
  assert.deepEqual(body.messages, [{ role: "user", content: "Jeff visits Seoul" }]);
  assert.deepEqual(body.output_config, { effort: "low", format: { type: "json_schema", schema: GLOSSARY_SCHEMA } });
  assert.deepEqual(GLOSSARY_SCHEMA.required, ["register", "terms"]);
  assert.equal(GLOSSARY_SCHEMA.properties.terms.maxItems, 40);
  assert.match(body.system, /person names, places, brands, recurring technical terms, and nicknames/);
  for (const field of ["temperature", "top_p"]) assert.ok(!(field in body));
  const calls = stubFetch([jsonResponse(okBody({ content: [{ type: "text", text: JSON.stringify({ register: "banmal", terms: [{ source: " Jeff ", korean: " 제프 " }] }) }] }))]);
  assert.deepEqual(await callGlossary({ apiKey: "k", model: "m", transcript: "Jeff visits Seoul" }), {
    register: "banmal", terms: [{ source: "Jeff", korean: "제프" }], usage: { input_tokens: 30, output_tokens: 12 },
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
  assert.equal(calls[0].init.headers["anthropic-dangerous-direct-browser-access"], "true");
});

test("glossary parsing rejects invalid register, terms, JSON and truncated responses while preserving usage", async () => {
  for (const obj of [{ register: "auto", terms: [] }, { register: "haeyo" },
    { register: "haeyo", terms: [null] }, { register: "haeyo", terms: [{ source: "Jeff", korean: "" }] },
    { register: "haeyo", terms: Array.from({ length: 41 }, () => ({ source: "a", korean: "가" })) }]) {
    stubFetch([jsonResponse(okBody({ content: [{ type: "text", text: JSON.stringify(obj) }] }))]);
    await assert.rejects(callGlossary({ apiKey: "k", model: "m", transcript: "a" }), (err) => err.usage.input_tokens === 30);
  }
  for (const extra of [{ content: [{ type: "text", text: "bad JSON" }] }, { stop_reason: "max_tokens" }, { stop_reason: "refusal" }]) {
    stubFetch([jsonResponse(okBody(extra))]);
    await assert.rejects(callGlossary({ apiKey: "k", model: "m", transcript: "a" }), (err) => err.usage.output_tokens === 12);
  }
});

test("glossary appears only in translation prompts with nonempty terms and reaches callClaude", async () => {
  const glossary = [{ source: "Jeff", korean: "제프" }, { source: "Seoul", korean: "서울" }];
  const args = { model: "m", chunk, glossary };
  assert.equal(buildRequestBody(args).system, SYSTEM_PROMPT);
  assert.equal(buildRequestBody({ ...args, mode: "translate-ko", glossary: [] }).system, translateSystemPrompt());
  const calls = stubFetch([jsonResponse(okBody())]);
  await callClaude({ ...args, apiKey: "k", mode: "translate-ko" });
  assert.match(JSON.parse(calls[0].init.body).system, /"source":"Jeff","korean":"제프".*"source":"Seoul","korean":"서울"/);
});

const chunk = [
  { text: "안녕", startMs: 0 },
  { text: "하세요", startMs: 400 },
];

test("speaker marks append the same instruction in both modes; off preserves the existing prompts", () => {
  for (const mode of ["clean", "translate-ko"]) {
    for (const register of [null, "haeyo", "hapnida", "banmal"]) {
      const args = { model: "m", chunk, mode, register };
      const original = mode === "clean" ? SYSTEM_PROMPT : translateSystemPrompt(register);
      assert.equal(buildRequestBody(args).system, original);
      assert.equal(buildRequestBody({ ...args, speakers: false }).system, original);
      assert.equal(buildRequestBody({ ...args, speakers: true }).system, `${original}\n${SPEAKER_INSTRUCTION}`);
    }
  }
  assert.match(SPEAKER_INSTRUCTION, /no speaker information/);
  assert.match(SPEAKER_INSTRUCTION, /only from clear conversational cues/);
  assert.match(SPEAKER_INSTRUCTION, /question and answer, replies, addressing someone/);
  assert.match(SPEAKER_INSTRUCTION, /different voice\/perspective/);
  assert.match(SPEAKER_INSTRUCTION, /Prefer starting a new subtitle line/);
  assert.match(SPEAKER_INSTRUCTION, /Start a line with "- "/);
  assert.ok(SPEAKER_INSTRUCTION.includes('- first part\\n- second part'));
  assert.match(SPEAKER_INSTRUCTION, /monologues or narration, never add/);
  assert.match(SPEAKER_INSTRUCTION, /When unsure, do not mark/);
  assert.match(SPEAKER_INSTRUCTION, /Never write speaker names or labels like "A:"/);
});

test("callClaude forwards the speaker setting in both modes", async () => {
  const calls = stubFetch([jsonResponse(okBody()), jsonResponse(okBody())]);
  for (const mode of ["clean", "translate-ko"]) {
    await callClaude({ apiKey: "test-key", model: "m", chunk, mode, speakers: true });
  }
  for (const call of calls) {
    assert.ok(JSON.parse(call.init.body).system.endsWith(`\n${SPEAKER_INSTRUCTION}`));
  }
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  };
}

function okBody(overrides = {}) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ lines: [{ from: 0, to: 1, text: "안녕하세요." }] }) }],
    usage: { input_tokens: 30, output_tokens: 12 },
    ...overrides,
  };
}

function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next;
  };
  return calls;
}

test("request has the documented shape and no sampling fields", async () => {
  const calls = stubFetch([jsonResponse(okBody())]);
  await callClaude({ apiKey: "test-key", model: "claude-haiku-5-5", chunk });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["x-api-key"], "test-key");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.equal(init.headers["anthropic-dangerous-direct-browser-access"], "true");

  const body = JSON.parse(init.body);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.max_tokens, 16000);
  assert.deepEqual(body.output_config, { effort: "low", format: { type: "json_schema", schema: RESPONSE_SCHEMA } });
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.deepEqual(body.messages, [{ role: "user", content: "0\t안녕\n1\t하세요" }]);
  assert.deepEqual(body.thinking, { type: "disabled" });
  for (const forbidden of ["temperature", "top_p"]) {
    assert.ok(!(forbidden in body), `${forbidden} must not be sent`);
  }
  // no prefill: the only message is the user turn
  assert.equal(body.messages.length, 1);
});

test("translate-ko mode uses the translate system prompt and the same other fields", async () => {
  const calls = stubFetch([jsonResponse(okBody()), jsonResponse(okBody())]);
  await callClaude({ apiKey: "k", model: "claude-haiku-5-5", chunk, mode: "translate-ko" });
  await callClaude({ apiKey: "k", model: "claude-haiku-5-5", chunk });

  const translate = JSON.parse(calls[0].init.body);
  const clean = JSON.parse(calls[1].init.body);
  assert.equal(translate.system, translateSystemPrompt(null));
  assert.ok(translate.system.startsWith(TRANSLATE_KO_SYSTEM_PROMPT));
  assert.notEqual(TRANSLATE_KO_SYSTEM_PROMPT, SYSTEM_PROMPT);
  assert.match(translate.system, /Korean/);
  assert.equal(clean.system, SYSTEM_PROMPT);
  assert.deepEqual(
    { ...translate, system: null, output_config: null },
    { ...clean, system: null, output_config: null },
  );
  assert.deepEqual(translate.output_config.format.schema, TRANSLATE_RESPONSE_SCHEMA);
  assert.deepEqual(clean.output_config.format.schema, RESPONSE_SCHEMA);
  assert.deepEqual(translate.thinking, { type: "disabled" });
  for (const forbidden of ["temperature", "top_p"]) {
    assert.ok(!(forbidden in translate), `${forbidden} must not be sent`);
  }
});

test("schema matches the documented structure", () => {
  assert.deepEqual(RESPONSE_SCHEMA.required, ["lines"]);
  assert.equal(RESPONSE_SCHEMA.additionalProperties, false);
  assert.deepEqual(RESPONSE_SCHEMA.properties.lines.items.required, ["from", "to", "text"]);
});

test("translate request states the given register explicitly", () => {
  for (const [register, word] of [["haeyo", "해요체"], ["hapnida", "합니다체"], ["banmal", "반말"]]) {
    const { system } = buildRequestBody({ model: "m", chunk, mode: "translate-ko", register });
    assert.match(system, new RegExp(`exactly this Korean speech register[^\n]*${word}`));
    assert.match(system, new RegExp(`"${register}"`));
    assert.doesNotMatch(system, /Choose the Korean speech register/);
  }
});

test("translate request without a register asks the model to choose and report it", () => {
  const { system } = buildRequestBody({ model: "m", chunk, mode: "translate-ko", register: null });
  assert.match(system, /Choose the Korean speech register that best matches the speaker/);
  assert.match(system, /register field/);
  assert.doesNotMatch(system, /exactly this Korean speech register/);
  // an unknown value behaves like null
  const other = buildRequestBody({ model: "m", chunk, mode: "translate-ko", register: "bogus" });
  assert.equal(other.system, system);
});

test("clean request ignores the register", () => {
  const body = buildRequestBody({ model: "m", chunk, mode: "clean", register: "banmal" });
  assert.equal(body.system, SYSTEM_PROMPT);
  assert.deepEqual(body.output_config.format.schema, RESPONSE_SCHEMA);
});

test("both system prompts cover non-speech words by range but omit them from the text", () => {
  for (const prompt of [SYSTEM_PROMPT, TRANSLATE_KO_SYSTEM_PROMPT]) {
    assert.match(prompt, /non-speech annotations/);
    assert.match(prompt, /never skip an index/);
    assert.match(prompt, /omit them from its text/);
  }
});

test("translate schema requires a register enum next to lines", () => {
  assert.deepEqual(TRANSLATE_RESPONSE_SCHEMA.required, ["lines", "register"]);
  assert.equal(TRANSLATE_RESPONSE_SCHEMA.additionalProperties, false);
  assert.deepEqual(TRANSLATE_RESPONSE_SCHEMA.properties.register, { type: "string", enum: ["haeyo", "hapnida", "banmal"] });
  assert.deepEqual(TRANSLATE_RESPONSE_SCHEMA.properties.lines, RESPONSE_SCHEMA.properties.lines);
});

test("callClaude returns the reported register, or null when missing or invalid", async () => {
  const text = (obj) => okBody({ content: [{ type: "text", text: JSON.stringify(obj) }] });
  const lines = [{ from: 0, to: 1, text: "안녕하세요." }];
  stubFetch([
    jsonResponse(text({ lines, register: "banmal" })),
    jsonResponse(text({ lines })),
    jsonResponse(text({ lines, register: "polite" })),
  ]);
  assert.equal((await callClaude({ apiKey: "k", model: "m", chunk, mode: "translate-ko" })).register, "banmal");
  assert.equal((await callClaude({ apiKey: "k", model: "m", chunk, mode: "translate-ko" })).register, null);
  assert.equal((await callClaude({ apiKey: "k", model: "m", chunk, mode: "translate-ko" })).register, null);
});

test("takes the first text block after a thinking block and returns usage", async () => {
  stubFetch([
    jsonResponse(
      okBody({
        content: [
          { type: "thinking", thinking: "hmm", signature: "x" },
          { type: "text", text: JSON.stringify({ lines: [{ from: 0, to: 1, text: "안녕하세요." }] }) },
        ],
      }),
    ),
  ]);
  const result = await callClaude({ apiKey: "k", model: "m", chunk });
  assert.deepEqual(result.lines, [{ from: 0, to: 1, text: "안녕하세요." }]);
  assert.deepEqual(result.usage, { input_tokens: 30, output_tokens: 12 });
});

test("refusal and max_tokens stop reasons are errors", async () => {
  stubFetch([jsonResponse(okBody({ stop_reason: "refusal" }))]);
  await assert.rejects(callClaude({ apiKey: "k", model: "m", chunk }), (e) => e.code === "refusal");

  stubFetch([jsonResponse(okBody({ stop_reason: "max_tokens" }))]);
  await assert.rejects(callClaude({ apiKey: "k", model: "m", chunk }), (e) => e.code === "max_tokens");
});

test("invalid JSON text is an error", async () => {
  stubFetch([jsonResponse(okBody({ content: [{ type: "text", text: "not json" }] }))]);
  await assert.rejects(callClaude({ apiKey: "k", model: "m", chunk }), /읽을 수 없어요/);
});

test("429 is retried and honors retry-after", async () => {
  const calls = stubFetch([
    jsonResponse({ error: { message: "slow down" } }, { status: 429, headers: { "retry-after": "2" } }),
    jsonResponse(okBody()),
  ]);
  const waits = [];
  const result = await callClaude({ apiKey: "k", model: "m", chunk, sleep: async (ms) => waits.push(ms) });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(result.lines.length, 1);
});

test("5xx is retried twice with backoff, then fails", async () => {
  const calls = stubFetch([
    jsonResponse({ error: { message: "boom" } }, { status: 500 }),
    jsonResponse({ error: { message: "boom" } }, { status: 503 }),
    jsonResponse({ error: { message: "boom" } }, { status: 500 }),
  ]);
  const waits = [];
  await assert.rejects(
    callClaude({ apiKey: "k", model: "m", chunk, sleep: async (ms) => waits.push(ms) }),
    (e) => e.status === 500,
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("401 is not retried and reports a key problem", async () => {
  const calls = stubFetch([jsonResponse({ error: { message: "invalid x-api-key" } }, { status: 401 })]);
  await assert.rejects(callClaude({ apiKey: "bad", model: "m", chunk }), /API 키/);
  assert.equal(calls.length, 1);
});

test("translate request puts the previous-context block before the numbered list", async () => {
  const calls = stubFetch([jsonResponse(okBody())]);
  await callClaude({ apiKey: "k", model: "m", chunk, mode: "translate-ko", context: ["so", "what", "I", "mean"] });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.messages.length, 1);
  assert.equal(
    body.messages[0].content,
    "Previous context (do not translate, not numbered):\nso what I mean\n\nNumbered words to process:\n0\t안녕\n1\t하세요",
  );
  assert.match(body.system, /Previous context \(do not translate, not numbered\)/);
});

test("translate request without context, and clean requests with context, send only the numbered list", () => {
  const plain = "0\t안녕\n1\t하세요";
  assert.equal(buildRequestBody({ model: "m", chunk, mode: "translate-ko" }).messages[0].content, plain);
  assert.equal(buildRequestBody({ model: "m", chunk, mode: "translate-ko", context: [] }).messages[0].content, plain);
  assert.equal(buildRequestBody({ model: "m", chunk, mode: "clean", context: ["so", "what"] }).messages[0].content, plain);
  assert.equal(buildRequestBody({ model: "m", chunk, context: ["so"] }).messages[0].content, plain);
});
