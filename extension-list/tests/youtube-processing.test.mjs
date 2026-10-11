import { test } from "node:test";
import assert from "node:assert/strict";
import { polishTimings } from "./helpers/youtube-classic.mjs";
import { applyResult, fallbackSegment } from "./helpers/youtube-classic.mjs";
import { chunkSignature, createResumeRecord, matchesResumeRecord } from "./helpers/youtube-classic.mjs";

const cue = (startMs, endMs, text = "가") => ({ startMs, endMs, text });

test("polishTimings bridges gaps strictly below 400 ms", () => {
  assert.equal(polishTimings([cue(0, 1500), cue(1899, 3000)])[0].endMs, 1899);
  assert.equal(polishTimings([cue(0, 1500), cue(1900, 3000)])[0].endMs, 1500);
  assert.equal(polishTimings([cue(0, 1500), cue(1500, 3000)])[0].endMs, 1500);
});

test("polishTimings minimum is 1000 ms or 55 ms per nonspace character, capped at 3000", () => {
  assert.equal(polishTimings([cue(100, 200)])[0].endMs, 1100);
  assert.equal(polishTimings([cue(100, 200, "가 ".repeat(30) + "\n\t")])[0].endMs, 1750);
  assert.equal(polishTimings([cue(100, 200, "가".repeat(100))])[0].endMs, 3100);
  assert.equal(polishTimings([cue(0, 1, "😀".repeat(20))])[0].endMs, 1100);
});

test("polishTimings respects next start, preserves long cues and metadata, and does not mutate", () => {
  const input = [Object.freeze({ ...cue(0, 100), orig: "hello" }), Object.freeze(cue(500, 5000))];
  Object.freeze(input);
  const result = polishTimings(input);
  assert.deepEqual(result, [{ ...input[0], endMs: 500 }, input[1]]);
  assert.equal(input[0].endMs, 100);
  assert.deepEqual(polishTimings([]), []);
  assert.deepEqual(polishTimings([cue(0, 4500)]), [cue(0, 4500)]);
});

test("polishTimings does not close a 400+ ms source gap merely because the minimum reduces it", () => {
  assert.equal(polishTimings([cue(0, 500), cue(1300, 2500)])[0].endMs, 1000);
});

test("orig follows normal, repaired, empty-translation and fallback ranges; clean has no orig", () => {
  const units = ["Hello", "everyone", "good", "bye"].map((text, i) => ({ text, startMs: i * 400, endMs: (i + 1) * 400 }));
  const cases = [
    [{ from: 0, to: 1, text: "안녕" }, { from: 2, to: 3, text: "잘 가" }],
    [{ from: 1, to: 1, text: "안녕" }, { from: 3, to: 3, text: "잘 가" }],
    [{ from: 0, to: 1, text: "  " }, { from: 2, to: 3, text: "잘 가" }],
    null,
  ];
  for (const lines of cases) {
    const translated = applyResult(units, lines, { mode: "translate-ko" });
    assert.equal(translated.map((c) => c.orig).join(" "), "Hello everyone good bye");
    assert.ok(applyResult(units, lines).every((c) => !("orig" in c)));
  }
  assert.deepEqual(applyResult(units, cases[1], { mode: "translate-ko" }).map((c) => c.orig), ["Hello everyone good", "bye"]);
  assert.ok(fallbackSegment(units, { mode: "translate-ko", maxChars: 8 }).every((c) => c.orig === c.text));
  assert.ok(fallbackSegment(units).every((c) => !("orig" in c)));
});

test("cue construction prevents a short source gap from causing overlapping fallback tails", () => {
  const units = [{ text: "a", startMs: 0, endMs: 0 }, { text: "b", startMs: 500, endMs: 600 }];
  const cues = applyResult(units, [{ from: 0, to: 0, text: "a" }, { from: 1, to: 1, text: "b" }]);
  assert.ok(cues[0].endMs <= cues[1].startMs);
});

test("resume records keep successful chunks only and match transcript, chunking and track", () => {
  const chunks = [[{ text: "a", startMs: 0, endMs: 500 }], [{ text: "b", startMs: 500, endMs: 1000 }]];
  const glossary = [{ source: "a", korean: "에이" }];
  const record = createResumeRecord(chunks, [{ failed: false, cues: [cue(0, 500)] }, { failed: true, cues: [cue(500, 1000)] }], glossary, "banmal", "en:asr");
  assert.deepEqual(record.successful, { 0: [cue(0, 500)] });
  assert.deepEqual(record.glossary, glossary);
  assert.equal(record.register, "banmal");
  assert.ok(matchesResumeRecord(structuredClone(record), chunks, "en:asr"));
  assert.equal(matchesResumeRecord(record, chunks, "ja:asr"), false);
  assert.equal(matchesResumeRecord(null, chunks, "en:asr"), false);
  for (const field of ["text", "startMs", "endMs"]) {
    const changed = structuredClone(chunks);
    changed[0][0][field] = field === "text" ? "different" : 1;
    assert.equal(matchesResumeRecord(record, changed, "en:asr"), false);
  }
  assert.equal(matchesResumeRecord(record, [chunks.flat()], "en:asr"), false);
  assert.notEqual(chunkSignature(chunks), chunkSignature([chunks.flat()]));
  for (const successful of [{ 9: [cue(0, 1)] }, { 0: [] }, { 0: [{ startMs: 0, endMs: NaN, text: "a" }] }, []]) {
    assert.equal(matchesResumeRecord({ ...record, successful }, chunks, "en:asr"), false);
  }
});
