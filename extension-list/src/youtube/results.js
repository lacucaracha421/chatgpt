// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
const { REGISTERS } = globalThis.LakomicsYouTube.prompts;
const { normalizeUserTerms } = globalThis.LakomicsYouTube.terms;

function apiError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

function validateChunk(parsed, usage) {
  if (!parsed || !Array.isArray(parsed.lines)) throw apiError("모델 응답 형식이 올바르지 않아요.", { usage });
  return { lines: parsed.lines, register: REGISTERS.includes(parsed.register) ? parsed.register : null, usage };
}

function validateGlossary(parsed, usage) {
  if (!parsed || !REGISTERS.includes(parsed.register) || !Array.isArray(parsed.terms) || parsed.terms.length > 40 ||
      parsed.terms.some((term) => !term || typeof term.source !== "string" || !term.source.trim() ||
        typeof term.korean !== "string" || !term.korean.trim())) {
    throw apiError("용어집 응답 형식이 올바르지 않아요.", { usage });
  }
  return { register: parsed.register, terms: normalizeUserTerms(parsed.terms), usage };
}

(globalThis.LakomicsYouTube ??= {}).results = { apiError, validateChunk, validateGlossary };
})();
