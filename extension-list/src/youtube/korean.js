(() => {
  "use strict";
  (globalThis.LakomicsYouTube ??= {}).korean = {
    // Include the original whole Unicode blocks, including currently unassigned code points.
    offendingKoreanCues: cues => cues.filter(cue => globalThis.LakomicsTranslationCore.koreanProblems(cue.text).count > 0 ||
      /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(cue.text)),
  };
})();
