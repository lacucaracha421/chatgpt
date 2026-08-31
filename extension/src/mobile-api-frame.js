(() => {
  "use strict";

  const PAGE_ORIGIN = "https://lacucaracha421.github.io";
  const COLLECTOR_SETTINGS_KEY = "collectorSettings";
  const COLLECTOR_TOKEN_KEY = "collectorToken";
  const DEFAULT_BASE_URL = "http://100.76.119.29:32146";
  const MAX_CAPTURES = 500;

  function clean(value, max = 500) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function referrerAllowed() {
    try {
      return new URL(document.referrer).origin === PAGE_ORIGIN;
    } catch {
      return false;
    }
  }

  function normalizeBaseUrl(value) {
    const raw = clean(value, 500) || DEFAULT_BASE_URL;
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      const knownVps = url.protocol === "http:" && host === "100.76.119.29" && url.port === "32146";
      const tailnetHttps = url.protocol === "https:" && host.endsWith(".ts.net");
      if (!knownVps && !tailnetHttps) return "";
      if (url.username || url.password || url.search || url.hash) return "";
      if (url.pathname && url.pathname !== "/") return "";
      return `${url.protocol}//${url.host}`;
    } catch {
      return "";
    }
  }

  async function collectorConfig() {
    const stored = await chrome.storage.local.get([COLLECTOR_SETTINGS_KEY, COLLECTOR_TOKEN_KEY]);
    const token = clean(stored[COLLECTOR_TOKEN_KEY], 300);
    const baseUrl = normalizeBaseUrl(stored[COLLECTOR_SETTINGS_KEY]?.baseUrl);
    if (!token) return { ok: false, code: "collector_token_missing" };
    if (!baseUrl) return { ok: false, code: "collector_not_configured" };
    return { ok: true, token, baseUrl };
  }

  async function collectorRequest(path) {
    const config = await collectorConfig();
    if (!config.ok) return config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${config.baseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.token}` },
        signal: controller.signal,
        cache: "no-store",
      });
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok) {
        return {
          ok: false,
          code: response.status === 401 ? "collector_unauthorized" : "collector_http_error",
          httpStatus: response.status,
          detail: clean(payload?.detail, 200),
        };
      }
      return { ok: true, payload };
    } catch (error) {
      return {
        ok: false,
        code: error?.name === "AbortError" ? "collector_timeout" : "collector_request_failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizeCapture(value) {
    if (!value || typeof value !== "object") return null;
    const id = clean(value.id, 240);
    const classificationId = clean(value.classification_id, 240);
    const mediaType = clean(value.media_type, 40) === "video" ? "video" : "image";
    const mediaUrl = clean(value.media_url, 2000);
    const sourceUrl = clean(value.source_url, 2000);
    if (!id || !classificationId || !sourceUrl) return null;
    return {
      id,
      classificationId,
      mediaType,
      mediaUrl,
      sourceUrl,
      status: clean(value.status, 40),
      createdAt: clean(value.created_at, 120),
      importedAt: clean(value.imported_at, 120) || null,
      publishedAt: clean(value.published_at, 120) || null,
      contentType: clean(value.content_type, 120),
      sizeBytes: Number.isFinite(Number(value.size_bytes)) ? Number(value.size_bytes) : null,
    };
  }

  async function listCaptures(requestedLimit) {
    const limit = Math.max(1, Math.min(MAX_CAPTURES, Number(requestedLimit) || MAX_CAPTURES));
    const result = await collectorRequest(`/v1/captures?limit=${limit}`);
    if (!result.ok) return result;
    const items = Array.isArray(result.payload?.items)
      ? result.payload.items.map(normalizeCapture).filter(Boolean)
      : [];
    return { ok: true, items };
  }

  async function captureTicket(captureId) {
    const id = clean(captureId, 240);
    if (!id) return { ok: false, code: "invalid_capture_id" };
    const result = await collectorRequest(`/v1/captures/${encodeURIComponent(id)}/download`);
    if (!result.ok) return result;
    const url = clean(result.payload?.download_url, 4000);
    if (result.payload?.method !== "GET" || !url) return { ok: false, code: "invalid_download_ticket" };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, code: "invalid_download_ticket" };
      }
    } catch {
      return { ok: false, code: "invalid_download_ticket" };
    }
    return { ok: true, url };
  }

  function reply(target, requestId, result) {
    target.postMessage({
      source: "lakomics-mobile-api",
      requestId,
      result,
    }, "*");
  }

  window.addEventListener("message", async (event) => {
    if (!referrerAllowed() || event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== "lakomics-mobile-content") return;
    const requestId = clean(data.requestId, 120);
    if (!requestId) return;

    let result;
    if (data.op === "captures:list") {
      result = await listCaptures(data.limit);
    } else if (data.op === "capture:ticket") {
      result = await captureTicket(data.captureId);
    } else {
      result = { ok: false, code: "unknown_mobile_api_operation" };
    }
    reply(event.source, requestId, result);
  });
})();
