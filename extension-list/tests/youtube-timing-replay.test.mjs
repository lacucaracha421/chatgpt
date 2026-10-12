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

// ---- The policy before 3.5.20 (kept only to show the improvement) ----
// Cue end = next line start, or last word start + 1.5 s after a pause over 2 s; reading time 55 ms/char within
// 1-3 s; gaps under 400 ms bridged; the same fragment merge.
const legacyReading = (text) => Math.min(3000, Math.max(1000, 55 * Array.from(text.replace(/\s/gu, "")).length));
function legacyBuild(chunk, lines) {
  const cues = lines.map((line, k) => {
    const startMs = chunk[line.from].startMs, lastStart = chunk[line.to].startMs, next = lines[k + 1];
    let end = next ? chunk[next.from].startMs : chunk[line.to].endMs;
    if (!Number.isFinite(end) || end <= lastStart || end - lastStart > 2000) {
      end = Math.max(lastStart + 1500, startMs + legacyReading(line.text));
    }
    if (next) end = Math.min(end, chunk[next.from].startMs);
    const covered = chunk.slice(line.from, line.to + 1);
    return { startMs, endMs: end, text: line.text, orig: covered.map((u) => u.text).join(" "),
      wordStarts: covered.map((u) => u.startMs), wordChars: covered.map((u) => Array.from(u.text).length) };
  });
  return splitDisplayCues(cues);
}
function legacyPolish(cues) {
  const merged = cues.map((cue) => ({ ...cue }));
  for (let i = 0; i < merged.length; i++) {
    const cue = merged[i], next = merged[i + 1];
    if (!cue.splitLine || (next?.startMs ?? Infinity) - cue.startMs >= legacyReading(cue.text)) continue;
    const neighbour = next?.splitLine === cue.splitLine ? i + 1 : merged[i - 1]?.splitLine === cue.splitLine ? i - 1 : -1;
    if (neighbour < 0) continue;
    const first = Math.min(i, neighbour), a = merged[first], b = merged[first + 1];
    merged.splice(first, 2, { ...a, endMs: b.endMs, text: `${a.text} ${b.text}`, orig: [a.orig, b.orig].filter(Boolean).join(" "), splitMerged: true });
    i = first - 1;
  }
  return merged.map((cue, index) => {
    const nextStart = merged[index + 1]?.startMs ?? Infinity;
    const gap = nextStart - cue.endMs;
    const target = gap >= 0 && gap < 400 ? nextStart : cue.startMs + legacyReading(cue.text);
    return { ...cue, endMs: Math.max(cue.endMs, Math.min(target, nextStart)) };
  });
}
function legacyPipeline(units, shape) {
  const chunks = chunkUnits(units, 200);
  const perChunk = chunks.map((chunk, index) => {
    const nextStart = chunks[index + 1]?.[0].startMs ?? Infinity;
    const cues = legacyBuild(chunk, standInLines(chunk, shape)).map((cue) => ({ ...cue, endMs: Math.min(cue.endMs, nextStart) }));
    return splitDisplayCues(legacyPolish([...cues, { startMs: nextStart, endMs: nextStart, text: "" }]).slice(0, -1));
  });
  return splitDisplayCues(legacyPolish(perChunk.flat())).map((cue) => ({ ...cue, startMs: Math.round(cue.startMs), endMs: Math.round(cue.endMs) }));
}

// ---- The pipeline of this version, as service.js runs it ----
function currentPipeline(units, shape) {
  const raw = chunkUnits(units, 200).flatMap((chunk) =>
    applyResult(chunk, standInLines(chunk, shape), { mode: "translate-ko", human: false }));
  return finalizeTimings(raw);
}

// ---- The metric ----
//   early:     ends more than 700 ms before the speech of its words ends
//   late:      stays more than 700 ms after that speech
//   short:     shown for less than its reading time although the next cue starts over 300 ms after it ends
//   unbridged: a visible gap of 82 ms to 1.2 s before the next cue (blinking); cues at the 7 s limit are exempt
//   overlaps:  ends after the next cue starts
function measure(units, cues) {
  const result = { cues: cues.length, early: 0, late: 0, short: 0, unbridged: 0, overlaps: 0 };
  let cursor = 0;
  cues.forEach((cue, i) => {
    const next = cues[i + 1];
    // The source words that start inside [this start, next start) belong to this cue.
    let last = -1;
    while (cursor < units.length && (next === undefined || units[cursor].startMs < next.startMs)) {
      if (units[cursor].startMs >= cue.startMs) last = cursor;
      cursor++;
    }
    if (last >= 0) {
      if (wordEnd(units, last) - cue.endMs > 700) result.early++;
      if (cue.endMs - wordEnd(units, last) > 700) result.late++;
    }
    const room = (next?.startMs ?? Infinity) - cue.endMs;
    const shown = cue.endMs - cue.startMs;
    if (next && cue.endMs > next.startMs) result.overlaps++;
    if (shown < readingTime(cue.text) - 1 && room > 300 && shown < 7000) result.short++;
    if (next && room > 81 && room < 1200 && shown < 7000) result.unbridged++;
  });
  return result;
}

// Measured once on this fixture (same lines through both policies). Cues per case: before/after.
//   case                   early   late    short  unbridged   (before -> after)
//   real/sentences         0 -> 0   5 -> 3   0 -> 0   0 -> 0
//   real/clauses           0 -> 0   7 -> 4   0 -> 0   1 -> 0
//   real/longPauses        0 -> 0   6 -> 3   0 -> 0   0 -> 0
//   withPauses/sentences   0 -> 0  24 -> 12  2 -> 0   0 -> 0
//   withPauses/clauses     0 -> 0  22 -> 9   3 -> 0   1 -> 0
//   withPauses/longPauses  0 -> 0  35 -> 17  2 -> 0   0 -> 0
// Where speech is continuous the old policy already held a line until the next one; it differed in the pauses
// (1.5 s tails and a 3 s reading limit) and in holding cues too long after the speech. "late" counts what the new
// policy still holds by design (reading time, bridged gaps up to 1.2 s), so it is bounded rather than zero.
const MAX_LATE = { "real/sentences": 3, "real/clauses": 4, "real/longPauses": 3,
  "withPauses/sentences": 12, "withPauses/clauses": 9, "withPauses/longPauses": 17 };

const SHAPES = {
  sentences: { min: 6, max: 14, pauseMs: 500 },
  clauses: { min: 3, max: 7, pauseMs: 300 },
  longPauses: { min: 5, max: 12, pauseMs: 1000 },
};

test("replay of a real auto-caption track: cues stay up for their speech and reading time, without blinking", () => {
  assert.equal(realUnits.length, 860);
  const tracks = { real: realUnits, withPauses: withPauses(realUnits) };
  const report = {};
  for (const [trackName, units] of Object.entries(tracks)) {
    for (const [shapeName, shape] of Object.entries(SHAPES)) {
      const before = measure(units, legacyPipeline(units, shape));
      const after = measure(units, currentPipeline(units, shape));
      report[`${trackName}/${shapeName}`] = { before, after };
      assert.equal(after.overlaps, 0, `${trackName}/${shapeName} overlaps`);
      assert.equal(after.unbridged, 0, `${trackName}/${shapeName} unbridged gaps`);
      assert.equal(after.short, 0, `${trackName}/${shapeName} cues cut short of their reading time`);
      // Tighten only: measured with this fixture and stand-in model.
      assert.ok(after.early <= 0, `${trackName}/${shapeName} early ends: ${after.early}`);
      assert.ok(after.late <= MAX_LATE[`${trackName}/${shapeName}`] && after.late < before.late, `${trackName}/${shapeName} late ends: ${after.late} vs ${before.late}`);
      assert.ok(after.short <= before.short && after.unbridged <= before.unbridged);
    }
  }
  const gappy = report["withPauses/sentences"];
  assert.ok(gappy.before.short + gappy.before.unbridged > 0, "the paused track should expose the old policy");
});
