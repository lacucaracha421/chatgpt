// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Deciding how a caption track is processed.

const MODE_CLEAN = "clean";
const MODE_TRANSLATE_KO = "translate-ko";

// trackKey is `${lang}:${kind}`. Korean tracks are only cleaned; other languages are translated
// into Korean unless translation is switched off (translate === false).
function modeForTrack(trackKey, translate = true) {
  const lang = String(trackKey || "").split(":")[0].toLowerCase();
  if (lang === "ko" || lang.startsWith("ko-")) return MODE_CLEAN;
  return translate === false ? MODE_CLEAN : MODE_TRANSLATE_KO;
}

const REGISTER_SETTINGS = ["auto", "haeyo", "hapnida", "banmal"];

function normalizeRegisterSetting(value) {
  return REGISTER_SETTINGS.includes(value) ? value : "auto";
}

// Mode string used in cache keys and the index: translations are stored per register setting so
// changing the setting produces a fresh result. Clean mode does not depend on it.
// Speaker marks use a separate cache; with them off, existing mode strings stay unchanged.
// Callers pass the effective glossarySonnet flag (false when disabled); it affects translations only.
function storageMode(trackKey, translate = true, registerSetting = "auto", speakers = false, glossarySonnet = false) {
  const mode = modeForTrack(trackKey, translate);
  const base = mode === MODE_TRANSLATE_KO ? `${mode}-${normalizeRegisterSetting(registerSetting)}` : mode;
  return base + (speakers ? "+spk" : "") + (mode === MODE_TRANSLATE_KO && glossarySonnet ? "+gs" : "");
}

(globalThis.LakomicsYouTube ??= {}).mode = { MODE_CLEAN, MODE_TRANSLATE_KO, modeForTrack, REGISTER_SETTINGS, normalizeRegisterSetting, storageMode };
})();
