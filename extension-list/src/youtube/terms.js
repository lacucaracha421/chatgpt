(() => {
  "use strict";
  const core = globalThis.LakomicsTranslationCore;
  const normalizeUserTerms = value => core.normalizeUserTerms(Array.isArray(value)
    ? value.filter(term => typeof term?.source === "string" && term.source.length <= 80 &&
      typeof term.korean === "string" && term.korean.length <= 80) : []);
  function mergeTerms(modelTerms = [], userTerms = []) {
    const merged = new Map();
    for (const term of [...normalizeUserTerms(modelTerms), ...normalizeUserTerms(userTerms)]) {
      merged.set(term.source.toLowerCase(), { ...term });
    }
    return [...merged.values()];
  }
  const normalizeGlossary = value => Array.isArray(value)
    ? [...normalizeUserTerms(value.slice(0, 200)), ...normalizeUserTerms(value.slice(200, 240))] : [];
  (globalThis.LakomicsYouTube ??= {}).terms = {
    normalizeUserTerms, normalizeGlossary, mergeTerms, parseUserTerms: core.parseUserTerms,
    termsForTranscript: (terms, text) => core.termsForText(normalizeUserTerms(terms), text),
  };
})();
