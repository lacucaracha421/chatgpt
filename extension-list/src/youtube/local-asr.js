// Classic worker script. Talks to the PC's local speech recognition server (_tools/asr/server.py).
(() => {
"use strict";
// The content script drives the job (start, poll, fetch result) through short `youtube:asr` messages; this
// module only makes the local HTTP calls, so the worker never has to stay alive for a whole transcription.

const BASE = "http://127.0.0.1:39125";
const HEALTH_TIMEOUT_MS = 800;
const CALL_TIMEOUT_MS = 5000;
const RESULT_TIMEOUT_MS = 20000;
const MAX_JSON3 = 5 * 1024 * 1024; // what the page bridge and the worker accept for a caption track
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
const STATES = ["queued", "downloading", "transcribing", "diarizing", "done", "error"];

async function call(path, { method = "GET", body, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const response = await fetch(BASE + path, {
    method, cache: "no-store",
    headers: { "X-Lakomics-Asr": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
}

// Is the server up (and the GPU model usable)? Any failure just means "not available".
async function available() {
  try {
    const response = await call("/health", { timeoutMs: HEALTH_TIMEOUT_MS });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.ok === true;
  } catch { return false; }
}

function job(data) {
  if (!data || !STATES.includes(data.state)) return { ok: false };
  const progress = Number.isFinite(data.progress) ? Math.min(1, Math.max(0, data.progress)) : 0;
  return { ok: true, state: data.state, progress, ...(data.state === "error" ? { error: String(data.error || "").slice(0, 200) } : {}) };
}

async function start(videoId) {
  const response = await call("/jobs", { method: "POST", body: { videoId } });
  return response.ok ? job(await response.json()) : { ok: false };
}

async function status(videoId) {
  const response = await call(`/jobs/${videoId}`);
  return response.ok ? job(await response.json()) : { ok: false };
}

async function json3(videoId) {
  const response = await call(`/jobs/${videoId}/json3`, { timeoutMs: RESULT_TIMEOUT_MS });
  if (!response.ok) return { ok: false };
  const text = await response.text();
  if (!text || text.length > MAX_JSON3) return { ok: false };
  try { if (!Array.isArray(JSON.parse(text)?.events)) return { ok: false }; } catch { return { ok: false }; }
  return { ok: true, text };
}

// `youtube:asr` message from a YouTube page: { op: "health" } | { op: "start"|"status"|"json3", videoId }.
async function handle(message) {
  try {
    if (message.op === "health") return { ok: true, available: await available() };
    if (typeof message.videoId !== "string" || !VIDEO_ID.test(message.videoId)) return { ok: false, code: "invalid_request" };
    if (message.op === "start") return await start(message.videoId);
    if (message.op === "status") return await status(message.videoId);
    if (message.op === "json3") return await json3(message.videoId);
    return { ok: false, code: "invalid_request" };
  } catch { return { ok: false }; }
}

(globalThis.LakomicsYouTube ??= {}).localAsr = { BASE, available, start, status, json3, handle };
})();
