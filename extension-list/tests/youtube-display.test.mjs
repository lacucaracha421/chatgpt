import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDisplayCues } from "./helpers/youtube-classic.mjs";
import { applyResult, fallbackSegment, repairLines } from "./helpers/youtube-classic.mjs";
import { finalizeTimings } from "./helpers/youtube-classic.mjs";
import { TRANSLATE_KO_SYSTEM_PROMPT } from "./helpers/youtube-classic.mjs";

function safe(cues, maxChars) {
  for (let i = 0; i < cues.length; i++) {
    assert.ok(Array.from(cues[i].text).length <= maxChars);
    assert.ok(cues[i].endMs - cues[i].startMs <= 7000.000001);
    assert.ok(cues[i].endMs > cues[i].startMs);
    if (i) assert.ok(cues[i - 1].endMs <= cues[i].startMs);
  }
}

test("display splits Korean/CJK and Latin at punctuation/spaces, preserving text and proportional timing", () => {
  for (const [text, max] of [["짧은 문장을 자연스럽게 읽어요. 다음 문장도 길게 이어지면 나누어 보여줘요. ".repeat(4), 44],
    ["これは長い字幕です。".repeat(20), 44], ["First sentence ends here. Second clause, with more words to read. ".repeat(4), 84]]) {
    const input = Object.freeze({ startMs: 100, endMs: 25100, text });
    const cues = splitDisplayCues([input]);
    safe(cues, max);
    assert.equal(cues[0].startMs, 100);
    assert.equal(cues.at(-1).endMs, 25100);
    assert.equal(cues.map((c) => c.text).join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
    const total = cues.reduce((sum, c) => sum + Array.from(c.text).length, 0);
    for (const cue of cues) assert.ok(Math.abs((cue.endMs - cue.startMs) / 25000 - Array.from(cue.text).length / total) < 1e-9);
  }
});

test("display limits apply to model lines, repaired lines and long single-unit fallback in every mode", () => {
  const units = [{ text: "가".repeat(120), startMs: 0, endMs: 18000 }];
  for (const mode of ["clean", "translate-ko"]) {
    safe(applyResult(units, [{ from: 0, to: 0, text: units[0].text }], { mode }), 44);
    safe(fallbackSegment(units, { mode }), 44);
  }
  const words = Array.from({ length: 20 }, (_, i) => ({ text: "word", startMs: i * 500, endMs: (i + 1) * 500 }));
  safe(applyResult(words, [{ from: 2, to: 19, text: "나누어 보여줘요. ".repeat(12) }], { mode: "translate-ko" }), 44);
});

test("orig follows Korean splits, short original stays on first part; orig never triggers splitting", () => {
  const text = "긴 번역 문장을 나누어 보여줘요. ".repeat(5);
  for (const orig of ["a", "source words in original language. ".repeat(6)]) {
    const cues = splitDisplayCues([{ startMs: 0, endMs: 6000, text, orig }]);
    safe(cues, 44);
    assert.equal(cues.map((c) => c.orig || "").join("").replace(/\s/g, ""), orig.replace(/\s/g, ""));
    if (orig === "a") assert.ok(cues.slice(1).every((c) => !("orig" in c)));
    else assert.ok(cues.every((c) => c.orig));
  }
  const cues = splitDisplayCues([{ startMs: 0, endMs: 6000, text: "네", orig: "source ".repeat(50) }]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].orig, "source ".repeat(50));
});

test("a fitting Korean sentence never becomes three cues ending in 않아요", () => {
  const text = "저는 이 방법을 사용하면 문제가 다시 생길 거라고 생각하지 않아요.";
  const input = { startMs: 0, endMs: 6000, text, orig: "a very long original sentence ".repeat(8) };
  assert.deepEqual(splitDisplayCues([input]), [input]);
});

test("long Korean translations keep predicates and avoid single-word or tiny fragments", () => {
  for (const ending of ["생각하지 않아요.", "할 수 없어요.", "하고 있어요.", "좋아질 거예요.", "좋아질 것 같아요."]) {
    const text = "우선 지금까지 살펴본 내용을 충분히 설명할게요. 저는 이 방법을 사용하면 문제가 다시 생길 거라고 " + ending;
    const cues = splitDisplayCues([{ startMs: 0, endMs: 6500, text, orig: "source words ".repeat(20) }]);
    assert.ok(cues.length > 1);
    assert.ok(cues.some((c) => c.text.includes(ending)));
    assert.ok(cues.every((c) => c.text.split(/\s+/).length > 1 && (c.text.match(/\p{Script=Hangul}/gu) || []).length >= 6));
    assert.equal(cues.map((c) => c.text).join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  }
});

test("duration-only splitting and post-polish safety preserve endpoints without overlaps", () => {
  safe(splitDisplayCues([{ startMs: 0, endMs: 30000, text: "네" }]), 44);
  const cues = splitDisplayCues(finalizeTimings([{ startMs: 0, endMs: 7000, text: "hello" },
    { startMs: 7300, endMs: 8500, text: "next" }]));
  safe(cues, 84);
  assert.equal(cues.at(-1).endMs, 8500);
});

test("coverage repair refuses large leading/middle/trailing gaps and prompt limits translation lines", () => {
  assert.equal(repairLines(10, [{ from: 4, to: 9, text: "x" }]), null);
  assert.equal(repairLines(10, [{ from: 0, to: 5, text: "x" }]), null);
  assert.equal(repairLines(10, [{ from: 0, to: 1, text: "x" }, { from: 6, to: 9, text: "y" }]), null);
  assert.match(TRANSLATE_KO_SYSTEM_PROMPT, /one sentence or clause/);
  assert.match(TRANSLATE_KO_SYSTEM_PROMPT, /must not exceed about 40/);
});

// 20 words: the first ten fast (0-2000 ms, 200 ms each), the last ten slow (2000-7000 ms, 500 ms each).
function unevenUnits() {
  return Array.from({ length: 20 }, (_, i) => {
    const startMs = i < 10 ? i * 200 : 2000 + (i - 10) * 500;
    return { text: "word", startMs, endMs: startMs + (i < 10 ? 200 : 500) };
  });
}
const longKorean = "이 문장은 앞부분을 아주 빠르게 말하고 뒷부분은 천천히 말하는 긴 설명입니다. 그래서 두 번째 문장은 느리게 이어서 읽히는 긴 설명입니다.";

test("word-aligned split cuts at a source word start, not at the character-proportional time", () => {
  const units = unevenUnits();
  const lines = [{ from: 0, to: 19, text: longKorean }];
  const result = applyResult(units, lines, { mode: "translate-ko", human: false });
  assert.equal(result.length, 2);
  // Plain proportional allocation would cut near the middle of the 12 s line.
  const proportional = splitDisplayCues([{ startMs: 0, endMs: 7500, text: longKorean, orig: "x" }]);
  assert.equal(proportional.length, 2);
  const startsOfWords = new Set(units.map((u) => u.startMs));
  assert.ok(startsOfWords.has(result[1].startMs));
  assert.equal(result[0].endMs, result[1].startMs);
  // The first fragment holds 57 % of the Korean characters, i.e. about word 11 of 20, which starts at 2500 ms.
  assert.equal(result[1].startMs, 2500);
  assert.ok(proportional[1].startMs > 4000);
  for (const cue of result) assert.equal(Object.hasOwn(cue, "wordStarts") || Object.hasOwn(cue, "wordChars"), false);
});

test("word-aligned boundaries are monotonic, keep a minimum duration and stay inside the line", () => {
  // Words bunch up at 0-300 ms and 600-900 ms, so the ideal cuts fall where the minimum duration forbids them.
  const starts = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 5000, 5100, 5200, 9000, 9100, 9200];
  const text = ["첫 번째 조각은 이만큼 길게 이어져요.", "두 번째 조각도 이만큼 길게 이어져요.", "세 번째 조각도 이만큼 길게 이어져요."].join(" ");
  const input = { startMs: 0, endMs: 9500, text, orig: "source", wordStarts: starts, wordChars: starts.map(() => 4) };
  const aligned = splitDisplayCues([input]);
  assert.ok(aligned.length >= 2);
  assert.equal(aligned[0].startMs, 0);
  assert.equal(aligned.at(-1).endMs, 9500);
  for (let i = 0; i < aligned.length; i++) {
    assert.ok(aligned[i].endMs - aligned[i].startMs >= 800, `fragment ${i} is too short`);
    assert.ok(aligned[i].endMs - aligned[i].startMs <= 7000);
    if (i) {
      assert.equal(aligned[i - 1].endMs, aligned[i].startMs);
      assert.ok(starts.includes(aligned[i].startMs), `${aligned[i].startMs} is not a word start`);
    }
  }
  // Too short for the minimum per fragment: plain proportional allocation.
  const tight = splitDisplayCues([{ ...input, endMs: 1500, wordStarts: [0, 10, 20, 30], wordChars: [4, 4, 4, 4] }]);
  assert.ok(tight.length >= 2);
  assert.deepEqual(tight, splitDisplayCues([{ startMs: 0, endMs: 1500, text, orig: "source" }]));
});

test("without usable word starts the split stays character-proportional and clean", () => {
  const base = { startMs: 0, endMs: 7500, text: longKorean, orig: "x" };
  const plain = splitDisplayCues([base]);
  for (const extra of [{}, { wordStarts: [0] }, { wordStarts: [], wordChars: [] }]) {
    const result = splitDisplayCues([{ ...base, ...extra }]);
    assert.deepEqual(result, plain);
  }
  const single = splitDisplayCues([{ startMs: 0, endMs: 1000, text: "네", wordStarts: [0, 500], wordChars: [1, 1] }]);
  assert.deepEqual(single, [{ startMs: 0, endMs: 1000, text: "네" }]);
});

test("a word-aligned split stays put when split again and survives timing merges", () => {
  const units = unevenUnits();
  const result = applyResult(units, [{ from: 0, to: 19, text: longKorean }], { mode: "translate-ko" });
  assert.deepEqual(splitDisplayCues(structuredClone(result)), result);
  assert.deepEqual(splitDisplayCues(finalizeTimings(structuredClone(result))).map((c) => c.text.replace(/\s/g, "")).join(""),
    longKorean.replace(/\s/g, ""));
  assert.doesNotMatch(JSON.stringify(result), /wordStarts|wordChars/);
  // Too short to give each fragment its minimum: merged back by timing, text intact.
  const tight = applyResult([{ text: "a", startMs: 0, endMs: 100 }, { text: "b", startMs: 100, endMs: 200 }],
    [{ from: 0, to: 1, text: longKorean }], { mode: "translate-ko" });
  assert.equal(finalizeTimings(tight).map((c) => c.text.replace(/\s/g, "")).join(""), longKorean.replace(/\s/g, ""));
});
