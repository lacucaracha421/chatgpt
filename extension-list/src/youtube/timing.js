// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Pure timing polish for cues sorted by start with non-overlapping source timings.
function readingTime(text) {
  return Math.min(3000, Math.max(1000, 55 * Array.from(text.replace(/\s/gu, "")).length));
}

function polishTimings(cues) {
  const merged = cues.map((cue) => ({ ...cue }));
  for (let i = 0; i < merged.length; i++) {
    const cue = merged[i];
    const next = merged[i + 1];
    if (!cue.splitLine || (next?.startMs ?? Infinity) - cue.startMs >= readingTime(cue.text)) continue;
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
  return merged.map((cue, index) => {
    const nextStart = merged[index + 1]?.startMs ?? Infinity;
    const minimum = readingTime(cue.text);
    const gap = nextStart - cue.endMs;
    const target = gap >= 0 && gap < 400 ? nextStart : cue.startMs + minimum;
    const endMs = Math.max(cue.endMs, Math.min(target, nextStart));
    return { ...cue, endMs };
  });
}

(globalThis.LakomicsYouTube ??= {}).timing = { polishTimings, readingTime };
})();
