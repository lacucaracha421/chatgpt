(() => {
  "use strict";
  const RECENT_KEY = "lakomics:list:recent-saved-x:v1";
  const RECENT_MS = 10 * 60_000;

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

  function mediaType(candidate) {
    if (gifLike(candidate)) return "animated_gif";
    return candidate?.type === "video" ? "video" : candidate?.type === "image" || !candidate?.type ? "image" : candidate.type;
  }

  function source(candidate) {
    return ["x", "arca", "dcinside", "web"].includes(candidate?.source) ? candidate.source : "web";
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

  async function save({ candidate, classificationId, classificationPath = [] }) {
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

  globalThis.LakomicsSaveClient = { gifLike, mediaType, safeServerDetail, save, savedIndex, xKey };
})();
