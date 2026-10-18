// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// The one display-timing policy for subtitle cues.
//
// Cues arrive from cues.js/display.js sorted by start, non-overlapping, with endMs = the end of the real
// speech of their source words. finalizeTimings decides how long each stays on screen:
//   end = max(source end, start + reading time), never past the next speech onset;
//   up to 80 ms of silence is kept before the next cue, without cutting source speech;
//   a gap of less than 1.2 s to the next cue is bridged so lines do not blink off and on;
//   short cues get at least 1.2 s when silence permits; reading extensions are bounded to 7 s.
const READING_CHARS_PER_SECOND = 12; // Korean reading speed
const MIN_READING_MS = 1200;
const MAX_READING_MS = 6000;
const MIN_DISPLAY_MS = 1000;
const SHORT_DISPLAY_MS = 300; // floor when the next cue starts too soon for MIN_DISPLAY_MS
const GUARD_MS = 80; // visible gap kept before the next cue
const BRIDGE_GAP_MS = 1200;
const FAST_READING_CHARS_PER_SECOND = 17; // fastest rate a split fragment may need before it is merged back

const countChars = (text) => Array.from(String(text).replace(/\s/gu, "")).length;

function readingTime(text) {
  return Math.min(MAX_READING_MS, Math.max(MIN_READING_MS, countChars(text) / READING_CHARS_PER_SECOND * 1000));
}

// Fragments of one translated line (same splitLine) whose share of the speech is too short to be read
// (faster than 17 characters per second, and never under the minimum display time) go back into one cue,
// next to their neighbour; fragments of different lines are never joined.
function mergeTinyFragments(cues) {
  const merged = cues.map((cue) => ({ ...cue }));
  for (let i = 0; i < merged.length; i++) {
    const cue = merged[i];
    const next = merged[i + 1];
    if (!cue.splitLine || cue.endMs - cue.startMs >=
      Math.max(MIN_DISPLAY_MS + GUARD_MS, countChars(cue.text) / FAST_READING_CHARS_PER_SECOND * 1000)) continue;
    const neighbour = next?.splitLine === cue.splitLine ? i + 1 :
      merged[i - 1]?.splitLine === cue.splitLine ? i - 1 : -1;
    if (neighbour < 0) continue;
    const first = Math.min(i, neighbour);
    const a = merged[first], b = merged[first + 1];
    merged.splice(first, 2, { ...a, endMs: b.endMs,
      text: `${a.text} ${b.text}`,
      ...((a.orig || b.orig) ? { orig: [a.orig, b.orig].filter(Boolean).join(" ") } : {}), splitMerged: true });
    i = first - 1;
  }
  return merged;
}

// nextStartMs: start of the cue that follows the last one given (the next chunk's first word), if any.
function finalizeTimings(cues, { nextStartMs = Infinity } = {}) {
  const merged = mergeTinyFragments(cues);
  const maxMs = globalThis.LakomicsYouTube.display.MAX_MS;
  return merged.map((cue, index) => {
    const next = merged[index + 1]?.startMs ?? nextStartMs;
    const speechEnd = Math.max(cue.endMs, cue.startMs);
    // Keep the guard in silence only. It must never cut off source speech.
    const cap = Math.min(next, Math.max(speechEnd, next - GUARD_MS));
    let end = Math.max(speechEnd, cue.startMs + readingTime(cue.text));
    if (cap - cue.startMs >= MIN_DISPLAY_MS) end = Math.min(end, cap);
    else end = Math.min(next, Math.max(speechEnd, cap, cue.startMs + SHORT_DISPLAY_MS));
    if (next - end < BRIDGE_GAP_MS) end = Math.max(end, Math.min(cap, cue.startMs + maxMs));
    end = Math.min(end, Math.max(speechEnd, cue.startMs + maxMs));
    const startMs = Math.round(cue.startMs);
    return { ...cue, startMs, endMs: Math.max(startMs, Math.min(Math.round(end), Math.round(next))) };
  });
}

(globalThis.LakomicsYouTube ??= {}).timing = { finalizeTimings, readingTime };
})();
