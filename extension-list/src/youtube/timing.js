// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Pure timing polish for cues sorted by start with non-overlapping source timings.
function polishTimings(cues) {
  return cues.map((cue, index) => {
    const nextStart = cues[index + 1]?.startMs ?? Infinity;
    const chars = Array.from(cue.text.replace(/\s/gu, "")).length;
    const minimum = Math.min(3000, Math.max(1000, 55 * chars));
    const gap = nextStart - cue.endMs;
    const target = gap >= 0 && gap < 400 ? nextStart : cue.startMs + minimum;
    const endMs = Math.max(cue.endMs, Math.min(target, nextStart));
    return { ...cue, endMs };
  });
}

(globalThis.LakomicsYouTube ??= {}).timing = { polishTimings };
})();
