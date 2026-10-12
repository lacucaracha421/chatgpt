// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Splitting units into model-sized chunks and building the numbered word list for the prompt.

// Prefer sentence ends, then larger start-time gaps; ties go to the later cut.
// Reserve a minimum tail by rebalancing the last cut, rather than growing a request.
function chunkUnits(units, maxWords = 600) {
  const limit = Math.min(240, Math.max(1, Math.floor(maxWords) || 1));
  const minLen = Math.max(1, Math.floor(limit / 2));
  const minTail = Math.min(30, minLen);
  const sentenceEnd = /[.!?。！？…][\s"'\p{Pe}\p{Pf}]*$/u;
  const chunks = [];
  let start = 0;

  while (units.length - start > limit) {
    const lastCut = Math.min(start + limit, units.length - minTail);
    let cut = lastCut;
    let bestGap = -1;
    let bestSentenceEnd = false;
    for (let c = start + minLen; c <= lastCut; c++) {
      const gap = units[c].startMs - units[c - 1].startMs;
      const endsSentence = sentenceEnd.test(units[c - 1].text);
      if ((endsSentence && !bestSentenceEnd) ||
          (endsSentence === bestSentenceEnd && gap >= bestGap)) {
        bestSentenceEnd = endsSentence;
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
