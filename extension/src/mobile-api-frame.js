(() => {
  "use strict";

  const PAGE_ORIGIN = "https://lacucaracha421.github.io";
  const COLLECTOR_SETTINGS_KEY = "collectorSettings";
  const COLLECTOR_TOKEN_KEY = "collectorToken";
  const DEFAULT_BASE_URL = "http://100.76.119.29:32146";
  const LIBRARY_MAX_LIMIT = 100;
  const LIBRARY_DEFAULT_LIMIT = 50;
  const MEDIA_VARIANTS = new Set(["thumbnail", "original"]);

  function clean(value, max = 500) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
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

  async function collectorRequest(path, options = {}) {
    const config = await collectorConfig();
    if (!config.ok) return config;
    const method = options.method === "POST" ? "POST" : "GET";
    const body = method === "POST" && options.body ? JSON.stringify(options.body) : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
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

  function normalizeLibraryClassification(value) {
    if (!value || typeof value !== "object") return null;
    const id = clean(value.id, 240);
    const name = clean(value.name, 120);
    if (!id || !name) return null;
    const parentId = clean(value.parent_id, 240) || null;
    const numericCount = Number(value.asset_count);
    return {
      id,
      name,
      parentId,
      kind: clean(value.kind, 40) || "tag",
      iconKey: clean(value.icon_key, 60) || null,
      colorKey: clean(value.color_key, 60) || null,
      sortIndex: Number.isFinite(Number(value.sort_index)) ? Number(value.sort_index) : null,
      assetCount: Number.isFinite(numericCount) && numericCount >= 0 ? Math.round(numericCount) : 0,
    };
  }

  function normalizeLibraryAsset(value) {
    if (!value || typeof value !== "object") return null;
    const id = clean(value.id, 240);
    if (!id) return null;
    const numericSize = Number(value.size_bytes);
    const classificationIds = Array.isArray(value.classification_ids)
      ? value.classification_ids.map((entry) => clean(entry, 240)).filter(Boolean).slice(0, 200)
      : [];
    return {
      id,
      kind: clean(value.kind, 20),
      contentType: clean(value.content_type, 120),
      sizeBytes: Number.isFinite(numericSize) && numericSize >= 0 ? Math.round(numericSize) : null,
      collectedAt: clean(value.collected_at, 120) || null,
      committedAt: clean(value.committed_at, 120) || null,
      sourcePublishedAt: clean(value.source_published_at, 120) || null,
      sourceUrl: clean(value.source_url, 2000) || null,
      creatorName: clean(value.creator_name, 200) || null,
      creatorHandle: clean(value.creator_handle, 200) || null,
      importSource: clean(value.import_source, 60) || null,
      classificationIds,
      originalAvailable: value.original_available === true,
      thumbnailAvailable: value.thumbnail_available === true,
    };
  }

  async function libraryClassifications() {
    const result = await collectorRequest("/v1/library/classifications");
    if (!result.ok) return result;
    const items = Array.isArray(result.payload?.items)
      ? result.payload.items.map(normalizeLibraryClassification).filter(Boolean)
      : [];
    return { ok: true, items, publishedAt: clean(result.payload?.published_at, 120) || null };
  }

  async function libraryAssets(params = {}) {
    const classificationId = clean(params.classificationId, 240);
    if (!classificationId) return { ok: false, code: "invalid_classification_id" };
    const cursor = typeof params.cursor === "string" ? params.cursor.slice(0, 2000) : "";
    const requested = Number(params.limit);
    const limit = Math.max(1, Math.min(LIBRARY_MAX_LIMIT, Number.isFinite(requested) ? Math.round(requested) : LIBRARY_DEFAULT_LIMIT));
    const query = new URLSearchParams({ classification_id: classificationId, limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const result = await collectorRequest(`/v1/library/assets?${query.toString()}`);
    if (!result.ok) return result;
    const items = Array.isArray(result.payload?.items)
      ? result.payload.items.map(normalizeLibraryAsset).filter(Boolean)
      : [];
    const nextCursor = clean(result.payload?.next_cursor, 2000) || null;
    return {
      ok: true,
      items,
      hasMore: result.payload?.has_more === true,
      nextCursor: result.payload?.has_more === true ? nextCursor : null,
    };
  }

  async function libraryMediaTicket(params = {}) {
    const assetId = clean(params.assetId, 240);
    const variant = clean(params.variant, 20);
    if (!assetId) return { ok: false, code: "invalid_asset_id" };
    if (!MEDIA_VARIANTS.has(variant)) return { ok: false, code: "invalid_media_variant" };
    const result = await collectorRequest(
      `/v1/library/assets/${encodeURIComponent(assetId)}/media-ticket`,
      { method: "POST", body: { variant } },
    );
    if (!result.ok) return result;
    const url = clean(result.payload?.url, 4000);
    if (!url) return { ok: false, code: "invalid_media_ticket" };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, code: "invalid_media_ticket" };
      }
    } catch {
      return { ok: false, code: "invalid_media_ticket" };
    }
    return {
      ok: true,
      url,
      variant,
      contentType: clean(result.payload?.content_type, 120) || null,
      sizeBytes: Number.isFinite(Number(result.payload?.size_bytes)) ? Number(result.payload.size_bytes) : null,
      expiresAt: clean(result.payload?.expires_at, 120) || null,
    };
  }

  function reply(target, targetOrigin, requestId, result) {
    target.postMessage({
      source: "lakomics-mobile-api",
      requestId,
      result,
    }, targetOrigin);
  }

  window.addEventListener("message", async (event) => {
    // document.referrer is not reliable for chrome-extension iframes on Android.
    // Validate the actual sender origin instead; only the Lakomics Pages origin
    // may invoke this privileged bridge.
    if (event.source !== window.parent || event.origin !== PAGE_ORIGIN) return;
    const data = event.data;
    if (!data || data.source !== "lakomics-mobile-content") return;
    const requestId = clean(data.requestId, 120);
    if (!requestId) return;

    let result;
    if (data.op === "library:classifications") {
      result = await libraryClassifications();
    } else if (data.op === "library:assets") {
      result = await libraryAssets({
        classificationId: data.classificationId,
        cursor: data.cursor,
        limit: data.limit,
      });
    } else if (data.op === "library:media-ticket") {
      result = await libraryMediaTicket({ assetId: data.assetId, variant: data.variant });
    } else {
      result = { ok: false, code: "unknown_mobile_api_operation" };
    }
    reply(event.source, event.origin, requestId, result);
  });
})();
