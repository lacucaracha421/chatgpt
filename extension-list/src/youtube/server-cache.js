(() => {
  "use strict";
  const ENDPOINT = "/v1/extension/subtitles";
  const uploads = new Set();
  const string = (value, max) => typeof value === "string" && value.length <= max;
  function validIdentity(video, track, mode) {
    return string(video, 20) && /^[A-Za-z0-9_-]{6,20}$/.test(video) &&
      string(track, 40) && /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(track) &&
      string(mode, 80) && /^[\x20-\x7e]+$/.test(mode);
  }
  function validate(value, identity) {
    if (!value || value.version !== 1 || !validIdentity(value.video, value.track, value.mode) ||
        (identity && (value.video !== identity.video || value.track !== identity.track || value.mode !== identity.mode)) ||
        !string(value.model, 80) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 ||
        !(value.register === null || ["haeyo", "hapnida", "banmal"].includes(value.register)) ||
        !Array.isArray(value.glossary) || value.glossary.length > 240 ||
        !value.glossary.every(term => term && string(term.source, 80) && string(term.korean, 80)) ||
        !Array.isArray(value.cues) || value.cues.length < 1 || value.cues.length > 20000 ||
        !value.cues.every(cue => cue && Number.isSafeInteger(cue.startMs) && Number.isSafeInteger(cue.endMs) &&
          cue.startMs >= 0 && cue.endMs >= cue.startMs && string(cue.text, 500) &&
          (!Object.hasOwn(cue, "orig") || string(cue.orig, 500)))) return null;
    const result = { video: value.video, track: value.track, mode: value.mode, model: value.model,
      createdAt: value.createdAt, register: value.register,
      glossary: value.glossary.map(({ source, korean }) => ({ source, korean })),
      cues: value.cues.map(({ startMs, endMs, text, orig }) => ({ startMs, endMs, text, ...(orig === undefined ? {} : { orig }) }))
        .sort((a, b) => a.startMs - b.startMs) };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 4 * 1024 * 1024) return null;
    return result;
  }
  async function context() {
    const api = globalThis.LakomicsListApi;
    const connection = await api.readConnection();
    return connection ? { expectedConnection: api.connectionIdentity(connection), timeoutMs: 5000 } : null;
  }
  async function get(identity, connection) {
    if (!connection || !validIdentity(identity.video, identity.track, identity.mode)) return null;
    try {
      const query = new URLSearchParams(identity);
      const response = await globalThis.LakomicsListApi.request(`${ENDPOINT}?${query}`, connection);
      return response.status === 200 ? validate(response.data, identity) : null;
    } catch { return null; }
  }
  function put(value, connection, current = () => true) {
    const body = validate({ ...value, version: 1 });
    if (!body || !connection || !current()) return;
    const job = (async () => {
      for (let attempt = 0; attempt < 2 && current(); attempt++) {
        try {
          const response = await globalThis.LakomicsListApi.request(ENDPOINT, { ...connection, method: "PUT", body });
          if (response.status === 200) return;
        } catch {}
      }
      if (current()) console.warn("[Lakomics YouTube] server cache upload failed");
    })();
    uploads.add(job);
    void job.finally(() => uploads.delete(job));
  }
  async function clear() {
    const connection = await context();
    if (!connection) return { ok: false, code: "unpaired" };
    await Promise.allSettled([...uploads]);
    try {
      const response = await globalThis.LakomicsListApi.request(ENDPOINT, { ...connection, method: "DELETE" });
      return response.status === 200 && response.data?.ok === true
        ? { ok: true, deleted: Number(response.data.deleted) || 0 } : { ok: false, code: "server_unavailable" };
    } catch { return { ok: false, code: "server_unavailable" }; }
  }
  globalThis.LakomicsYouTube.serverCache = { validIdentity, validate, context, get, put, clear };
})();
