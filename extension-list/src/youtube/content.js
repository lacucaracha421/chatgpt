// Isolated-world content script (classic script). Adds the player button, collects the caption
// track, asks the background worker for clean cues and shows them in an overlay.
(() => {
  "use strict";

  const TAG = "__lakomics_youtube_v1__";
  const BUSY_DELAY_MS = 400;
  const CAPTURE_WAIT_MS = 4000;
  const TOAST_MS = 4000;
  const NO_CAPTIONS = "이 영상에는 자막이 없어요";
  const PREFETCH_DELAY_MS = 2000;
  const PARTIAL_FAILURE_TEXT = "일부 구간은 정리하지 못했어요 — 다시 누르면 재시도해요";
  const RETRANSLATE_PROMPT = "이 영상 다시 번역 — 한 번 더 누르면 시작";
  const RETRANSLATE_PARTIAL_TEXT = "일부 구간을 다시 번역하지 못해서 이전 자막을 그대로 두었어요";
  const RETRANSLATE_MS = 4000; // how long the prompt waits for the second press
  const RETRANSLATE_GUARD_MS = 500; // a click right behind the long press that raised the prompt belongs to that gesture
  const RETRANSLATE_CHOICE_MS = 6000; // the source choice is a decision, so it waits longer than the single prompt
  const RETRANSLATE_HOLD_MIN_MS = 1500; // least time left once the pointer or focus leaves the choice
  const CHOICE_TITLE = "이 영상 다시 번역";
  const CHOICE_KOTOBA = "PC 받아쓰기(Kotoba)";
  const CHOICE_YOUTUBE = "YouTube 자막";
  const CHOICE_CURRENT = " · 지금"; // marks the source of the subtitles on screen
  const ASR_POLL_MS = 1500; // how often the PC's recognition progress is asked for
  const ASR_POLL_LIMIT = 8000; // polls before giving up (about 3 hours)
  const ASR_FAIL_LIMIT = 3; // failed status calls in a row that end the PC run
  const ASR_FALLBACK_TEXT = "PC 받아쓰기에 실패해서 YouTube 자막으로 번역해요";
  const ASR_FALLBACK_NO_CAPTIONS = "PC 받아쓰기에 실패했고 YouTube 자막도 없어요";

  const state = {
    token: 0, // bumped on every video change; stale async work checks it
    videoId: null,
    status: "idle", // idle | processing | ready | error
    cues: null, // sorted by startMs; while processing, only the finished parts
    ranges: [], // covered time ranges [{ startMs, endMs }], sorted and merged
    complete: false, // true once the full result is in: everything counts as covered
    fromCache: false, // the shown result came from the cache, not from a job of this page visit
    partialFailure: false, // the last result had fallback chunks: the next press retries
    prefetch: null, // { videoId, promise, metaPromise }: caption and metadata acquisition
    prefetchTimer: 0,
    showClean: false,
    error: "",
    progress: null,
    busyVisible: false,
    busyTimer: 0,
    stage: "track", // track | asr (the PC writes the captions down) | claude
    asrPercent: 0, // progress of the PC's recognition while stage is "asr"
    trackKey: null, // track the shown subtitles were made from (kotoba:ja, ja:asr, ...), once known
  };

  let button = null;
  let overlay = null;
  let toast = null;
  let toastTimer = 0;
  let choiceEl = null; // the "which source" prompt (see openRetranslatePrompt)
  let choiceKeys = false; // the Escape listener of the open choice is installed
  let lastTrackInfo = null; // { videoId, spoken, tracks } from the latest player track list
  let listenedPlayer = null;
  let resizeObserver = null;
  let lastCueIndex = -2;
  let rafId = 0;
  let retranslate = null; // the open "retranslate this video" prompt, see openRetranslatePrompt
  let enabled = true;
  let localAsrEnabled = true; // use the PC's Japanese recognition when it is running (default on)
  let stageNoticeUntil = 0; // a notice toast owns the stage line until then
  let settingsReady = false;
  let standaloneLogged = false;
  const enabledKey = "lakomics:youtube:settings:enabled";
  const localAsrKey = "lakomics:youtube:settings:localAsr";

  function standalonePresent() {
    if (!document.getElementById("ytsf-button")) return false;
    if (!standaloneLogged) {
      standaloneLogged = true;
      console.info("[Lakomics YouTube] standalone 자막다듬이 detected; skipping our UI");
    }
    return true;
  }
  function available() { return enabled && !standalonePresent(); }
  function removeUi() {
    state.token++;
    clearTimeout(state.busyTimer);
    clearTimeout(state.prefetchTimer);
    clearTimeout(toastTimer);
    clearRetranslate();
    state.status = "idle";
    state.cues = null;
    state.showClean = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    getPlayer()?.classList.remove("lakomics-yt-active");
    button?.remove(); overlay?.remove(); toast?.remove(); choiceEl?.remove();
    button = overlay = toast = choiceEl = null;
  }

  const appearance = { fontScale: 1, position: "default", showOriginal: false, rolling: false, speakerColors: true };
  const appearanceKeys = ["lakomics:youtube:settings:fontScale", "lakomics:youtube:settings:position",
    "lakomics:youtube:settings:showOriginal", "lakomics:youtube:settings:rolling", "lakomics:youtube:settings:speakerColors"];
  const changedAppearanceKeys = new Set();

  function setAppearance(key, value) {
    if (key === "lakomics:youtube:settings:fontScale") {
      appearance.fontScale = [0.85, 1, 1.15, 1.3].includes(value) ? value : 1;
    } else if (key === "lakomics:youtube:settings:position") {
      appearance.position = value === "raised" ? "raised" : "default";
    } else if (key === "lakomics:youtube:settings:showOriginal") {
      appearance.showOriginal = value === true;
    } else if (key === "lakomics:youtube:settings:rolling") {
      appearance.rolling = value === true; // off unless explicitly turned on (user, 2026-10-12)
    } else if (key === "lakomics:youtube:settings:speakerColors") {
      appearance.speakerColors = value !== false; // on unless explicitly turned off
    }
  }

  function applyAppearance(instant = true) {
    if (!overlay) return;
    overlay.style.setProperty("--lakomics-yt-scale", String(appearance.fontScale));
    overlay.style.setProperty("--lakomics-yt-raise", appearance.position === "raised" ? "0.06" : "0");
    lastCueIndex = -2;
    rolling = null; // lines are rebuilt, so font, position and original-text changes apply to them too
    instantRender = instant; // a setting change redraws the line in place, without the entrance fade
    try { sync(); } finally { instantRender = false; }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Object.hasOwn(changes, enabledKey)) {
      changedAppearanceKeys.add(enabledKey);
      enabled = changes[enabledKey].newValue !== false;
      if (!available()) removeUi();
      else if (settingsReady) { resetForVideo(currentVideoId()); ensureUi(); }
    }
    if (Object.hasOwn(changes, localAsrKey)) {
      changedAppearanceKeys.add(localAsrKey);
      localAsrEnabled = changes[localAsrKey].newValue !== false;
    }
    if (Object.hasOwn(changes, "lakomics:youtube:cache:clearGeneration")) {
      if (available() && settingsReady) resetForVideo(currentVideoId());
    }
    let changed = false;
    for (const key of appearanceKeys) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
      changedAppearanceKeys.add(key);
      setAppearance(key, changes[key].newValue);
      changed = true;
    }
    if (changed) applyAppearance();
  });

  const initialSettings = chrome.storage.local.get([...appearanceKeys, enabledKey, localAsrKey]).then((stored) => {
    if (!changedAppearanceKeys.has(enabledKey)) enabled = stored[enabledKey] !== false;
    if (!changedAppearanceKeys.has(localAsrKey)) localAsrEnabled = stored[localAsrKey] !== false;
    for (const key of appearanceKeys) {
      // A live change received during the initial read takes precedence.
      if (!changedAppearanceKeys.has(key)) setAppearance(key, stored[key]);
    }
    applyAppearance();
  }).catch(() => {
    // Keep defaults if the extension storage is unavailable.
  });

  class UserError extends Error {}

  // ---------------------------------------------------------------- page bridge

  const MAX_TEXT = 5 * 1024 * 1024;
  const replyTypes = { getTracks: "tracks", getMeta: "meta", fetchText: "fetchResult", getRecent: "recent" };
  const boundedString = (value, max) => typeof value === "string" && value.length <= max;
  const YOUTUBE_ORIGINS = ["https://www.youtube.com", "https://m.youtube.com"];
  function allowedUrl(value) {
    if (!boundedString(value, 8192)) return false;
    try {
      const url = new URL(value);
      return YOUTUBE_ORIGINS.includes(url.origin) && !url.username && !url.password && !url.hash && url.pathname === "/api/timedtext";
    } catch { return false; }
  }
  function validReply(type, data) {
    if (data.type !== replyTypes[type]) return false;
    if (type === "fetchText") return typeof data.ok === "boolean" && boundedString(data.text, MAX_TEXT) && (!data.ok || isJson3(data.text));
    if (type === "getRecent") {
      if (!Array.isArray(data.items) || data.items.length > 8) return false;
      let size = 0;
      data.items = data.items.filter((item) => {
        if (!item || !allowedUrl(item.url) || !boundedString(item.text, MAX_TEXT) || size + item.text.length > MAX_TEXT) return false;
        size += item.text.length;
        return true;
      }).map(({ url, text }) => ({ url, text }));
      return true;
    }
    if (type === "getTracks") {
      if (!(data.videoId === null || boundedString(data.videoId, 100)) || !Array.isArray(data.tracks) || data.tracks.length > 100) return false;
      data.tracks = data.tracks.filter((track) => track && allowedUrl(track.baseUrl) && boundedString(track.languageCode, 80) && track.languageCode.length > 0 &&
        (track.kind == null || boundedString(track.kind, 80))).map(({ baseUrl, languageCode, kind, isDefault }) =>
          ({ baseUrl, languageCode, kind, isDefault: isDefault === true }));
      return true;
    }
    if (type === "getMeta") {
      const meta = data.meta;
      return meta === null || (meta && boundedString(meta.videoId, 100) && boundedString(meta.title, 1000) &&
        boundedString(meta.author, 500) && boundedString(meta.shortDescription, 10000) &&
        Array.isArray(meta.keywords) && meta.keywords.length <= 100 && meta.keywords.every((word) => boundedString(word, 500)));
    }
    return false;
  }
  const pendingReplies = new Map();
  const captured = new Map(); // videoId -> Map(trackKey -> { url, text, at })
  const capturedUrls = new Map(); // videoId -> latest validated URL, including translated captures
  const sourceFetches = new Map(); // source URL -> bounded refetch promise
  const captureWaiters = new Set();

  function askPage(type, payload, timeoutMs = 1000) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pendingReplies.delete(id);
        resolve(null);
      }, timeoutMs);
      pendingReplies.set(id, { type, resolve: (reply) => {
        clearTimeout(timer);
        resolve(reply);
      } });
      window.postMessage({ tag: TAG, dir: "toPage", type, id, ...payload }, window.location.origin);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.tag !== TAG || data.dir !== "toIso") return;
    if (data.type === "timedtext") {
      onCaptured(data.url, data.text);
    } else if (data.id && pendingReplies.has(data.id)) {
      const pending = pendingReplies.get(data.id);
      if (data.type !== replyTypes[pending.type]) return;
      const valid = validReply(pending.type, data);
      pendingReplies.delete(data.id);
      pending.resolve(valid ? data : null);
    }
  });

  function trackKeyFromParams(params) {
    return `${params.get("lang") || "und"}:${params.get("kind") || "std"}`;
  }

  function onCaptured(url, text) {
    if (!allowedUrl(url) || !boundedString(text, MAX_TEXT)) return;
    let params;
    try {
      params = new URL(url).searchParams;
    } catch {
      return;
    }
    const videoId = params.get("v");
    if (!boundedString(videoId, 100) || !videoId) return;
    capturedUrls.set(videoId, url);
    while (capturedUrls.size > 8) capturedUrls.delete(capturedUrls.keys().next().value);
    if (params.has("tlang")) {
      const sourceUrl = withJson3Format(url);
      if (!sourceFetches.has(sourceUrl) && sourceFetches.size < 8) {
        const pending = fetchJson3(sourceUrl).then((sourceText) => {
          if (sourceText) onCaptured(sourceUrl, sourceText);
        }).finally(() => sourceFetches.delete(sourceUrl));
        sourceFetches.set(sourceUrl, pending);
      }
      return sourceFetches.get(sourceUrl);
    }

    if (!captured.has(videoId)) captured.set(videoId, new Map());
    captured.get(videoId).set(trackKeyFromParams(params), { url, text, at: Date.now() });
    while (captured.size > 8) captured.delete(captured.keys().next().value);
    const tracks = captured.get(videoId);
    while (tracks.size > 8) tracks.delete(tracks.keys().next().value);
    // Keep at most one bridge budget across all captured tracks/videos.
    const size = () => [...captured.values()].reduce((sum, entries) =>
      sum + [...entries.values()].reduce((total, entry) => total + entry.text.length, 0), 0);
    while (size() > MAX_TEXT) {
      const firstVideo = captured.keys().next().value;
      const firstTracks = captured.get(firstVideo);
      firstTracks.delete(firstTracks.keys().next().value);
      if (!firstTracks.size) captured.delete(firstVideo);
    }
    console.info("[Lakomics YouTube] capture stored", videoId, isJson3(text));
    for (const waiter of captureWaiters) waiter(videoId);
  }

  // Prefers the auto-generated (asr) track, otherwise the most recently captured one.
  function pickCaptured(videoId) {
    const tracks = captured.get(videoId);
    if (!tracks || !tracks.size) return null;
    let best = null;
    for (const [trackKey, entry] of tracks) {
      const candidate = { trackKey, ...entry };
      const asr = trackKey.endsWith(":asr");
      if (!best || (asr && !best.trackKey.endsWith(":asr")) || (asr === best.trackKey.endsWith(":asr") && entry.at > best.at)) {
        best = candidate;
      }
    }
    return best;
  }

  function waitForCapture(videoId, timeoutMs) {
    return new Promise((resolve) => {
      let timer = 0;
      const waiter = (id) => {
        if (id !== videoId) return;
        captureWaiters.delete(waiter);
        clearTimeout(timer);
        resolve(pickCaptured(videoId));
      };
      timer = setTimeout(() => {
        captureWaiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      captureWaiters.add(waiter);
    });
  }

  function isJson3(text) {
    try {
      const data = JSON.parse(text);
      return Array.isArray(data && data.events);
    } catch {
      return false;
    }
  }

  function withJson3Format(url) {
    const u = new URL(url, window.location.href);
    u.searchParams.delete("tlang");
    u.searchParams.set("fmt", "json3");
    return u.href;
  }

  async function fetchJson3(url) {
    if (!allowedUrl(url)) return "";
    console.info("[Lakomics YouTube] json3 refetch start");
    const reply = await askPage("fetchText", { url: withJson3Format(url) }, 2500);
    console.info("[Lakomics YouTube] json3 refetch end", Boolean(reply?.ok));
    return reply && reply.ok && isJson3(reply.text) ? reply.text : "";
  }

  function chosenKey(track) {
    return `${track.languageCode}:${track.kind || "std"}`;
  }

  function trackUrl(url, track) {
    if (!allowedUrl(url)) return null;
    const u = new URL(url);
    u.searchParams.set("lang", track.languageCode);
    if (track.kind) u.searchParams.set("kind", track.kind);
    else u.searchParams.delete("kind");
    u.searchParams.delete("tlang");
    u.searchParams.delete("name");
    u.searchParams.set("fmt", "json3");
    return allowedUrl(u.href) ? u.href : null;
  }

  async function getTrackChoice(videoId) {
    console.info("[Lakomics YouTube] track list start", videoId);
    const reply = await askPage("getTracks", {});
    if (!reply || reply.videoId !== videoId) return { spoken: null, track: null, tracks: null };
    const tracks = reply.tracks.filter((t) => new URL(t.baseUrl).searchParams.get("v") === videoId);
    lastTrackInfo = { videoId, spoken: tracks.find((t) => t.kind === "asr")?.languageCode || null, tracks };
    const asr = tracks.find((t) => t.kind === "asr");
    const uploader = (t) => !t.kind || t.kind === "std" || t.kind === "standard";
    const baseLanguage = (lang) => lang.toLowerCase().split("-")[0];
    const spoken = asr?.languageCode || null;
    const track = asr
      ? tracks.find((t) => uploader(t) && baseLanguage(t.languageCode) === baseLanguage(spoken)) || asr
      : tracks.find((t) => uploader(t) && t.isDefault) || tracks.find(uploader) || tracks[0];
    return { spoken, track: track || null, tracks };
  }

  function trackResult(choice, trackKey, text, source) {
    console.info("[Lakomics YouTube] track choice", { spoken: choice.spoken, chosen: trackKey, source });
    return { trackKey, text };
  }

  // Reuse the chosen capture, then try a captured URL's tokens, then the player baseUrl.
  async function fromCaptionTracks(videoId, choice) {
    choice = choice || await getTrackChoice(videoId);
    if (!choice.track) return null;
    const key = chosenKey(choice.track);
    const entry = captured.get(videoId)?.get(key);
    if (entry && isJson3(entry.text)) return trackResult(choice, key, entry.text, "captured");
    const seed = entry?.url || capturedUrls.get(videoId);
    const urls = [seed && trackUrl(seed, choice.track), withJson3Format(choice.track.baseUrl)];
    for (let i = 0; i < urls.length; i++) {
      if (!urls[i]) continue;
      const text = await fetchJson3(urls[i]);
      if (!text) continue;
      onCaptured(urls[i], text);
      return trackResult(choice, key, text, i === 0 ? "rewritten" : "captionTracks");
    }
    return null;
  }

  async function capturedResult(videoId, choice, source) {
    const found = pickCaptured(videoId);
    if (!found) return null;
    const text = isJson3(found.text) ? found.text : await fetchJson3(found.url);
    return text ? trackResult(choice, found.trackKey, text, source) : null;
  }

  // Captions YouTube loaded before this script started listening.
  async function pullRecent() {
    console.info("[Lakomics YouTube] recent start");
    const reply = await askPage("getRecent", {});
    console.info("[Lakomics YouTube] recent end", reply?.items.length || 0);
    await Promise.all(((reply && reply.items) || []).map((item) => onCaptured(item.url, item.text)));
  }

  // Desktop CC button, or the inner button of the mobile one (only if it reports its pressed state,
  // so the original state can always be restored).
  function captionToggle() {
    const desktop = document.querySelector(".ytp-subtitles-button");
    if (desktop) return desktop;
    const mobile = document.querySelector("ytm-closed-captioning-button button[aria-pressed]");
    return mobile || null;
  }

  // Fallback 2: make the player request captions (switch them on, or off and on again if they
  // were already on), then restore the original state.
  async function captureViaButton(videoId) {
    const toggle = captionToggle();
    if (!toggle) {
      console.info("[Lakomics YouTube] no subtitles button");
      return null;
    }
    console.info("[Lakomics YouTube] CC toggle start", videoId);
    const wasOn = toggle.getAttribute("aria-pressed") === "true";
    const waiting = waitForCapture(videoId, CAPTURE_WAIT_MS);
    if (wasOn) toggle.click();
    toggle.click();
    const found = await waiting;
    const isOn = toggle.getAttribute("aria-pressed") === "true";
    if (isOn !== wasOn) toggle.click();
    console.info("[Lakomics YouTube] capture via button", wasOn, Boolean(found));
    return found;
  }

  // Everything that needs no CC button toggling; a failed chosen track waits for the click fallback.
  // Resolves to { trackKey, text } or null; never throws.
  async function acquireSilently(videoId) {
    try {
      let found = pickCaptured(videoId);
      if (!found) {
        const fetching = [...sourceFetches].filter(([url]) => new URL(url).searchParams.get("v") === videoId).map(([, promise]) => promise);
        if (fetching.length) {
          await Promise.all(fetching);
          found = pickCaptured(videoId);
        }
      }
      if (!found) {
        await pullRecent();
        found = pickCaptured(videoId);
      }
      const choice = await getTrackChoice(videoId);
      if (choice.track) return await fromCaptionTracks(videoId, choice);
      return await capturedResult(videoId, choice, "captured");
    } catch (err) {
      console.info("[Lakomics YouTube] silent capture failed");
      return null;
    }
  }

  // Page metadata is optional and can add at most one second to acquisition.
  async function fetchMeta(videoId) {
    const reply = await askPage("getMeta", { videoId }, 1000);
    return reply?.meta?.videoId === videoId ? reply.meta : null;
  }

  // Started a moment after a video opens so the button press can use the result right away.
  function startPrefetch(token, videoId) {
    if (token !== state.token || state.status !== "idle" || state.cues) return;
    const metaPromise = fetchMeta(videoId);
    state.prefetch = { videoId, metaPromise, promise: acquireSilently(videoId) };
    void metaPromise.then((meta) => recheckCached(token, videoId, meta));
  }

  // Resolves to { trackKey, text } with json3 text for the current video, from YouTube's caption tracks.
  async function acquireCaptionTrack(videoId) {
    const silent = state.prefetch?.videoId === videoId
      ? await state.prefetch.promise : await acquireSilently(videoId);
    if (silent) return silent;

    if (currentVideoId() !== videoId || state.videoId !== videoId) throw new UserError("영상이 변경됐어요");
    const found = await captureViaButton(videoId);
    if (currentVideoId() !== videoId || state.videoId !== videoId) throw new UserError("영상이 변경됐어요");
    const choice = await getTrackChoice(videoId);
    const chosen = await fromCaptionTracks(videoId, choice);
    if (currentVideoId() !== videoId || state.videoId !== videoId) throw new UserError("영상이 변경됐어요");
    if (chosen) return chosen;
    const fallback = await capturedResult(videoId, choice, "capture-fallback");
    if (fallback) return fallback;
    if (!found) throw new UserError(NO_CAPTIONS);
    throw new UserError("자막을 불러오지 못했어요");
  }

  // ---------------------------------------------------------------- the PC's Japanese recognition (Kotoba)

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // One call to the PC server through the worker. Null on any failure; only a stale extension is an error.
  async function askLocalAsr(message) {
    try {
      return await sendToBackground({ type: "youtube:asr", ...message });
    } catch (err) {
      if (err instanceof UserError) throw err;
      return null;
    }
  }

  function setAsrPercent(progress) {
    const percent = Math.min(99, Math.max(0, Math.round((Number(progress) || 0) * 100)));
    if (percent === state.asrPercent) return;
    state.asrPercent = percent;
    renderButton();
    showStage();
  }

  // Starts (or joins) the PC's job for this video, follows its progress and returns the finished json3 text.
  // A failed job, an unreachable server or a missing result throws a plain Error; a changed video throws UserError.
  async function runLocalAsr(videoId, token) {
    const stale = () => token !== state.token || currentVideoId() !== videoId || state.videoId !== videoId;
    const changed = () => new UserError("영상이 변경됐어요");
    state.stage = "asr";
    state.asrPercent = 0;
    renderButton();
    showStage();
    let job = await askLocalAsr({ op: "start", videoId });
    if (!job?.ok) throw new Error("PC recognition did not start");
    let failures = 0;
    for (let polls = 0; job.state !== "done"; polls++) {
      if (stale()) throw changed();
      if (job.state === "error") throw new Error(job.error || "PC recognition failed");
      if (polls >= ASR_POLL_LIMIT) throw new Error("PC recognition took too long");
      setAsrPercent(job.progress);
      await sleep(ASR_POLL_MS);
      if (stale()) throw changed();
      const next = await askLocalAsr({ op: "status", videoId });
      if (next?.ok) { job = next; failures = 0; }
      else if (++failures >= ASR_FAIL_LIMIT) throw new Error("PC recognition server unreachable");
    }
    const result = await askLocalAsr({ op: "json3", videoId });
    if (stale()) throw changed();
    if (!result?.ok || typeof result.text !== "string" || !isJson3(result.text)) throw new Error("PC recognition result missing");
    return result.text;
  }

  // Does this video's own caption situation call for the PC's recognition (Japanese, no human Japanese track)?
  async function wantsKotoba(videoId) {
    const choice = globalThis.LakomicsYouTube?.asrChoice;
    if (!localAsrEnabled || !choice) return false;
    const found = await getTrackChoice(videoId);
    // Without any caption track only the page metadata can tell the language.
    const meta = found.tracks && !found.tracks.length
      ? await (state.prefetch?.videoId === videoId ? state.prefetch.metaPromise : fetchMeta(videoId)) : null;
    return choice.wantsLocalAsr({ tracks: found.tracks, spoken: found.spoken, meta });
  }

  async function kotobaRunning() {
    const health = await askLocalAsr({ op: "health" });
    return Boolean(health?.ok && health.available === true);
  }

  // The user's per-video choice ("kotoba" | "youtube" | null), see source-pref.js.
  async function savedSource(videoId) {
    return (await globalThis.LakomicsYouTube?.sourcePref?.get(videoId)) || null;
  }

  // null: the PC's recognition is not wanted or not running (nothing changes for the user).
  // { track }: its result. { failed: true }: it started and then failed.
  // `source` is the source picked for this run ("kotoba" | "youtube"); without it the saved choice for the video
  // applies, and without that the automatic one.
  async function acquireLocalAsr(videoId, token, source = null) {
    const choice = globalThis.LakomicsYouTube?.asrChoice;
    if (!localAsrEnabled || !choice) return null;
    if ((source || await savedSource(videoId)) === "youtube") return null;
    if (!(await wantsKotoba(videoId))) return null;
    if (!(await kotobaRunning())) return null;
    console.info("[Lakomics YouTube] PC recognition", videoId);
    try {
      return { track: { trackKey: choice.TRACK_KEY, text: await runLocalAsr(videoId, token) } };
    } catch (err) {
      if (err instanceof UserError) throw err;
      console.warn("[Lakomics YouTube] PC recognition failed", err);
      return { failed: true };
    }
  }

  // The PC's recognition when it applies, otherwise (or when it fails) YouTube's caption track.
  function acquireTrack(videoId, source = null) {
    // Switched off (or not loaded): exactly the caption-track path, with no extra step before it.
    if (!localAsrEnabled || !globalThis.LakomicsYouTube?.asrChoice) return acquireCaptionTrack(videoId);
    return acquireTrackWithLocalAsr(videoId, source);
  }

  async function acquireTrackWithLocalAsr(videoId, source) {
    const token = state.token;
    const local = await acquireLocalAsr(videoId, token, source);
    if (local?.track) return local.track;
    if (!local?.failed) return acquireCaptionTrack(videoId);
    state.stage = "track";
    stageNoticeUntil = Date.now() + TOAST_MS;
    showToast(ASR_FALLBACK_TEXT, TOAST_MS);
    setTimeout(showStage, TOAST_MS + 50);
    try {
      return await acquireCaptionTrack(videoId);
    } catch (err) {
      if (err instanceof UserError && err.message === NO_CAPTIONS) throw new UserError(ASR_FALLBACK_NO_CAPTIONS);
      throw err;
    }
  }

  // ---------------------------------------------------------------- background messaging

  async function sendToBackground(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      if (/context invalidated/i.test(String(err && err.message))) {
        throw new UserError("확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요");
      }
      throw err;
    }
  }

  // Adds [startMs, endMs) to a sorted, merged range list and returns the new list.
  function addRange(ranges, startMs, endMs) {
    const all = [...ranges, { startMs, endMs }].sort((a, b) => a.startMs - b.startMs);
    const merged = [];
    for (const range of all) {
      const last = merged[merged.length - 1];
      if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
      else merged.push({ startMs: range.startMs, endMs: range.endMs });
    }
    return merged;
  }

  // A finished chunk: its cues replace whatever lay in its time range and the range becomes covered.
  // The first one turns the clean view on; after that the user's choice stays.
  function mergePartial(message) {
    const first = !state.cues;
    const kept = (state.cues || []).filter((c) => c.startMs < message.startMs || c.startMs >= message.endMs);
    state.cues = kept.concat(message.cues).sort((a, b) => a.startMs - b.startMs);
    state.ranges = addRange(state.ranges, message.startMs, message.endMs);
    lastCueIndex = -2;
    if (first) {
      state.showClean = true;
      applyMode();
      renderButton();
    } else applyMode();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.videoId !== state.videoId || state.status !== "processing") return;
    if (message.type === "youtube:progress") {
      state.progress = { done: message.done, total: message.total, mode: message.mode };
      renderButton();
      showStage();
    } else if (message.type === "youtube:partial" && Array.isArray(message.cues)) {
      mergePartial(message);
    }
  });

  // ---------------------------------------------------------------- player elements

  function getPlayer() {
    return document.getElementById("movie_player");
  }

  function getVideo() {
    const player = getPlayer();
    return player ? player.querySelector("video") : null;
  }

  function ensureOverlay() {
    const player = getPlayer();
    if (!player) return null;
    if (!overlay || !overlay.isConnected || overlay.parentNode !== player) {
      if (overlay) overlay.remove();
      overlay = document.createElement("div");
      overlay.id = "lakomics-yt-overlay";
      overlay.style.display = "none";
      overlay.appendChild(document.createElement("span"));
      player.appendChild(overlay);
      lastCueIndex = -2;
      applyAppearance(false);
    }
    attachPlayerListeners(player);
    updateFontSize();
    return overlay;
  }

  function updateFontSize() {
    const player = getPlayer();
    if (!player || !overlay) return;
    overlay.style.setProperty("--lakomics-yt-h", String(player.clientHeight));
  }

  function attachPlayerListeners(player) {
    if (listenedPlayer === player) return;
    listenedPlayer = player;
    // Capture phase: media events do not bubble, and this survives <video> being replaced.
    for (const name of ["play", "playing"]) player.addEventListener(name, startLoop, true);
    for (const name of ["pause", "seeked", "seeking", "timeupdate"]) player.addEventListener(name, sync, true);
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(updateFontSize);
    resizeObserver.observe(player);
    updateFontSize();
  }

  // ---------------------------------------------------------------- overlay sync

  function isActive() {
    return Boolean(state.cues && state.showClean);
  }

  function needsOverlay() {
    return isActive() || (state.status === "processing" && (!state.cues || state.showClean));
  }

  function youtubeHasText(player) {
    return [...player.querySelectorAll(".ytp-caption-window-container .ytp-caption-segment")].some((node) =>
      node.textContent.trim() && node.getClientRects().length &&
      getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).opacity !== "0");
  }

  const HOLD_GAP_MS = 300; // a gap this short between two cues never empties the overlay

  function findCue(ms) {
    const cues = state.cues;
    let lo = 0;
    let hi = cues.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].startMs <= ms) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return -1;
    if (ms < cues[found].endMs) return found;
    // Consecutive cues hand over without an empty frame: a cue stays through a gap of up to HOLD_GAP_MS
    // (timing.js leaves 80 ms before the next cue, and older caches may hold other small gaps).
    const next = cues[found + 1];
    return next && next.startMs - cues[found].endMs <= HOLD_GAP_MS ? found : -1;
  }

  function isCovered(ms) {
    if (state.complete) return true;
    return state.ranges.some((r) => r.startMs <= ms && ms < r.endMs);
  }

  // ---- Rolling two-line display (roll-up): the current cue sits in the bottom slot and the previous cue stays
  // above it until the next cue replaces it, so fast speech can still be read. Display only; cue times are untouched.
  const ROLL_GAP_MS = 1200; // previous cue ended more than this before the current one: speech resumed after silence
  const ROLL_MOVE_MS = 140;
  const ROLL_FADE_OUT_MS = 160; // the overlay fades out when it empties into silence
  let rolling = null; // { bottom, top }: lines { cue, el, role } on screen while the two-line display is active
  let instantRender = false;

  // Index of the cue to show above cue `index`, or -1. The previous cue stays for as long as the current one
  // is on screen (there is no timer: the next push replaces it); it is not shown at all when the current cue
  // starts after a silence (the previous cue ended more than 1.2 s earlier). When the current cue ends and
  // no cue follows soon, the overlay clears and both lines leave together.
  function previousLineIndex(cues, index) {
    const previous = cues[index - 1];
    const current = cues[index];
    return isDrawable(previous) && current && current.startMs - previous.endMs <= ROLL_GAP_MS ? index - 1 : -1;
  }

  function reducedMotion() {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function rectOf(node) {
    return typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
  }

  function hasText(value) {
    return typeof value === "string" && value.trim() !== "";
  }

  // A cue without any text is never drawn: an empty span would still paint its background and padding as a bar.
  function isDrawable(cue) {
    return Boolean(cue) && hasText(cue.text);
  }

  // Speaker colours (text colour only; speaker 0 keeps the default white): see content.css.
  const SPEAKER_CLASSES = ["", "lakomics-yt-spk1", "lakomics-yt-spk2"];

  // True when this cue is shown in its speaker's colour: the setting is on and the cue knows its speaker
  // (audio-based, from the PC's recognition). Such a cue never shows the "- " speaker marks.
  function speakerColored(cue) {
    return appearance.speakerColors && Number.isInteger(cue.speaker);
  }

  // One cue's text (and, for the current line, its original) inside `parent`.
  function fillCue(parent, cue, withOriginal) {
    const translation = document.createElement("span");
    const colored = speakerColored(cue);
    translation.textContent = colored ? cue.text.replace(/(^|\n)- /g, "$1") : cue.text;
    if (colored && SPEAKER_CLASSES[cue.speaker]) translation.className = SPEAKER_CLASSES[cue.speaker];
    if (withOriginal && hasText(cue.orig)) {
      const originalLine = document.createElement("div");
      originalLine.className = "lakomics-yt-orig-line";
      const original = document.createElement("span");
      original.className = "lakomics-yt-orig";
      original.textContent = cue.orig;
      originalLine.appendChild(original);
      const translationLine = document.createElement("div");
      translationLine.appendChild(translation);
      parent.replaceChildren(originalLine, translationLine);
    } else {
      parent.replaceChildren(translation);
    }
  }

  // Fades exist only at the edges of speech: a line appearing after silence fades in (lakomics-yt-in) and
  // the overlay fades out when it empties into silence. Cue changes never touch opacity.
  let fadeOut = null;

  function cancelFadeOut() {
    if (!fadeOut) return;
    const animation = fadeOut;
    fadeOut = null;
    animation.onfinish = null;
    if (typeof animation.cancel === "function") animation.cancel();
  }

  function clearOverlay(fade = false) {
    cancelFadeOut();
    rolling = null;
    if (!overlay) return;
    const finish = () => {
      overlay.replaceChildren(document.createElement("span"));
      overlay.style.display = "none";
    };
    if (fade && overlay.style.display === "block" && !instantRender && !reducedMotion() && typeof overlay.animate === "function") {
      const animation = overlay.animate({ opacity: [1, 0] }, { duration: ROLL_FADE_OUT_MS, easing: "ease-in", fill: "forwards" });
      fadeOut = animation;
      animation.onfinish = () => {
        if (fadeOut !== animation) return;
        fadeOut = null;
        finish();
        if (typeof animation.cancel === "function") animation.cancel();
      };
      return;
    }
    finish();
  }

  // Puts `topCue` (or nothing) above `bottomCue`. Lines are matched by cue start, so a line that stays keeps its
  // element: the old bottom line becomes the top line and slides up (a translate only, never an opacity change),
  // the new line takes the bottom slot at once, and a replaced top line is removed at once. Only an empty
  // overlay fades in. The bottom slot never moves: the overlay is anchored to the player by its bottom edge
  // and grows upwards. CSS clamps the top slot to one visual line.
  function renderRolling(bottomCue, topCue) {
    const prior = rolling || { bottom: null, top: null };
    const motion = !instantRender && !reducedMotion();
    const shown = Boolean(rolling) && overlay.style.display === "block";
    const before = motion && shown ? [prior.bottom, prior.top].filter(Boolean).map((line) => [line, rectOf(line.el)]) : [];
    // A line is the same line while its cue starts at the same time: a re-sent cue keeps its element, and
    // changed text is swapped in place instead of fading out and in.
    const take = (cue) => {
      const line = [prior.bottom, prior.top].find((item) => item && item.cue.startMs === cue.startMs);
      if (!line) return { cue, el: document.createElement("div"), role: "" };
      line.dirty = line.cue.text !== cue.text || line.cue.orig !== cue.orig || line.cue.speaker !== cue.speaker;
      line.cue = cue;
      return line;
    };
    const next = { bottom: take(bottomCue), top: topCue ? take(topCue) : null };
    for (const [line, role] of [[next.top, "prev"], [next.bottom, "cur"]]) {
      if (!line) continue;
      if (line.role === role && !line.dirty) continue;
      // Only an empty overlay fades in: where a line is replaced, opacity must never dip, or every cue blinks.
      const fresh = !line.role && !shown;
      fillCue(line.el, line.cue, role === "cur" && appearance.showOriginal);
      if (line.role !== role) {
        line.el.className = `lakomics-yt-line lakomics-yt-${role}${fresh && motion ? " lakomics-yt-in" : ""}`;
      }
      line.role = role;
      line.dirty = false;
    }
    const kept = [next.top, next.bottom].filter(Boolean);
    overlay.replaceChildren(...kept.map((line) => line.el));
    overlay.style.display = "block";
    rolling = next;
    for (const [line, rect] of before) {
      const el = line.el;
      if (!kept.includes(line) || !rect || typeof el.animate !== "function") continue;
      const now = rectOf(el);
      const dy = now ? rect.top - now.top : 0;
      if (Math.abs(dy) > 0.5) el.animate({ transform: [`translateY(${dy}px)`, "none"] }, { duration: ROLL_MOVE_MS, easing: "ease-out" });
    }
  }

  // Inside a covered range our cue replaces YouTube's captions; outside it YouTube's own show, so
  // nothing blanks while chunks are still being processed. The swap happens only at range boundaries.
  function sync() {
    if (!needsOverlay() || !overlay) return;
    const player = getPlayer();
    const video = getVideo();
    if (!player || !video) return;

    const ms = video.currentTime * 1000;
    const covered = isActive() && isCovered(ms);
    player.classList.toggle("lakomics-yt-active", covered);

    const ad = player.classList.contains("ad-showing");
    let index = covered && !ad ? findCue(ms) : -1;
    if (index >= 0 && !isDrawable(state.cues[index])) index = -1;
    const waiting = !covered && !ad && state.status === "processing" && state.busyVisible && !youtubeHasText(player);
    const topIndex = appearance.rolling && index >= 0 ? previousLineIndex(state.cues, index) : -1;
    const displayKey = waiting ? "waiting" : appearance.rolling ? `${index}:${topIndex}` : index;
    if (displayKey === lastCueIndex) return;
    lastCueIndex = displayKey;
    if (index >= 0 || waiting) cancelFadeOut();
    overlay.classList.toggle("lakomics-yt-waiting", waiting);
    if (waiting) {
      const note = document.createElement("span");
      note.textContent = "이 구간은 아직 처리 중이에요";
      rolling = null;
      overlay.replaceChildren(note);
      overlay.style.display = "block";
      return;
    }
    if (index < 0) {
      clearOverlay(true);
    } else if (appearance.rolling) {
      renderRolling(state.cues[index], topIndex >= 0 ? state.cues[topIndex] : null);
    } else {
      const fadeIn = overlay.style.display !== "block" && !instantRender && !reducedMotion();
      rolling = null;
      fillCue(overlay, state.cues[index], appearance.showOriginal);
      if (fadeIn) for (const child of overlay.children) child.classList.add("lakomics-yt-in");
      overlay.style.display = "block";
    }
  }

  function loop() {
    rafId = 0;
    sync();
    const video = getVideo();
    if (needsOverlay() && video && !video.paused) rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    sync();
    if (!rafId && needsOverlay() && getVideo() && !getVideo().paused) rafId = requestAnimationFrame(loop);
  }

  // Shows or hides the clean captions and YouTube's own, depending on state.
  function applyMode() {
    const player = getPlayer();
    const active = isActive();
    if (player && !active) player.classList.remove("lakomics-yt-active"); // while active, sync() decides
    if (needsOverlay()) {
      ensureOverlay();
      lastCueIndex = -2;
      startLoop();
    } else {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      clearOverlay();
      lastCueIndex = -2;
    }
  }

  // ---------------------------------------------------------------- button and toast

  // Desktop player: the right-hand control bar. Mobile (m.youtube.com): the top-right icon row.
  function findControls() {
    const desktop = document.querySelector(".ytp-right-controls");
    if (desktop) return { controls: desktop, mobile: false };
    const mobile = document.querySelector("player-top-controls .player-controls-top") ||
      document.querySelector(".player-controls-top");
    return mobile ? { controls: mobile, mobile: true } : null;
  }

  // The tap must not reach the player's own handlers (they toggle the controls).
  const TOUCH_EVENTS = ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup"];

  function ensureButton() {
    if (!settingsReady || !available()) return;
    if (button && button.isConnected) return;
    const found = findControls();
    if (!found) return;
    const { controls, mobile } = found;

    button = document.createElement("button");
    button.id = "lakomics-yt-button";
    button.className = mobile ? "lakomics-yt-mobile" : "ytp-button";
    button.type = "button";
    const icon = document.createElement("span");
    icon.className = "lakomics-yt-icon";
    icon.textContent = "AI";
    button.appendChild(icon);
    button.addEventListener("click", onButtonClick);
    button.addEventListener("contextmenu", onButtonContextMenu);

    if (mobile) {
      for (const name of TOUCH_EVENTS) button.addEventListener(name, (event) => event.stopPropagation());
      const settings = controls.querySelector(".player-settings-icon");
      const captions = controls.querySelector("ytm-closed-captioning-button");
      if (settings && settings.parentNode === controls) controls.insertBefore(button, settings);
      else if (captions && captions.parentNode === controls) captions.after(button);
      else controls.appendChild(button);
    } else {
      const settings = controls.querySelector(".ytp-settings-button");
      if (settings && settings.parentNode) settings.parentNode.insertBefore(button, settings);
      else controls.appendChild(button);
    }
    renderButton();
  }

  function renderButton() {
    if (!button) return;
    const busy = state.status === "processing" && state.busyVisible;
    button.classList.toggle("lakomics-yt-on", isActive());
    button.classList.toggle("lakomics-yt-busy", busy);
    button.classList.toggle("lakomics-yt-ready", Boolean(state.cues && !state.showClean && state.status !== "processing"));

    let tip = "AI 자막 만들기";
    if (state.status === "processing") {
      if (busy && state.stage === "asr") {
        tip = `PC 받아쓰는 중… ${state.asrPercent}%`;
      } else if (busy) {
        const p = state.progress;
        const verb = p && p.mode && p.mode.startsWith("translate") ? "번역" : "정리";
        tip = p ? `AI ${verb} 중…${p.total ? ` ${p.done}/${p.total}` : ""}` : "AI 자막 만드는 중…";
      }
    } else if (state.status === "error") {
      tip = state.error;
    } else if (state.cues) {
      tip = (state.showClean ? "원래 자막으로 보기 (Shift+A)" : "AI 자막 보기 (Shift+A)") +
        (button.classList.contains("lakomics-yt-mobile") ? " · 길게 누르기: 다시 번역" : " · 우클릭: 다시 번역");
    }
    button.title = tip;
    button.setAttribute("aria-label", tip);
  }

  // ms = 0 keeps the message up until it is replaced or hidden.
  function showToast(text, ms = TOAST_MS) {
    const player = getPlayer();
    if (!player) return;
    if (!toast || !toast.isConnected) {
      toast = document.createElement("div");
      toast.id = "lakomics-yt-toast";
      player.appendChild(toast);
    }
    toast.textContent = text;
    // Force a style flush so the fade-in transition runs on first show.
    void toast.offsetWidth;
    toast.classList.add("lakomics-yt-show");
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = setTimeout(() => toast.classList.remove("lakomics-yt-show"), ms);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toast) toast.classList.remove("lakomics-yt-show");
  }

  // While processing, the current stage stays on screen (after the busy delay).
  function stageText() {
    const p = state.progress;
    if (state.stage === "track") return "자막을 가져오는 중…";
    if (state.stage === "asr") return `PC에서 받아쓰는 중… ${state.asrPercent}%`;
    const verb = p && p.mode && p.mode.startsWith("translate") ? "번역" : "정리";
    return p && p.total > 1 ? `${verb} 중… (${p.done}/${p.total})` : `${verb} 중…`;
  }

  function showStage() {
    if (Date.now() < stageNoticeUntil) return;
    if (state.status === "processing" && state.busyVisible) showToast(stageText(), 0);
  }

  // ---------------------------------------------------------------- actions

  async function onButtonClick(event) {
    if (event.isTrusted !== true || !available()) return;
    event.preventDefault();
    event.stopPropagation();
    const urlVideoId = currentVideoId();
    if (urlVideoId !== state.videoId) resetForVideo(urlVideoId);
    console.info("[Lakomics YouTube] click", state.videoId, state.status);
    if (!state.videoId) return;
    if (retranslate) return confirmRetranslate(event); // the prompt is up: this press answers it

    if (state.status === "processing") {
      // Once the first chunk is in, the user may switch between clean and original while the rest runs.
      if (state.cues) toggleClean();
      else { state.busyVisible = true; renderButton(); showStage(); }
      return;
    }
    if (state.partialFailure) {
      // The last result had chunks that failed: pressing again tries again, with the clean view on.
      state.showClean = Boolean(state.cues);
      if (state.cues) applyMode();
      await startProcessing(event);
      return;
    }
    if (state.cues) {
      toggleClean();
      return;
    }
    await startProcessing(event);
  }

  // Right click (desktop) or long press (mobile) on the button only asks; nothing starts without a further
  // answer, otherwise the prompt fades away and costs nothing. The player's and the browser's own menus never open
  // over the button. The prompt is one of two kinds:
  //  - single: "press again to start" (a second press on the button starts the re-translation);
  //  - choice: when the PC's recognition (Kotoba) is a real option for this video, two buttons pick the caption
  //    source of the new run. The PC button waits (disabled) until the server answers, and the prompt turns into
  //    the single kind if it turns out not to be an option.
  function onButtonContextMenu(event) {
    if (event.isTrusted !== true || !available()) return;
    event.preventDefault();
    event.stopPropagation();
    const urlVideoId = currentVideoId();
    if (urlVideoId !== state.videoId) resetForVideo(urlVideoId);
    if (retranslate) return confirmRetranslate(event);
    if (!state.videoId || !state.cues || state.status === "processing") return;
    openRetranslatePrompt(state.videoId);
  }

  // true: the video's tracks already say the PC's recognition applies; false: it cannot be an option; null: not
  // known yet (no track list has been read for this video).
  function kotobaHint(videoId) {
    const choice = globalThis.LakomicsYouTube?.asrChoice;
    if (!localAsrEnabled || !choice) return false;
    const info = lastTrackInfo;
    if (!info || info.videoId !== videoId || !Array.isArray(info.tracks) || !info.tracks.length) return null;
    return choice.wantsLocalAsr({ tracks: info.tracks, spoken: info.spoken });
  }

  function openRetranslatePrompt(videoId) {
    const prompt = { armedAt: Date.now(), shownAt: 0, mode: "single", kotoba: null, timer: 0, deadline: 0, remaining: 0,
      hover: false, focus: false, paused: false, token: state.token, kotobaButton: null };
    retranslate = prompt;
    const hint = kotobaHint(videoId);
    if (hint === true) showChoice(prompt);
    else showSinglePrompt(prompt);
    if (hint !== false) void resolveKotoba(prompt, videoId);
  }

  function startPromptTimer(prompt, ms) {
    clearTimeout(prompt.timer);
    prompt.remaining = ms;
    prompt.deadline = Date.now() + ms;
    prompt.timer = setTimeout(clearRetranslate, ms);
  }

  function showSinglePrompt(prompt) {
    prompt.mode = "single";
    prompt.paused = false;
    clearTimeout(prompt.timer);
    prompt.timer = setTimeout(clearRetranslate, RETRANSLATE_MS);
    showToast(RETRANSLATE_PROMPT, RETRANSLATE_MS);
  }

  // Is the PC's recognition a real option for this video right now? Never throws.
  async function kotobaAvailable(videoId) {
    try { return (await wantsKotoba(videoId)) && (await kotobaRunning()); } catch { return false; }
  }

  async function resolveKotoba(prompt, videoId) {
    const available = await kotobaAvailable(videoId);
    if (retranslate !== prompt || prompt.token !== state.token) return;
    prompt.kotoba = available;
    if (available) {
      if (prompt.mode === "choice") { if (prompt.kotobaButton) prompt.kotobaButton.disabled = false; }
      else { clearTimeout(prompt.timer); hideToast(); showChoice(prompt); }
    } else if (prompt.mode === "choice") {
      hideChoice();
      showSinglePrompt(prompt);
    }
  }

  // "kotoba" | "youtube" | null: the source of the subtitles on screen.
  function shownSource() {
    if (!state.trackKey) return null;
    return state.trackKey === globalThis.LakomicsYouTube?.asrChoice?.TRACK_KEY ? "kotoba" : "youtube";
  }

  function showChoice(prompt) {
    const player = getPlayer();
    if (!player) return;
    if (!choiceEl || !choiceEl.isConnected) {
      choiceEl = document.createElement("div");
      choiceEl.id = "lakomics-yt-choice";
      choiceEl.setAttribute("role", "group");
      choiceEl.setAttribute("aria-label", CHOICE_TITLE);
      // Nothing inside the prompt may reach the player's own handlers (play/pause, controls, shortcuts, menu).
      for (const name of [...TOUCH_EVENTS, "click", "dblclick", "contextmenu", "keydown", "keyup"]) {
        choiceEl.addEventListener(name, (event) => event.stopPropagation());
      }
      choiceEl.addEventListener("pointerenter", () => holdPrompt("hover", true));
      choiceEl.addEventListener("pointerleave", () => holdPrompt("hover", false));
      choiceEl.addEventListener("focusin", () => holdPrompt("focus", true));
      choiceEl.addEventListener("focusout", () => holdPrompt("focus", false));
      player.appendChild(choiceEl);
    }
    choiceEl.classList.toggle("lakomics-yt-choice-mobile", Boolean(button?.classList.contains("lakomics-yt-mobile")));
    const title = document.createElement("div");
    title.textContent = CHOICE_TITLE;
    const actions = document.createElement("div");
    actions.className = "lakomics-yt-choice-actions";
    const current = shownSource();
    for (const [source, label] of [["kotoba", CHOICE_KOTOBA], ["youtube", CHOICE_YOUTUBE]]) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "lakomics-yt-choice-button";
      choice.textContent = label + (current === source ? CHOICE_CURRENT : "");
      choice.setAttribute("aria-pressed", String(current === source));
      choice.addEventListener("click", (event) => { void chooseSource(source, event); });
      if (source === "kotoba") {
        choice.disabled = prompt.kotoba !== true; // the server has not answered yet
        prompt.kotobaButton = choice;
      }
      actions.appendChild(choice);
    }
    choiceEl.replaceChildren(title, actions);
    prompt.mode = "choice";
    prompt.shownAt = Date.now();
    prompt.hover = prompt.focus = prompt.paused = false;
    // Force a style flush so the fade-in transition runs on first show.
    void choiceEl.offsetWidth;
    choiceEl.classList.add("lakomics-yt-show");
    if (!choiceKeys) { window.addEventListener("keydown", onChoiceKeydown, true); choiceKeys = true; }
    startPromptTimer(prompt, RETRANSLATE_CHOICE_MS);
  }

  function hideChoice() {
    if (choiceEl) choiceEl.classList.remove("lakomics-yt-show");
    if (choiceKeys) { window.removeEventListener("keydown", onChoiceKeydown, true); choiceKeys = false; }
  }

  // While the pointer is over the choice or focus is inside it, the timeout waits.
  function holdPrompt(kind, on) {
    const prompt = retranslate;
    if (!prompt || prompt.mode !== "choice") return;
    prompt[kind] = on;
    const hold = prompt.hover || prompt.focus;
    if (hold && !prompt.paused) {
      clearTimeout(prompt.timer);
      prompt.remaining = Math.max(RETRANSLATE_HOLD_MIN_MS, prompt.deadline - Date.now());
      prompt.paused = true;
    } else if (!hold && prompt.paused) {
      prompt.paused = false;
      startPromptTimer(prompt, prompt.remaining);
    }
  }

  function onChoiceKeydown(event) {
    if (event.key !== "Escape" || retranslate?.mode !== "choice") return;
    if (choiceEl && event.target instanceof Node && choiceEl.contains(event.target)) { event.preventDefault(); event.stopPropagation(); }
    clearRetranslate();
  }

  function clearRetranslate() {
    hideChoice();
    if (!retranslate) return;
    clearTimeout(retranslate.timer);
    retranslate = null;
  }

  // A button of the choice: starts the re-translation with that caption source and remembers it for the video.
  async function chooseSource(source, event) {
    const prompt = retranslate;
    if (event.isTrusted !== true || !prompt || prompt.mode !== "choice" || !available()) return;
    if (Date.now() - prompt.shownAt < RETRANSLATE_GUARD_MS) return;
    if (source === "kotoba" && prompt.kotoba !== true) return;
    const videoId = state.videoId;
    const wanted = Boolean(videoId && videoId === currentVideoId() && state.cues && state.status !== "processing");
    clearRetranslate();
    if (!wanted) return;
    void globalThis.LakomicsYouTube?.sourcePref?.set(videoId, source);
    await startProcessing(event, true, source);
  }

  async function confirmRetranslate(event) {
    if (Date.now() - retranslate.armedAt < RETRANSLATE_GUARD_MS) return;
    if (retranslate.mode === "choice") { clearRetranslate(); return; } // the choice is answered with its own buttons
    const wanted = Boolean(state.videoId && state.cues && state.status !== "processing");
    clearRetranslate();
    hideToast();
    if (wanted) await startProcessing(event, true);
  }

  function toggleClean() {
    state.showClean = !state.showClean;
    applyMode();
    renderButton();
  }

  window.addEventListener("keydown", (event) => {
    if (event.isTrusted !== true || !available()) return;
    if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.isComposing) return;
    // event.code so the shortcut also works while the Korean (Hangul) input mode is on.
    if (event.code !== "KeyA") return;
    const isEditing = (element) => element instanceof Element &&
      (element.matches("input, textarea, select") || element.isContentEditable);
    if (event.composedPath().some(isEditing) || isEditing(document.activeElement)) return;
    if (!state.videoId || state.videoId !== currentVideoId() || !state.cues) return;
    event.preventDefault();
    toggleClean();
  }, true);

  function currentPositionMs() {
    const video = getVideo();
    return video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) : 0;
  }

  // `fresh` makes the worker translate again instead of reusing any stored result. The old subtitles stay on
  // screen (finished chunks replace theirs one range at a time) and come back untouched if the run fails.
  // `source` ("kotoba" | "youtube") is the caption source picked in the retranslate choice for this run.
  async function startProcessing(event, fresh = false, source = null) {
    if (event?.isTrusted !== true || !available()) return;
    const token = state.token;
    const videoId = state.videoId;
    clearRetranslate();
    const before = fresh ? { cues: state.cues, ranges: state.ranges, complete: state.complete, showClean: state.showClean,
      fromCache: state.fromCache, partialFailure: state.partialFailure, status: state.status, error: state.error,
      trackKey: state.trackKey } : null;

    state.status = "processing";
    state.fromCache = false;
    state.error = "";
    state.progress = null;
    state.busyVisible = false;
    state.stage = "track";
    state.asrPercent = 0;
    stageNoticeUntil = 0;
    applyMode();
    renderButton();
    // The busy look appears only after a delay so quick results never blink it.
    state.busyTimer = setTimeout(() => {
      if (token === state.token && state.status === "processing") {
        state.busyVisible = true;
        renderButton();
        showStage();
        sync();
      }
    }, BUSY_DELAY_MS);

    try {
      const metaPromise = state.prefetch?.videoId === videoId ? state.prefetch.metaPromise : fetchMeta(videoId);
      const [track, meta] = await Promise.all([acquireTrack(videoId, source), metaPromise]);
      if (token !== state.token || currentVideoId() !== videoId) return;
      state.trackKey = track.trackKey;
      console.info("[Lakomics YouTube] track", track.trackKey, track.text.length);
      state.stage = "claude";
      showStage();
      const reply = await sendToBackground({
        type: "youtube:process",
        videoId,
        trackKey: track.trackKey,
        json3: track.text,
        meta,
        positionMs: currentPositionMs(),
        ...(fresh ? { fresh: true } : {}),
      });
      if (token !== state.token || currentVideoId() !== videoId) return;
      if (!reply || !reply.ok) throw new UserError((reply && reply.error) || "자막 정리에 실패했어요");
      // Nothing was stored for a result with fallback chunks, so the old subtitles are the better ones.
      if (fresh && reply.partialFailure) throw new UserError(RETRANSLATE_PARTIAL_TEXT);
      // Partials may already have turned the view on (and the user may have turned it off again).
      if (!state.cues) state.showClean = true;
      state.cues = reply.cues;
      state.complete = true;
      state.fromCache = false;
      state.partialFailure = Boolean(reply.partialFailure);
      lastCueIndex = -2;
      state.status = "ready";
      if (state.partialFailure) showToast(PARTIAL_FAILURE_TEXT, 6000);
      else if (fresh) showToast("다시 번역했어요", 2000);
      else if (state.busyVisible) showToast("AI 자막 완료", 2000);
      else hideToast();
    } catch (err) {
      if (token !== state.token || currentVideoId() !== videoId) return;
      console.warn("[Lakomics YouTube]", err);
      const text = err instanceof UserError ? err.message : "자막 정리에 실패했어요. 잠시 후 다시 시도해 주세요.";
      if (before) {
        Object.assign(state, before);
        lastCueIndex = -2;
      } else {
        state.status = "error";
        // Chunks that did finish stay on screen; pressing again retries the rest.
        if (state.cues && !state.complete) state.partialFailure = true;
        state.error = text;
      }
      showToast(text, 8000);
    } finally {
      if (token === state.token) {
        clearTimeout(state.busyTimer);
        state.busyVisible = false;
        applyMode();
        renderButton();
      }
    }
  }

  // A cached result for this video is applied right away, without any API call.
  async function applyCached(token, videoId) {
    try {
      const reply = await sendToBackground({ type: "youtube:getCached", videoId });
      if (token !== state.token || currentVideoId() !== videoId || state.status !== "idle" || !reply || !reply.ok || !reply.cached) return;
      state.cues = reply.cached.cues;
      state.trackKey = reply.cached.trackKey || null;
      state.complete = true;
      state.showClean = true;
      state.fromCache = true;
      state.status = "ready";
      applyMode();
      renderButton();
    } catch {
      // no cache available: stay idle
    }
  }

  // The first lookup runs before the page metadata exists. Once it is known, a video with a channel style rule
  // gets its exact result: the one made for the rule, and an older result made without it is dropped (made again
  // on the next press). Videos without a rule are left untouched.
  async function recheckCached(token, videoId, meta) {
    if (!meta || token !== state.token || state.status !== "ready" || !state.fromCache) return;
    try {
      const reply = await sendToBackground({ type: "youtube:getCached", videoId, meta });
      if (token !== state.token || currentVideoId() !== videoId || !reply || !reply.ok || !reply.styled) return;
      if (reply.cached) {
        if (state.status !== "ready" || !state.fromCache) return;
        state.cues = reply.cached.cues;
        state.trackKey = reply.cached.trackKey || null;
        state.complete = true;
        state.showClean = true;
        state.fromCache = true;
        state.status = "ready";
      } else if (state.status === "ready" && state.fromCache) {
        state.cues = null;
        state.trackKey = null;
        state.ranges = [];
        state.complete = false;
        state.showClean = false;
        state.fromCache = false;
        state.status = "idle";
      } else return;
      applyMode();
      renderButton();
    } catch {
      // keep what is shown
    }
  }

  function resetForVideo(videoId) {
    state.token += 1;
    clearTimeout(state.busyTimer);
    clearTimeout(toastTimer);
    clearRetranslate();
    if (toast) toast.classList.remove("lakomics-yt-show");
    state.videoId = videoId;
    state.status = "idle";
    state.cues = null;
    state.trackKey = null;
    state.ranges = [];
    state.complete = false;
    state.partialFailure = false;
    state.fromCache = false;
    state.prefetch = null;
    clearTimeout(state.prefetchTimer);
    state.showClean = false;
    state.error = "";
    state.progress = null;
    state.busyVisible = false;
    applyMode();
    renderButton();
    if (videoId) {
      const token = state.token;
      applyCached(token, videoId);
      state.prefetchTimer = setTimeout(() => startPrefetch(token, videoId), PREFETCH_DELAY_MS);
    }
  }

  function currentVideoId() {
    return new URL(window.location.href).searchParams.get("v");
  }

  function onNavigate() {
    if (!settingsReady || !available()) return;
    const videoId = currentVideoId();
    if (videoId !== state.videoId) resetForVideo(videoId);
    ensureUi();
  }

  // Cheap check that re-adds our elements if YouTube re-rendered the player.
  function ensureUi() {
    if (!settingsReady) return;
    if (!available()) { if (button || overlay || toast) removeUi(); return; }
    if (!button || !button.isConnected) ensureButton();
    if (needsOverlay()) {
      if (!overlay || !overlay.isConnected || overlay.parentNode !== getPlayer()) applyMode();
      else startLoop();
    }
  }

  // ---------------------------------------------------------------- start

  document.addEventListener("yt-navigate-finish", onNavigate);

  let uiCheckQueued = false;
  new MutationObserver(() => {
    if (uiCheckQueued) return;
    uiCheckQueued = true;
    requestAnimationFrame(() => {
      uiCheckQueued = false;
      ensureUi();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  void initialSettings.then(() => {
    settingsReady = true;
    if (!available()) return;
    resetForVideo(currentVideoId());
    ensureUi();
  });
})();
