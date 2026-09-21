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
        return temporaryTarget(message.candidate);
      case "collector:save":
        return globalThis.LakomicsSaveClient.save(message.payload || {});
      case "saved-index:get":
        return globalThis.LakomicsSaveClient.savedIndex();
      default:
        return { ok: false, code: "unknown_message" };
    }
  }

  // Temporary save downloads the selected original. An X video or GIF is a CDN MP4
  // that needs no resolution once known; when the page has not mounted a player the
  // player identity is resolved first, exactly like a permanent save. A poster URL
  // is never substituted for the animation.
  async function temporaryTarget(candidate) {
    if (!candidate) return { ok: false, code: "media_unsupported" };
    if (candidate.type === "image") return downloadTemporary(candidate);
    if (candidate.type !== "video" || candidate.source !== "x") return { ok: false, code: "media_unsupported" };

    async function resolvedUrl(value) {
      const direct = globalThis.LakomicsSaveClient.xVideoMediaUrl(value);
      if (direct) return direct;
      const resolved = await globalThis.LakomicsSaveClient.resolveXVideoCandidate(value);
      return globalThis.LakomicsSaveClient.xVideoMediaUrl(resolved);
    }

    const mediaUrl = await resolvedUrl(candidate);
    if (!mediaUrl) return { ok: false, code: "media_unsupported" };
    return downloadTemporary({ type: "video", mediaUrl });
  }

  async function downloadTemporary(candidate) {
    if (candidate?.type !== "image" && candidate?.type !== "video") return { ok: false, code: "media_unsupported" };
    let url;
    try { url = new URL(candidate.mediaUrl); } catch { return { ok: false, code: "invalid_url" }; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return { ok: false, code: "invalid_url" };
    try {
      // Callback form also works in Chromium runtimes without Promise support.
      // Ignore its return value: some variants expose a Promise-like value even
      // though the callback remains the authority for the actual result.
      const downloadId = await new Promise((resolve, reject) => {
        try {
          chrome.downloads.download({ url: url.href, saveAs: false, conflictAction: "uniquify" }, (id) => {
            const error = chrome.runtime?.lastError;
            if (error) reject(error);
            else if (!Number.isInteger(id)) reject(new Error("Browser did not return a download id"));
            else resolve(id);
          });
        } catch (error) { reject(error); }
      });
      return { ok: true, downloadId, status: "download_started" };
    } catch (error) {
      const browserMessage = safeDownloadError(error);
      return { ok: false, code: "download_failed", ...(browserMessage ? { browserMessage } : {}) };
    }
  }

  function safeDownloadError(error) {
    const message = String(error?.message || error || "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (!message) return null;
    return message
      .replace(/\b(?:https?|ftp|file|data|blob):[^\s<>"']*/gi, "[URL]")
      .replace(/\b[A-Za-z]:[\\/][^\s<>"']*/g, "[path]")
      .replace(/\b(?:Bearer\s+|Basic\s+)[A-Za-z0-9+/=._~-]+/gi, "[credential]")
      .replace(/\b(?:sk|pk|api|token|secret)[-_][A-Za-z0-9._~-]{8,}\b/gi, "[credential]")
      .slice(0, 180);
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
