// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Which chunk to process when, and which time range a finished chunk covers.

// Chunk indices in processing order: the chunk containing positionMs first, then the following chunks
// in order, then the earlier ones, nearest first. A chunk spans from its first word's start to the next
// chunk's first word start; a position before the first word counts as chunk 0 and one after the last as
// the last chunk.
function chunkOrder(chunks, positionMs) {
  const n = chunks.length;
  if (!n) return [];
  const position = Number.isFinite(positionMs) ? positionMs : 0;
  let current = 0;
  for (let i = 0; i < n; i++) {
    if (chunks[i].length && chunks[i][0].startMs <= position) current = i;
  }
  const order = [];
  for (let i = current; i < n; i++) order.push(i);
  for (let i = current - 1; i >= 0; i--) order.push(i);
  return order;
}

// Time range [startMs, endMs) a finished chunk covers: its first word's start up to the next chunk's
// first word start, or (final chunk) the end of its last cue.
function chunkRange(chunks, index, cues = []) {
  const chunk = chunks[index];
  const startMs = chunk[0].startMs;
  const next = chunks[index + 1];
  if (next) return { startMs, endMs: next[0].startMs };
  let endMs = chunk[chunk.length - 1].endMs;
  if (!Number.isFinite(endMs)) endMs = startMs;
  for (const cue of cues) endMs = Math.max(endMs, cue.endMs);
  return { startMs, endMs };
}

(globalThis.LakomicsYouTube ??= {}).order = { chunkOrder, chunkRange };
})();
