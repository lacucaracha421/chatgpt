import { test } from "node:test";
import assert from "node:assert/strict";
import { polishTimings } from "./helpers/youtube-classic.mjs";
import { applyResult, fallbackSegment } from "./helpers/youtube-classic.mjs";
import { chunkSignature, createResumeRecord, matchesResumeRecord } from "./helpers/youtube-classic.mjs";
import { splitDisplayCues } from "./helpers/youtube-classic.mjs";

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

test("timing merges only fragments of the same translated line and display does not undo it", () => {
  const text = "이 문장은 자막을 읽을 시간이 부족할 때 같은 번역문 조각들을 합쳐서 보여주는지 확인합니다. ".repeat(2);
  const parts = splitDisplayCues([{ startMs: 0, endMs: 900, text, orig: "source words ".repeat(20) }]);
  assert.ok(parts.length > 1);
  const result = polishTimings(structuredClone(parts));
  assert.equal(result.length, 1);
  assert.ok(result[0].endMs >= 1000);
  assert.deepEqual(splitDisplayCues(result), result);
  assert.equal(result[0].text.replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("a final short fragment merges backwards but never across a translated line", () => {
  const input = [{ ...cue(0, 1800, "처음 문장을 충분히 읽을 수 있어요"), splitLine: "one", orig: "first" },
    { ...cue(1800, 2000, "마지막 부분도 읽어요"), splitLine: "one", orig: "last" },
    { ...cue(2000, 2400, "아니요, 안 해요."), orig: "No, I do not." }];
  const result = polishTimings(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].endMs, 2000);
  assert.equal(result[1].startMs, 2000);
  assert.equal(result[1].text, "아니요, 안 해요.");
  assert.equal(input.length, 3);
});

test("merging preserves deliberate repeated clauses", () => {
  const text = "이 문장은 아주 길게 설명하고 있는 내용입니다. ".repeat(2).trim();
  const parts = splitDisplayCues([{ startMs: 0, endMs: 900, text, orig: "source words ".repeat(10) }]);
  assert.ok(parts.length > 1);
  assert.equal(polishTimings(parts)[0].text.replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("manual translated captions get their reading time; short auto-caption tails stay bounded", () => {
  const text = "저는 이 방법을 사용하면 문제가 다시 생길 거라고 생각하지 않아요.";
  const units = [{ text: "This is a manual caption.", startMs: 0, endMs: 6000 }];
  const result = applyResult(units, [{ from: 0, to: 0, text }], { mode: "translate-ko" });
  const reading = Math.min(3000, Math.max(1000, 55 * Array.from(text.replace(/\s/g, "")).length));
  assert.equal(result.length, 1);
  assert.equal(result[0].endMs, Math.max(1500, reading));
  assert.ok(result[0].endMs > 1500);
  assert.equal(applyResult(units, [{ from: 0, to: 0, text: "네" }], { mode: "translate-ko" })[0].endMs, 1500);
  assert.equal(applyResult(units, [{ from: 0, to: 0, text: units[0].text }])[0].endMs, 1500);
});

test("standalone negative answers retain separate source cues and speech sync", () => {
  const units = [{ text: "Question", startMs: 0, endMs: 600 }, { text: "No", startMs: 600, endMs: 1800 }];
  const result = polishTimings(applyResult(units, [{ from: 0, to: 0, text: "이 방법으로 할까요?" },
    { from: 1, to: 1, text: "아니요, 안 해요." }], { mode: "translate-ko" }));
  assert.equal(result.length, 2);
  assert.equal(result[0].endMs, 600);
  assert.equal(result[1].startMs, 600);
  assert.equal(result[1].text, "아니요, 안 해요.");
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
