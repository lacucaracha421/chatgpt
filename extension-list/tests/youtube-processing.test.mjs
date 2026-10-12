import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeTimings, readingTime } from "./helpers/youtube-classic.mjs";
import { applyResult, fallbackSegment } from "./helpers/youtube-classic.mjs";
import { chunkSignature, createResumeRecord, matchesResumeRecord } from "./helpers/youtube-classic.mjs";
import { splitDisplayCues } from "./helpers/youtube-classic.mjs";

const cue = (startMs, endMs, text = "가") => ({ startMs, endMs, text });

test("finalizeTimings bridges gaps strictly below 1.2 s to 80 ms before the next cue", () => {
  assert.equal(finalizeTimings([cue(0, 1500), cue(2699, 4000)])[0].endMs, 2699 - 80);
  assert.equal(finalizeTimings([cue(0, 1500), cue(2700, 4000)])[0].endMs, 1500);
  assert.equal(finalizeTimings([cue(0, 1500), cue(1550, 4000)])[0].endMs, 1550 - 80);
});

test("finalizeTimings keeps a cue for its reading time: 12 characters per second between 1.2 s and 6 s", () => {
  assert.equal(finalizeTimings([cue(100, 200)])[0].endMs, 1300);
  assert.equal(finalizeTimings([cue(100, 200, "가 ".repeat(30) + "\n\t")])[0].endMs, 100 + 2500);
  assert.equal(finalizeTimings([cue(100, 200, "가".repeat(100))])[0].endMs, 6100);
  assert.equal(finalizeTimings([cue(0, 1, "😀".repeat(24))])[0].endMs, 2000);
  assert.equal(readingTime("가 ".repeat(6)), 1200);
});

test("finalizeTimings never ends a cue before its speech, nor later than 7 s", () => {
  assert.equal(finalizeTimings([cue(0, 4500)])[0].endMs, 4500);
  assert.equal(finalizeTimings([cue(0, 6900, "가".repeat(80)), cue(7500, 9000)])[0].endMs, 7000);
  assert.equal(finalizeTimings([cue(0, 1, "가".repeat(80))])[0].endMs, 6000);
});

test("finalizeTimings clamps to the next start, with a floor of 700 ms and then 300 ms", () => {
  // Room for the minimum: end 80 ms before the next cue.
  assert.equal(finalizeTimings([cue(0, 1500), cue(780, 3000)])[0].endMs, 700);
  // Next cue too close for 700 ms: end at the guard, at least 300 ms, never past the next start.
  assert.equal(finalizeTimings([cue(0, 100), cue(500, 3000)])[0].endMs, 420);
  assert.equal(finalizeTimings([cue(0, 100), cue(350, 3000)])[0].endMs, 300);
  assert.equal(finalizeTimings([cue(0, 100), cue(200, 3000)])[0].endMs, 200);
});

test("finalizeTimings bounds a chunk's last cue by the next chunk and does not mutate its input", () => {
  assert.equal(finalizeTimings([cue(0, 100)], { nextStartMs: 5000 })[0].endMs, 1200);
  assert.equal(finalizeTimings([cue(0, 100)], { nextStartMs: 1000 })[0].endMs, 920);
  assert.equal(finalizeTimings([cue(0, 100)], { nextStartMs: 1500 })[0].endMs, 1420);
  const input = [Object.freeze({ ...cue(0, 100), orig: "hello" }), Object.freeze(cue(500, 5000))];
  Object.freeze(input);
  const result = finalizeTimings(input);
  assert.deepEqual(result, [{ ...input[0], endMs: 420 }, input[1]]);
  assert.equal(input[0].endMs, 100);
  assert.deepEqual(finalizeTimings([]), []);
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
  const result = finalizeTimings(structuredClone(parts));
  assert.equal(result.length, 1);
  assert.ok(result[0].endMs >= 1200);
  assert.deepEqual(splitDisplayCues(result), result);
  assert.equal(result[0].text.replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("a final short fragment merges backwards but never across a translated line", () => {
  const input = [{ ...cue(0, 1800, "처음 문장을 충분히 읽을 수 있어요"), splitLine: "one", orig: "first" },
    { ...cue(1800, 2000, "마지막 부분도 읽어요"), splitLine: "one", orig: "last" },
    { ...cue(2000, 2400, "아니요, 안 해요."), orig: "No, I do not." }];
  const result = finalizeTimings(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].endMs, 2000 - 80);
  assert.equal(result[1].startMs, 2000);
  assert.equal(result[1].text, "아니요, 안 해요.");
  assert.equal(input.length, 3);
});

test("merging preserves deliberate repeated clauses", () => {
  const text = "이 문장은 아주 길게 설명하고 있는 내용입니다. ".repeat(2).trim();
  const parts = splitDisplayCues([{ startMs: 0, endMs: 900, text, orig: "source words ".repeat(10) }]);
  assert.ok(parts.length > 1);
  assert.equal(finalizeTimings(parts)[0].text.replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("manual translated captions stay for their event; short word units get the reading minimum", () => {
  const text = "저는 이 방법을 사용하면 문제가 다시 생길 거라고 생각하지 않아요.";
  const units = [{ text: "This is a manual caption.", startMs: 0, endMs: 6000 }];
  const shown = (lines, human) => finalizeTimings(applyResult(units, lines, { mode: "translate-ko", human }));
  assert.equal(shown([{ from: 0, to: 0, text }], true)[0].endMs, 6000);
  assert.equal(shown([{ from: 0, to: 0, text: "네" }], true)[0].endMs, 6000);
  assert.equal(shown([{ from: 0, to: 0, text }], false)[0].endMs, Math.round(readingTime(text)));
  assert.equal(shown([{ from: 0, to: 0, text: "네" }], false)[0].endMs, 1200);
});

test("standalone negative answers retain separate source cues and speech sync", () => {
  const units = [{ text: "Question", startMs: 0, endMs: 600 }, { text: "No", startMs: 600, endMs: 1800 }];
  const result = finalizeTimings(applyResult(units, [{ from: 0, to: 0, text: "이 방법으로 할까요?" },
    { from: 1, to: 1, text: "아니요, 안 해요." }], { mode: "translate-ko" }));
  assert.equal(result.length, 2);
  assert.equal(result[0].endMs, 600 - 80);
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
