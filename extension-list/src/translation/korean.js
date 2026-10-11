(() => {
  "use strict";
  const core = globalThis.LakomicsTranslationCore ??= {};
  // Match supplementary Han and kana too, including half-width kana and the prolonged mark.
  const foreign = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/gu;
  core.withoutPreservedTokens = text => String(text || "")
    .replace(/https?:\/\/[^\s<>]+|www\.[^\s<>]+|\[\[LINK_\d+\]\]/gi, "")
    .replace(/(^|[^\p{L}\p{N}_])[@#][\p{L}\p{N}\p{M}_]+/gu, "$1");
  core.koreanProblems = text => {
    const leftovers = core.withoutPreservedTokens(text).match(foreign) || [];
    return { count: leftovers.length, characters: [...new Set(leftovers)].slice(0, 12).join("") };
  };
  core.qualityNote = text => `Korean Hangul only in prose: remove remaining kana/kanji/Chinese characters (${core.koreanProblems(text).characters}). Translate them naturally, without bracketed originals. Keep preserved X tokens unchanged.`;
})();
