(() => {
  "use strict";

  if (!globalThis.LakomicsRadial && typeof importScripts === "function") {
    importScripts("layout.js");
  }

  const API_BASE_URL = "http://127.0.0.1:32145";
  const CACHE_MS = 30_000;
  const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
  let classificationCache = null;
  let classificationCachedAt = 0;

  async function handleMessage(message) {
    switch (message?.type) {
      case "settings:get": {
        const { connectionToken } = await chrome.storage.local.get(["connectionToken"]);
        return { ok: true, tokenConfigured: TOKEN_PATTERN.test(connectionToken ?? "") };
      }
      case "settings:set-token": {
        const token = String(message.token ?? "").trim();
        if (!TOKEN_PATTERN.test(token)) {
          return { ok: false, code: "invalid_connection_key" };
        }
        await chrome.storage.local.set({ connectionToken: token });
        classificationCache = null;
        classificationCachedAt = 0;
        return { ok: true };
      }
      case "layout:get": {
        const { radialLayout } = await chrome.storage.local.get(["radialLayout"]);
        return {
          ok: true,
          layout: validLayout(radialLayout) ? radialLayout : { version: 1, parents: {} },
        };
      }
      case "layout:set": {
        if (!validLayout(message.layout)) {
          return { ok: false, code: "invalid_layout" };
        }
        await chrome.storage.local.set({ radialLayout: message.layout });
        if (classificationCache) classificationCache.layout = message.layout;
        return { ok: true };
      }
      case "classifications:get":
        return classifications(false);
      case "classifications:refresh":
        return classifications(true);
      case "ingestion:create":
        return apiRequest("/v1/ingestions", {
          method: "POST",
          body: JSON.stringify(message.payload),
        });
      default:
        return { ok: false, code: "unknown_message" };
    }
  }

  async function classifications(force) {
    const now = Date.now();
    if (!force && classificationCache && now - classificationCachedAt <= CACHE_MS) {
      return { ok: true, ...classificationCache };
    }
    const response = await apiRequest("/v1/classifications");
    if (!response.ok) return response;
    const entries = Array.isArray(response.entries) ? response.entries : [];
    const { radialLayout } = await chrome.storage.local.get(["radialLayout"]);
    const layout = globalThis.LakomicsRadial.reconcileLayout(entries, radialLayout);
    if (JSON.stringify(layout) !== JSON.stringify(radialLayout)) {
      await chrome.storage.local.set({ radialLayout: layout });
    }
    classificationCache = { entries, layout };
    classificationCachedAt = now;
    return { ok: true, ...classificationCache };
  }

  function validLayout(layout) {
    if (!layout || layout.version !== 1 || !layout.parents || typeof layout.parents !== "object") {
      return false;
    }
    return Object.values(layout.parents).every((pages) =>
      Array.isArray(pages) && pages.every((page) =>
        Array.isArray(page) && page.every((id) => id === null || typeof id === "string")));
  }

  async function apiRequest(path, init = {}) {
    const { connectionToken } = await chrome.storage.local.get(["connectionToken"]);
    if (!TOKEN_PATTERN.test(connectionToken ?? "")) {
      return { ok: false, code: "connection_key_missing" };
    }
    const headers = { Authorization: `Bearer ${connectionToken}` };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    } catch {
      return { ok: false, code: "app_offline" };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) {
      return {
        ok: false,
        code: typeof body.code === "string" ? body.code : "request_failed",
        ...(typeof body.message === "string" ? { message: body.message } : {}),
      };
    }
    return { ok: true, ...body };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse, () => sendResponse({ ok: false, code: "worker_failed" }));
    return true;
  });

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsBackground = { handleMessage };
  }
})();
