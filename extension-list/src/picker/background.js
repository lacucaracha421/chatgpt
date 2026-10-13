(() => {
  "use strict";
  // Service-worker side of the Arca Live picker. Only this file knows the PC connection key and
  // talks to the PC service (http://127.0.0.1:32145); the page and the panel get decoded results.
  const Model = globalThis.LakomicsPickerModel;
  const BASE = "http://127.0.0.1:32145";
  const COMMAND = "toggle-arca-picker";
  const KEY_PATTERN = /^[0-9a-f]{32}$/;
  const MAX_THUMBNAIL = 8 * 1024 * 1024, MAX_ORIGINAL = 20 * 1024 * 1024;

  function createService({ storage = chrome.storage.local, fetchImpl = (...args) => fetch(...args), runtime = chrome.runtime, tabs = chrome.tabs, base = BASE,
    api = globalThis.LakomicsListApi, userAgent = globalThis.navigator?.userAgent || "" } = {}) {
    async function readKey() {
      const stored = await storage.get([Model.PC_KEY]);
      const value = stored?.[Model.PC_KEY];
      return typeof value === "string" && KEY_PATTERN.test(value) ? value : null;
    }

    // One PC request. Never throws; failures carry only a kind, status and code.
    async function callPC(path, { method = "GET", body, timeoutMs = 15000, limit = 1024 * 1024 } = {}) {
      const key = await readKey();
      if (!key) return { ok: false, kind: "unpaired", status: 0, code: "no_key" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(base + path, {
          method,
          headers: { authorization: "Bearer " + key, "x-lakomics-extension-id": runtime.id, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
        });
        if (!response.ok) {
          let code = "";
          try { code = String((await response.json())?.code || ""); } catch {}
          return { ok: false, kind: Model.mapFailure({ status: response.status, code }), status: response.status, code };
        }
        return { ok: true, response, limit, source: "PC" };
      } catch (error) {
        const code = error?.name === "AbortError" ? "timeout" : "offline";
        return { ok: false, kind: Model.mapFailure({ status: 0, code }), status: 0, code };
      } finally { clearTimeout(timer); }
    }

    async function callServer(path, { method = "GET", body, timeoutMs = 15000 } = {}) {
      const connection = await api?.readConnection();
      if (!connection) return { ok: false, kind: "unpaired", status: 0, code: "no_key" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(connection.origin + path, {
          method, headers: { authorization: "Bearer " + connection.token,
            ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
        });
        // Do not deliver a result from a pairing replaced while the request was in flight.
        const current = await api.readConnection();
        if (!current || current.origin !== connection.origin || current.token !== connection.token) {
          return { ok: false, kind: "unpaired", status: 401, code: "connection_changed" };
        }
        if (!response.ok) {
          let code = "";
          try { const data = await response.json(); code = String(data?.code || data?.detail?.code || ""); } catch {}
          return { ok: false, kind: Model.mapFailure({ status: response.status, code }), status: response.status, code };
        }
        return { ok: true, response, source: "server" };
      } catch (error) {
        const code = error?.name === "AbortError" ? "timeout" : "offline";
        return { ok: false, kind: Model.mapFailure({ status: 0, code }), status: 0, code };
      } finally { clearTimeout(timer); }
    }

    async function call(path, options) {
      if (/Android|Helium/i.test(userAgent) || !await readKey()) return callServer(path, options);
      const pc = await callPC(path, options);
      // A PC refusal (including 401/403/423) is final; only unreachable PCs fall back.
      if (!pc.ok && pc.status === 0 && ["offline", "timeout"].includes(pc.code)) {
        const server = await callServer(path, options);
        return server.code === "no_key" ? pc : server;
      }
      return pc;
    }

    async function json(path, options) {
      const result = await call(path, options);
      if (!result.ok) return result;
      try { return { ok: true, data: await result.response.json(), source: result.source }; }
      catch { return { ok: false, kind: "unknown", status: 200, code: "bad_json" }; }
    }

    async function bytes(path, { cap, timeoutMs }) {
      const result = await call(path, { timeoutMs });
      if (!result.ok) return result;
      let response = result.response;
      let controller, timer;
      try {
        if (result.source === "server") {
          const ticket = await response.json();
          const url = new URL(ticket.url);
          if (url.protocol !== "https:" || url.username || url.password || !Model.MIMES.includes(ticket.contentType)
            || !Number.isSafeInteger(ticket.sizeBytes) || ticket.sizeBytes < 0) throw new Error("invalid ticket");
          if (ticket.sizeBytes > cap) return { ok: false, kind: "tooLarge", status: 413, code: "too_large" };
          controller = new AbortController();
          timer = setTimeout(() => controller.abort(), timeoutMs);
          response = await fetchImpl(url.href, { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
          if (!response.ok) return { ok: false, kind: "offline", status: response.status, code: "media_unavailable" };
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > cap) {
          await response.body?.cancel();
          return { ok: false, kind: "tooLarge", status: 413, code: "too_large" };
        }
        // Bound streaming allocations too, even when storage omits Content-Length.
        const reader = response.body?.getReader();
        const chunks = [];
        let size = 0;
        if (reader) {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > cap) { await reader.cancel(); return { ok: false, kind: "tooLarge", status: 413, code: "too_large" }; }
            chunks.push(value);
          }
        }
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        const mime = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        return { ok: true, data, mime };
      } catch { return { ok: false, kind: "offline", status: 0, code: "offline" }; }
      finally { if (timer) clearTimeout(timer); }
    }

    const fail = result => ({ ok: false, kind: result.kind, status: result.status, code: result.code });

    async function folders() {
      const result = await json("/v1/picker/folders", { timeoutMs: 10000 });
      // An older PC build has no `characters`; the panel then simply lists folders.
      return result.ok ? { ok: true, entries: Model.cleanFolders(result.data?.entries), characters: Model.cleanCharacters(result.data?.characters) } : fail(result);
    }

    async function batch(message) {
      const exclude = Array.isArray(message.exclude) ? message.exclude : [];
      const limit = message.limit === undefined ? Model.BATCH : Number(message.limit);
      // Exactly one of a folder and a character/group scope.
      const scope = message.scope === undefined ? null : Model.cleanScope(message.scope);
      const byScope = message.scope !== undefined, byFolder = message.folderId !== undefined;
      if (byScope === byFolder || (byScope && (!scope || scope.kind === "folder")) || (byFolder && !Model.validId(message.folderId))
        || !Number.isInteger(limit) || limit < 1 || limit > Model.MAX_BATCH
        || exclude.length > Model.MAX_EXCLUDE || !exclude.every(Model.validId)) return { ok: false, kind: "invalid", status: 400, code: "invalid" };
      const target = byScope ? { scope: { kind: scope.kind, id: scope.id } } : { folderId: message.folderId, includeDescendants: message.includeDescendants === true };
      const result = await json("/v1/picker/batch", { method: "POST", body: { ...target, limit, exclude }, timeoutMs: 20000 });
      if (!result.ok) return fail(result);
      const items = (Array.isArray(result.data?.items) ? result.data.items : [])
        .filter(item => item && Model.validId(item.assetId) && Model.MIMES.includes(item.mime))
        .map(item => ({ assetId: item.assetId, width: Model.clampInt(item.width), height: Model.clampInt(item.height), byteSize: Model.clampInt(item.byteSize), mime: item.mime }));
      return { ok: true, items, remaining: Model.clampInt(result.data?.remaining) };
    }

    async function thumbnail(message) {
      if (!Model.validId(message.assetId)) return { ok: false, kind: "invalid", status: 400, code: "invalid" };
      const result = await bytes("/v1/picker/thumbnail/" + message.assetId, { cap: MAX_THUMBNAIL, timeoutMs: 20000 });
      if (!result.ok) return fail(result);
      return { ok: true, mime: result.mime.startsWith("image/") ? result.mime : "image/webp", base64: Model.toBase64(result.data) };
    }

    async function original(message) {
      if (!Model.validId(message.assetId)) return { ok: false, kind: "invalid", status: 400, code: "invalid" };
      const result = await bytes("/v1/picker/original/" + message.assetId, { cap: MAX_ORIGINAL, timeoutMs: 90000 });
      if (!result.ok) return fail(result);
      if (!Model.MIMES.includes(result.mime)) return { ok: false, kind: "unsupported", status: 415, code: "unsupported" };
      return { ok: true, mime: result.mime, size: result.data.length, base64: Model.toBase64(result.data) };
    }

    const fromContentPage = sender => sender?.id === runtime.id && Number.isInteger(sender.tab?.id) && sender.frameId === 0 && Model.isArcaWriteUrl(sender.url);
    const fromOptionsPage = sender => sender?.id === runtime.id && sender.frameId === 0 && String(sender.url || "").split("#")[0] === runtime.getURL("options/options.html");

    async function handle(message, sender) {
      switch (message?.type) {
        case "picker:key-state": {
          if (!fromOptionsPage(sender)) return { ok: false, code: "forbidden_sender" };
          return { ok: true, hasKey: Boolean(await readKey()) };
        }
        case "picker:key-set": {
          if (!fromOptionsPage(sender)) return { ok: false, code: "forbidden_sender" };
          const value = String(message.value || "").trim().toLowerCase();
          if (!KEY_PATTERN.test(value)) return { ok: false, code: "invalid_key" };
          await storage.set({ [Model.PC_KEY]: value });
          return { ok: true, hasKey: true };
        }
        case "picker:key-clear": {
          if (!fromOptionsPage(sender)) return { ok: false, code: "forbidden_sender" };
          await storage.remove([Model.PC_KEY]);
          return { ok: true, hasKey: false };
        }
        default:
      }
      if (!fromContentPage(sender)) return { ok: false, code: "forbidden_sender" };
      switch (message?.type) {
        case "picker:folders": return folders();
        case "picker:batch": return batch(message);
        case "picker:thumb": return thumbnail(message);
        case "picker:original": return original(message);
        case "picker:settings":
          await tabs.create({ url: runtime.getURL("options/options.html") + "#pair-section" });
          return { ok: true };
        default: return { ok: false, code: "unknown_message" };
      }
    }

    // Alt+Shift+L (or the user's own binding): toggle the panel in the active Arca write tab.
    async function routeCommand(command) {
      if (command !== COMMAND) return false;
      const [tab] = await tabs.query({ active: true, lastFocusedWindow: true });
      if (!Number.isInteger(tab?.id) || !Model.isArcaWriteUrl(tab.url)) return false;
      await new Promise(resolve => {
        try { tabs.sendMessage(tab.id, { type: "picker:toggle" }, { frameId: 0 }, () => { void runtime.lastError; resolve(); }); }
        catch { resolve(); }
      });
      return true;
    }

    return { handle, routeCommand, folders, batch, thumbnail, original, readKey };
  }

  const exported = { createService, BASE, COMMAND, service: null, handle: (message, sender) => (exported.service ||= createService()).handle(message, sender) };
  globalThis.LakomicsPickerBackground = exported;
  if (typeof chrome !== "undefined" && chrome.runtime?.id && chrome.storage?.local && chrome.commands?.onCommand) {
    chrome.commands.onCommand.addListener(command => { void (exported.service ||= createService()).routeCommand(command).catch(() => {}); });
  }
})();
