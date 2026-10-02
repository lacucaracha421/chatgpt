(() => {
  "use strict";
  const STATE_KEY = "lakomics:list:state:v1";
  const OUTBOX_KEY = "lakomics:list:profile-outbox:v1";
  const HIDDEN_KEY = "lakomics:arc:hidden:v1";
  let refreshPromise = null;
  let flushPromise = null;
  let generation = 0;
  let mutations = Promise.resolve(), requests = Promise.resolve();
  const changed = () => ({ ok: false, code: "connection_changed" });

  // Serialize storage separately so offline edits remain durable while a request waits.
  function mutate(work, started = generation) {
    const result = mutations.then(() => started === generation ? work() : changed());
    mutations = result.catch(() => {});
    return result;
  }
  function requestSerial(work, started) {
    const result = requests.then(() => started === generation ? work() : changed());
    requests = result.catch(() => {});
    return result;
  }

  function normalizeState(value) {
    const tree = globalThis.LakomicsClassificationTree;
    if (!value || typeof value !== "object") return null;
    const entries = tree.cleanEntries(value.classifications?.entries);
    const profile = tree.normalizeProfile(value.profile);
    if (!entries.length && Number(value.classifications?.revision || 0) <= 0) return null;
    return {
      profile,
      hiddenClassificationIds: tree.cleanIds(value.hiddenClassificationIds),
      classifications: { entries, revision: Math.max(0, Number(value.classifications?.revision) || 0) },
      arcLayout: tree.reconcileArcLayout(entries, profile, value.arcLayout),
      syncedAt: Math.max(0, Number(value.syncedAt) || 0),
    };
  }

  async function readState() {
    const menu = globalThis.LakomicsMenuSettings;
    const stored = await chrome.storage.local.get([STATE_KEY, HIDDEN_KEY, ...(menu ? [menu.KEY] : [])]);
    const state = stored[STATE_KEY] && { ...stored[STATE_KEY], hiddenClassificationIds: stored[HIDDEN_KEY] };
    return normalizeState(menu ? menu.project(state, stored[menu.KEY]) : state);
  }

  async function writeState(value) {
    const menu = globalThis.LakomicsMenuSettings;
    const stored = await chrome.storage.local.get([STATE_KEY, HIDDEN_KEY, ...(menu ? [menu.KEY] : [])]);
    const state = { ...value, hiddenClassificationIds: stored[HIDDEN_KEY], arcLayout: value.arcLayout ?? normalizeState(stored[STATE_KEY])?.arcLayout, syncedAt: value.syncedAt ?? Date.now() };
    const normalized = normalizeState(menu ? menu.project(state, stored[menu.KEY]) : state);
    if (!normalized) throw new Error("Invalid Lakomics state");
    await chrome.storage.local.set({ [STATE_KEY]: normalized });
    return normalized;
  }

  function clear() {
    generation++;
    refreshPromise = flushPromise = null;
    requests = Promise.resolve();
    return mutate(async () => {
      await globalThis.LakomicsMenuSettings?.clear();
      await chrome.storage.local.remove([STATE_KEY, OUTBOX_KEY, HIDDEN_KEY]);
    });
  }

  function setHidden(ids) {
    return mutate(async () => {
      await globalThis.LakomicsMenuSettings?.record({ hiddenClassificationIds: ids }, await readState());
      await chrome.storage.local.set({ [HIDDEN_KEY]: globalThis.LakomicsClassificationTree.cleanIds(ids) });
      return { ok: true, state: await readState() };
    });
  }

  function seed(bootstrap) {
    return mutate(async () => {
      if (!bootstrap?.profile || !bootstrap?.classifications) return null;
      return writeState({ ...bootstrap, profile: await overlayPending(bootstrap.profile), syncedAt: Date.now() });
    });
  }

  function refresh({ forceMenuSettings = false } = {}) {
    if (refreshPromise) return refreshPromise;
    const started = generation;
    const promise = requestSerial(async () => {
      await drain(started);
      if (started !== generation) return changed();
      const response = await globalThis.LakomicsListApi.request("/v1/extension/bootstrap");
      if (started !== generation) return changed();
      if (!response.ok) return { ok: false, code: response.code || `http_${response.status}` };
      const state = await mutate(async () => {
        if (!response.data?.profile || !response.data?.classifications) return null;
        return writeState({ ...response.data, profile: await overlayPending(response.data.profile), syncedAt: Date.now() });
      }, started);
      if (started !== generation) return changed();
      if (!state) return { ok: false, code: "invalid_state" };
      await globalThis.LakomicsMenuSettings?.sync({ force: forceMenuSettings });
      if (started !== generation) return changed();
      return { ok: true, state: await readState() };
    }, started).finally(() => { if (refreshPromise === promise) refreshPromise = null; });
    refreshPromise = promise;
    return promise;
  }

  async function getState({ refreshIfStale = true } = {}) {
    let state = await readState();
    if (!state) {
      const refreshed = await refresh();
      return refreshed.ok ? { ok: true, state: refreshed.state, stale: false } : refreshed;
    }
    await globalThis.LakomicsMenuSettings?.sync();
    state = await readState();
    if (!state) return { ok: false, code: "state_missing" };
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
    return Array.isArray(stored[OUTBOX_KEY]) ? stored[OUTBOX_KEY].filter(item => item?.patch && typeof item.patch === "object") : [];
  }

  function mergePatch(previous, next) {
    return {
      ...previous, ...next,
      ...(previous.listOrderPatch || next.listOrderPatch ? { listOrderPatch: { ...previous.listOrderPatch, ...next.listOrderPatch } } : {}),
      ...(previous.preferences || next.preferences ? { preferences: { ...previous.preferences, ...next.preferences } } : {}),
    };
  }

  async function overlayPending(profile) {
    for (const item of await readOutbox()) profile = applyLocal(profile, item.patch);
    return profile;
  }

  async function enqueue(patch) {
    const merged = (await readOutbox()).reduce((all, item) => mergePatch(all, item.patch), {});
    await chrome.storage.local.set({ [OUTBOX_KEY]: [{ id: crypto.randomUUID(), patch: mergePatch(merged, patch) }] });
  }

  async function sendPatch(item, started, allowConflictRetry = true) {
    const state = await readState();
    if (started !== generation) return changed();
    if (!state) return { ok: false, code: "state_missing" };
    const response = await globalThis.LakomicsListApi.request("/v1/extension/profile", {
      method: "PATCH", body: { ...item.patch, expectedRevision: state.profile.revision }, timeoutMs: 10000,
    });
    if (started !== generation) return changed();
    if (response.ok) {
      return mutate(async () => {
        // Never acknowledge an edit that arrived while this request was in flight.
        const remaining = (await readOutbox()).filter(pending => pending.id !== item.id);
        await chrome.storage.local.set({ [OUTBOX_KEY]: remaining });
        const current = await readState();
        const next = await writeState({ ...current, profile: await overlayPending(response.data), syncedAt: Date.now() });
        return { ok: true, state: next };
      }, started);
    }
    if (response.status === 409 && allowConflictRetry) {
      const current = response.data?.detail?.profile;
      if (!current) return { ok: false, code: "profile_conflict" };
      await mutate(async () => writeState({ ...await readState(), profile: await overlayPending(current), syncedAt: Date.now() }), started);
      return sendPatch(item, started, false);
    }
    return { ok: false, code: response.code || (response.status === 401 ? "revoked" : "sync_failed") };
  }

  async function patchProfile(patch) {
    const started = generation;
    const optimistic = await mutate(async () => {
      const state = await readState();
      if (!state) return { ok: false, code: "state_missing" };
      if (patch.listOrderPatch) await globalThis.LakomicsMenuSettings?.record(patch, state);
      await enqueue(patch);
      return { ok: true, state: await writeState({ ...state, profile: applyLocal(state.profile, patch), syncedAt: state.syncedAt }) };
    }, started);
    if (!optimistic.ok || started !== generation) return started !== generation ? changed() : optimistic;
    const sent = await flush();
    if (started !== generation) return changed();
    if (!sent.ok && sent.code === "revoked") return sent;
    const pending = (await readOutbox()).length > 0;
    if (started !== generation) return changed();
    return { ok: true, state: await readState(), ...(pending ? { pending: true } : {}) };
  }

  async function drain(started) {
    let completed = 0;
    while (started === generation) {
      const item = await mutate(async () => (await readOutbox())[0], started);
      if (started !== generation) return changed();
      if (!item) return { ok: true, completed };
      const result = await sendPatch(item, started);
      if (!result.ok) return { ...result, completed };
      completed++;
    }
    return changed();
  }

  function flush() {
    if (flushPromise) return flushPromise;
    const started = generation;
    const promise = requestSerial(() => drain(started), started)
      .finally(() => { if (flushPromise === promise) flushPromise = null; });
    flushPromise = promise;
    return promise;
  }

  globalThis.LakomicsProfileStore = { STATE_KEY, OUTBOX_KEY, HIDDEN_KEY, setHidden, normalizeState, readState, seed, refresh, getState, patchProfile, flush, clear };
})();
