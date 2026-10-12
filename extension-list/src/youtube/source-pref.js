// Classic script, shared by the YouTube content script and the background worker.
(() => {
"use strict";
// Which caption source the user chose for one video when re-translating it: "kotoba" (the PC's recognition)
// or "youtube" (YouTube's own track). One small entry per video in extension storage, newest last in a bounded
// order list; the oldest entries are dropped past LIMIT. A video without an entry keeps the automatic choice.

const PREFIX = "lakomics:youtube:source:";
const ORDER_KEY = `${PREFIX}order`; // not a video key: video ids here are at least 6 characters
const LIMIT = 500;
const SOURCES = ["kotoba", "youtube"];
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

const keyFor = (videoId) => `${PREFIX}${videoId}`;

// "kotoba" | "youtube" | null (no choice, an unreadable entry or unavailable storage).
async function get(videoId) {
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) return null;
  try {
    const value = (await chrome.storage.local.get(keyFor(videoId)))?.[keyFor(videoId)];
    return SOURCES.includes(value) ? value : null;
  } catch { return null; }
}

// Stores the choice and moves the video to the newest end; false when it could not be stored.
async function set(videoId, source) {
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId) || !SOURCES.includes(source)) return false;
  try {
    const stored = (await chrome.storage.local.get(ORDER_KEY))?.[ORDER_KEY];
    const order = (Array.isArray(stored) ? stored : []).filter((id) => typeof id === "string" && VIDEO_ID.test(id) && id !== videoId);
    order.push(videoId);
    const dropped = order.splice(0, Math.max(0, order.length - LIMIT));
    await chrome.storage.local.set({ [keyFor(videoId)]: source, [ORDER_KEY]: order });
    if (dropped.length) await chrome.storage.local.remove(dropped.map(keyFor));
    return true;
  } catch { return false; }
}

(globalThis.LakomicsYouTube ??= {}).sourcePref = { PREFIX, ORDER_KEY, LIMIT, SOURCES, get, set };
})();
