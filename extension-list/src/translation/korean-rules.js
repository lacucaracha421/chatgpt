(() => {
  "use strict";
  const core = globalThis.LakomicsTranslationCore ??= {};
  core.koreanRules = [
    "Output Korean in Hangul only. Write numbers with Arabic digits, never spelled out in Hangul: years, dates, times, ages, amounts, counts and measurements (1957년, 3시 20분, 25살, 5만 원). Latin letters are allowed only for brand names, acronyms and units. Preserve X URLs, [[LINK_n]] placeholders, @mentions, #hashtags and emoji exactly. Never leave Japanese kana, kanji or Chinese characters in prose, and never add the original word in brackets.",
    "Translate everyday words into the words Koreans actually use (りんごジュース → 사과 주스), instead of transliterating them.",
    "Do not render Japanese/Chinese kanji compounds by their Sino-Korean reading when that word is not common in Korean; use the natural Korean expression (風害 → 바람 피해).",
    "For proper nouns, use the spelling commonly used in Korea; otherwise transcribe by standard Korean loanword orthography.",
  ].join("\n");
})();
