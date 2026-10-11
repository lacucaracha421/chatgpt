import { test } from "node:test";
import assert from "node:assert/strict";
import { offendingKoreanCues } from "./helpers/youtube-classic.mjs";
import { buildRequestBody, buildGlossaryBody } from "./helpers/youtube-classic.mjs";
import { buildChunkPrompt, buildGlossaryPrompt } from "./helpers/youtube-classic.mjs";
import { storageMode } from "./helpers/youtube-classic.mjs";

test("detects every requested kana/CJK range, allows Korean, digits and Latin, ignores orig", () => {
  const clean = Object.freeze({ text: "사과 주스 250 ml, Apple AI!", orig: "りんごジュース 風害" });
  const dirty = ["링(りんご) 주스", "カナ", "ㇰ", "ｶﾅ", "風害", "㐀", "豈"].map((text) => Object.freeze({ text }));
  const cues = Object.freeze([clean, ...dirty]);
  assert.deepEqual(offendingKoreanCues(cues), dirty);
  assert.deepEqual(offendingKoreanCues([clean]), []);
  assert.deepEqual(offendingKoreanCues([]), []);
  for (const [start, end] of [[0x3040, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9f],
    [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]]) {
    assert.equal(offendingKoreanCues([{ text: String.fromCharCode(start) }, { text: String.fromCharCode(end) }]).length, 2);
  }
});

for (const provider of ["anthropic"]) {
  test(`${provider} translate and glossary bodies contain natural Korean rendering rules`, () => {
    const args = { model: "mock-model", chunk: [{ text: "りんご" }], mode: "translate-ko", transcript: "りんご 風害" };
    const bodies = provider === "anthropic" ? [buildRequestBody(args), buildGlossaryBody(args)]
      : [buildGeminiBody(buildChunkPrompt(args)), buildGeminiBody(buildGlossaryPrompt(args))];
    for (const body of bodies) {
      const system = body.system || body.systemInstruction.parts[0].text;
      for (const rule of [/Korean in Hangul only/, /Write numbers with Arabic digits/, /Latin letters are allowed only for brand names, acronyms and units/,
        /Never leave Japanese kana, kanji or Chinese characters/, /never add the original word in brackets/,
        /りんごジュース → 사과 주스/, /instead of transliterating/, /Sino-Korean reading.*not common in Korean/,
        /風害 → 바람 피해/, /spelling commonly used in Korea/, /standard Korean loanword orthography/]) {
        assert.match(system, rule);
      }
    }
    assert.match(bodies[1].system || bodies[1].systemInstruction.parts[0].text, /every korean rendering, not the source spelling/);
  });

  test(`${provider} retry note preserves the rest of the chunk request`, () => {
    const args = { model: "mock-model", chunk: [{ text: "りんご" }], mode: "translate-ko", register: "banmal",
      context: ["前"], speakers: true, glossary: [{ source: "りんご", korean: "사과" }] };
    const build = provider === "anthropic" ? buildRequestBody : (a) => buildGeminiBody(buildChunkPrompt(a));
    const first = build(args);
    const retry = build({ ...args, retryNote: "Korean Hangul only. Offending line: りんご" });
    const firstText = provider === "anthropic" ? first.messages[0].content : first.contents[0].parts[0].text;
    const retryText = provider === "anthropic" ? retry.messages[0].content : retry.contents[0].parts[0].text;
    assert.equal(retryText, firstText + "\n\nKorean Hangul only. Offending line: りんご");
    if (provider === "anthropic") retry.messages = first.messages;
    else retry.contents = first.contents;
    assert.deepEqual(retry, first);
  });
}

test("storageMode isolates Sonnet glossaries for translated tracks and composes speaker marks", () => {
  assert.equal(storageMode("ja:asr", true, "auto", false, true), "translate-ko-auto+gs");
  assert.equal(storageMode("ja-JP:std", true, "banmal", true, true), "translate-ko-banmal+spk+gs");
  assert.equal(storageMode("en:asr", true, "haeyo", false, false), "translate-ko-haeyo");
  assert.equal(storageMode("ko:asr", true, "auto", false, true), "clean");
  assert.equal(storageMode("ja:asr", false, "auto", true, true), "clean+spk");
});
