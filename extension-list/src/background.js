importScripts("classification-tree.js", "api-client.js", "menu-settings.js", "profile-store.js", "save-client.js", "translate-service.js", "av-lookup.js");

(() => {
  "use strict";
  const AV_LOOKUP_MENU_ID = "lakomics-av-lookup";
  const AV_SEND_MENU_ID = "lakomics-av-send";

  async function sendAvLookup(request) {
    const productCode = globalThis.LakomicsAvLookup.normalizeProductCode(request?.productCode);
    if (!productCode || !request?.requestId) return { ok: false, code: "invalid_query" };
    return globalThis.LakomicsListApi.request("/v1/av-lookups", {
      method: "POST",
      body: { requestId: request.requestId, productCode, sourceUrl: request.sourceUrl ?? null },
    });
  }

  async function sendAvSelection(info, tab) {
    const request = globalThis.LakomicsAvLookup.createSendRequest(info.selectionText, info.pageUrl || tab?.url);
    if (!request) return { ok: false, code: "invalid_query" };
    let result;
    try { result = await sendAvLookup(request); }
    catch { result = { ok: false, code: "worker_failed" }; }
    if (Number.isInteger(tab?.id)) {
      // A callback also works in browsers whose runtime messaging is callback-only.
      chrome.tabs.sendMessage(tab.id, { type: "av-send-result", request, result },
        { frameId: 0 }, () => void chrome.runtime.lastError);
    }
    return result;
  }

  async function openAvLookup(selectionText, tab) {
    const query = globalThis.LakomicsAvLookup?.normalizeQuery(selectionText) || "";
    if (!query) return { ok: false, code: "invalid_query" };
    if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.index)) return { ok: false, code: "tab_unavailable" };
    const urls = globalThis.LakomicsAvLookup.buildLookupUrls(query);
    for (let i = 0; i < urls.length; i += 1) {
      await chrome.tabs.create({ url: urls[i], active: false, index: tab.index + 1 + i, openerTabId: tab.id });
    }
    return { ok: true, query, urls };
  }

  let connectionChanges = Promise.resolve();
  function changeConnection(work) {
    const result = connectionChanges.then(work);
    connectionChanges = result.catch(() => {});
    return result;
  }
  function confirmationPage(sender) {
    return sender.id === chrome.runtime.id && sender.url?.split("#")[0] === chrome.runtime.getURL("options/pairing.html") && sender.frameId === 0;
  }

  async function handleMessage(message, sender = {}) {
    if (message?.type?.startsWith("translation:")) return globalThis.LakomicsTranslation.handle(message);
    switch (message?.type) {
      case "pair:review": {
        if (!globalThis.LakomicsListApi.parsePairing(message.value)) return { ok: false, code: "invalid_pairing" };
        await chrome.tabs.create({ url: chrome.runtime.getURL("options/pairing.html") + "#" + encodeURIComponent(message.value) });
        return { ok: true, pending: true };
      }
      case "pair": {
        if (!confirmationPage(sender)) return { ok: false, code: "confirmation_required" };
        return changeConnection(async () => {
          const result = await globalThis.LakomicsListApi.pair(message.value, {
            confirmedOrigin: message.confirmedOrigin, expectedConnection: message.expectedConnection,
          });
          if (!result.ok) return result;
          await globalThis.LakomicsProfileStore.seed(result.bootstrap);
          await globalThis.LakomicsMenuSettings.sync({ force: true });
          return { ok: true, state: await globalThis.LakomicsProfileStore.readState(), connection: { origin: result.connection.origin, clientId: result.connection.clientId } };
        });
      }
      case "disconnect":
        return changeConnection(async () => {
          await globalThis.LakomicsListApi.request("/v1/extension/session", { method: "DELETE", timeoutMs: 5000 }).catch(() => undefined);
          await globalThis.LakomicsListApi.clearConnection();
          return { ok: true };
        });
      case "settings:open":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case "settings:get": {
        const connection = await globalThis.LakomicsListApi.readConnection();
        const state = await globalThis.LakomicsProfileStore.readState();
        return { ok: true, paired: Boolean(connection), origin: connection?.origin ?? null, clientId: connection?.clientId ?? null, pairedAt: connection?.pairedAt ?? 0, connectionIdentity: globalThis.LakomicsListApi.connectionIdentity(connection), state };
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
      case "av-lookup":
        return openAvLookup(message.selectionText, sender.tab);
      case "av-send":
        return sendAvLookup(message.request);
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    Promise.resolve(handleMessage(message, sender)).then(sendResponse).catch((error) => sendResponse({ ok: false, code: "worker_failed", message: String(error?.message || error || "") }));
    return true;
  });

  chrome.action?.onClicked?.addListener(() => {
    void chrome.runtime.openOptionsPage?.();
  });

  chrome.runtime.onStartup?.addListener(() => {
    void globalThis.LakomicsProfileStore.flush()
      .then(() => globalThis.LakomicsProfileStore.refresh({ forceMenuSettings: true }))
      .catch(() => {});
  });

  chrome.runtime.onInstalled?.addListener(() => {
    void globalThis.LakomicsProfileStore.refresh({ forceMenuSettings: true }).catch(() => {});
    if (chrome.contextMenus?.create) chrome.contextMenus.create({ id: AV_LOOKUP_MENU_ID, title: "AV 표지 찾기: “%s”", contexts: ["selection"] }, () => void chrome.runtime.lastError);
    if (chrome.contextMenus?.create) chrome.contextMenus.create({ id: AV_SEND_MENU_ID, title: "AV 컬렉션에 보내기: “%s”", contexts: ["selection"], documentUrlPatterns: ["https://*/*"] }, () => void chrome.runtime.lastError);
  });

  chrome.contextMenus?.onClicked?.addListener((info, tab) => {
    if (info?.menuItemId === AV_SEND_MENU_ID) return sendAvSelection(info, tab);
    if (info?.menuItemId !== AV_LOOKUP_MENU_ID) return undefined;
    return openAvLookup(info.selectionText, tab);
  });

  if (globalThis.__LAKOMICS_TEST__) globalThis.LakomicsAvLookupBackground = { AV_LOOKUP_MENU_ID, AV_SEND_MENU_ID, handleMessage, openAvLookup };
})();
