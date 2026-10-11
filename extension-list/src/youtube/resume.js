// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Include text and end times too: identical chunk boundaries can hide a changed transcript.
function chunkSignature(chunks) {
  return JSON.stringify(chunks.map((chunk) => chunk.map(({ text, startMs, endMs }) => [text, startMs, endMs])));
}

function createResumeRecord(chunks, outcomes, glossary, register, trackKey) {
  const successful = {};
  outcomes.forEach((outcome, index) => {
    if (outcome && !outcome.failed) successful[index] = outcome.cues;
  });
  return { chunkCount: chunks.length, signature: chunkSignature(chunks), trackKey, successful, glossary, register };
}

function matchesResumeRecord(record, chunks, trackKey) {
  return Boolean(record && record.trackKey === trackKey && record.chunkCount === chunks.length &&
    (record.register === null || ["haeyo", "hapnida", "banmal"].includes(record.register)) &&
    Array.isArray(record.glossary) && record.glossary.length <= 240 && record.glossary.every((term) =>
      term && typeof term.source === "string" && term.source.trim() && term.source.length <= 80 &&
      typeof term.korean === "string" && term.korean.trim() && term.korean.length <= 80) &&
    record.signature === chunkSignature(chunks) && record.successful &&
    typeof record.successful === "object" && !Array.isArray(record.successful) &&
    Object.entries(record.successful).every(([index, cues]) =>
      /^(0|[1-9]\d*)$/.test(index) && Number(index) < chunks.length && Array.isArray(cues) && cues.length > 0 &&
      cues.every((cue) => cue && Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs) &&
        cue.endMs >= cue.startMs && typeof cue.text === "string")));
}

(globalThis.LakomicsYouTube ??= {}).resume = { chunkSignature, createResumeRecord, matchesResumeRecord };
})();
