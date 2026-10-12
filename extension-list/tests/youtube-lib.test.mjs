import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJson3 } from "./helpers/youtube-classic.mjs";
import { chunkUnits, buildPrompt, chunkContexts, chunkFollowing, CONTEXT_HEADER, FOLLOWING_HEADER, FOLLOWING_WORDS } from "./helpers/youtube-classic.mjs";
import { chunkOrder, chunkRange } from "./helpers/youtube-classic.mjs";
import { finalizeTimings, readingTime } from "./helpers/youtube-classic.mjs";
import { applyResult, fallbackSegment, repairLines, coverageProblem } from "./helpers/youtube-classic.mjs";
import { modeForTrack, storageMode, normalizeRegisterSetting } from "./helpers/youtube-classic.mjs";

const asrSample = {
  events: [
    { tStartMs: 0, dDurationMs: 5000, wWinId: 1 }, // window definition, no segs
    {
      tStartMs: 100,
      dDurationMs: 2000,
      segs: [{ utf8: "안녕" }, { utf8: " 하세요", tOffsetMs: 400 }, { utf8: " 여러분", tOffsetMs: 900 }],
    },
    { tStartMs: 2100, dDurationMs: 1, aAppend: 1, segs: [{ utf8: "\n" }] },
    { tStartMs: 2100, dDurationMs: 1500, segs: [{ utf8: "\n" }, { utf8: "반가워요", tOffsetMs: 0 }] },
  ],
};

function makeUnits(words, starts) {
  return words.map((text, i) => ({ text, startMs: starts[i] }));
}

test("applyResult clean mode preserves speaker hyphens and newline with the same letters", () => {
  const chunk = makeUnits(["그거", "진짜야", "응"], [0, 400, 900]);
  const text = "- 그거 진짜야?\n- 응.";
  // Word units carry no end: the last word "응" is assumed to take 250 + 60 ms.
  assert.deepEqual(applyResult(chunk, [{ from: 0, to: 2, text }], { mode: "clean" }), [
    { startMs: 0, endMs: 900 + 310, text },
  ]);
});

test("storageMode isolates speaker marks while preserving off-mode cache strings", () => {
  for (const [track, translate, register, base] of [
    ["ko:asr", true, "banmal", "clean"],
    ["en:asr", false, "auto", "clean"],
    ["en:asr", true, "auto", "translate-ko-auto"],
    ["en:asr", true, "haeyo", "translate-ko-haeyo"],
    ["ja:std", true, "banmal", "translate-ko-banmal"],
    ["en:asr", true, "bogus", "translate-ko-auto"],
  ]) {
    assert.equal(storageMode(track, translate, register), base);
    assert.equal(storageMode(track, translate, register, false), base);
    assert.equal(storageMode(track, translate, register, true), `${base}+spk`);
  }
});

test("parseJson3 reads word offsets, skips aAppend and whitespace-only segs", () => {
  const { units, endMs } = parseJson3(JSON.stringify(asrSample));
  assert.deepEqual(
    units.map((u) => [u.text, u.startMs, u.endMs]),
    [
      ["안녕", 100, 500],
      ["하세요", 500, 1000],
      ["여러분", 1000, 2100], // last word of the event ends at the event end
      ["반가워요", 2100, 3600],
    ],
  );
  assert.equal(endMs, 3600);
});

test("parseJson3 caps the event end at the next word start", () => {
  const { units } = parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: "a" }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "b" }] },
    ],
  });
  assert.equal(units[0].endMs, 1000);
  assert.equal(units[1].endMs, 2000);
});

test("parseJson3 handles manual tracks and missing events", () => {
  const manual = parseJson3({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "Hello\nthere " }] }] });
  assert.equal(manual.units.length, 1);
  assert.equal(manual.units[0].text, "Hello there");
  assert.deepEqual(parseJson3({}).units, []);
});

test("chunkUnits returns one chunk when small enough", () => {
  const units = makeUnits(["a", "b", "c"], [0, 100, 200]);
  assert.deepEqual(chunkUnits(units, 600), [units]);
  assert.deepEqual(chunkUnits([], 600), []);
});

test("chunkUnits splits at the largest gap and respects maxWords", () => {
  const starts = [0, 100, 200, 300, 5000, 5100, 5200, 5300, 5400, 5500];
  const units = makeUnits(starts.map((_, i) => `w${i}`), starts);
  const chunks = chunkUnits(units, 6);
  assert.deepEqual(chunks.map((c) => c.length), [4, 6]);
  assert.ok(chunks.every((c) => c.length <= 6));
  assert.deepEqual(chunks.flat(), units);
});

test("chunkUnits keeps every chunk within maxWords for long input", () => {
  const units = Array.from({ length: 1000 }, (_, i) => ({ text: `w${i}`, startMs: i * 300 + (i % 97 === 0 ? 1500 : 0) }));
  const chunks = chunkUnits(units, 100);
  assert.ok(chunks.every((c) => c.length <= 100));
  assert.deepEqual(chunks.flat(), units);
});

test("buildPrompt numbers words locally", () => {
  const units = makeUnits(["안녕하세요", "여러분"], [0, 500]);
  assert.equal(buildPrompt(units), "0\t안녕하세요\n1\t여러분");
});

test("applyResult happy path keeps the model text", () => {
  const chunk = makeUnits(["안녕", "하세요", "여러분", "반가워요"], [0, 400, 900, 2000]);
  const cues = applyResult(chunk, [
    { from: 0, to: 2, text: "안녕하세요, 여러분." },
    { from: 3, to: 3, text: "반가워요!" },
  ]);
  assert.deepEqual(cues, [
    { startMs: 0, endMs: 900 + 250 + 60 * 3, text: "안녕하세요, 여러분." },
    { startMs: 2000, endMs: 2000 + 250 + 60 * 4, text: "반가워요!" },
  ]);
});

test("an auto-caption line ends at its last word's estimated speech end, not in the following silence", () => {
  // 250 ms + 60 ms per character, at most 1.2 s, and never past the next word's start.
  const chunk = makeUnits(["안녕", "하세요", "여러분", "반가워요"], [0, 400, 900, 3000]);
  const cues = applyResult(chunk, [
    { from: 0, to: 2, text: "안녕하세요 여러분" },
    { from: 3, to: 3, text: "반가워요" },
  ]);
  assert.equal(cues[0].endMs, 900 + 250 + 60 * 3);
  assert.equal(cues[1].startMs, 3000);
  const long = applyResult([{ text: "a".repeat(30), startMs: 0 }], [{ from: 0, to: 0, text: "가" }]);
  assert.equal(long[0].endMs, 1200);
  const crowded = applyResult([{ text: "abcdefghij", startMs: 0, endMs: 300 }, { text: "b", startMs: 300 }],
    [{ from: 0, to: 0, text: "가" }, { from: 1, to: 1, text: "나" }]);
  assert.equal(crowded[0].endMs, 300);
});

test("a translated line stays on screen for its reading time whatever the source end says", () => {
  const text = "저는 이 방법을 사용하면 문제가 다시 생길 거라고 생각하지 않아요.";
  const reading = readingTime(text);
  assert.ok(reading > 1200 && reading < 6000);
  for (const endMs of [undefined, 0, 6000]) {
    const raw = applyResult([{ text: "Manual source caption", startMs: 0, endMs }],
      [{ from: 0, to: 0, text }], { mode: "translate-ko" });
    assert.equal(raw.length, 1);
    assert.equal(raw[0].endMs, 1200);
    assert.equal(finalizeTimings(raw)[0].endMs, Math.round(reading));
  }
});

test("applyResult uses the last word's own end for the final line when it is shorter than the estimate", () => {
  const chunk = [
    { text: "a", startMs: 0, endMs: 500 },
    { text: "b", startMs: 500, endMs: 700 },
  ];
  const cues = applyResult(chunk, [{ from: 0, to: 1, text: "a b" }]);
  assert.deepEqual(cues, [{ startMs: 0, endMs: 700, text: "a b" }]);
});

test("applyResult replaces a changed line with the original words", () => {
  const chunk = makeUnits(["안녕", "하세요", "여러분", "반가워요"], [0, 400, 900, 1500]);
  const cues = applyResult(chunk, [
    { from: 0, to: 2, text: "안녕하세요 여러분들" }, // added letters
    { from: 3, to: 3, text: "반가워요." },
  ]);
  assert.equal(cues[0].text, "안녕 하세요 여러분");
  assert.equal(cues[0].startMs, 0);
  assert.equal(cues[1].text, "반가워요.");
});

test("applyResult falls back to fallbackSegment on a coverage gap", () => {
  const chunk = makeUnits(["안녕", "하세요", "여러분", "반가워요"], [0, 400, 900, 1500]);
  const expected = fallbackSegment(chunk);
  assert.ok(expected.length > 0);
  assert.deepEqual(applyResult(chunk, [{ from: 0, to: 0, text: "안녕" }, { from: 2, to: 3, text: "여러분 반가워요" }]), expected);
  // overlap
  assert.deepEqual(applyResult(chunk, [{ from: 0, to: 2, text: "안녕하세요 여러분" }, { from: 2, to: 3, text: "여러분 반가워요" }]), expected);
  // missing tail
  assert.deepEqual(applyResult(chunk, [{ from: 0, to: 2, text: "안녕하세요 여러분" }]), expected);
  // not an array
  assert.deepEqual(applyResult(chunk, null), expected);
});

test("fallbackSegment splits at pauses and at the maximum length", () => {
  const paused = makeUnits(["a", "b", "c", "d"], [0, 300, 2000, 2300]);
  assert.deepEqual(
    fallbackSegment(paused).map((c) => c.text),
    ["a b", "c d"],
  );

  const words = Array.from({ length: 20 }, () => "가나다라마");
  const long = makeUnits(words, words.map((_, i) => i * 300));
  const cues = fallbackSegment(long);
  assert.ok(cues.length > 1);
  assert.ok(cues.every((c) => c.text.length <= 40));
  assert.equal(cues.map((c) => c.text).join(" "), words.join(" "));
});

test("applyResult in translate-ko mode keeps translated text", () => {
  const chunk = makeUnits(["Hello", "everyone", "nice", "to", "see", "you"], [0, 400, 900, 1500, 1800, 2100]);
  const cues = applyResult(
    chunk,
    [
      { from: 0, to: 1, text: "  안녕하세요, 여러분.  " },
      { from: 2, to: 5, text: "만나서 반가워요." },
    ],
    { mode: "translate-ko" },
  );
  assert.deepEqual(cues, [
    { startMs: 0, endMs: 900, text: "안녕하세요, 여러분.", orig: "Hello everyone" },
    { startMs: 900, endMs: 2100 + 250 + 60 * 3, text: "만나서 반가워요.", orig: "nice to see you" },
  ]);
  // clean mode would have replaced the changed text with the original words
  const clean = applyResult(chunk, [{ from: 0, to: 5, text: "안녕하세요" }]);
  assert.equal(clean[0].text, "Hello everyone nice to see you");
});

test("applyResult in translate-ko mode uses the original words for an empty translation", () => {
  const chunk = makeUnits(["Hello", "everyone", "bye"], [0, 400, 900]);
  const cues = applyResult(
    chunk,
    [
      { from: 0, to: 1, text: "   " },
      { from: 2, to: 2, text: "안녕." },
    ],
    { mode: "translate-ko" },
  );
  assert.equal(cues[0].text, "Hello everyone");
  assert.equal(cues[1].text, "안녕.");
});

test("applyResult in translate-ko mode keeps translated text across a coverage gap", () => {
  const chunk = makeUnits(["Hello", "everyone", "nice", "to"], [0, 400, 900, 1500]);
  const gap = [{ from: 0, to: 0, text: "안녕" }, { from: 2, to: 3, text: "만나서 반가워요" }];
  const cues = applyResult(chunk, gap, { mode: "translate-ko" });
  assert.deepEqual(
    cues.map((c) => [c.startMs, c.text]),
    [[0, "안녕"], [900, "만나서 반가워요"]],
  );
  // clean mode stays strict
  assert.deepEqual(applyResult(chunk, gap), fallbackSegment(chunk));
});

test("applyResult in translate-ko mode falls back when nothing is usable", () => {
  const chunk = makeUnits(["Hello", "everyone", "nice", "to"], [0, 400, 900, 1500]);
  const expected = fallbackSegment(chunk, { mode: "translate-ko" });
  assert.deepEqual(applyResult(chunk, null, { mode: "translate-ko" }), expected);
  assert.deepEqual(applyResult(chunk, [{ from: 3, to: 1, text: "x" }, { from: 0, to: 9, text: "y" }], { mode: "translate-ko" }), expected);
  assert.equal(expected.map((c) => c.text).join(" "), "Hello everyone nice to");
});

test("coverageProblem names the first problem", () => {
  const l = (from, to) => ({ from, to, text: "x" });
  assert.equal(coverageProblem(4, [l(0, 1), l(2, 3)]), null);
  assert.match(coverageProblem(4, [l(0, 0), l(2, 3)]), /gap/);
  assert.match(coverageProblem(4, [l(0, 2), l(2, 3)]), /overlap/);
  assert.match(coverageProblem(4, [l(1, 3)]), /not 0/);
  assert.match(coverageProblem(4, [l(0, 1)]), /missing end/);
  assert.match(coverageProblem(4, [l(0, 4)]), /out of range/);
  assert.match(coverageProblem(4, []), /no lines/);
});

test("repairLines absorbs a gap in the middle by extending the previous line", () => {
  const l = (from, to, text) => ({ from, to, text });
  assert.deepEqual(repairLines(6, [l(0, 1, "a"), l(4, 5, "b")]), [l(0, 3, "a"), l(4, 5, "b")]);
});

test("repairLines fills a missing start and a missing end", () => {
  const l = (from, to, text) => ({ from, to, text });
  assert.deepEqual(repairLines(5, [l(2, 4, "a")]), [l(0, 4, "a")]);
  assert.deepEqual(repairLines(5, [l(0, 1, "a"), l(2, 2, "b")]), [l(0, 1, "a"), l(2, 4, "b")]);
});

test("repairLines clamps overlaps, drops emptied lines and sorts by start", () => {
  const l = (from, to, text) => ({ from, to, text });
  assert.deepEqual(repairLines(6, [l(3, 5, "b"), l(0, 3, "a")]), [l(0, 3, "a"), l(4, 5, "b")]);
  // a line fully inside the previous one disappears
  assert.deepEqual(repairLines(4, [l(0, 3, "a"), l(1, 2, "b")]), [l(0, 3, "a")]);
});

test("repairLines drops malformed entries and returns null when none is usable", () => {
  const l = (from, to, text) => ({ from, to, text });
  const bad = [null, { from: 1.5, to: 2, text: "x" }, l(3, 1, "x"), l(0, 9, "x"), l(-1, 1, "x"), { from: 0, to: 1 }, "x"];
  assert.deepEqual(repairLines(4, [...bad, l(1, 2, "ok")]), [l(0, 3, "ok")]);
  assert.equal(repairLines(4, bad), null);
  assert.equal(repairLines(4, []), null);
  assert.equal(repairLines(4, null), null);
  assert.equal(repairLines(0, [l(0, 0, "x")]), null);
});

test("modeForTrack: Korean tracks are cleaned, others translated unless disabled", () => {
  assert.equal(modeForTrack("ko:asr"), "clean");
  assert.equal(modeForTrack("ko-KR:std"), "clean");
  assert.equal(modeForTrack("en:asr"), "translate-ko");
  assert.equal(modeForTrack("en:asr", true), "translate-ko");
  assert.equal(modeForTrack("en:asr", false), "clean");
  assert.equal(modeForTrack("ja:std", undefined), "translate-ko");
  assert.equal(modeForTrack("ko:asr", false), "clean");
});

test("parseJson3 strips sound tags and music notes and drops segs left empty", () => {
  const { units } = parseJson3({
    events: [
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "[음악]" }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: "[Music]" }, { utf8: " hello", tOffsetMs: 100 }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: "♪" }, { utf8: "♫ ♪" , tOffsetMs: 50 }] },
      { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: "안녕 [박수]  하세요" }, { utf8: "[Applause]", tOffsetMs: 300 }] },
      { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: "(웃음) 네" }, { utf8: "♪ 노래 ♪", tOffsetMs: 200 }] },
    ],
  });
  assert.deepEqual(
    units.map((u) => u.text),
    ["hello", "안녕 하세요", "(웃음) 네", "노래"],
  );
});

test("storageMode adds the register setting only to translate mode", () => {
  assert.equal(storageMode("en:asr", true, "auto"), "translate-ko-auto");
  assert.equal(storageMode("en:asr", true, "haeyo"), "translate-ko-haeyo");
  assert.equal(storageMode("ja:std", undefined, "banmal"), "translate-ko-banmal");
  assert.equal(storageMode("en:asr", true, "bogus"), "translate-ko-auto");
  assert.equal(storageMode("en:asr", true), "translate-ko-auto");
  assert.equal(storageMode("en:asr", false, "banmal"), "clean");
  assert.equal(storageMode("ko:asr", true, "banmal"), "clean");
  assert.equal(normalizeRegisterSetting(undefined), "auto");
  assert.equal(normalizeRegisterSetting("banmal"), "banmal");
});

test("buildPrompt puts context words in a separate block before the numbered list", () => {
  const units = makeUnits(["안녕하세요", "여러분"], [0, 500]);
  const prompt = buildPrompt(units, ["그래서", "말이야"]);
  assert.equal(
    prompt,
    `${CONTEXT_HEADER}\n그래서 말이야\n\nNumbered words to process:\n0\t안녕하세요\n1\t여러분`,
  );
  // numbering still starts at 0 for the chunk itself; empty context changes nothing
  assert.equal(buildPrompt(units, []), "0\t안녕하세요\n1\t여러분");
  assert.equal(buildPrompt(units, undefined), "0\t안녕하세요\n1\t여러분");
});

test("chunkContexts gives each chunk the last words before it, capped", () => {
  const units = Array.from({ length: 10 }, (_, i) => ({ text: `w${i}`, startMs: i * 100 }));
  const chunks = [units.slice(0, 4), units.slice(4, 8), units.slice(8)];
  assert.deepEqual(chunkContexts(chunks, 3), [[], ["w1", "w2", "w3"], ["w5", "w6", "w7"]]);
  assert.deepEqual(chunkContexts(chunks, 60)[2], ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"]);
  assert.deepEqual(chunkContexts(chunks, 0), [[], [], []]);
  assert.deepEqual(chunkContexts([]), []);
});

test("buildPrompt puts following words in a separate block after the numbered list", () => {
  const units = makeUnits(["안녕하세요", "여러분"], [0, 500]);
  assert.equal(
    buildPrompt(units, [], ["다음", "말이야"]),
    `0\t안녕하세요\n1\t여러분\n\n${FOLLOWING_HEADER}\n다음 말이야`,
  );
  assert.equal(
    buildPrompt(units, ["그래서"], ["다음"]),
    `${CONTEXT_HEADER}\n그래서\n\nNumbered words to process:\n0\t안녕하세요\n1\t여러분\n\n${FOLLOWING_HEADER}\n다음`,
  );
  assert.equal(buildPrompt(units, ["그래서"], []), buildPrompt(units, ["그래서"]));
  assert.equal(buildPrompt(units, [], undefined), "0\t안녕하세요\n1\t여러분");
});

test("chunkFollowing gives each chunk the first words after it, across chunks and capped; the last chunk has none", () => {
  const units = Array.from({ length: 10 }, (_, i) => ({ text: `w${i}`, startMs: i * 100 }));
  const chunks = [units.slice(0, 4), units.slice(4, 6), units.slice(6, 8), units.slice(8)];
  assert.deepEqual(chunkFollowing(chunks, 3), [["w4", "w5", "w6"], ["w6", "w7", "w8"], ["w8", "w9"], []]);
  assert.deepEqual(chunkFollowing(chunks)[0], ["w4", "w5", "w6", "w7", "w8", "w9"]);
  assert.deepEqual(chunkFollowing(chunks, 0), [[], [], [], []]);
  assert.deepEqual(chunkFollowing([units]), [[]]);
  assert.deepEqual(chunkFollowing([]), []);
  assert.equal(FOLLOWING_WORDS, 80);
  const long = Array.from({ length: 3 }, (_, c) => Array.from({ length: 200 }, (_, i) => ({ text: `c${c}w${i}`, startMs: 0 })));
  const following = chunkFollowing(long);
  assert.equal(following[0].length, 80);
  assert.deepEqual([following[0][0], following[0][79]], ["c1w0", "c1w79"]);
  assert.equal(following[2].length, 0);
});

test("chunkOrder starts at the chunk containing the position, then later chunks, then earlier ones", () => {
  const mk = (start) => [{ text: "a", startMs: start, endMs: start + 50 }];
  const chunks = [mk(0), mk(1000), mk(2000), mk(3000), mk(4000)];
  assert.deepEqual(chunkOrder(chunks, 2500), [2, 3, 4, 1, 0]);
  assert.deepEqual(chunkOrder(chunks, 2000), [2, 3, 4, 1, 0]); // a chunk starts at its first word
  assert.deepEqual(chunkOrder(chunks, 1999), [1, 2, 3, 4, 0]);
  assert.deepEqual(chunkOrder(chunks, 0), [0, 1, 2, 3, 4]);
  assert.deepEqual(chunkOrder(chunks, -5), [0, 1, 2, 3, 4]); // before the first word
  assert.deepEqual(chunkOrder(chunks, 999999), [4, 3, 2, 1, 0]); // after the last
  assert.deepEqual(chunkOrder(chunks, NaN), [0, 1, 2, 3, 4]);
  assert.deepEqual(chunkOrder(chunks, undefined), [0, 1, 2, 3, 4]);
  assert.deepEqual(chunkOrder([], 100), []);
  assert.deepEqual(chunkOrder([mk(500)], 100), [0]);
});

test("chunkRange runs to the next chunk's first word, or to the last cue end for the final chunk", () => {
  const chunks = [
    [{ text: "a", startMs: 100, endMs: 400 }, { text: "b", startMs: 400, endMs: 900 }],
    [{ text: "c", startMs: 1200, endMs: 1500 }, { text: "d", startMs: 1500, endMs: 1800 }],
  ];
  assert.deepEqual(chunkRange(chunks, 0), { startMs: 100, endMs: 1200 });
  assert.deepEqual(chunkRange(chunks, 1, [{ startMs: 1200, endMs: 1900, text: "x" }]), { startMs: 1200, endMs: 1900 });
  assert.deepEqual(chunkRange(chunks, 1), { startMs: 1200, endMs: 1800 });
});

test("register setting: defaults to following the speaker, accepts only known values, and update persists it", async () => {
  const { DEFAULTS, normalize, update, read, PREFIX } = await import("./helpers/youtube-classic.mjs");
  assert.equal(DEFAULTS.register, "auto");
  assert.equal(normalize({}).register, "auto");
  assert.equal(normalize({ register: "haeyo" }).register, "haeyo");
  assert.equal(normalize({ register: "formal" }).register, "auto");
  const stored = {};
  const old = globalThis.chrome;
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])),
    set: async (values) => Object.assign(stored, values),
  } } };
  try {
    assert.equal((await read()).register, "auto");
    assert.equal((await update({ register: "haeyo" })).ok, true);
    assert.equal(stored[PREFIX + "register"], "haeyo");
    assert.equal((await read()).register, "haeyo");
    assert.equal((await update({ register: "bogus" })).ok, false);
    assert.equal((await read()).register, "haeyo");
  } finally { globalThis.chrome = old; }
});
