// Classic script, shared by the YouTube content script and the background worker.
(() => {
"use strict";
// When does a video get the PC's local speech recognition (Kotoba-whisper) instead of YouTube's captions?

// trackKey of every result made from the PC's recognition (`${lang}:${kind}`; never ends in `:asr`).
const TRACK_KEY = "kotoba:ja";

const baseLanguage = (lang) => String(lang || "").toLowerCase().split(/[-_]/)[0];
const isJapanese = (lang) => baseLanguage(lang) === "ja";
// A caption track made by a person (the uploader), as opposed to YouTube's automatic one.
const isHumanTrack = (track) => !track.kind || track.kind === "std" || track.kind === "standard";

const KANA = /[぀-ゟ゠-ヿｦ-ﾟ]/gu;

// A video without any caption track tells nothing about its language, so the page metadata decides:
// Japanese kana in the title, channel name and the start of the description.
function metaLooksJapanese(meta) {
  if (!meta || typeof meta !== "object") return false;
  const text = [meta.title, meta.author, String(meta.shortDescription || "").slice(0, 500)].filter((part) => typeof part === "string").join("\n");
  const kana = (text.match(KANA) || []).length;
  const letters = (text.match(/\p{L}/gu) || []).length;
  return kana >= 3 && kana / Math.max(1, letters) >= 0.15;
}

// tracks: the video's caption tracks ([{ languageCode, kind }]), or null when the player had none to tell.
// spoken: language code of YouTube's automatic track, if there is one (the spoken language).
// Human-made Japanese captions always win; otherwise Kotoba is for a video with Japanese auto-captions,
// or one without any captions whose page metadata looks Japanese.
function wantsLocalAsr({ enabled = true, tracks, spoken = null, meta = null } = {}) {
  if (enabled === false || !Array.isArray(tracks)) return false;
  if (tracks.some((track) => isHumanTrack(track) && isJapanese(track.languageCode))) return false;
  if (spoken) return isJapanese(spoken);
  return tracks.length === 0 && metaLooksJapanese(meta);
}

(globalThis.LakomicsYouTube ??= {}).asrChoice = { TRACK_KEY, isJapanese, isHumanTrack, metaLooksJapanese, wantsLocalAsr };
})();
