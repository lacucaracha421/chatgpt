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

// The PC's recognition labels who speaks (unit.speaker, 0 for the first voice found in the audio); the prompt shows
// that as [S1], [S2] ... in front of a word. Speakers are numbered from 1 there.
const speakerLabel = (speaker) => `[S${speaker + 1}]`;
const hasSpeaker = (unit) => Boolean(unit) && Number.isInteger(unit.speaker);
const hasSpeakers = (units) => Array.isArray(units) && units.some(hasSpeaker);

// "0\t안녕하세요\n1\t여러분..." with indices local to the chunk; with labels: "0\t[S2] 안녕하세요".
// With context words, they come first in a clearly separated block the model must not translate or number;
// with following words, a second such block comes after the list.
function buildPrompt(chunk, context = [], following = [], { labels = false } = {}) {
  const list = chunk.map((unit, i) => `${i}\t${labels && hasSpeaker(unit) ? `${speakerLabel(unit.speaker)} ` : ""}${unit.text}`).join("\n");
  const before = Array.isArray(context) && context.length > 0;
  const after = Array.isArray(following) && following.length > 0;
  if (!before && !after) return list;
  return (before ? `${CONTEXT_HEADER}\n${context.join(" ")}\n\n${LIST_HEADER}\n` : "") + list +
    (after ? `\n\n${FOLLOWING_HEADER}\n${following.join(" ")}` : "");
}

const CONTEXT_WORDS = 60;
const FOLLOWING_WORDS = 80;
const CONTEXT_HEADER = "Previous context (do not translate, not numbered):";
const FOLLOWING_HEADER = "Following context (do not translate, not numbered):";
const LIST_HEADER = "Numbered words to process:";

// Context words as plain strings. With speakers, a label string comes first and wherever the speaker changes.
function contextWords(units) {
  if (!hasSpeakers(units)) return units.map((unit) => unit.text);
  const words = [];
  let last = null;
  for (const unit of units) {
    if (hasSpeaker(unit) && unit.speaker !== last) { words.push(speakerLabel(unit.speaker)); last = unit.speaker; }
    words.push(unit.text);
  }
  return words;
}

// For every chunk, the (up to maxWords) original words right before it, as plain strings; the first
// chunk has none. Read-only context for translating small chunks.
function chunkContexts(chunks, maxWords = CONTEXT_WORDS) {
  const limit = Math.max(0, Math.floor(maxWords));
  const out = [];
  let tail = [];
  for (const chunk of chunks) {
    out.push(contextWords(tail));
    tail = limit ? tail.concat(chunk).slice(-limit) : [];
  }
  return out;
}

// For every chunk, the (up to maxWords) original words right after it, drawn across the next chunks; the last
// chunk has none. Read-only context, like chunkContexts.
function chunkFollowing(chunks, maxWords = FOLLOWING_WORDS) {
  const limit = Math.max(0, Math.floor(maxWords));
  return chunks.map((_, i) => {
    const units = [];
    for (let j = i + 1; j < chunks.length && units.length < limit; j++) {
      for (const unit of chunks[j]) {
        if (units.length >= limit) break;
        units.push(unit);
      }
    }
    return contextWords(units);
  });
}

(globalThis.LakomicsYouTube ??= {}).chunk = { chunkUnits, buildPrompt, hasSpeakers, speakerLabel, CONTEXT_WORDS, FOLLOWING_WORDS, CONTEXT_HEADER, FOLLOWING_HEADER, LIST_HEADER, chunkContexts, chunkFollowing };
})();
