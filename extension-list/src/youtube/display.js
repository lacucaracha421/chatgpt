// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Pure display limits, shared by model, repaired and fallback cue construction.
const MAX_MS = 7000;
const length = (text) => Array.from(text).length;
// Leading forms that continue the previous word's predicate; a Korean line must not start with them.
const PREDICATE_TAIL = /^(?:않|못|없|있|수(?:\s|$)|거예|것(?:\s|$)|같|되고|되어|되었|되면|되지|됐|돼|하게|하고\s*말|말았|말(?:\s|$)|버렸|버리|싶었|싶)/u;
const isDigit = (char) => char !== undefined && /\p{Nd}/u.test(char);
const limit = (text) => /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? 44 : 84;

function parts(text, maxChars, korean = false) {
  const chars = Array.from(text.trim());
  const out = [];
  while (chars.length > maxChars) {
    // Korean with word boundaries must find a safe cut; otherwise retain the remainder.
    let cut = korean && /\s/u.test(chars.join("")) ? null : maxChars;
    // Prefer a sentence/clause end, then a word boundary; hard cut unspaced CJK/long tokens.
    for (const boundary of [/[.!?。！？,，;；:：、]/u, /\s/u]) {
      let found = 0;
      for (let i = korean ? 0 : Math.floor(maxChars / 3); i < maxChars; i++) {
        if (!boundary.test(chars[i])) continue;
        // 1,000 / 3.5 / 10:30 are single tokens, not clause boundaries.
        if (/[.,:，]/u.test(chars[i]) && isDigit(chars[i - 1]) && isDigit(chars[i + 1])) continue;
        const left = chars.slice(0, i + 1).join("").trim();
        const right = chars.slice(i + 1).join("").trim();
        if (korean) {
          // Keep auxiliary predicates and tiny remainders with their own sentence.
          if ([left, right].some((part) => part.split(/\s+/u).length < 2 ||
            (part.match(/\p{Script=Hangul}/gu) || []).length < 6)) continue;
          if (PREDICATE_TAIL.test(right) ||
            /(?:^|\s)(?:수|것)$/u.test(left)) continue;
        }
        found = i + 1;
      }
      if (found) { cut = found; break; }
    }
    // Keep an indivisible predicate intact even if wrapping must exceed the character limit.
    if (cut === null) break;
    out.push(chars.splice(0, cut).join("").trim());
    while (chars.length && /\s/u.test(chars[0])) chars.shift();
  }
  if (chars.length) out.push(chars.join(""));
  return out.filter(Boolean);
}

// Divide an original into the same number of pieces, retaining words where possible.
function originalParts(text, count) {
  const chars = Array.from(text.trim());
  if (chars.length < count * 2) return null;
  const out = [];
  for (let left = count; left > 1; left--) {
    const target = Math.min(limit(text), Math.ceil(chars.length / left));
    let cut = target;
    for (let i = target; i > Math.floor(target / 2); i--) {
      if (chars.length - i <= (left - 1) * limit(text) && /[\s.!?。！？,，;；、]/u.test(chars[i - 1])) { cut = i; break; }
    }
    out.push(chars.splice(0, cut).join("").trim());
  }
  out.push(chars.join("").trim());
  return out.every(Boolean) ? out : null;
}

// A fragment shorter than this is hard to read, so word-aligned cuts keep at least this much between them.
const MIN_FRAGMENT_MS = 800;

// Fragment boundary times [start, ..., end] for `weights` (one per fragment), or null to keep the plain
// proportional allocation. Each boundary takes the Korean text's cumulative share, finds the same share of
// the line's source characters (long words take longer to say, so characters follow speech better than a
// word count), and snaps to the nearest source word start that keeps every fragment between the minimum and the display maximum.
function wordAlignedBounds(cue, weights) {
  const starts = cue.wordStarts;
  if (!Array.isArray(starts) || starts.length < 2 || !starts.every(Number.isFinite)) return null;
  const chars = starts.map((_, i) => {
    const size = cue.wordChars?.[i];
    return Number.isFinite(size) && size > 0 ? size : 1;
  });
  const offsets = [];
  let sourceTotal = 0;
  for (const size of chars) { offsets.push(sourceTotal); sourceTotal += size; }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const duration = cue.endMs - cue.startMs;
  const count = weights.length;
  if (duration < count * MIN_FRAGMENT_MS) return null;
  const bounds = [cue.startMs];
  let share = 0;
  for (let j = 1; j < count; j++) {
    share += weights[j - 1];
    const wanted = sourceTotal * share / total;
    // Every fragment keeps its minimum and stays within the display maximum, here and for the rest.
    const low = Math.max(bounds[j - 1] + MIN_FRAGMENT_MS, cue.endMs - (count - j) * MAX_MS);
    const high = Math.min(bounds[j - 1] + MAX_MS, cue.endMs - (count - j) * MIN_FRAGMENT_MS);
    if (low > high) return null;
    let best = -1;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] < low || starts[i] > high) continue;
      if (best < 0 || Math.abs(offsets[i] - wanted) < Math.abs(offsets[best] - wanted)) best = i;
    }
    const proportional = cue.startMs + duration * share / total;
    bounds.push(best < 0 ? Math.min(high, Math.max(low, proportional)) : starts[best]);
  }
  bounds.push(cue.endMs);
  return bounds;
}

function splitDisplayCues(cues) {
  return cues.flatMap((cue) => {
    // Source word times only guide the split; they must never reach the caches.
    const { wordStarts, wordChars, ...stripped } = cue;
    const plain = wordStarts === undefined && wordChars === undefined ? cue : stripped;
    // Timing may merge our fragments; a second display pass must not undo that.
    if (cue.splitMerged) return [plain];
    const duration = cue.endMs - cue.startMs;
    const textLength = length(cue.text);
    const origLength = typeof cue.orig === "string" ? length(cue.orig) : 0;
    const count = Math.max(1, Math.ceil(duration / MAX_MS), Math.ceil(textLength / limit(cue.text)));
    if (count === 1 || duration <= 0 || !textLength) return [plain];
    const korean = typeof cue.orig === "string" && /\p{Script=Hangul}/u.test(cue.text);
    const budget = korean ? limit(cue.text) : Math.max(1, Math.min(limit(cue.text), Math.floor(textLength / count)));
    const texts = parts(cue.text, budget, korean);
    const textTotal = texts.reduce((sum, part) => sum + length(part), 0);
    // A very short utterance held for a long time still gets bounded display intervals.
    const weighted = texts.flatMap((text) => {
      const span = duration * length(text) / textTotal;
      const intervals = Math.max(1, Math.ceil(span / MAX_MS));
      return Array.from({ length: intervals }, () => ({ text, weight: length(text) / intervals }));
    });
    while (!korean && weighted.length < count) {
      const index = weighted.reduce((best, part, i) => part.weight > weighted[best].weight ? i : best, 0);
      const part = weighted[index];
      weighted.splice(index, 1, { text: part.text, weight: part.weight / 2 }, { text: part.text, weight: part.weight / 2 });
    }
    const originals = origLength ? originalParts(cue.orig, weighted.length) : null;
    const total = weighted.reduce((sum, part) => sum + part.weight, 0);
    const bounds = wordAlignedBounds(cue, weighted.map((part) => part.weight)) ||
      weighted.map((_, i) => cue.startMs + duration * weighted.slice(0, i).reduce((sum, part) => sum + part.weight, 0) / total)
        .concat(cue.endMs);
    // A serializable identity survives partial-result/resume storage.
    const splitLine = korean && weighted.length > 1 ? cue.splitLine || JSON.stringify([cue.startMs, cue.endMs, cue.text, cue.orig]) : null;
    return weighted.map((part, index) => {
      const { orig, ...base } = stripped;
      return { ...base, startMs: bounds[index], endMs: bounds[index + 1],
        text: part.text, ...(splitLine ? { splitLine } : {}),
        ...(origLength && (originals || index === 0) ? { orig: originals ? originals[index] : orig } : {}) };
    });
  });
}

(globalThis.LakomicsYouTube ??= {}).display = { splitDisplayCues, MAX_MS };
})();
