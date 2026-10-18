import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyResult, chunkUnits, finalizeTimings, parseJson3, readingTime, splitDisplayCues } from "./helpers/youtube-classic.mjs";

// Replay of the first five minutes of a real auto-caption track (YPoBMzAkZZM, en:asr, 860 word units) through the
// real pipeline: parse -> chunk -> applyResult (cue building + display split) -> timing.finalizeTimings.
// The model is replaced by a deterministic stand-in that cuts lines of a few words at pauses or sentence ends and
// writes a Korean placeholder of 1.1 x the English characters. The metric compares each displayed cue with the
// real speech of its source words, computed here from the units alone (independent of either timing policy).
const track = JSON.parse(readFileSync(new URL("./fixtures/youtube/yt-asr-YPoBMzAkZZM-first5min.json3.json", import.meta.url), "utf8"));
const realUnits = parseJson3(track).units;

const SYLLABLES = Array.from("가나다라마바사아자차카타파");
function placeholder(words) {
  let n = 0;
  return words.map((word) => {
    const size = Math.max(1, Math.round(1.1 * Array.from(word.text.replace(/\s/gu, "")).length));
    return Array.from({ length: size }, () => SYLLABLES[n++ % SYLLABLES.length]).join("");
  }).join(" ");
}

// Close a line after `max` words, or after `min`+ words at a sentence end or a pause of `pauseMs` or more.
function standInLines(chunk, { min, max, pauseMs }) {
  const lines = [];
  let from = 0;
  for (let i = 0; i < chunk.length; i++) {
    const count = i - from + 1;
    const pause = i + 1 < chunk.length && chunk[i + 1].startMs - chunk[i].startMs >= pauseMs;
    const sentence = /[.!?]$/u.test(chunk[i].text);
    if (i === chunk.length - 1 || count >= max || (count >= min && (pause || sentence))) {
      lines.push({ from, to: i, text: placeholder(chunk.slice(from, i + 1)) });
      from = i + 1;
    }
  }
  return lines;
}

// The same track with silences added after every 20th word, alternately 1 s and 3 s (music or a pause in the real video).
function withPauses(units) {
  let shift = 0;
  return units.map((unit, i) => {
    if (i > 0 && i % 20 === 0) shift += (i / 20) % 2 ? 1000 : 3000;
    return { ...unit, startMs: unit.startMs + shift, endMs: unit.endMs + shift };
  });
}

// Real end of a source word: the next word's start, but at most 250 ms + 60 ms per character (max 1.2 s).
function wordEnd(units, index) {
  const unit = units[index];
  const estimate = Math.min(1200, 250 + 60 * Array.from(unit.text.replace(/\s/gu, "")).length);
  return Math.min(units[index + 1]?.startMs ?? Infinity, unit.startMs + estimate);
}

// Check the current contract directly. Counts measured against the retired policy depended
// on character-proportional translation fragments, which are no longer source-aligned cues.
for (const [name, shape] of Object.entries({
  sentences: { min: 6, max: 14, pauseMs: 500 },
  clauses: { min: 3, max: 7, pauseMs: 300 },
  longPauses: { min: 5, max: 12, pauseMs: 1000 },
})) {
  test(`five-minute caption replay: ${name} preserves source ranges and extends only before the next onset`, () => {
    for (const units of [realUnits, withPauses(realUnits)]) {
      const raw = chunkUnits(units, 200).flatMap(chunk =>
        applyResult(chunk, standInLines(chunk, shape), { mode: 'translate-ko' }));
      const cues = finalizeTimings(raw);
      assert.equal(cues.length, raw.length);
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i], next = cues[i + 1]?.startMs ?? Infinity;
        assert.equal(cue.startMs, raw[i].startMs);
        assert.ok(cue.endMs >= raw[i].endMs);
        assert.ok(cue.endMs <= next);
        const readingEnd = Math.min(next - 80, cue.startMs + readingTime(cue.text));
        assert.ok(cue.endMs >= readingEnd - 1);
        const word = units.findLast(u => u.startMs >= cue.startMs && u.startMs < next);
        const sourceEnd = word.sourceEndMs ?? Math.min(word.endMs, wordEnd([word], 0));
        assert.ok(cue.endMs >= Math.min(sourceEnd, next) - 1);
      }
    }
  });
}
