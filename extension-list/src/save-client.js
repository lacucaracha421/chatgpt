(() => {
  "use strict";
  const RECENT_KEY = "lakomics:list:recent-saved-x:v1";
  const RECENT_MS = 10 * 60_000;
  const X_SYNDICATION_ENDPOINT = "https://cdn.syndication.twimg.com/tweet-result";

  function xKey(sourceUrl) {
    try {
      const url = new URL(sourceUrl);
      if (!["x.com", "twitter.com"].includes(url.hostname)) return "";
      const match = url.pathname.match(/^\/[^/]+\/status\/(\d+)\/photo\/(\d+)/);
      return match && Number(match[2]) > 0 ? `${match[1]}:${Number(match[2])}` : "";
    } catch { return ""; }
  }

  function gifLike(candidate) {
    if (/\.gif$/i.test(String(candidate?.filename || "").trim())) return true;
    const value = String(candidate?.mediaUrl || "");
    try {
      const url = new URL(value);
      if (/\.gif$/i.test(url.pathname)) return true;
      if (String(url.searchParams.get("format") || "").toLowerCase() === "gif") return true;
    } catch {}
    return /(?:^|[?&])format=gif(?:&|$)/i.test(value);
  }

  // X serves an animated original as an MP4, so `animated_gif` would describe bytes
  // that are not GIF. Animated media carries the video transport; only candidates
  // whose bytes really are GIF are reported as `animated_gif`.
  function mediaType(candidate) {
    if (candidate?.type === "video") return "video";
    if (gifLike(candidate)) return "animated_gif";
    return candidate?.type === "image" || !candidate?.type ? "image" : candidate.type;
  }

  // New candidates carry the all-media ordinal. Older callers can still supply
  // only their video ordinal, which must be projected onto video entries.
  function explicitOverallMediaIndex(candidate) {
    const value = Number(candidate?.overallMediaIndex);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  // Legacy candidates without overallMediaIndex used a video-only mediaIndex.
  function videoOrdinal(candidate) {
    const value = Number(candidate?.mediaIndex);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  function source(candidate) {
    try {
      const url = new URL(candidate?.sourceUrl || "");
      if (["x.com", "twitter.com"].includes(url.hostname)) return "x";
    } catch {}
    return ["x", "arca", "dcinside", "web"].includes(candidate?.source) ? candidate.source : "web";
  }

  function xPostId(candidate) {
    const explicit = String(candidate?.postId || "");
    if (/^\d+$/.test(explicit)) return explicit;
    try {
      const url = new URL(candidate?.sourceUrl || "");
      if (!["x.com", "twitter.com"].includes(url.hostname)) return "";
      return url.pathname.match(/\/status\/(\d+)/)?.[1] || "";
    } catch { return ""; }
  }

  function syndicationToken(postId) {
    return ((Number(postId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "") || "a";
  }

  function isXVideoUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "video.twimg.com" && !url.username && !url.password && !url.hash;
    } catch { return false; }
  }

  // A direct URL may already be validated by x-source, or arrive from a caller. It is
  // trusted only as a progressive MP4 on X's video CDN: a manifest such as the `pl/`
  // m3u8 variant is not a downloadable original and must never be handed to the
  // server or to a browser download.
  function isProgressiveXVideoUrl(value) {
    if (!isXVideoUrl(value)) return false;
    try { return /\.mp4$/i.test(new URL(value).pathname); } catch { return false; }
  }

  function bestXVideoUrl(variants) {
    return (Array.isArray(variants) ? variants : [])
      .filter(variant => variant?.content_type === "video/mp4" && isProgressiveXVideoUrl(variant.url))
      .map((variant) => ({ url: variant.url, bitrate: Number(variant.bitrate) || 0 }))
      .sort((left, right) => right.bitrate - left.bitrate)[0]?.url || null;
  }

  // The media endpoint is the only authority for animated identity. It names the
  // selected media `animated_gif` or `video`; nothing is inferred from a URL path.
  function selectedMediaType(details, index) {
    const selected = Array.isArray(details) ? details[index] : null;
    return selected?.type === "animated_gif" ? "animated_gif" : selected?.type === "video" ? "video" : null;
  }

  // The media endpoint lists every media in one sequence. The requested ordinal
  // addresses that sequence, so it is resolved against the full list; an ordinal
  // beyond the returned media is invalid and yields no index at all rather than
  // silently selecting a different media.
  function mediaIndexAt(ordinal, length) {
    if (ordinal === null || ordinal > length) return null;
    return ordinal - 1;
  }

  // Include unavailable video entries in the ordinal mapping: filtering by usable
  // URL would shift later ordinals and could capture a different video.
  function resolveMediaIndex(candidate, details) {
    const explicit = explicitOverallMediaIndex(candidate);
    if (explicit !== null) return mediaIndexAt(explicit, details.length);
    const ordinal = videoOrdinal(candidate);
    if (ordinal === null) return null;
    const videoPositions = details.map((media, index) => ["video", "animated_gif"].includes(media?.type) ? index : -1).filter(index => index >= 0);
    const index = mediaIndexAt(ordinal, videoPositions.length);
    return index === null ? null : videoPositions[index];
  }

  async function resolveXVideo(candidate) {
    if (candidate?.type !== "video" || source(candidate) !== "x") return { ok: true, candidate };
    if (isProgressiveXVideoUrl(candidate.mediaUrl)) {
      return { ok: true, candidate };
    }
    const postId = xPostId(candidate);
    if (!postId) return { ok: false, code: "video_unavailable" };
    let response;
    try {
      const params = new URLSearchParams({ id: postId, token: syndicationToken(postId) });
      response = await fetch(`${X_SYNDICATION_ENDPOINT}?${params}`, { method: "GET", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    } catch { return { ok: false, code: "video_info_failed" }; }
    if (!response?.ok) {
      return { ok: false, code: [403, 404].includes(response?.status) ? "video_unavailable" : "video_info_failed" };
    }
    let data;
    try { data = await response.json(); }
    catch { return { ok: false, code: "video_info_failed" }; }
    if (!data || data.__typename === "TweetTombstone") return { ok: false, code: "video_unavailable" };
    const details = Array.isArray(data.mediaDetails) ? data.mediaDetails : [];
    const videos = details.map((media) => bestXVideoUrl(media?.video_info?.variants));
    const index = resolveMediaIndex(candidate, details);
    if (index === null) return { ok: false, code: "video_unavailable" };
    const mediaUrl = videos[index];
    // A known ordinal that does not resolve is a wrong-media risk, not a reason to
    // capture whichever video came first.
    if (!mediaUrl) return { ok: false, code: "video_unavailable" };
    const media = selectedMediaType(details, index);
    if (!media) return { ok: false, code: "video_unavailable" };
    return { ok: true, candidate: { ...candidate, mediaUrl, animatedMedia: media === "animated_gif" } };
  }

  function safeServerDetail(value) {
    const raw = typeof value === "string" ? value
      : typeof value?.message === "string" ? value.message
      : typeof value?.code === "string" ? value.code
      : "";
    return raw
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer […]")
      .replace(/https?:\/\/[^\s"']+/gi, "[URL]")
      .replace(/#[A-Za-z0-9_-]{16,}/g, "#[…]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  async function rememberRecent(sourceUrl) {
    const key = xKey(sourceUrl);
    if (!key) return;
    const stored = await chrome.storage.local.get([RECENT_KEY]);
    const now = Date.now();
    const values = (Array.isArray(stored[RECENT_KEY]) ? stored[RECENT_KEY] : [])
      .filter((item) => item && item.expiresAt > now && typeof item.key === "string" && item.key !== key);
    values.push({ key, expiresAt: now + RECENT_MS });
    await chrome.storage.local.set({ [RECENT_KEY]: values.slice(-500) });
  }

  async function recentKeys() {
    const stored = await chrome.storage.local.get([RECENT_KEY]);
    const now = Date.now();
    const live = (Array.isArray(stored[RECENT_KEY]) ? stored[RECENT_KEY] : []).filter((item) => item && item.expiresAt > now && typeof item.key === "string");
    if (live.length !== (stored[RECENT_KEY] || []).length) await chrome.storage.local.set({ [RECENT_KEY]: live });
    return [...new Set(live.map((item) => item.key))];
  }

  async function confirm(payload) {
    const params = new URLSearchParams({ source_url: payload.source_url, media_url: payload.media_url, classification_id: payload.classification_id });
    const response = await globalThis.LakomicsListApi.request(`/v1/extension/captures/confirm?${params}`, { timeoutMs: 8000 });
    if (!response.ok || !response.data?.found) return null;
    return response.data?.capture || { status: "pending" };
  }

  // Public resolution entry for callers that hold a candidate but not its media URL.
  // Returns the original candidate unchanged when resolution is impossible, so a
  // caller can still report the real failure code from save().
  async function resolveXVideoCandidate(candidate) {
    if (candidate?.type !== "video") return candidate;
    const video = await resolveXVideo(candidate);
    return video.ok ? video.candidate : candidate;
  }

  // Eligibility follows the media URL, not the identity, and requires a validated
  // progressive MP4 so a manifest is never downloaded.
  function xVideoMediaUrl(candidate) {
    return isProgressiveXVideoUrl(candidate?.mediaUrl) ? candidate.mediaUrl : null;
  }

  async function save({ candidate, classificationId, classificationPath = [] }) {
    const resolved = await resolveXVideo(candidate);
    if (!resolved.ok) return resolved;
    candidate = resolved.candidate;
    const type = mediaType(candidate);
    if (!["image", "video", "animated_gif"].includes(type)) return { ok: false, code: "media_unsupported" };
    const payload = {
      source_url: candidate.sourceUrl,
      media_url: candidate.mediaUrl,
      classification_id: classificationId,
      published_at: candidate.publishedAt || null,
      media_type: type,
      source: source(candidate),
    };
    const response = await globalThis.LakomicsListApi.request("/v1/captures", { method: "POST", body: payload, timeoutMs: type === "video" ? 300_000 : 60_000 });
    if (response.ok) {
      await rememberRecent(candidate.sourceUrl);
      const capture = response.data?.capture || null;
      return {
        ok: true,
        status: response.data?.created === false ? "duplicate" : "captured",
        capture,
        captureStatus: capture?.status || "pending",
      };
    }
    if ([0, 408, 429, 500, 502, 503, 504].includes(response.status)) {
      const confirmed = await confirm(payload).catch(() => null);
      if (confirmed) {
        await rememberRecent(candidate.sourceUrl);
        return { ok: true, status: "confirmed", capture: confirmed, captureStatus: confirmed.status || "pending" };
      }
    }
    if (response.status === 401) return { ok: false, code: "revoked" };
    if (response.status === 409 && response.data?.detail?.code === "classification_stale") return { ok: false, code: "classification_stale" };
    return {
      ok: false,
      code: response.status === 0 ? (response.code || "server_offline") : "server_save_failed",
      httpStatus: response.status,
      serverDetail: safeServerDetail(response.data?.detail),
    };
  }

  async function savedIndex() {
    const response = await globalThis.LakomicsListApi.request("/v1/saved-x-media", { timeoutMs: 8000 });
    const recent = await recentKeys();
    if (!response.ok) return recent.length ? { ok: true, savedKeys: recent, indexSource: "recent" } : { ok: false, code: response.code || "offline" };
    const keys = Array.isArray(response.data?.keys) ? response.data.keys.filter((key) => typeof key === "string") : [];
    return { ok: true, savedKeys: [...new Set([...keys, ...recent])], indexSource: "server", authoritative: true };
  }

  globalThis.LakomicsSaveClient = { gifLike, mediaType, safeServerDetail, save, savedIndex, xKey, resolveXVideoCandidate, xVideoMediaUrl };
})();
