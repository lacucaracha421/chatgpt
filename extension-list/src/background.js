importScripts("classification-tree.js", "api-client.js", "profile-store.js", "save-client.js", "translate-service.js");

(() => {
  "use strict";
  async function handleMessage(message) {
    if (message?.type?.startsWith("translation:")) return globalThis.LakomicsTranslation.handle(message);
    switch (message?.type) {
      case "pair": {
        const result = await globalThis.LakomicsListApi.pair(message.value);
        if (!result.ok) return result;
        const state = await globalThis.LakomicsProfileStore.seed(result.bootstrap);
        void globalThis.LakomicsProfileStore.flush();
        return { ok: true, state, connection: { origin: result.connection.origin, clientId: result.connection.clientId } };
      }
      case "disconnect":
        await globalThis.LakomicsListApi.request("/v1/extension/session", { method: "DELETE", timeoutMs: 5000 }).catch(() => undefined);
        await globalThis.LakomicsListApi.clearConnection();
        await globalThis.LakomicsProfileStore.clear();
        return { ok: true };
      case "settings:open":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case "settings:get": {
        const connection = await globalThis.LakomicsListApi.readConnection();
        const state = await globalThis.LakomicsProfileStore.readState();
        return { ok: true, paired: Boolean(connection), origin: connection?.origin ?? null, clientId: connection?.clientId ?? null, state };
      }
      case "collector:state": {
        const result = await globalThis.LakomicsProfileStore.getState();
        if (result.ok) {
          void globalThis.LakomicsProfileStore.flush();
        }
        return result;
      }
      case "profile:refresh": {
        const result = await globalThis.LakomicsProfileStore.refresh();
        return result;
      }
      case "arc:hidden":
        return globalThis.LakomicsProfileStore.setHidden(message.ids);
      case "profile:patch": {
        const result = await globalThis.LakomicsProfileStore.patchProfile(message.patch || {});
        return result;
      }
      case "collector:temporary":
        return downloadTemporary(message.candidate);
      case "collector:save":
        return globalThis.LakomicsSaveClient.save(message.payload || {});
      case "saved-index:get":
        return globalThis.LakomicsSaveClient.savedIndex();
      default:
        return { ok: false, code: "unknown_message" };
    }
  }

  async function downloadTemporary(candidate) {
    if (candidate?.type !== "image") return { ok: false, code: "media_unsupported" };
    let url;
    try { url = new URL(candidate.mediaUrl); } catch { return { ok: false, code: "invalid_url" }; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return { ok: false, code: "invalid_url" };
    try {
      // No filename directory: the browser owns the configured Desktop destination.
      const downloadId = await chrome.downloads.download({ url: url.href, saveAs: false, conflictAction: "uniquify" });
      return { ok: true, downloadId, status: "download_started" };
    } catch { return { ok: false, code: "download_failed" }; }
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
      .catch(() => {});
  });
})();
