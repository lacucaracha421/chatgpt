(() => {
  "use strict";
  const STATE_KEY = "lakomics:list:state:v1";
  const OUTBOX_KEY = "lakomics:list:profile-outbox:v1";
  const MAX_OUTBOX = 32;
  let refreshPromise = null;
  let flushPromise = null;

  function normalizeState(value) {
    const tree = globalThis.LakomicsClassificationTree;
    if (!value || typeof value !== "object") return null;
    const entries = tree.cleanEntries(value.classifications?.entries);
    const profile = tree.normalizeProfile(value.profile);
    if (!entries.length && Number(value.classifications?.revision || 0) <= 0) return null;
    return {
      profile,
      classifications: { entries, revision: Math.max(0, Number(value.classifications?.revision) || 0) },
      syncedAt: Math.max(0, Number(value.syncedAt) || 0),
    };
  }

  async function readState() {
    const stored = await chrome.storage.local.get([STATE_KEY]);
    return normalizeState(stored[STATE_KEY]);
  }

  async function writeState(value) {
    const normalized = normalizeState({ ...value, syncedAt: value.syncedAt ?? Date.now() });
    if (!normalized) throw new Error("Invalid Lakomics state");
    await chrome.storage.local.set({ [STATE_KEY]: normalized });
    return normalized;
  }

  async function clear() {
    await chrome.storage.local.remove([STATE_KEY, OUTBOX_KEY]);
  }

  async function seed(bootstrap) {
    if (!bootstrap?.profile || !bootstrap?.classifications) return null;
    const state = await writeState({ ...bootstrap, syncedAt: Date.now() });
    return state;
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    const promise = globalThis.LakomicsListApi.request("/v1/extension/bootstrap")
      .then(async (response) => {
        if (!response.ok) return { ok: false, code: response.code || `http_${response.status}` };
        const state = await seed(response.data);
        return state ? { ok: true, state } : { ok: false, code: "invalid_state" };
      }).finally(() => { if (refreshPromise === promise) refreshPromise = null; });
    refreshPromise = promise;
    return promise;
  }

  async function getState({ refreshIfStale = true } = {}) {
    let state = await readState();
    if (!state) {
      const refreshed = await refresh();
      return refreshed.ok ? { ok: true, state: refreshed.state, stale: false } : refreshed;
    }
    if (refreshIfStale && Date.now() - state.syncedAt > 30_000) void flush().then(() => refresh()).catch(() => {});
    return { ok: true, state, stale: Date.now() - state.syncedAt > 60_000 };
  }

  function applyLocal(profile, patch) {
    const next = globalThis.LakomicsClassificationTree.normalizeProfile(profile);
    if (Array.isArray(patch.pinnedClassificationIds)) next.pinnedClassificationIds = globalThis.LakomicsClassificationTree.cleanIds(patch.pinnedClassificationIds);
    if (patch.listOrderPatch && typeof patch.listOrderPatch === "object") {
      next.listOrder = { ...next.listOrder };
      for (const [key, ids] of Object.entries(patch.listOrderPatch)) {
        if (ids === null) delete next.listOrder[key];
        else next.listOrder[key] = globalThis.LakomicsClassificationTree.cleanIds(ids);
      }
    }
    if (patch.preferences && typeof patch.preferences === "object") next.preferences = { ...next.preferences, ...patch.preferences };
    return next;
  }

  async function readOutbox() {
    const stored = await chrome.storage.local.get([OUTBOX_KEY]);
    return Array.isArray(stored[OUTBOX_KEY]) ? stored[OUTBOX_KEY].filter((item) => item && typeof item === "object").slice(-MAX_OUTBOX) : [];
  }

  async function enqueue(patch) {
    const outbox = await readOutbox();
    const last = outbox.at(-1);
    if (last) {
      if (patch.listOrderPatch && last.patch?.listOrderPatch) last.patch.listOrderPatch = { ...last.patch.listOrderPatch, ...patch.listOrderPatch };
      else if (patch.preferences && last.patch?.preferences) last.patch.preferences = { ...last.patch.preferences, ...patch.preferences };
      else if (patch.pinnedClassificationIds && last.patch?.pinnedClassificationIds) last.patch.pinnedClassificationIds = patch.pinnedClassificationIds;
      else outbox.push({ id: crypto.randomUUID(), patch });
    } else outbox.push({ id: crypto.randomUUID(), patch });
    await chrome.storage.local.set({ [OUTBOX_KEY]: outbox.slice(-MAX_OUTBOX) });
  }

  async function sendPatch(patch, allowConflictRetry = true) {
    const state = await readState();
    if (!state) return { ok: false, code: "state_missing" };
    const response = await globalThis.LakomicsListApi.request("/v1/extension/profile", {
      method: "PATCH", body: { expectedRevision: state.profile.revision, ...patch }, timeoutMs: 10000,
    });
    if (response.ok) {
      const next = await writeState({ ...state, profile: response.data, syncedAt: Date.now() });
      return { ok: true, state: next };
    }
    if (response.status === 409 && allowConflictRetry) {
      const current = response.data?.detail?.profile;
      if (!current) return { ok: false, code: "profile_conflict" };
      await writeState({ ...state, profile: current, syncedAt: Date.now() });
      return sendPatch(patch, false);
    }
    return { ok: false, code: response.code || (response.status === 401 ? "revoked" : "sync_failed") };
  }

  async function patchProfile(patch) {
    const state = await readState();
    if (!state) return { ok: false, code: "state_missing" };
    const optimistic = await writeState({ ...state, profile: applyLocal(state.profile, patch), syncedAt: state.syncedAt });
    const sent = await sendPatch(patch);
    if (sent.ok) return sent;
    if (sent.code === "revoked") return sent;
    await enqueue(patch);
    return { ok: true, state: optimistic, pending: true };
  }

  async function flush() {
    if (flushPromise) return flushPromise;
    const promise = (async () => {
      let outbox = await readOutbox();
      let completed = 0;
      while (outbox.length) {
        const item = outbox[0];
        const result = await sendPatch(item.patch);
        if (!result.ok) return { ok: false, code: result.code, completed };
        outbox = outbox.slice(1);
        completed += 1;
        await chrome.storage.local.set({ [OUTBOX_KEY]: outbox });
      }
      return { ok: true, completed };
    })().finally(() => { if (flushPromise === promise) flushPromise = null; });
    flushPromise = promise;
    return promise;
  }

  globalThis.LakomicsProfileStore = { STATE_KEY, OUTBOX_KEY, normalizeState, readState, seed, refresh, getState, patchProfile, flush, clear };
})();
