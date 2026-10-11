// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Turning model output (or a fallback segmentation) into timed cues.
const { splitDisplayCues } = globalThis.LakomicsYouTube.display;

const MAX_GAP_MS = 2000;
const TAIL_MS = 1500;

// Whitespace and punctuation/symbols never count when checking that the model kept the words.
function normalize(text) {
  return String(text).normalize("NFC").replace(/[\s\p{P}\p{S}]/gu, "");
}

function wordsText(units, from, to) {
  return units
    .slice(from, to + 1)
    .map((u) => u.text)
    .join(" ");
}

// lines: [{ from, to, text }] with inclusive local indices, already validated as contiguous.
function buildCues(units, lines, mode = "clean") {
  const cues = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const startMs = units[line.from].startMs;
    const lastStart = units[line.to].startMs;
    const next = lines[k + 1];

    // Following line start, or (for the last line of a chunk) the last word's own end.
    let end = next ? units[next.from].startMs : units[line.to].endMs;
    if (!Number.isFinite(end) || end <= lastStart || end - lastStart > MAX_GAP_MS) {
      end = lastStart + TAIL_MS;
    }
    if (next) end = Math.min(end, units[next.from].startMs);
    cues.push({ startMs, endMs: end, text: line.text,
      ...(mode === "translate-ko" ? { orig: wordsText(units, line.from, line.to) } : {}) });
  }
  return splitDisplayCues(cues);
}

// Simple segmentation by pauses (> 700 ms between word starts) and a maximum line length.
function fallbackSegment(units, { pauseMs = 700, maxChars = 40, mode = "clean" } = {}) {
  if (!units.length) return [];

  const lines = [];
  let from = 0;
  let length = 0;

  for (let i = 0; i < units.length; i++) {
    const word = units[i].text;
    if (i > from) {
      const pause = units[i].startMs - units[i - 1].startMs > pauseMs;
      const tooLong = length + 1 + word.length > maxChars;
      if (pause || tooLong) {
        lines.push({ from, to: i - 1, text: wordsText(units, from, i - 1) });
        from = i;
      }
    }
    length = (i === from ? 0 : length + 1) + word.length;
  }
  lines.push({ from, to: units.length - 1, text: wordsText(units, from, units.length - 1) });

  return buildCues(units, lines, mode);
}

// Describes the first reason lines do not cover 0..n-1 contiguously and in order, or null when they do.
function coverageProblem(n, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return "no lines";
  let expected = 0;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (!line || !Number.isInteger(line.from) || !Number.isInteger(line.to)) return `line ${k} is malformed`;
    if (typeof line.text !== "string") return `line ${k} has no text`;
    if (line.to < line.from) return `line ${k} ends before it starts (${line.from}-${line.to})`;
    if (line.to >= n) return `line ${k} is out of range (${line.from}-${line.to}, last index ${n - 1})`;
    if (k === 0 && line.from !== 0) return `first line starts at ${line.from}, not 0`;
    if (line.from > expected) return `gap before line ${k}: indices ${expected}-${line.from - 1} are not covered`;
    if (line.from < expected) return `overlap at line ${k}: starts at ${line.from}, expected ${expected}`;
    expected = line.to + 1;
  }
  return expected === n ? null : `missing end: indices ${expected}-${n - 1} are not covered`;
}

function coversChunk(n, lines) {
  return coverageProblem(n, lines) === null;
}

// Lenient repair for translations: drops malformed entries, sorts by start, clamps overlaps to the
// previous line, and absorbs gaps by stretching the neighbouring line, so the result covers 0..n-1
// exactly. Gaps larger than a few words require a model retry, not range stretching.
// Returns null when repair would absorb too many words or no usable line is left.
function repairLines(n, lines, maxGapWords = 3) {
  if (!Array.isArray(lines) || !Number.isInteger(n) || n <= 0) return null;

  const usable = lines
    .filter(
      (l) =>
        l &&
        Number.isInteger(l.from) &&
        Number.isInteger(l.to) &&
        typeof l.text === "string" &&
        l.from >= 0 &&
        l.to >= l.from &&
        l.to < n,
    )
    .map((l) => ({ from: l.from, to: l.to, text: l.text }))
    .sort((a, b) => a.from - b.from || a.to - b.to);

  const out = [];
  for (const line of usable) {
    const prev = out[out.length - 1];
    if (prev) {
      if (line.from <= prev.to) line.from = prev.to + 1;
      if (line.from > line.to) continue;
      if (line.from - prev.to - 1 > maxGapWords) return null;
      if (line.from > prev.to + 1) prev.to = line.from - 1;
    }
    out.push(line);
  }
  if (!out.length) return null;
  if (out[0].from > maxGapWords || n - 1 - out[out.length - 1].to > maxGapWords) return null;
  out[0].from = 0;
  out[out.length - 1].to = n - 1;
  return out;
}

// chunk: units of one chunk. modelLines: [{ from, to, text }] (inclusive local indices).
// mode "translate-ko": the text is a translation, so the same-letters check is skipped.
function applyResult(chunk, modelLines, { mode = "clean" } = {}) {
  if (!chunk.length) return [];
  const translate = mode === "translate-ko";
  let usable = modelLines;
  if (!coversChunk(chunk.length, modelLines)) {
    // Translations keep their text when the line ranges are only slightly off; cleaning must match exactly.
    usable = translate ? repairLines(chunk.length, modelLines) : null;
    if (!usable) return fallbackSegment(chunk, { mode });
  }

  const lines = usable.map((line) => {
    const original = wordsText(chunk, line.from, line.to);
    if (translate) {
      const translated = line.text.trim();
      return { from: line.from, to: line.to, text: translated || original };
    }
    const same = normalize(line.text) === normalize(original);
    return { from: line.from, to: line.to, text: same ? line.text.trim() : original };
  });
  return buildCues(chunk, lines, mode);
}

(globalThis.LakomicsYouTube ??= {}).cues = { fallbackSegment, coverageProblem, repairLines, applyResult };
})();
