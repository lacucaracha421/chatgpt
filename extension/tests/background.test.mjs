import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");

test("keeps the connection token inside the service worker", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueJson({ entries: [] });

  const settings = await harness.api.handleMessage({ type: "settings:get" });
  const classifications = await harness.api.handleMessage({ type: "classifications:get" });

  assert.deepEqual(plain(settings), { ok: true, tokenConfigured: true });
  assert.equal(classifications.ok, true);
  assert.equal(
    harness.fetchCalls[0].options.headers.Authorization,
    "Bearer 0123456789abcdef0123456789abcdef",
  );
  assert.equal(JSON.stringify(settings).includes("0123456789abcdef"), false);
});

test("caches classifications for thirty seconds and never serves stale data offline", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueJson({ entries: [{ id: "tag-1", kind: "tag", name: "Arona", parentId: null }] });

  const first = await harness.api.handleMessage({ type: "classifications:get" });
  harness.clock.now = 30_000;
  const cached = await harness.api.handleMessage({ type: "classifications:get" });
  assert.deepEqual(cached.entries, first.entries);
  assert.equal(harness.fetchCalls.length, 1);

  harness.clock.now = 30_001;
  harness.queueError(new TypeError("Failed to fetch"));
  const offline = await harness.api.handleMessage({ type: "classifications:get" });
  assert.deepEqual(plain(offline), { ok: false, code: "app_offline" });
  assert.equal(harness.fetchCalls.length, 2);
});

test("refresh bypasses cache and ingestion preserves server error codes", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueJson({ entries: [] });
  harness.queueJson({ entries: [{ id: "fresh" }] });
  harness.queueJson(
    { code: "classification_not_found", message: "Refresh classifications." },
    404,
  );

  await harness.api.handleMessage({ type: "classifications:get" });
  const refreshed = await harness.api.handleMessage({ type: "classifications:refresh" });
  const ingestion = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/ABC?format=jpg&name=orig",
      sourceUrl: "https://x.com/user/status/1/photo/1",
      classificationId: "deleted",
    },
  });

  assert.deepEqual(plain(refreshed.entries), [{ id: "fresh" }]);
  assert.deepEqual(plain(ingestion), {
    ok: false,
    code: "classification_not_found",
    message: "Refresh classifications.",
  });
  assert.equal(harness.fetchCalls[2].options.method, "POST");
});

function createHarness(initialStorage = {}) {
  const storage = { ...initialStorage };
  const responses = [];
  const fetchCalls = [];
  const clock = { now: 0 };
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((name) => name in storage).map((name) => [name, storage[name]]));
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
    },
  };
  async function fetch(url, options) {
    fetchCalls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      async json() { return next.body; },
    };
  }
  const context = {
    chrome,
    fetch,
    Date: { now: () => clock.now },
    console,
    globalThis: null,
    __LAKOMICS_TEST__: true,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "background.js" });
  return {
    api: context.LakomicsBackground,
    clock,
    fetchCalls,
    queueJson(body, status = 200) { responses.push({ body, status }); },
    queueError(error) { responses.push(error); },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
