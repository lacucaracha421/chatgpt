// Ported from yt-subs 089a1fd; classic worker namespace.
(() => {
"use strict";
// Parses a YouTube json3 caption track into word-like units.
//
// json3 shape: { events: [{ tStartMs, dDurationMs, aAppend?, segs?: [{ utf8, tOffsetMs? }] }] }
// Auto-generated (asr) tracks carry one seg per word with tOffsetMs relative to the event start.
// Manual tracks usually carry one seg per event; that becomes one unit per seg.
//
// Returns { units: [{ text, startMs, endMs }], endMs } where endMs of the track is the latest unit end.

// Removes sound tags such as [음악], [Music], [박수] and the music notes ♪/♫ (parentheses stay).
function stripNonSpeech(raw) {
  return String(raw)
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[♪♫]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJson3(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const events = Array.isArray(data && data.events) ? data.events : [];

  const units = [];
  const eventEnds = []; // parallel to units: event end for the last unit of an event, else null

  for (const ev of events) {
    if (!ev || ev.aAppend || !Array.isArray(ev.segs)) continue;

    const eventStart = Number(ev.tStartMs) || 0;
    const eventEnd = ev.dDurationMs != null ? eventStart + (Number(ev.dDurationMs) || 0) : null;
    const before = units.length;

    for (const seg of ev.segs) {
      const text = stripNonSpeech((seg && seg.utf8) ?? "");
      if (!text) continue;
      units.push({ text, startMs: eventStart + (Number(seg.tOffsetMs) || 0), endMs: 0 });
      eventEnds.push(null);
    }

    if (units.length > before) eventEnds[units.length - 1] = eventEnd;
  }

  let trackEnd = 0;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const next = units[i + 1];
    let end;
    if (eventEnds[i] != null) {
      // Last word of an event ends at the event end, but never later than the next word starts.
      end = next && next.startMs < eventEnds[i] ? next.startMs : eventEnds[i];
    } else {
      end = next ? next.startMs : unit.startMs;
    }
    unit.endMs = Math.max(end, unit.startMs);
    trackEnd = Math.max(trackEnd, unit.endMs);
  }

  return { units, endMs: trackEnd };
}

(globalThis.LakomicsYouTube ??= {}).parse = { parseJson3 };
})();
