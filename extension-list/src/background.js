importScripts("classification-tree.js", "api-client.js", "profile-store.js", "save-client.js");

(() => {
  "use strict";
  const X_TRANSLATE_ALLOWED_HOSTS = new Set([
    "ollama.com", "generativelanguage.googleapis.com", "ai-gateway.vercel.sh", "openrouter.ai",
  ]);

  async function syncPortablePreferences(profile) {
    if (!profile?.preferences) return;
    await chrome.storage.local.set({ xTranslateEnabled: profile.preferences.xTranslateEnabled !== false });
  }

  async function handleMessage(message) {
    switch (message?.type) {
      case "pair": {
        const result = await globalThis.LakomicsListApi.pair(message.value);
        if (!result.ok) return result;
        const state = await globalThis.LakomicsProfileStore.seed(result.bootstrap);
        await syncPortablePreferences(state?.profile);
        void globalThis.LakomicsProfileStore.flush();
        return { ok: true, state, connection: { origin: result.connection.origin, clientId: result.connection.clientId } };
      }
      case "disconnect":
        await globalThis.LakomicsListApi.request("/v1/extension/session", { method: "DELETE", timeoutMs: 5000 }).catch(() => undefined);
        await globalThis.LakomicsListApi.clearConnection();
        await globalThis.LakomicsProfileStore.clear();
        return { ok: true };
      case "settings:get": {
        const connection = await globalThis.LakomicsListApi.readConnection();
        const state = await globalThis.LakomicsProfileStore.readState();
        return { ok: true, paired: Boolean(connection), origin: connection?.origin ?? null, clientId: connection?.clientId ?? null, state };
      }
      case "collector:state": {
        const result = await globalThis.LakomicsProfileStore.getState();
        if (result.ok) {
          await syncPortablePreferences(result.state.profile);
          void globalThis.LakomicsProfileStore.flush();
        }
        return result;
      }
      case "profile:refresh": {
        const result = await globalThis.LakomicsProfileStore.refresh();
        if (result.ok) await syncPortablePreferences(result.state.profile);
        return result;
      }
      case "arc:hidden":
        return globalThis.LakomicsProfileStore.setHidden(message.ids);
      case "profile:patch": {
        const result = await globalThis.LakomicsProfileStore.patchProfile(message.patch || {});
        if (result.ok) await syncPortablePreferences(result.state.profile);
        return result;
      }
      case "collector:save":
        return globalThis.LakomicsSaveClient.save(message.payload || {});
      case "saved-index:get":
        return globalThis.LakomicsSaveClient.savedIndex();
      case "xtranslate:http":
        return translateHttpRequest(message.request || {});
      default:
        return { ok: false, code: "unknown_message" };
    }
  }

  function isAllowedTranslateUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" && X_TRANSLATE_ALLOWED_HOSTS.has(url.hostname.toLowerCase());
    } catch { return false; }
  }

  async function translateHttpRequest(request = {}) {
    const url = String(request.url || "");
    if (!isAllowedTranslateUrl(url)) return { ok: false, code: "xtranslate_url_blocked" };
    const method = String(request.method || "GET").toUpperCase();
    if (!new Set(["GET", "POST"]).has(method)) return { ok: false, code: "xtranslate_method_blocked" };
    const headers = {};
    for (const [name, value] of Object.entries(request.headers && typeof request.headers === "object" ? request.headers : {})) {
      if (/^(?:host|cookie|origin|referer|sec-)/i.test(name)) continue;
      headers[String(name)] = String(value);
    }
    const timeoutMs = Math.min(90_000, Math.max(1_000, Math.round(Number(request.timeout) || 90_000)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method, headers, ...(method === "GET" || request.data == null ? {} : { body: String(request.data) }), signal: controller.signal });
      const responseText = await response.text();
      return {
        ok: true, status: response.status, statusText: response.statusText, responseText,
        responseHeaders: [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\r\n"),
        finalUrl: response.url || url,
      };
    } catch (error) {
      return { ok: false, code: error?.name === "AbortError" ? "xtranslate_timeout" : "xtranslate_network_error", message: String(error?.message || error || "network error") };
    } finally { clearTimeout(timer); }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    Promise.resolve(handleMessage(message)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: "worker_failed", message: String(error?.message || error || "") }));
    return true;
  });

  chrome.action?.onClicked?.addListener(() => {
    void chrome.runtime.openOptionsPage?.();
  });

  chrome.runtime.onStartup?.addListener(() => {
    void globalThis.LakomicsProfileStore.flush()
      .then(() => globalThis.LakomicsProfileStore.refresh())
      .then((result) => result.ok && syncPortablePreferences(result.state.profile))
      .catch(() => {});
  });
})();
