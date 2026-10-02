(() => {
  "use strict";
  const CONNECTION_KEY = "lakomics:list:connection";
  let generation = 0, changing = false;

  function normalizeOrigin(value) {
    try {
      const url = new URL(String(value || ""));
      const host = url.hostname.toLowerCase();
      const development = url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost" || host === "100.76.119.29");
      if (url.protocol !== "https:" && !development) return "";
      if (url.username || url.password || url.search || url.hash) return "";
      return `${url.protocol}//${url.host}`;
    } catch { return ""; }
  }

  function parsePairing(value) {
    try {
      const url = new URL(String(value || "").trim());
      const origin = normalizeOrigin(url.origin);
      const secret = url.hash.startsWith("#") ? decodeURIComponent(url.hash.slice(1)) : "";
      if (!origin || url.username || url.password || url.search || url.pathname.replace(/\/+$/, "") !== "/extension-pair" || secret.length < 16 || secret.length > 256) return null;
      return { origin, secret };
    } catch { return null; }
  }

  async function readConnection() {
    const stored = await chrome.storage.local.get([CONNECTION_KEY]);
    const value = stored[CONNECTION_KEY];
    if (!value || !normalizeOrigin(value.origin) || typeof value.token !== "string" || value.token.length < 20) return null;
    return { origin: normalizeOrigin(value.origin), token: value.token, clientId: value.clientId || null, pairedAt: Number(value.pairedAt) || 0, connectionId: value.connectionId || null };
  }

  function connectionIdentity(value) {
    return value ? JSON.stringify([value.origin, value.connectionId, value.clientId, value.pairedAt]) : null;
  }

  async function replaceConnection(value) {
    generation++;
    changing = true;
    try {
      await globalThis.LakomicsProfileStore?.clear();
      await globalThis.LakomicsSaveClient?.clearRecent();
      if (value) await chrome.storage.local.set({ [CONNECTION_KEY]: value });
      else await chrome.storage.local.remove([CONNECTION_KEY]);
    } finally { changing = false; }
  }

  function clearConnection() { return replaceConnection(null); }

  async function rawRequest(origin, path, { token = null, method = "GET", body = undefined, timeoutMs = 12000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      let data = null;
      try { data = await response.json(); } catch {}
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      return { ok: false, status: 0, code: error?.name === "AbortError" ? "timeout" : "offline" };
    } finally { clearTimeout(timer); }
  }

  async function pair(value, { confirmedOrigin, expectedConnection } = {}) {
    const parsed = parsePairing(value);
    if (!parsed) return { ok: false, code: "invalid_pairing" };
    if (confirmedOrigin !== parsed.origin) return { ok: false, code: "confirmation_required" };
    const started = generation;
    if (connectionIdentity(await readConnection()) !== expectedConnection) return { ok: false, code: "connection_changed" };
    const response = await rawRequest(parsed.origin, "/v1/extension/pair", { method: "POST", body: { secret: parsed.secret } });
    if (!response.ok || (typeof response.data?.clientToken !== "string" || response.data.clientToken.length < 20)) {
      return { ok: false, code: response.status === 410 ? "pairing_expired" : response.status === 0 ? response.code : "pairing_failed", httpStatus: response.status };
    }
    const connection = { origin: normalizeOrigin(response.data.serverOrigin || parsed.origin), token: response.data.clientToken, clientId: response.data.clientId || null, pairedAt: Date.now(), connectionId: crypto.randomUUID() };
    if (connection.origin !== parsed.origin) return { ok: false, code: "pairing_failed" };
    if (generation !== started || connectionIdentity(await readConnection()) !== expectedConnection) return { ok: false, code: "connection_changed" };
    await replaceConnection(connection);
    return { ok: true, connection, bootstrap: { profile: response.data.profile, classifications: response.data.classifications } };
  }

  async function request(path, options = {}) {
    const started = generation;
    if (changing) return { ok: false, status: 0, code: "connection_changed" };
    const connection = await readConnection();
    if (!connection) return { ok: false, status: 401, code: "unpaired" };
    if (options.expectedOrigin && connection.origin !== options.expectedOrigin) return { ok: false, status: 0, code: "connection_changed" };
    if (Object.hasOwn(options, "expectedConnection") && options.expectedConnection !== connectionIdentity(connection)) return { ok: false, status: 0, code: "connection_changed" };
    if (changing || generation !== started) return { ok: false, status: 0, code: "connection_changed" };
    const response = await rawRequest(connection.origin, path, { ...options, token: connection.token });
    if (changing || generation !== started || connectionIdentity(connection) !== connectionIdentity(await readConnection())) return { ok: false, status: 0, code: "connection_changed" };
    if (!response.ok && response.status === 401) return { ...response, code: "revoked" };
    return response;
  }

  globalThis.LakomicsListApi = { CONNECTION_KEY, connectionIdentity, normalizeOrigin, parsePairing, readConnection, clearConnection, pair, request };
})();
