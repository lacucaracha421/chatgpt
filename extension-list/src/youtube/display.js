// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Pure display limits, shared by model, repaired and fallback cue construction.
const MAX_MS = 7000;
const length = (text) => Array.from(text).length;
const limit = (text) => /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? 44 : 84;

function parts(text, maxChars) {
  const chars = Array.from(text.trim());
  const out = [];
  while (chars.length > maxChars) {
    let cut = maxChars;
    // Prefer a sentence/clause end, then a word boundary; hard cut unspaced CJK/long tokens.
    for (const boundary of [/[.!?。！？,，;；:：、]/u, /\s/u]) {
      let found = 0;
      for (let i = Math.floor(maxChars / 3); i < maxChars; i++) {
        if (boundary.test(chars[i])) found = i + 1;
      }
      if (found) { cut = found; break; }
    }
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

function splitDisplayCues(cues) {
  return cues.flatMap((cue) => {
    const duration = cue.endMs - cue.startMs;
    const textLength = length(cue.text);
    const origLength = typeof cue.orig === "string" ? length(cue.orig) : 0;
    const count = Math.max(1, Math.ceil(duration / MAX_MS), Math.ceil(textLength / limit(cue.text)),
      origLength ? Math.ceil(origLength / limit(cue.orig)) : 1);
    if (count === 1 || duration <= 0 || !textLength) return [cue];
    const budget = Math.max(1, Math.min(limit(cue.text), Math.floor(textLength / count)));
    const texts = parts(cue.text, budget);
    const textTotal = texts.reduce((sum, part) => sum + length(part), 0);
    // A very short utterance held for a long time still gets bounded display intervals.
    const weighted = texts.flatMap((text) => {
      const span = duration * length(text) / textTotal;
      const intervals = Math.max(1, Math.ceil(span / MAX_MS));
      return Array.from({ length: intervals }, () => ({ text, weight: length(text) / intervals }));
    });
    while (weighted.length < count) {
      const index = weighted.reduce((best, part, i) => part.weight > weighted[best].weight ? i : best, 0);
      const part = weighted[index];
      weighted.splice(index, 1, { text: part.text, weight: part.weight / 2 }, { text: part.text, weight: part.weight / 2 });
    }
    const originals = origLength ? originalParts(cue.orig, weighted.length) : null;
    const total = weighted.reduce((sum, part) => sum + part.weight, 0);
    let elapsed = 0;
    return weighted.map((part, index) => {
      const startMs = cue.startMs + duration * elapsed / total;
      elapsed += part.weight;
      const { orig, ...base } = cue;
      return { ...base, startMs, endMs: index === weighted.length - 1 ? cue.endMs : cue.startMs + duration * elapsed / total,
        text: part.text, ...(origLength && (originals || index === 0) ? { orig: originals ? originals[index] : orig } : {}) };
    });
  });
}

(globalThis.LakomicsYouTube ??= {}).display = { splitDisplayCues };
})();
