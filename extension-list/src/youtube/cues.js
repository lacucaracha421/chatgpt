// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Turning model output (or a fallback segmentation) into timed cues.
const { splitDisplayCues } = globalThis.LakomicsYouTube.display;

// Estimated time to say one auto-caption word: json3 gives only word starts, so a word is assumed to
// last 250 ms plus 60 ms per character, at most 1.2 s, and never past the next word's start.
const WORD_BASE_MS = 250;
const WORD_CHAR_MS = 60;
const WORD_MAX_MS = 1200;

// Apply only within one translated chunk, before ranges become timed display cues.
function mergeDanglingEndings(units, lines) {
  const ending = /^(?:않아요|않습니다|있어요|없어요|거예요|같아요|이에요|예요)[\s\p{P}]*$/u;
  const sentenceEnd = /[.!?。！？…][\s"'\p{Pe}\p{Pf}]*$/u;
  const merged = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    const gap = previous ? units[line.from].startMs - units[previous.to].startMs : Infinity;
    if (previous && previous.to + 1 === line.from && ending.test(line.text) &&
        !sentenceEnd.test(previous.text) && gap >= 0 && gap <= 1500) {
      previous.text += ` ${line.text}`;
      previous.to = line.to;
    } else {
      merged.push({ ...line });
    }
  }
  return merged;
}

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

// End of the real speech of one source unit. Human-made tracks hold whole caption events, so the event's
// own end is the speech end; auto-caption units are single words and get the estimate above.
function speechEnd(unit, human) {
  const known = Number.isFinite(unit.endMs) && unit.endMs > unit.startMs ? unit.endMs : null;
  if (human && known !== null) return known;
  const chars = Array.from(String(unit.text).replace(/\s/gu, "")).length;
  const estimate = unit.startMs + Math.min(WORD_MAX_MS, WORD_BASE_MS + WORD_CHAR_MS * chars);
  return known === null ? estimate : Math.min(known, estimate);
}

// The speaker of a stretch of units: whoever speaks longest in it (a word without an end counts as one
// millisecond), or undefined when the units carry no speaker (YouTube tracks, older results).
function majoritySpeaker(units, human) {
  const time = new Map();
  for (const unit of units) {
    if (!Number.isInteger(unit.speaker)) continue;
    time.set(unit.speaker, (time.get(unit.speaker) || 0) + Math.max(1, speechEnd(unit, human) - unit.startMs));
  }
  let best;
  for (const [speaker, ms] of time) if (best === undefined || ms > time.get(best)) best = speaker;
  return best;
}

// A speaker label the model echoed ("[S2] ...") never belongs in a subtitle.
const ECHOED_LABEL = /\[S\d{1,2}\]\s*/gu;

// lines: [{ from, to, text }] with inclusive local indices, already validated as contiguous.
// human: the units are whole caption events of a human-made track (see speechEnd).
// A cue spans exactly the speech of its words; how long it stays on screen beyond that (reading time,
// bridging small gaps) is decided once for all cues by timing.finalizeTimings.
function buildCues(units, lines, mode = "clean", human = false) {
  const cues = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    const startMs = units[line.from].startMs;
    const next = lines[k + 1];
    let end = Math.max(startMs, speechEnd(units[line.to], human));
    if (next) end = Math.min(end, Math.max(startMs, units[next.from].startMs));
    // Source word starts (and sizes) guide where splitDisplayCues cuts this line; it strips them again.
    const covered = units.slice(line.from, line.to + 1);
    const speaker = majoritySpeaker(covered, human);
    cues.push({ startMs, endMs: end, text: line.text, ...(speaker === undefined ? {} : { speaker }),
      wordStarts: covered.map((u) => u.startMs), wordChars: covered.map((u) => Array.from(u.text).length),
      ...(mode === "translate-ko" ? { orig: wordsText(units, line.from, line.to) } : {}) });
  }
  return splitDisplayCues(cues);
}

// Simple segmentation by pauses (> 700 ms between word starts) and a maximum line length.
function fallbackSegment(units, { pauseMs = 700, maxChars = 40, mode = "clean", human = false } = {}) {
  if (!units.length) return [];

  const lines = [];
  let from = 0;
  let length = 0;

  for (let i = 0; i < units.length; i++) {
    const word = units[i].text;
    if (i > from) {
      const pause = units[i].startMs - units[i - 1].startMs > pauseMs;
      const tooLong = length + 1 + word.length > maxChars;
      const speakerChange = Number.isInteger(units[i].speaker) && Number.isInteger(units[i - 1].speaker) &&
        units[i].speaker !== units[i - 1].speaker;
      if (pause || tooLong || speakerChange) {
        lines.push({ from, to: i - 1, text: wordsText(units, from, i - 1) });
        from = i;
      }
    }
    length = (i === from ? 0 : length + 1) + word.length;
  }
  lines.push({ from, to: units.length - 1, text: wordsText(units, from, units.length - 1) });

  return buildCues(units, lines, mode, human);
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
function applyResult(chunk, modelLines, { mode = "clean", human = false } = {}) {
  if (!chunk.length) return [];
  const translate = mode === "translate-ko";
  const labelled = translate && chunk.some((unit) => Number.isInteger(unit.speaker));
  let usable = modelLines;
  if (!coversChunk(chunk.length, modelLines)) {
    // Translations keep their text when the line ranges are only slightly off; cleaning must match exactly.
    usable = translate ? repairLines(chunk.length, modelLines) : null;
    if (!usable) return fallbackSegment(chunk, { mode, human });
  }

  const lines = usable.map((line) => {
    const original = wordsText(chunk, line.from, line.to);
    if (translate) {
      const translated = (labelled ? line.text.replace(ECHOED_LABEL, "") : line.text).trim();
      return { from: line.from, to: line.to, text: translated || original };
    }
    const same = normalize(line.text) === normalize(original);
    return { from: line.from, to: line.to, text: same ? line.text.trim() : original };
  });
  return buildCues(chunk, translate ? mergeDanglingEndings(chunk, lines) : lines, mode, human);
}

(globalThis.LakomicsYouTube ??= {}).cues = { fallbackSegment, coverageProblem, repairLines, applyResult };
})();
