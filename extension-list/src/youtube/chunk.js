// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Splitting units into model-sized chunks and building the numbered word list for the prompt.

// Splits units into chunks of at most maxWords. Each cut is placed at the largest pause
// (difference between consecutive word start times) within the window where the chunk is
// between maxWords/2 and maxWords words long. On ties the later position wins.
function chunkUnits(units, maxWords = 600) {
  const limit = Math.max(1, Math.floor(maxWords));
  const minLen = Math.max(1, Math.floor(limit / 2));
  const chunks = [];
  let start = 0;

  while (units.length - start > limit) {
    let cut = start + limit;
    let bestGap = -1;
    for (let c = start + minLen; c <= start + limit; c++) {
      const gap = units[c].startMs - units[c - 1].startMs;
      if (gap >= bestGap) {
        bestGap = gap;
        cut = c;
      }
    }
    chunks.push(units.slice(start, cut));
    start = cut;
  }

  if (start < units.length) chunks.push(units.slice(start));
  return chunks;
}

// "0\t안녕하세요\n1\t여러분..." with indices local to the chunk.
// With context words, they come first in a clearly separated block the model must not translate or number.
function buildPrompt(chunk, context = []) {
  const list = chunk.map((unit, i) => `${i}\t${unit.text}`).join("\n");
  if (!Array.isArray(context) || !context.length) return list;
  return `${CONTEXT_HEADER}\n${context.join(" ")}\n\n${LIST_HEADER}\n${list}`;
}

const CONTEXT_WORDS = 60;
const CONTEXT_HEADER = "Previous context (do not translate, not numbered):";
const LIST_HEADER = "Numbered words to process:";

// For every chunk, the (up to maxWords) original words right before it, as plain strings; the first
// chunk has none. Read-only context for translating small chunks.
function chunkContexts(chunks, maxWords = CONTEXT_WORDS) {
  const limit = Math.max(0, Math.floor(maxWords));
  const out = [];
  let tail = [];
  for (const chunk of chunks) {
    out.push(tail);
    tail = limit ? tail.concat(chunk.map((unit) => unit.text)).slice(-limit) : [];
  }
  return out;
}

(globalThis.LakomicsYouTube ??= {}).chunk = { chunkUnits, buildPrompt, CONTEXT_WORDS, CONTEXT_HEADER, LIST_HEADER, chunkContexts };
})();
