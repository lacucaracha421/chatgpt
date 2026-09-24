(() => {
  "use strict";
  const KEY = "lakomics:arc:server-settings:v1";
  const PATH = "/v1/extension/settings";
  const READ_INTERVAL = 5 * 60_000;
  const DEBOUNCE_MS = 750;
  let timer = null, inFlight = null, epoch = 0;
  let edits = Promise.resolve();

  // Only local storage mutations are serialized. Network waits never block a
  // local edit, and a response cannot acknowledge an edit it did not send.
  function mutate(operation) {
    const result = edits.then(operation);
    edits = result.catch(() => {});
    return result;
  }
  async function read() {
    return (await chrome.storage.local.get([KEY]))[KEY] || {};
  }
  async function save(value) { await chrome.storage.local.set({ [KEY]: value }); }
  function documentFrom(state) {
    return {
      schemaVersion: 1,
      listOrder: state?.profile?.listOrder || {},
      hiddenClassificationIds: state?.hiddenClassificationIds || [],
    };
  }
  function validRemote(value) {
    return value?.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0
      && value.listOrder && typeof value.listOrder === "object" && !Array.isArray(value.listOrder)
      && Object.values(value.listOrder).every(ids => Array.isArray(ids) && ids.every(id => typeof id === "string"))
      && Array.isArray(value.hiddenClassificationIds) && value.hiddenClassificationIds.every(id => typeof id === "string");
  }
  function project(state, metadata) {
    if (!state || !metadata?.document) return state;
    const live = new Set(state.classifications.entries.map(entry => entry.id));
    const tree = globalThis.LakomicsClassificationTree;
    const listOrder = Object.fromEntries(Object.entries(metadata.document.listOrder)
      .filter(([parent]) => parent === "__root__" || live.has(parent))
      .map(([parent, ids]) => [parent, tree.cleanIds(ids, live)]));
    const profile = { ...state.profile, listOrder };
    const model = tree.createModel(state.classifications.entries, profile);
    const arcLayout = Object.fromEntries(Object.entries(state.arcLayout || {}).map(([parent, layout]) => {
      const siblings = new Set(parent === "__root__"
        ? model.rootItems().map(item => item.entry.id) : model.children(parent).map(entry => entry.id));
      return [parent, { ...layout, slots: (layout.slots || []).filter(id => siblings.has(id)) }];
    }));
    return {
      ...state,
      profile,
      hiddenClassificationIds: tree.cleanIds(metadata.document.hiddenClassificationIds, live),
      // Compact removed slots before reconciliation so new folders append.
      // Existing positions survive snapshot reordering; explicit order changes
      // still reset the layout through its normal intent comparison.
      arcLayout,
    };
  }
  function schedule() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void sync({ push: true }).catch(() => {});
    }, DEBOUNCE_MS);
  }
  async function record(patch, state) {
    await mutate(async () => {
      const current = await read();
      const document = structuredClone(current.document || documentFrom(state));
      if (patch.listOrderPatch) {
        for (const [key, ids] of Object.entries(patch.listOrderPatch)) {
          if (ids === null) delete document.listOrder[key];
          else Object.defineProperty(document.listOrder, key, {
            value: globalThis.LakomicsClassificationTree.cleanIds(ids), enumerable: true, configurable: true, writable: true,
          });
        }
      }
      if (patch.hiddenClassificationIds) document.hiddenClassificationIds = globalThis.LakomicsClassificationTree.cleanIds(patch.hiddenClassificationIds);
      await save({ ...current, document, dirty: true, generation: (current.generation || 0) + 1 });
    });
    schedule();
  }
  async function clear() {
    epoch++;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    inFlight = null;
    await mutate(() => chrome.storage.local.remove([KEY]));
  }

  async function sync({ force = false, push = false } = {}) {
    if (inFlight) return inFlight;
    const started = epoch;
    let origin;
    const request = options => {
      if (epoch !== started) return Promise.resolve({ ok: false, status: 0 });
      return globalThis.LakomicsListApi.request(PATH, { timeoutMs: 4000, expectedOrigin: origin, ...options });
    };
    async function failed(response) {
      if (response.status === 404) await mutate(async () => {
        if (epoch !== started) return;
        await save({ ...await read(), unsupported: true, checkedAt: Date.now() });
      });
      return { ok: false, status: response.status };
    }
    async function pull() {
      const response = await request({});
      if (!response.ok) return failed(response);
      if (!validRemote(response.data)) return { ok: false };
      await mutate(async () => {
        if (epoch !== started) return;
        const current = await read();
        const remote = response.data;
        let document = current.document, dirty = current.dirty || false;
        if (!dirty && (!document || remote.revision > (current.revision ?? -1))) {
          if (remote.revision > 0) {
            document = { schemaVersion: 1, listOrder: remote.listOrder, hiddenClassificationIds: remote.hiddenClassificationIds };
          } else {
            // First contact with a newly wired server: migrate existing local
            // hides and the legacy profile order without overwriting a backup.
            document = documentFrom(await globalThis.LakomicsProfileStore.readState());
            dirty = Boolean(Object.keys(document.listOrder).length || document.hiddenClassificationIds.length);
          }
        }
        await save({ ...current, document, dirty, revision: remote.revision, unsupported: false, checkedAt: Date.now() });
      });
      return { ok: epoch === started };
    }
    const work = (async () => {
      const connection = await globalThis.LakomicsListApi.readConnection();
      if (!connection || epoch !== started) return { ok: false };
      origin = connection.origin;
      await edits;
      let current = await read();
      const due = !current.checkedAt || Date.now() - current.checkedAt >= READ_INTERVAL;
      if (current.unsupported && !due) return { ok: false, status: 404 };
      if (force || due || (push && current.revision === undefined)) {
        // Persist throttling across service-worker suspension, including offline
        // failures. No alarms, intervals, or background polling are needed.
        await mutate(async () => {
          if (epoch === started) await save({ ...await read(), checkedAt: Date.now() });
        });
        const result = await pull();
        if (!result.ok) return result;
      }
      if (epoch !== started) return { ok: false };
      if (!push && timer !== null) return { ok: true };
      for (let attempt = 0; attempt < 2; attempt++) {
        current = await read();
        if (!current.dirty || !current.document || current.revision === undefined) return { ok: true };
        const response = await request({ method: "PUT", body: { ...current.document, expectedRevision: current.revision } });
        if (epoch !== started) return { ok: false };
        if (response.ok && validRemote(response.data)) {
          let pending = false;
          await mutate(async () => {
            if (epoch !== started) return;
            const latest = await read();
            pending = latest.generation !== current.generation;
            await save({ ...latest, revision: response.data.revision, dirty: pending });
          });
          if (pending) schedule();
          return { ok: true };
        }
        if (response.status !== 409 || attempt === 1) return failed(response);
        // Last local document wins, using a fresh revision. Pull never replaces
        // dirty local edits, including edits made while the request was running.
        const result = await pull();
        if (!result.ok) return result;
      }
    })();
    const promise = work.finally(() => { if (inFlight === promise) inFlight = null; });
    inFlight = promise;
    return promise;
  }

  globalThis.LakomicsMenuSettings = { KEY, PATH, READ_INTERVAL, DEBOUNCE_MS, project, record, sync, clear };
})();
