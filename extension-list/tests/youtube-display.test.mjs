import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDisplayCues } from "./helpers/youtube-classic.mjs";
import { applyResult, fallbackSegment, repairLines } from "./helpers/youtube-classic.mjs";
import { polishTimings } from "./helpers/youtube-classic.mjs";
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
  const cues = splitDisplayCues(polishTimings([{ startMs: 0, endMs: 7000, text: "hello" },
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
