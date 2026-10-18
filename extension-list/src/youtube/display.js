// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
const MAX_MS = 7000;
const length = text => Array.from(text).length;
const isDigit = char => char !== undefined && /\p{Nd}/u.test(char);
const limit = text => /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? 44 : 84;

function parts(text, maxChars) {
  const chars = Array.from(text.trim());
  const out = [];
  while (chars.length > maxChars) {
    let cut = maxChars;
    for (const boundary of [/[.!?。！？,，;；:：、]/u, /\s/u]) {
      let found = 0;
      for (let i = Math.floor(maxChars / 3); i < maxChars; i++) {
        if (!boundary.test(chars[i])) continue;
        if (/[.,:，]/u.test(chars[i]) && isDigit(chars[i - 1]) && isDigit(chars[i + 1])) continue;
        found = i + 1;
      }
      if (found) { cut = found; break; }
    }
    out.push(chars.splice(0, cut).join("").trim());
    while (chars.length && /\s/u.test(chars[0])) chars.shift();
  }
  if (chars.length) out.push(chars.join(""));
  return out.filter(Boolean);
}

function splitDisplayCues(cues) {
  return cues.flatMap(cue => {
    const { wordStarts, wordChars, ...plain } = cue;
    // A translation is fitted to its source slot before display. Layout wraps the text;
    // Korean length and display duration cannot invent a speech boundary.
    if (typeof cue.orig === "string") return [plain];
    const duration = cue.endMs - cue.startMs;
    const size = length(cue.text);
    if (duration <= 0 || !size) return [plain];
    const count = Math.max(1, Math.ceil(duration / MAX_MS), Math.ceil(size / limit(cue.text)));
    const budget = Math.max(1, Math.min(limit(cue.text), Math.floor(size / count)));
    const texts = parts(cue.text, budget);
    // A short utterance with a long source interval stays one cue, never repeated copies.
    if (texts.length === 1) return [plain];
    const total = texts.reduce((sum, text) => sum + length(text), 0);
    let elapsed = 0;
    return texts.map((text, index) => {
      const startMs = cue.startMs + duration * elapsed / total;
      elapsed += length(text);
      return { ...plain, startMs,
        endMs: index === texts.length - 1 ? cue.endMs : cue.startMs + duration * elapsed / total, text };
    });
  });
}

(globalThis.LakomicsYouTube ??= {}).display = { splitDisplayCues, MAX_MS };
})();
