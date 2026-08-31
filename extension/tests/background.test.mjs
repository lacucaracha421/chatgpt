import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const layoutSource = fs.readFileSync(new URL("../src/layout.js", import.meta.url), "utf8");
const defaultsSource = fs.readFileSync(new URL("../src/defaults.js", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../src/background-worker.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

const workerImportBlock = `  if (typeof importScripts === "function") {
    if (!globalThis.LakomicsRadial) importScripts("layout.js");
    if (!globalThis.LakomicsDefaults) importScripts("defaults.js");
  }

`;
const workerHeader = `// Generated classic MV3 service worker bundle for Android Chromium/Quetta.
// Keep in sync with layout.js + defaults.js + background.js; tests verify this exactly.

`;

test("MV3 background worker is a self-contained bundle with no importScripts fetches", () => {
  assert.equal(manifest.background?.service_worker, "src/background-worker.js");
  const normalizeNewlines = (value) => value.replace(/\r\n/g, "\n");
  const normalizedSource = normalizeNewlines(source);
  const normalizedLayout = normalizeNewlines(layoutSource);
  const normalizedDefaults = normalizeNewlines(defaultsSource);
  assert.equal(normalizedSource.includes(workerImportBlock), true);
  const expected = workerHeader
    + normalizedLayout.trimEnd() + "\n\n"
    + normalizedDefaults.trimEnd() + "\n\n"
    + normalizedSource.replace(workerImportBlock, "");
  assert.equal(normalizeNewlines(workerSource), expected);
  assert.doesNotMatch(workerSource, /\bimportScripts\s*\(/);
});

test("keeps the connection token inside the service worker", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueJson({ entries: [] });

  const settings = await harness.api.handleMessage({ type: "settings:get" });
  const classifications = await harness.api.handleMessage({ type: "classifications:get" });

  assert.equal(settings.ok, true);
  assert.equal(settings.tokenConfigured, true);
  assert.equal(settings.preferences.saveMode, "auto");
  assert.equal(settings.preferences.touchLongPressMs, 450);
  assert.equal(settings.preferences.autoLikeOnSave, true);
  assert.equal(settings.downloadsApiAvailable, true);
  assert.equal(classifications.ok, true);
  assert.equal(
    harness.fetchCalls[0].options.headers.Authorization,
    "Bearer 0123456789abcdef0123456789abcdef",
  );
  assert.equal(
    harness.fetchCalls[0].options.headers["X-Lakomics-Extension-Id"],
    "nclkmjmmlcdaeomgadndeangccfidfbk",
  );
  assert.equal(JSON.stringify(settings).includes("0123456789abcdef"), false);
});

test("CRX runtime id keeps the legacy PC extension identity header", async () => {
  const harness = createHarness(
    { connectionToken: "0123456789abcdef0123456789abcdef" },
    "golmemaokleeigalndaacoolafdlmoai",
  );
  harness.queueJson({ entries: [] });

  const response = await harness.api.handleMessage({ type: "classifications:get" });

  assert.equal(response.ok, true);
  assert.equal(
    harness.fetchCalls[0].options.headers["X-Lakomics-Extension-Id"],
    "nclkmjmmlcdaeomgadndeangccfidfbk",
  );
});

test("legacy app-only preference migrates to auto and preserves the last classifications offline", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    preferences: { saveMode: "app" },
  });
  harness.queueJson({ entries: [{ id: "tag-1", kind: "tag", name: "Arona", parentId: null }] });

  const first = await harness.api.handleMessage({ type: "classifications:get" });
  harness.clock.now = 30_000;
  const cached = await harness.api.handleMessage({ type: "classifications:get" });
  assert.deepEqual(cached.entries, first.entries);
  assert.equal(harness.fetchCalls.length, 1);

  harness.clock.now = 30_001;
  harness.queueError(new TypeError("Failed to fetch"));
  const offline = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(offline.ok, true);
  assert.equal(offline.classificationSource, "app-cache");
  assert.deepEqual(plain(offline.entries), plain(first.entries));
  await new Promise((resolve) => setImmediate(resolve));
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
    httpStatus: 404,
    message: "Refresh classifications.",
  });
  assert.equal(harness.fetchCalls[2].options.method, "POST");
});

test("reconciles and stores layout without exposing storage to page scripts", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    radialLayout: { version: 1, parents: { __root__: [["deleted", null, null, null, null, null]] } },
  });
  harness.queueJson({
    entries: [{ id: "fresh", kind: "root", name: "Fresh", parentId: null }],
  });

  const response = await harness.api.handleMessage({ type: "classifications:refresh" });
  const stored = await harness.api.handleMessage({ type: "layout:get" });

  assert.equal(response.layout.parents.__root__[0][0], "fresh");
  assert.deepEqual(plain(stored.layout), plain(response.layout));
  assert.deepEqual(plain(harness.storage.radialLayout), plain(response.layout));
});

test("pinned:get and pinned:set round-trip classification ids in storage", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });

  const before = await harness.api.handleMessage({ type: "pinned:get" });
  assert.deepEqual(plain(before), { ok: true, pinnedIds: [] });

  const set = await harness.api.handleMessage({ type: "pinned:set", pinnedIds: ["reverse"] });
  assert.deepEqual(plain(set), { ok: true });

  const after = await harness.api.handleMessage({ type: "pinned:get" });
  assert.deepEqual(plain(after), { ok: true, pinnedIds: ["reverse"] });
  assert.deepEqual(plain(harness.storage.pinnedClassificationIds), ["reverse"]);
});

test("pinned:set rejects non-array pinnedIds", async () => {
  const harness = createHarness();

  const response = await harness.api.handleMessage({ type: "pinned:set", pinnedIds: "reverse" });

  assert.deepEqual(plain(response), { ok: false, code: "invalid_pinned" });
});

test("classifications:refresh includes persisted pinned ids", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    pinnedClassificationIds: ["reverse"],
  });
  harness.queueJson({ entries: [] });

  const response = await harness.api.handleMessage({ type: "classifications:refresh" });

  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.pinnedIds), ["reverse"]);
});

test("classifications:get serves fresh pinned ids after pinned:set without cache staleness", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueJson({ entries: [] });

  const before = await harness.api.handleMessage({ type: "classifications:get" });
  assert.deepEqual(plain(before.pinnedIds), []);

  const set = await harness.api.handleMessage({ type: "pinned:set", pinnedIds: ["reverse"] });
  assert.deepEqual(plain(set), { ok: true });

  const after = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(after.ok, true);
  assert.deepEqual(plain(after.pinnedIds), ["reverse"]);
  assert.equal(harness.fetchCalls.length, 1);
});


test("auto mode falls back to local classifications when the app is unavailable", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueError(new TypeError("Failed to fetch"));

  const response = await harness.api.handleMessage({ type: "classifications:get" });

  assert.equal(response.ok, true);
  assert.equal(response.classificationSource, "local");
  assert.equal(response.fallbackCode, "app_offline");
  assert.deepEqual(plain(response.entries.map((entry) => entry.name)), ["리버스", "명조", "젠레스", "게임", "만화", "기타"]);
});

test("offline backoff skips the network probe and serves the snapshot immediately", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    preferences: { saveMode: "auto" },
    lastAppClassifications: {
      version: 2, baseUrl: "http://127.0.0.1:32145", endpointSource: "app",
      entries: [{ id: "game", kind: "root", name: "게임", parentId: null }],
      layout: { version: 1, parents: {} }, pinnedIds: [], savedAt: 1,
    },
  });
  // 첫 시도는 실제 네트워크로 나가 실패한다.
  harness.queueError(new TypeError("Failed to fetch"));
  await harness.api.handleMessage({ type: "classifications:get" });
  const callsAfterFailure = harness.fetchCalls.length;
  assert.equal(callsAfterFailure, 1);

  // backoff 60초 안의 재호출은 네트워크를 건드리지 않고 스냅샷을 바로 쓴다.
  harness.clock.now = 30_000;
  const cached = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(cached.classificationSource, "app-cache");
  assert.equal(harness.fetchCalls.length, callsAfterFailure);

  // 60초가 지나면 캐시를 즉시 주고 배경에서 네트워크를 다시 시도한다.
  harness.clock.now = 90_001;
  harness.queueJson({ entries: [{ id: "game", kind: "root", name: "게임", parentId: null }] });
  const refreshed = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(refreshed.classificationSource, "app-cache");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.fetchCalls.length, callsAfterFailure + 1);
});

test("failed saved-index probes also honor the offline backoff", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueError(new TypeError("Failed to fetch"));
  await harness.api.handleMessage({ type: "saved-index:get" });
  const callsAfterFailure = harness.fetchCalls.length;

  harness.clock.now = 10_000;
  const cached = await harness.api.handleMessage({ type: "saved-index:get" });
  assert.equal(cached.ok, false);
  assert.equal(harness.fetchCalls.length, callsAfterFailure);
});

test("classification diagnostics from settings:get reflect the latest lookup", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.setPlatform("android");
  harness.queueJson({
    entries: [
      { id: "game", kind: "root", name: "게임", parentId: null },
      { id: "manga", kind: "root", name: "만화", parentId: null },
    ],
  });

  await harness.api.handleMessage({ type: "classifications:get" });
  const settings = await harness.api.handleMessage({ type: "settings:get" });
  assert.equal(settings.classificationDiagnostics.source, "cloud");
  assert.equal(settings.classificationDiagnostics.count, 2);
  assert.equal(settings.classificationDiagnostics.fallbackReason, null);
});

test("settings:get marks the six-item local fallback explicitly", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueError(new TypeError("Failed to fetch"));
  await harness.api.handleMessage({ type: "classifications:get" });

  const settings = await harness.api.handleMessage({ type: "settings:get" });
  assert.equal(settings.classificationDiagnostics.source, "local");
  assert.equal(settings.classificationDiagnostics.fallbackReason, "app_offline");
  assert.equal(settings.classificationDiagnostics.count, 6);
  assert.equal(settings.lastConnectionFailure.code, "app_offline");
});

test("saved-media diagnostics report the active snapshot source and key count", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "https://collector.tail.ts.net" },
  });
  harness.setPlatform("android");
  harness.queueJson({ keys: ["123:1", "124:2"] });
  const index = await harness.api.handleMessage({ type: "saved-index:get" });
  assert.equal(index.indexSource, "cloud");

  const settings = await harness.api.handleMessage({ type: "settings:get" });
  assert.equal(settings.savedMediaDiagnostics.source, "cloud");
  assert.equal(settings.savedMediaDiagnostics.keyCount, 2);
});

test("collector failure is recorded without leaking token or endpoint material", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "https://collector.tail.ts.net" },
  });
  harness.setPlatform("android");
  harness.queueError(new TypeError("offline"));
  await harness.api.handleMessage({ type: "saved-index:get" });

  const settings = await harness.api.handleMessage({ type: "settings:get" });
  assert.equal(settings.lastCollectorFailure.code, "collector_offline");
  assert.equal(typeof settings.lastCollectorFailure.failedAt, "number");
});

test("save mode changes route saves between pc and cloud without duplicate invocations", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    connectionToken: "0123456789abcdef0123456789abcdef",
    preferences: { saveMode: "cloud" },
  });
  harness.queueJson({ ok: true, created: true, capture: { id: "c-1", status: "pending" } });
  const payload = {
    source: "x",
    mediaUrl: "https://pbs.twimg.com/media/MODE?format=jpg&name=orig",
    sourceUrl: "https://x.com/artist/status/7777/photo/1",
    classificationId: "game",
    classificationName: "Game",
    classificationSource: "app-cache",
  };

  const cloudSaved = await harness.api.handleMessage({ type: "ingestion:create", payload });
  assert.equal(cloudSaved.ok, true);
  assert.equal(cloudSaved.status, "captured");
  assert.equal(harness.downloadCalls.length, 0);
  assert.match(harness.fetchCalls[0].url, /\/v1\/captures$/);
  const callsAfterCloud = harness.fetchCalls.length;

  await harness.api.handleMessage({
    type: "settings:set-preferences",
    preferences: { saveMode: "pc" },
  });
  harness.queueJson({ entries: [] });
  const appSaved = await harness.api.handleMessage({ type: "ingestion:create", payload });
  assert.equal(appSaved.ok, true);
  assert.match(harness.fetchCalls[callsAfterCloud].url, /\/v1\/ingestions$/);
  assert.equal(harness.downloadCalls.length, 0);
});

test("pc save mode reports a direct error instead of falling back to cloud", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    connectionToken: "0123456789abcdef0123456789abcdef",
    preferences: { saveMode: "pc" },
  });
  harness.queueError(new TypeError("Failed to fetch"));
  harness.queueError(new TypeError("Failed to fetch"));
  harness.queueError(new TypeError("Failed to fetch"));

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/PCONLY?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/8888/photo/1",
      classificationId: "game",
      classificationName: "Game",
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, false);
  assert.equal(harness.fetchCalls.every((call) => call.url.includes("/v1/ingestions")), true);
  assert.equal(harness.downloadCalls.length, 0);
});

test("local tree remains intact after switching download modes back and forth", async () => {
  const harness = createHarness({ preferences: { saveMode: "auto" } });
  const treeResponse = await harness.api.handleMessage({ type: "local-tree:get" });
  const originalTree = plain(treeResponse.tree);

  await harness.api.handleMessage({
    type: "settings:set-preferences",
    preferences: { saveMode: "download" },
  });
  const afterDownload = await harness.api.handleMessage({ type: "local-tree:get" });
  assert.deepEqual(plain(afterDownload.tree), originalTree);

  await harness.api.handleMessage({
    type: "settings:set-preferences",
    preferences: { saveMode: "auto" },
  });
  const restored = await harness.api.handleMessage({ type: "local-tree:get" });
  assert.deepEqual(plain(restored.tree), originalTree);
});

test("settings:get reports the last connection failure for diagnostics", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueError(new TypeError("Failed to fetch"));
  await harness.api.handleMessage({ type: "classifications:get" });

  const settings = await harness.api.handleMessage({ type: "settings:get" });
  assert.equal(settings.lastConnectionFailure.code, "app_offline");
  assert.equal(settings.lastConnectionFailure.failedAt, harness.clock.now);
});


test("auto mode preserves the last app tag layout and pinned order while Lakomics is offline", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    preferences: { saveMode: "auto" },
  });
  harness.queueJson({
    entries: [
      { id: "a", kind: "root", name: "A", parentId: null },
      { id: "b", kind: "root", name: "B", parentId: null },
      { id: "a1", kind: "tag", name: "A1", parentId: "a" },
      { id: "a2", kind: "tag", name: "A2", parentId: "a" },
    ],
  });

  const online = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(online.ok, true);

  const customLayout = plain(online.layout);
  customLayout.parents.__root__[0] = ["b", "a", null, null, null, null];
  customLayout.parents.a[0] = ["a2", "a1", null, null, null, null];
  await harness.api.handleMessage({ type: "layout:set", layout: customLayout });
  await harness.api.handleMessage({ type: "pinned:set", pinnedIds: ["a2"] });

  harness.clock.now = 30_001;
  harness.queueError(new TypeError("Failed to fetch"));
  const offline = await harness.api.handleMessage({ type: "classifications:get" });

  assert.equal(offline.ok, true);
  assert.equal(offline.classificationSource, "app-cache");
  assert.deepEqual(plain(offline.layout.parents.__root__[0]), customLayout.parents.__root__[0]);
  assert.deepEqual(plain(offline.layout.parents.a[0]), customLayout.parents.a[0]);
  assert.deepEqual(plain(offline.layout.parents.__pinned__[0]), ["a", "b", "a2", null, null, null]);
  assert.deepEqual(plain(offline.pinnedIds), ["a2"]);
  assert.deepEqual(plain(offline.entries.map((entry) => entry.id)), ["a", "b", "a1", "a2"]);
});

test("app classification cache is isolated by the active Lakomics endpoint", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    remoteSettings: { enabled: true, baseUrl: "https://first.tail0000.ts.net" },
  });
  harness.queueJson({ entries: [{ id: "first", kind: "root", name: "First", parentId: null }] });

  const first = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(first.entries[0].id, "first");

  const changed = await harness.api.handleMessage({
    type: "settings:set-remote",
    remote: { enabled: true, baseUrl: "https://second.tail0000.ts.net" },
  });
  assert.equal(changed.ok, true);
  harness.queueError(new TypeError("Failed to fetch"));

  const offline = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(offline.classificationSource, "local");
  assert.equal(offline.fallbackCode, "app_offline");
  assert.equal(offline.entries.some((entry) => entry.id === "first"), false);
});

test("cached app classifications still fall back to browser download while Lakomics is offline", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    preferences: { saveMode: "auto", downloadFolder: "Lakomics" },
  });
  harness.queueJson({ entries: [{ id: "game", kind: "root", name: "게임", parentId: null }] });
  await harness.api.handleMessage({ type: "classifications:get" });

  harness.clock.now = 30_001;
  harness.queueError(new TypeError("Failed to fetch"));
  const classifications = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(classifications.classificationSource, "app-cache");

  harness.queueError(new TypeError("Failed to fetch"));
  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/OFFLINE?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/4242/photo/1",
      classificationId: "game",
      classificationName: "게임",
      classificationPath: ["게임"],
      classificationSource: classifications.classificationSource,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "downloaded");
  assert.equal(response.fallbackCode, "app_offline");
  assert.equal(harness.downloadCalls.length, 2);
  assert.equal(harness.downloadCalls[0].filename, "Lakomics/게임/artist_4242_1_OFFLINE.jpg");
  assert.equal(harness.downloadCalls[1].filename, "Lakomics/게임/artist_4242_1_OFFLINE.json");
});



test("auto mode treats a Tailscale 502 as offline and downloads to the device", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    preferences: { saveMode: "auto", downloadFolder: "Lakomics" },
    remoteSettings: { enabled: true, baseUrl: "https://laku.tail0aa1a3.ts.net" },
  });
  harness.queueJson({}, 502);

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/GATEWAY?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/5252/photo/1",
      classificationId: "game",
      classificationName: "게임",
      classificationPath: ["게임"],
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "downloaded");
  assert.equal(response.fallbackCode, "request_failed");
  assert.equal(harness.downloadCalls.length, 2);
  assert.equal(harness.downloadCalls[0].filename, "Lakomics/게임/artist_5252_1_GATEWAY.jpg");
});

test("legacy app-only preference no longer disables offline device collection", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    preferences: { saveMode: "app", downloadFolder: "Lakomics" },
  });
  harness.queueError(new TypeError("Failed to fetch"));

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/LEGACY?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/6262/photo/1",
      classificationId: "game",
      classificationName: "게임",
      classificationPath: ["게임"],
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "downloaded");
  assert.equal(response.fallbackCode, "app_offline");
  assert.equal(harness.downloadCalls.length, 2);
});

test("remote first-level ring uses roots first and appends explicitly pinned ids", async () => {
  const harness=createHarness({ connectionToken:"0123456789abcdef0123456789abcdef", remoteSettings:{enabled:true,baseUrl:"https://laku.tail0aa1a3.ts.net"}, pinnedClassificationIds:["reverse","ww","zzz"] });
  harness.queueJson({ entries:[{id:"game",kind:"root",name:"Game",parentId:null},{id:"manga",kind:"root",name:"Manga",parentId:null},{id:"other",kind:"root",name:"Other",parentId:null},{id:"reverse",kind:"tag",name:"Reverse",parentId:"game"},{id:"ww",kind:"tag",name:"Wuthering",parentId:"game"},{id:"zzz",kind:"tag",name:"Zenless",parentId:"game"}] });
  const response=await harness.api.handleMessage({type:"classifications:refresh"});
  assert.equal(response.classificationSource,"remote");
  assert.deepEqual(plain(response.layout.parents.__pinned__[0]), ["game","manga","other","reverse","ww","zzz"]);
});

test("mobile local tree stores twelve sparse secondary slots and exposes them to the radial", async () => {
  const harness = createHarness({ preferences: { saveMode: "download" } });
  const treeResponse = await harness.api.handleMessage({ type: "local-tree:get" });
  const tree = plain(treeResponse.tree);
  tree.roots[1].secondarySlots[0] = "카멜리아";
  tree.roots[1].secondarySlots[4] = "파수인";

  const saved = await harness.api.handleMessage({ type: "local-tree:set", tree });
  assert.equal(saved.ok, true);

  const response = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(response.classificationSource, "local");
  const root = response.entries.find((entry) => entry.id === "local:wuthering-waves");
  const children = response.entries.filter((entry) => entry.parentId === root.id);
  assert.deepEqual(plain(children.map((entry) => entry.name)), ["카멜리아", "파수인"]);
  assert.equal(response.layout.parents[root.id][0].length, 12);
  assert.equal(response.layout.parents[root.id][0][0], "local:wuthering-waves:secondary:0");
  assert.equal(response.layout.parents[root.id][0][1], null);
  assert.equal(response.layout.parents[root.id][0][4], "local:wuthering-waves:secondary:4");
});

test("local selections download directly into the configured classification folder", async () => {
  const harness = createHarness({ preferences: { saveMode: "download", downloadFolder: "Lakomics Inbox" } });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/ABC123?format=png&name=orig",
      sourceUrl: "https://x.com/artist/status/123456/photo/2",
      classificationId: "local:wuthering-waves",
      classificationName: "명조",
      classificationPath: ["명조"],
      classificationSource: "local",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "downloaded");
  assert.equal(harness.downloadCalls.length, 2);
  assert.equal(harness.downloadCalls[0].filename, "Lakomics Inbox/명조/artist_123456_2_ABC123.png");
  assert.equal(harness.downloadCalls[1].filename, "Lakomics Inbox/명조/artist_123456_2_ABC123.json");
  assert.match(harness.downloadCalls[1].url, /^data:application\/json;charset=utf-8,/);

  const encoded = harness.downloadCalls[1].url.split(",", 2)[1];
  const metadata = JSON.parse(decodeURIComponent(encoded));
  assert.equal(metadata.source, "x");
  assert.equal(metadata.sourceUrl, "https://x.com/artist/status/123456/photo/2");
  assert.equal(metadata.mediaUrl, "https://pbs.twimg.com/media/ABC123?format=png&name=orig");
  assert.equal(metadata.classificationName, "명조");
  assert.deepEqual(plain(metadata.classificationPath), ["명조"]);
  assert.equal(metadata.author, "artist");
  assert.equal(metadata.postId, "123456");
  assert.equal(metadata.mediaIndex, 2);
  assert.equal(metadata.filename, "Lakomics Inbox/명조/artist_123456_2_ABC123.png");
  assert.match(metadata.savedAt, /^\d{4}-\d{2}-\d{2}T/);
});


test("nested classification paths become nested offline folders", async () => {
  const harness = createHarness({ preferences: { saveMode: "download", downloadFolder: "Lakomics images" } });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/NESTED?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/789/photo/1",
      classificationId: "tag:camellya",
      classificationName: "카멜리아",
      classificationPath: ["명조", "카멜리아"],
      classificationSource: "local",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(harness.downloadCalls[0].filename, "Lakomics images/명조/카멜리아/artist_789_1_NESTED.jpg");
  assert.equal(harness.downloadCalls[1].filename, "Lakomics images/명조/카멜리아/artist_789_1_NESTED.json");
});

test("absolute Android download paths are rejected instead of being silently mangled", async () => {
  const harness = createHarness({ preferences: { saveMode: "auto", downloadFolder: "Lakomics" } });

  const response = await harness.api.handleMessage({
    type: "settings:set-preferences",
    preferences: { saveMode: "auto", downloadFolder: "/storage/emulated/0/Lakomics images" },
  });

  assert.deepEqual(plain(response), { ok: false, code: "absolute_download_path_unsupported" });
  assert.equal(harness.storage.preferences.downloadFolder, "Lakomics");
});

test("json sidecar follows the browser-resolved uniquified image filename", async () => {
  const harness = createHarness({ preferences: { saveMode: "download", downloadFolder: "Lakomics" } });
  harness.resolveDownloadCall(1, "/storage/emulated/0/Download/Lakomics/게임/artist_900_1_PAIR (1).jpg");

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/PAIR?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/900/photo/1",
      classificationId: "local:game",
      classificationName: "게임",
      classificationPath: ["게임"],
      classificationSource: "local",
      publishedAt: "2026-08-01T10:20:30.000Z",
    },
  });

  assert.equal(response.filename, "Lakomics/게임/artist_900_1_PAIR (1).jpg");
  assert.equal(harness.downloadCalls[1].filename, "Lakomics/게임/artist_900_1_PAIR (1).json");
  assert.equal(harness.downloadCalls[1].conflictAction, "overwrite");
  const metadata = JSON.parse(decodeURIComponent(harness.downloadCalls[1].url.split(",", 2)[1]));
  assert.equal(metadata.filename, "Lakomics/게임/artist_900_1_PAIR (1).jpg");
  assert.equal(metadata.publishedAt, "2026-08-01T10:20:30.000Z");
});

test("simultaneous identical saves serialize and do not race past duplicate suppression", async () => {
  const harness = createHarness({ preferences: { saveMode: "download" } });
  const message = {
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/RACE?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/901/photo/1",
      classificationId: "local:game",
      classificationName: "게임",
      classificationSource: "local",
    },
  };

  const [first, second] = await Promise.all([
    harness.api.handleMessage(message),
    harness.api.handleMessage(message),
  ]);

  assert.equal(first.status, "downloaded");
  assert.equal(second.status, "duplicate_recent");
  assert.equal(harness.downloadCalls.length, 2);
});

test("recent identical mobile saves are suppressed for ten seconds", async () => {
  const harness = createHarness({ preferences: { saveMode: "download" } });
  const message = {
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/DUP123?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/555/photo/1",
      classificationId: "local:game",
      classificationName: "게임",
      classificationSource: "local",
    },
  };

  const first = await harness.api.handleMessage(message);
  const second = await harness.api.handleMessage(message);

  assert.equal(first.status, "downloaded");
  assert.equal(second.ok, true);
  assert.equal(second.status, "duplicate_recent");
  assert.equal(harness.downloadCalls.length, 2);

  harness.clock.now = 10_001;
  const third = await harness.api.handleMessage(message);
  assert.equal(third.status, "downloaded");
  assert.equal(harness.downloadCalls.length, 4);
});

test("metadata retry downloads only the missing json sidecar", async () => {
  const harness = createHarness({ preferences: { saveMode: "download" } });
  harness.failDownloadCall(2, new Error("data url rejected"));
  const message = {
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/META123?format=png&name=orig",
      sourceUrl: "https://x.com/artist/status/777/photo/2",
      classificationId: "local:wuthering-waves",
      classificationName: "명조",
      classificationSource: "local",
    },
  };

  const first = await harness.api.handleMessage(message);
  assert.equal(first.ok, false);
  assert.equal(first.code, "metadata_download_failed");
  assert.equal(first.imageDownloaded, true);
  assert.equal(harness.downloadCalls.length, 2);

  const retry = await harness.api.handleMessage(message);
  assert.equal(retry.ok, true);
  assert.equal(retry.status, "metadata_repaired");
  assert.equal(harness.downloadCalls.length, 3);
  assert.match(harness.downloadCalls[2].filename, /\.json$/);
});

test("video selections resolve the highest bitrate MP4 before downloading", async () => {
  const harness = createHarness({ preferences: { saveMode: "download" } });
  harness.queueJson({
    text: "video post",
    mediaDetails: [{
      type: "video",
      original_info: { width: 1920, height: 1080 },
      video_info: {
        duration_millis: 12345,
        variants: [
          { content_type: "application/x-mpegURL", url: "https://video.twimg.com/ext_tw_video/1/pl/playlist.m3u8" },
          { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/640x360/LOW.mp4?tag=12" },
          { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1920x1080/HIGH.mp4?tag=12" },
        ],
      },
    }],
  });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      mediaUrl: null,
      sourceUrl: "https://x.com/artist/status/888/video/1",
      author: "artist",
      postId: "888",
      mediaIndex: 1,
      classificationId: "local:game",
      classificationName: "게임",
      classificationSource: "local",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "downloaded");
  assert.match(harness.fetchCalls[0].url, /^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result\?id=888&token=/);
  assert.equal(harness.downloadCalls.length, 2);
  assert.equal(harness.downloadCalls[0].url, "https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1920x1080/HIGH.mp4?tag=12");
  assert.match(harness.downloadCalls[0].filename, /^Lakomics\/게임\/artist_888_1_HIGH\.mp4$/);

  const encoded = harness.downloadCalls[1].url.split(",", 2)[1];
  const metadata = JSON.parse(decodeURIComponent(encoded));
  assert.equal(metadata.mediaType, "video");
  assert.equal(metadata.postId, "888");
  assert.equal(metadata.mediaIndex, 1);
  assert.equal(metadata.video.bitrate, 2176000);
  assert.equal(metadata.video.width, 1920);
  assert.equal(metadata.video.height, 1080);
  assert.equal(metadata.video.durationMs, 12345);
});

test("old PC app video rejection is reported as an app-update requirement", async () => {
  const harness = createHarness({
    preferences: { saveMode: "app" },
    connectionToken: "0123456789abcdef0123456789abcdef",
  });
  harness.queueJson({
    mediaDetails: [{
      type: "video",
      video_info: { variants: [
        { content_type: "video/mp4", bitrate: 1000, url: "https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/VID.mp4" },
      ] },
    }],
  });
  harness.queueJson({ code: "invalid_media_url", message: "X media URL is invalid." }, 400);

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      sourceUrl: "https://x.com/artist/status/889/video/1",
      postId: "889",
      mediaIndex: 1,
      classificationId: "tag",
      classificationName: "Tag",
      classificationSource: "app",
    },
  });

  assert.equal(response.ok, false);
  assert.equal(response.code, "pc_video_api_unsupported");
  assert.equal(harness.downloadCalls.length, 0);
});

test("animated GIF media uses the same MP4 pipeline", async () => {
  const harness = createHarness({ preferences: { saveMode: "download" } });
  harness.queueJson({
    mediaDetails: [{
      type: "animated_gif",
      video_info: {
        variants: [
          { content_type: "video/mp4", url: "https://video.twimg.com/tweet_video/GIF123.mp4" },
        ],
      },
    }],
  });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      sourceUrl: "https://x.com/artist/status/999/video/1",
      postId: "999",
      mediaIndex: 1,
      classificationId: "local:other",
      classificationName: "기타",
      classificationSource: "local",
    },
  });

  assert.equal(response.ok, true);
  const encoded = harness.downloadCalls[1].url.split(",", 2)[1];
  const metadata = JSON.parse(decodeURIComponent(encoded));
  assert.equal(metadata.mediaType, "animated_gif");
  assert.match(harness.downloadCalls[0].filename, /\.mp4$/);
});

test("tombstoned or unavailable X videos return a non-retryable media error", async () => {
  const harness = createHarness({ preferences: { saveMode: "download" } });
  harness.queueJson({ __typename: "TweetTombstone" });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      sourceUrl: "https://x.com/artist/status/1000/video/1",
      postId: "1000",
      classificationId: "local:other",
      classificationName: "기타",
      classificationSource: "local",
    },
  });

  assert.deepEqual(plain(response), { ok: false, code: "video_unavailable" });
  assert.equal(harness.downloadCalls.length, 0);
});


test("remote settings use a Tailscale Serve URL for classifications", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    remoteSettings: { enabled: true, baseUrl: "https://laku-pc.example-tailnet.ts.net" },
    preferences: { saveMode: "app" },
  });
  harness.queueJson({ entries: [{ id: "remote-tag", kind: "root", name: "Remote", parentId: null }] });

  const response = await harness.api.handleMessage({ type: "classifications:get" });

  assert.equal(response.ok, true);
  assert.equal(response.classificationSource, "remote");
  assert.equal(harness.fetchCalls[0].url, "https://laku-pc.example-tailnet.ts.net/v1/classifications");
});

test("remote connection test prefers health and reports capabilities", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    remoteSettings: { enabled: true, baseUrl: "https://laku-pc.example-tailnet.ts.net" },
  });
  harness.queueJson({ status: "ready", apiVersion: 2, capabilities: ["classifications", "ingestion"] });

  const response = await harness.api.handleMessage({ type: "remote:test" });

  assert.equal(response.ok, true);
  assert.equal(response.baseUrl, "https://laku-pc.example-tailnet.ts.net");
  assert.deepEqual(plain(response.health.capabilities), ["classifications", "ingestion"]);
  assert.equal(harness.fetchCalls[0].url, "https://laku-pc.example-tailnet.ts.net/v1/health");
});

test("remote connection test falls back to classifications on older Lakomics", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    remoteSettings: { enabled: true, baseUrl: "https://laku-pc.example-tailnet.ts.net" },
  });
  harness.queueJson({ code: "not_found", message: "Route not found." }, 404);
  harness.queueJson({ entries: [] });

  const response = await harness.api.handleMessage({ type: "remote:test" });

  assert.equal(response.ok, true);
  assert.equal(response.legacyHealth, true);
  assert.equal(harness.fetchCalls[1].url, "https://laku-pc.example-tailnet.ts.net/v1/classifications");
});

test("remote app mode sends ingestion to the PC through Tailscale Serve", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    remoteSettings: { enabled: true, baseUrl: "https://laku-pc.example-tailnet.ts.net" },
    preferences: { saveMode: "app" },
  });
  harness.queueJson({ status: "added", assetId: "asset-1" });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/ABC?format=png&name=orig",
      sourceUrl: "https://x.com/user/status/1/photo/1",
      classificationId: "tag-1",
      classificationName: "Tag",
      classificationSource: "remote",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(harness.fetchCalls[0].url, "https://laku-pc.example-tailnet.ts.net/v1/ingestions");
  assert.equal(harness.fetchCalls[0].options.method, "POST");
});

test("ingestion POST keeps the tweet publish timestamp for the PC app", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    remoteSettings: { enabled: true, baseUrl: "https://laku-pc.example-tailnet.ts.net" },
    preferences: { saveMode: "app" },
  });
  harness.queueJson({ status: "added", assetId: "asset-1" });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaUrl: "https://pbs.twimg.com/media/ABC?format=png&name=orig",
      sourceUrl: "https://x.com/user/status/1/photo/1",
      classificationId: "tag-1",
      classificationName: "Tag",
      classificationSource: "remote",
      publishedAt: "2026-08-01T10:20:30.000Z",
    },
  });

  assert.equal(response.ok, true);
  const body = JSON.parse(harness.fetchCalls[0].options.body);
  assert.equal(body.publishedAt, "2026-08-01T10:20:30.000Z");
});

test("invalid remote URLs are rejected instead of broadening host access", async () => {
  const harness = createHarness();
  const response = await harness.api.handleMessage({
    type: "settings:set-remote",
    remote: { enabled: true, baseUrl: "http://192.168.0.10:32145" },
  });
  assert.deepEqual(plain(response), { ok: false, code: "invalid_remote_url" });
});

test("new installs prefill the known Tailscale Serve URL without enabling remote", async () => {
  const harness = createHarness();
  const settings = await harness.api.handleMessage({ type: "settings:get" });

  assert.equal(settings.remote.enabled, false);
  assert.equal(settings.remote.baseUrl, "https://desktop-6oh3e09.tail0aa1a3.ts.net");
});

test("existing remote settings override the prefilled URL", async () => {
  const harness = createHarness({
    remoteSettings: { enabled: true, baseUrl: "https://other.tail123.ts.net" },
  });
  const settings = await harness.api.handleMessage({ type: "settings:get" });

  assert.equal(settings.remote.enabled, true);
  assert.equal(settings.remote.baseUrl, "https://other.tail123.ts.net");
});

test("connection backup round-trips the token and remote endpoint", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const sourceHarness = createHarness({
    connectionToken: token,
    remoteSettings: { enabled: true, baseUrl: "https://laku.tail0aa1a3.ts.net" },
  });
  const exported = await sourceHarness.api.handleMessage({ type: "connection-backup:export" });
  assert.equal(exported.ok, true);
  assert.equal(exported.backup.connectionToken, token);

  const targetHarness = createHarness();
  const imported = await targetHarness.api.handleMessage({
    type: "connection-backup:import",
    backup: plain(exported.backup),
  });
  assert.equal(imported.ok, true);
  assert.equal(targetHarness.storage.connectionToken, token);
  assert.deepEqual(plain(targetHarness.storage.remoteSettings), {
    enabled: true,
    baseUrl: "https://laku.tail0aa1a3.ts.net",
  });
});



test("saved X media index is persisted and reused while Lakomics is offline", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const harness = createHarness({ connectionToken: token });
  harness.queueJson({ keys: ["123:1", "123:2", "bad", "123:2"] });

  const live = await harness.api.handleMessage({ type: "saved-index:get" });
  assert.equal(live.ok, true);
  assert.equal(live.authoritative, true);
  assert.equal(live.indexSource, "app");
  assert.deepEqual(plain(live.savedKeys), ["123:1", "123:2"]);
  assert.equal(harness.fetchCalls[0].url, "http://127.0.0.1:32145/v1/saved-x-media");

  harness.queueError(new TypeError("offline"));
  const cached = await harness.api.handleMessage({ type: "saved-index:get" });
  assert.equal(cached.ok, true);
  assert.equal(cached.authoritative, true);
  assert.equal(cached.indexSource, "app-cache");
  assert.equal(cached.fallbackCode, "app_offline");
  assert.deepEqual(plain(cached.savedKeys), ["123:1", "123:2"]);
});

test("successful PC ingestion immediately advances an existing saved-index cache", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const harness = createHarness({
    connectionToken: token,
    lastAppSavedXMediaIndex: {
      version: 1, baseUrl: "http://127.0.0.1:32145", endpointSource: "app",
      savedKeys: ["1:1"], savedAt: 1,
    },
  });
  harness.queueJson({ status: "added", assetId: "asset-2" });
  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x", mediaType: "image",
      mediaUrl: "https://pbs.twimg.com/media/NEW?format=jpg&name=orig",
      sourceUrl: "https://x.com/user/status/222/photo/3",
      classificationId: "tag", classificationName: "Tag", classificationSource: "app",
    },
  });
  assert.equal(response.ok, true);
  assert.deepEqual(plain(harness.storage.lastAppSavedXMediaIndex.savedKeys), ["1:1", "222:3"]);
  assert.equal(harness.api.savedXMediaKeyFromSourceUrl("https://x.com/u/status/222/photo/3"), "222:3");
  assert.equal(harness.api.savedXMediaKeyFromSourceUrl("https://x.com/u/status/222"), "");
});

test("saved X media cache never leaks across Lakomics endpoints", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    remoteSettings: { enabled: true, baseUrl: "https://second.tail0000.ts.net" },
    lastAppSavedXMediaIndex: {
      version: 1, baseUrl: "https://first.tail0000.ts.net", endpointSource: "remote",
      savedKeys: ["10:1"], savedAt: 1,
    },
  });
  harness.queueError(new TypeError("offline"));
  const response = await harness.api.handleMessage({ type: "saved-index:get" });
  assert.equal(response.ok, false);
  assert.equal(response.code, "app_offline");
});

test("Android Collector reads saved X media from the VPS and persists a cloud cache", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "https://collector-a.tail.ts.net" },
  });
  harness.setPlatform("android");
  harness.queueJson({ keys: ["123:1", "123:2", "bad", "123:2"] });

  const response = await harness.api.handleMessage({ type: "saved-index:get" });

  assert.equal(response.ok, true);
  assert.equal(response.indexSource, "cloud");
  assert.deepEqual(plain(response.savedKeys), ["123:1", "123:2"]);
  assert.equal(harness.fetchCalls[0].url, "https://collector-a.tail.ts.net/v1/saved-x-media");
  assert.equal(harness.storage.lastCloudSavedXMediaIndex.baseUrl, "https://collector-a.tail.ts.net");
});

test("Android saved index uses only a matching Collector cloud cache when VPS is unavailable", async () => {
  const matching = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "https://collector-a.tail.ts.net" },
    lastCloudSavedXMediaIndex: {
      version: 1, baseUrl: "https://collector-a.tail.ts.net", savedKeys: ["10:1"], savedAt: 12,
    },
  });
  matching.setPlatform("android");
  matching.queueError(new TypeError("offline"));
  const cached = await matching.api.handleMessage({ type: "saved-index:get" });
  assert.equal(cached.indexSource, "cloud-cache");
  assert.deepEqual(plain(cached.savedKeys), ["10:1"]);

  const isolated = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "https://collector-b.tail.ts.net" },
    lastCloudSavedXMediaIndex: {
      version: 1, baseUrl: "https://collector-a.tail.ts.net", savedKeys: ["10:1"], savedAt: 12,
    },
  });
  isolated.setPlatform("android");
  isolated.queueError(new TypeError("offline"));
  const missing = await isolated.api.handleMessage({ type: "saved-index:get" });
  assert.equal(missing.ok, false);
  assert.equal(isolated.fetchCalls.length, 1, "Android must not probe a dead PC after VPS failure");
});

test("Android saved index merges bounded recentBrowserSaves keys into the VPS snapshot", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "https://collector.tail.ts.net" },
    recentBrowserSaves: {
      "saved-x-media\u0000999:2": { savedXMediaKey: "999:2", savedAt: 0 },
      "saved-x-media\u0000bad": { savedXMediaKey: "bad", savedAt: 0 },
    },
  });
  harness.setPlatform("android");
  harness.queueJson({ keys: ["123:1"] });

  const response = await harness.api.handleMessage({ type: "saved-index:get" });
  assert.deepEqual(plain(response.savedKeys), ["123:1", "999:2"]);
});

test("successful Android Collector save is immediately merged before VPS republishes", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.setPlatform("android");
  harness.queueJson({ capture: { id: "capture-1", status: "pending" } });
  const saved = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x", mediaType: "image",
      mediaUrl: "https://pbs.twimg.com/media/NEW?format=jpg&name=orig",
      sourceUrl: "https://x.com/user/status/222/photo/3",
      classificationId: "tag", classificationName: "Tag", classificationSource: "cloud",
    },
  });
  assert.equal(saved.ok, true);

  harness.queueJson({ keys: [] });
  const index = await harness.api.handleMessage({ type: "saved-index:get" });
  assert.deepEqual(plain(index.savedKeys), ["222:3"]);
  assert.equal(
    harness.storage.recentBrowserSaves["saved-x-media\u0000222:3"].savedXMediaKey,
    "222:3",
  );
});

test("X Translate proxy only allows the four configured HTTPS API hosts", async () => {
  const harness = createHarness();

  assert.equal(harness.api.isAllowedTranslateUrl("https://openrouter.ai/api/v1/models"), true);
  assert.equal(harness.api.isAllowedTranslateUrl("https://ollama.com/api/tags"), true);
  assert.equal(harness.api.isAllowedTranslateUrl("https://generativelanguage.googleapis.com/v1beta/models"), true);
  assert.equal(harness.api.isAllowedTranslateUrl("https://ai-gateway.vercel.sh/v1/models"), true);
  assert.equal(harness.api.isAllowedTranslateUrl("http://openrouter.ai/api/v1/models"), false);
  assert.equal(harness.api.isAllowedTranslateUrl("https://evil.openrouter.ai/api/v1/models"), false);
  assert.equal(harness.api.isAllowedTranslateUrl("https://example.com/"), false);
});

test("X Translate proxy forwards API requests without exposing arbitrary web access", async () => {
  const harness = createHarness();
  harness.queueJson({ choices: [{ message: { content: "translated" } }] }, 200, { "x-request-id": "req-1" });

  const response = await harness.api.handleMessage({
    type: "xtranslate:http",
    request: {
      method: "POST",
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        Origin: "https://should-be-stripped.example",
        "HTTP-Referer": "https://x.com/",
      },
      data: JSON.stringify({ model: "qwen/qwen3.5-flash-02-23" }),
      timeout: 5000,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.match(response.responseText, /translated/);
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].options.headers.Authorization, "Bearer secret");
  assert.equal(harness.fetchCalls[0].options.headers.Origin, undefined);
  assert.equal(harness.fetchCalls[0].options.headers["HTTP-Referer"], "https://x.com/");
});

test("X Translate proxy blocks unapproved URLs before fetch", async () => {
  const harness = createHarness();
  const response = await harness.api.handleMessage({
    type: "xtranslate:http",
    request: { method: "GET", url: "https://example.com/private" },
  });

  assert.deepEqual(plain(response), { ok: false, code: "xtranslate_url_blocked" });
  assert.equal(harness.fetchCalls.length, 0);
});


test("collector settings stay in extension storage without exposing the token", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });

  const settings = await harness.api.handleMessage({ type: "settings:get" });

  assert.equal(settings.collectorTokenConfigured, true);
  assert.deepEqual(plain(settings.collector), {
    enabled: true,
    baseUrl: "http://100.76.119.29:32146",
  });
  assert.equal(JSON.stringify(settings).includes("server-secret-token"), false);
  assert.ok(manifest.host_permissions.includes("http://100.76.119.29:32146/*"));
});

test("collector rejects arbitrary insecure endpoints", async () => {
  const harness = createHarness();

  const rejected = await harness.api.handleMessage({
    type: "settings:set-collector",
    collector: { enabled: true, baseUrl: "http://192.168.0.10:32146" },
  });

  assert.deepEqual(plain(rejected), { ok: false, code: "invalid_collector_url" });
});

test("collector-enabled image saves go to the VPS capture inbox instead of the PC", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    connectionToken: "0123456789abcdef0123456789abcdef",
  });
  harness.queueJson({
    ok: true,
    created: true,
    capture: { id: "capture-1", status: "pending" },
  });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "image",
      mediaUrl: "https://pbs.twimg.com/media/SERVER?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/4242/photo/1",
      classificationId: "game",
      classificationName: "??",
      classificationPath: ["??"],
      classificationSource: "app-cache",
      publishedAt: "2026-08-01T10:20:30.000Z",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "captured");
  assert.equal(response.captureId, "capture-1");
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, "http://100.76.119.29:32146/v1/captures");
  assert.equal(harness.fetchCalls[0].options.headers.Authorization, "Bearer server-secret-token");
  assert.equal(harness.fetchCalls[0].options.headers["X-Lakomics-Extension-Id"], undefined);
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].options.body), {
    source_url: "https://x.com/artist/status/4242/photo/1",
    media_url: "https://pbs.twimg.com/media/SERVER?format=jpg&name=orig",
    classification_id: "game",
    published_at: "2026-08-01T10:20:30.000Z",
    media_type: "image",
  });
  assert.equal(harness.downloadCalls.length, 0);
});

test("malformed successful collector response falls back instead of claiming capture", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    preferences: { saveMode: "auto", downloadFolder: "Lakomics" },
  });
  harness.queueJson({});

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "image",
      mediaUrl: "https://pbs.twimg.com/media/MALFORMED?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/4343/photo/1",
      classificationId: "game",
      classificationName: "Game",
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "downloaded");
  assert.equal(response.fallbackCode, "collector_request_failed");
  assert.equal(harness.downloadCalls.length, 2);
});

test("collector-enabled resolved video saves go to the VPS capture inbox", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    connectionToken: "0123456789abcdef0123456789abcdef",
    preferences: { saveMode: "app" },
  });
  harness.queueJson({ ok: true, created: true, capture: { id: "video-1", status: "pending" } });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      mediaUrl: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/VIDEO.mp4",
      sourceUrl: "https://x.com/artist/status/6262/video/1",
      classificationId: "game",
      classificationName: "Game",
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "captured");
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, "http://100.76.119.29:32146/v1/captures");
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].options.body), {
    source_url: "https://x.com/artist/status/6262/video/1",
    media_url: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/VIDEO.mp4",
    classification_id: "game",
    published_at: null,
    media_type: "video",
  });
  assert.equal(harness.downloadCalls.length, 0);
});

test("collector still captures video when classifications came from the local fallback tree", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    preferences: { saveMode: "auto", downloadFolder: "Lakomics" },
  });
  harness.queueJson({ ok: true, created: true, capture: { id: "video-local-1", status: "pending" } });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      mediaUrl: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/LOCAL.mp4",
      sourceUrl: "https://x.com/artist/status/6263/video/1",
      classificationId: "local:game",
      classificationName: "Game",
      classificationSource: "local",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "captured");
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, "http://100.76.119.29:32146/v1/captures");
  assert.equal(JSON.parse(harness.fetchCalls[0].options.body).classification_id, "local:game");
  assert.equal(harness.downloadCalls.length, 0);
});

test("collector resolves the highest bitrate MP4 before server capture", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.queueJson({
    mediaDetails: [{
      type: "video",
      video_info: { variants: [
        { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/ext_tw_video/1/pu/vid/640x360/LOW.mp4" },
        { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/ext_tw_video/1/pu/vid/1920x1080/HIGH.mp4" },
      ] },
    }],
  });
  harness.queueJson({ ok: true, created: true, capture: { id: "video-2", status: "pending" } });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      sourceUrl: "https://x.com/artist/status/6363/video/1",
      postId: "6363",
      mediaIndex: 1,
      classificationId: "game",
      classificationName: "Game",
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.match(harness.fetchCalls[0].url, /^https:\/\/cdn\.syndication\.twimg\.com\/tweet-result/);
  assert.equal(harness.fetchCalls[1].url, "http://100.76.119.29:32146/v1/captures");
  const body = JSON.parse(harness.fetchCalls[1].options.body);
  assert.equal(body.media_url, "https://video.twimg.com/ext_tw_video/1/pu/vid/1920x1080/HIGH.mp4");
  assert.equal(body.media_type, "video");
  assert.equal(harness.downloadCalls.length, 0);
});

test("collector sends animated GIF MP4 media as video", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.queueJson({ ok: true, created: true, capture: { id: "gif-1", status: "pending" } });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "animated_gif",
      mediaUrl: "https://video.twimg.com/tweet_video/GIF123.mp4",
      sourceUrl: "https://x.com/artist/status/6464/video/1",
      classificationId: "other",
      classificationName: "Other",
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(JSON.parse(harness.fetchCalls[0].options.body).media_type, "video");
  assert.equal(harness.downloadCalls.length, 0);
});

test("ambiguous collector failure confirms an idempotent capture before fallback", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.queueError(new TypeError("response lost"));
  harness.queueJson({ items: [{
    id: "confirmed-1",
    source_url: "https://x.com/artist/status/6555/video/1",
    media_url: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/CONFIRMED.mp4",
    classification_id: "game",
    status: "pending",
  }] });

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      mediaUrl: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/CONFIRMED.mp4",
      sourceUrl: "https://x.com/artist/status/6555/video/1",
      classificationId: "game",
      classificationName: "Game",
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "capture_duplicate");
  assert.equal(response.captureId, "confirmed-1");
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(
    harness.fetchCalls[1].url,
    "http://100.76.119.29:32146/v1/captures?source_url=https%3A%2F%2Fx.com%2Fartist%2Fstatus%2F6555%2Fvideo%2F1&media_url=https%3A%2F%2Fvideo.twimg.com%2Fext_tw_video%2F1%2Fpu%2Fvid%2F1280x720%2FCONFIRMED.mp4&classification_id=game&limit=1",
  );
  assert.equal(harness.downloadCalls.length, 0);
});

test("video collector network failure falls back to the device download", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    preferences: { saveMode: "auto", downloadFolder: "Lakomics" },
  });
  harness.queueError(new TypeError("offline"));

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      mediaUrl: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/FALLBACK.mp4",
      sourceUrl: "https://x.com/artist/status/6565/video/1",
      classificationId: "game",
      classificationName: "Game",
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "downloaded");
  assert.equal(response.fallbackCode, "collector_offline");
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.fetchCalls[0].url, "http://100.76.119.29:32146/v1/captures");
  assert.equal(harness.downloadCalls.length, 2);
});

test("collector network failure falls back to the device download", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    preferences: { saveMode: "auto", downloadFolder: "Lakomics" },
  });
  harness.queueError(new TypeError("offline"));

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "image",
      mediaUrl: "https://pbs.twimg.com/media/FALLBACK?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/5252/photo/1",
      classificationId: "game",
      classificationName: "??",
      classificationPath: ["??"],
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "downloaded");
  assert.equal(response.fallbackCode, "collector_offline");
  assert.equal(harness.downloadCalls.length, 2);
});

test("video collector HTTP failure records fallback diagnostics with status and detail", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    preferences: { saveMode: "auto", downloadFolder: "Lakomics" },
  });
  harness.queueJson({ detail: "X media returned HTTP 403" }, 502);

  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "video",
      mediaUrl: "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/DIAG.mp4",
      sourceUrl: "https://x.com/artist/status/6570/video/1",
      classificationId: "game",
      classificationName: "Game",
      classificationSource: "app-cache",
    },
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "downloaded");
  assert.equal(response.fallbackCode, "collector_request_failed");
  const diagnostics = harness.storage.lakomicsCollectorFallbackDiagnostics;
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "collector_request_failed");
  assert.equal(diagnostics[0].httpStatus, 502);
  assert.equal(diagnostics[0].message, "X media returned HTTP 403");
  assert.equal(diagnostics[0].mediaType, "video");
  assert.equal(typeof diagnostics[0].at, "string");
  assert.equal(diagnostics[0].token, undefined);
  assert.equal(diagnostics[0].mediaUrl, undefined);

  const diagnosticsResponse = await harness.api.handleMessage({ type: "collector:diagnostics" });
  assert.equal(diagnosticsResponse.ok, true);
  assert.equal(diagnosticsResponse.entries.length, 1);
  assert.equal(diagnosticsResponse.entries[0].code, "collector_request_failed");
});

test("collector diagnostics keep the most recent failure first and cap at twenty entries", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
    preferences: { saveMode: "auto", downloadFolder: "Lakomics" },
  });
  for (let index = 0; index < 25; index += 1) {
    harness.queueError(new TypeError("offline"));
    await harness.api.handleMessage({
      type: "ingestion:create",
      payload: {
        source: "x",
        mediaType: "image",
        mediaUrl: `https://pbs.twimg.com/media/OFF${index}?format=jpg&name=orig`,
        sourceUrl: `https://x.com/artist/status/70${index}/photo/1`,
        classificationId: "game",
        classificationName: "Game",
        classificationSource: "app-cache",
      },
    });
  }

  const entries = harness.storage.lakomicsCollectorFallbackDiagnostics;
  assert.equal(entries.length, 20);
  assert.equal(entries[0].code, "collector_offline");
});

test("toolbar click opens the extension options page", async () => {
  const harness = createHarness();

  await harness.clickAction();

  assert.equal(harness.optionsOpened, 1);
});

function createHarness(initialStorage = {}, runtimeId = "nclkmjmmlcdaeomgadndeangccfidfbk") {
  const storage = { ...initialStorage };
  const responses = [];
  const fetchCalls = [];
  const clock = { now: 0 };
  let harnessPlatform = "win";
  let actionListener;
  let optionsOpened = 0;
  const downloadCalls = [];
  const downloadFailures = new Map();
  const resolvedDownloadFilenames = new Map();
  const chrome = {
    action: { onClicked: { addListener(listener) { actionListener = listener; } } },
    downloads: {
      async download(options) {
        downloadCalls.push(options);
        const callNumber = downloadCalls.length;
        if (downloadFailures.has(callNumber)) throw downloadFailures.get(callNumber);
        return callNumber;
      },
      async search(query) {
        const id = Number(query?.id);
        const requested = downloadCalls[id - 1]?.filename;
        if (!requested) return [];
        const filename = resolvedDownloadFilenames.get(id)
          ?? `/storage/emulated/0/Download/${requested}`;
        return [{ id, filename }];
      },
    },
    runtime: {
      id: runtimeId,
      onMessage: { addListener() {} },
      async openOptionsPage() { optionsOpened += 1; },
      getPlatformInfo(callback) { callback({ os: harnessPlatform }); },
    },
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
    const bodyText = typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    const headerEntries = Object.entries(next.headers ?? {});
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: next.statusText ?? "",
      url,
      headers: { entries() { return headerEntries[Symbol.iterator](); } },
      async json() { return next.body; },
      async text() { return bodyText; },
    };
  }
  const NativeDate = Date;
  class MockDate extends NativeDate {
    static now() { return clock.now; }
  }
  const context = {
    chrome,
    fetch,
    Date: MockDate,
    URL,
    console,
    globalThis: null,
    __LAKOMICS_TEST__: true,
  };
  context.globalThis = context;
  vm.runInNewContext(layoutSource, context, { filename: "layout.js" });
  vm.runInNewContext(defaultsSource, context, { filename: "defaults.js" });
  vm.runInNewContext(source, context, { filename: "background.js" });
  return {
    api: context.LakomicsBackground,
    clock,
    setPlatform(os) { harnessPlatform = os; },
    fetchCalls,
    downloadCalls,
    storage,
    failDownloadCall(callNumber, error) { downloadFailures.set(callNumber, error); },
    resolveDownloadCall(callNumber, filename) { resolvedDownloadFilenames.set(callNumber, filename); },
    async clickAction() { await actionListener(); },
    get optionsOpened() { return optionsOpened; },
    queueJson(body, status = 200, headers = {}) { responses.push({ body, status, headers }); },
    queueError(error) { responses.push(error); },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("cold cache prefers current persisted pins over stale snapshot pins", async () => {
  const entries = [
    { id: "game", kind: "root", name: "Game", parentId: null },
    { id: "reverse", kind: "tag", name: "Reverse", parentId: "game" },
  ];
  const staleLayout = { version: 1, parents: {
    __root__: [["game", null, null, null, null, null]],
    game: [["reverse", null, null, null, null, null]],
    __pinned__: [["game", null, null, null, null, null]],
  } };
  const liveLayout = plain(staleLayout);
  liveLayout.parents.__pinned__[0][1] = "reverse";
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    pinnedClassificationIds: ["reverse"], radialLayout: liveLayout,
    lastAppClassifications: { version: 2, baseUrl: "http://127.0.0.1:32145", endpointSource: "app", entries, layout: staleLayout, pinnedIds: [], savedAt: 1 },
  });
  harness.queueError(new TypeError("offline"));
  const response = await harness.api.handleMessage({ type: "classifications:get" });
  assert.deepEqual(plain(response.pinnedIds), ["reverse"]);
  assert.ok(response.layout.parents.__pinned__.flat().includes("reverse"));
});
test("refresh remaps a deleted pinned id to the unique same-name live classification", async () => {
  const previousEntries = [
    { id: "old-reverse", kind: "root", name: "Reverse", parentId: null },
  ];
  const oldLayout = { version: 1, parents: { __pinned__: [["old-reverse", null, null, null, null, null]] } };
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    pinnedClassificationIds: ["old-reverse"], radialLayout: oldLayout,
    lastAppClassifications: { version: 2, baseUrl: "http://127.0.0.1:32145", endpointSource: "app", entries: previousEntries, layout: oldLayout, pinnedIds: ["old-reverse"], savedAt: 1 },
  });
  harness.queueJson({ entries: [
    { id: "game", kind: "root", name: "Game", parentId: null },
    { id: "new-reverse", kind: "tag", name: "Reverse", parentId: "game" },
    { id: "child", kind: "tag", name: "Child", parentId: "new-reverse" },
  ] });
  const response = await harness.api.handleMessage({ type: "classifications:refresh" });
  assert.deepEqual(plain(response.pinnedIds), ["new-reverse"]);
  assert.deepEqual(plain(harness.storage.pinnedClassificationIds), ["new-reverse"]);
  assert.ok(response.layout.parents.__pinned__.flat().includes("new-reverse"));
  assert.equal(response.layout.parents.__pinned__.flat().includes("old-reverse"), false);
});
test("radial-state:set stores layout and deduplicated pins together", async () => {
  const harness = createHarness();
  const layout = { version: 1, parents: { __pinned__: [["x", null, null, null, null, null]] } };
  const response = await harness.api.handleMessage({ type: "radial-state:set", layout, pinnedIds: ["x", "x"] });
  assert.equal(response.ok, true);
  assert.deepEqual(plain(response.pinnedIds), ["x"]);
  assert.deepEqual(plain(harness.storage.radialLayout), layout);
  assert.deepEqual(plain(harness.storage.pinnedClassificationIds), ["x"]);
});
test("refresh does not guess when a deleted pin name matches multiple live classifications", async () => {
  const oldLayout = { version: 1, parents: { __pinned__: [["old", null, null, null, null, null]] } };
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    pinnedClassificationIds: ["old"], radialLayout: oldLayout,
    lastAppClassifications: { version: 2, baseUrl: "http://127.0.0.1:32145", endpointSource: "app", entries: [{ id: "old", kind: "root", name: "Same", parentId: null }], layout: oldLayout, pinnedIds: ["old"], savedAt: 1 },
  });
  harness.queueJson({ entries: [{ id: "one", kind: "root", name: "Same", parentId: null }, { id: "two", kind: "tag", name: "Same", parentId: "one" }] });
  const response = await harness.api.handleMessage({ type: "classifications:refresh" });
  assert.deepEqual(plain(response.pinnedIds), []);
  assert.deepEqual(plain(harness.storage.pinnedClassificationIds), []);
});
test("pin repair never borrows same-name history from a different endpoint", async () => {
  const oldLayout = { version: 1, parents: { __pinned__: [["old", null, null, null, null, null]] } };
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    remoteSettings: { enabled: true, baseUrl: "https://second.tail0000.ts.net" },
    pinnedClassificationIds: ["old"], radialLayout: oldLayout,
    lastAppClassifications: { version: 2, baseUrl: "https://first.tail0000.ts.net", endpointSource: "remote", entries: [{ id: "old", kind: "root", name: "Same", parentId: null }], layout: oldLayout, pinnedIds: ["old"], savedAt: 1 },
  });
  harness.queueJson({ entries: [{ id: "new", kind: "tag", name: "Same", parentId: "root" }] });
  const response = await harness.api.handleMessage({ type: "classifications:refresh" });
  assert.deepEqual(plain(response.pinnedIds), []);
  assert.deepEqual(plain(harness.storage.pinnedClassificationIds), []);
});

test("mobile classifications come from the VPS snapshot without a connection key or PC", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.setPlatform("android");
  harness.queueJson({
    entries: [{ id: "game", kind: "root", name: "게임", parentId: null }],
  });

  const response = await harness.api.handleMessage({ type: "classifications:get" });

  assert.equal(response.ok, true);
  assert.equal(response.classificationSource, "cloud");
  assert.equal(response.entries[0].id, "game");
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, "http://100.76.119.29:32146/v1/classifications");
  assert.equal(
    harness.fetchCalls[0].options.headers.Authorization,
    "Bearer server-secret-token",
  );
});

test("cached cloud classifications are used when the VPS is temporarily unavailable", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.setPlatform("android");
  harness.queueJson({
    entries: [{ id: "game", kind: "root", name: "게임", parentId: null }],
  });
  const first = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(first.classificationSource, "cloud");

  harness.clock.now = 30_001;
  harness.queueError(new TypeError("Failed to fetch"));
  const second = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(second.ok, true);
  assert.equal(second.classificationSource, "cloud-cache");
  assert.equal(second.entries[0].id, "game");
  assert.equal(
    second.entries.some((entry) => entry.id === "local:wuthering-waves"),
    false,
    "local fallback tree must not replace a usable cloud snapshot",
  );
});

test("capture with cloud classifications sends the existing classification_id", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.setPlatform("android");
  harness.queueJson({
    entries: [{ id: "game", kind: "root", name: "게임", parentId: null }],
  });
  const classifications = await harness.api.handleMessage({ type: "classifications:get" });
  assert.equal(classifications.classificationSource, "cloud");

  harness.queueJson({ capture: { id: "capture-9", status: "pending" } });
  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "image",
      mediaUrl: "https://pbs.twimg.com/media/CLOUD?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/9000/photo/1",
      classificationId: classifications.entries[0].id,
      classificationName: classifications.entries[0].name,
      classificationSource: classifications.classificationSource,
    },
  });

  assert.equal(response.ok, true);
  const captureCalls = harness.fetchCalls.filter((call) => call.url.endsWith("/v1/captures"));
  assert.equal(captureCalls.length, 1);
  assert.equal(JSON.parse(captureCalls[0].options.body).classification_id, "game");
});

test("normal mobile save path stays fully on the cloud endpoint when the PC is off", async () => {
  const harness = createHarness({
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.setPlatform("android");
  harness.queueJson({
    entries: [{ id: "game", kind: "root", name: "게임", parentId: null }],
  });
  const classifications = await harness.api.handleMessage({ type: "classifications:get" });

  harness.queueJson({ capture: { id: "capture-10", status: "pending" } });
  const response = await harness.api.handleMessage({
    type: "ingestion:create",
    payload: {
      source: "x",
      mediaType: "image",
      mediaUrl: "https://pbs.twimg.com/media/OFFPC?format=jpg&name=orig",
      sourceUrl: "https://x.com/artist/status/10000/photo/1",
      classificationId: classifications.entries[0].id,
      classificationName: classifications.entries[0].name,
      classificationSource: classifications.classificationSource,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(
    harness.fetchCalls.every((call) => call.url.startsWith("http://100.76.119.29:32146/")),
    true,
    "no request may reach the direct PC endpoint while the PC is off",
  );
  assert.equal(harness.downloadCalls.length, 0);
});

test("desktop direct-PC classifications still work without collector settings", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
  });
  harness.queueJson({
    entries: [{ id: "pc", kind: "root", name: "PC", parentId: null }],
  });

  const response = await harness.api.handleMessage({ type: "classifications:get" });

  assert.equal(response.ok, true);
  assert.equal(response.classificationSource, "app");
  assert.equal(harness.fetchCalls[0].url, "http://127.0.0.1:32145/v1/classifications");
});

test("desktop with both paths keeps preferring the live PC endpoint for saved-index", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.queueJson({ keys: ["111:1"] });

  const saved = await harness.api.handleMessage({ type: "saved-index:get" });

  assert.equal(saved.ok, true);
  assert.equal(harness.fetchCalls[0].url, "http://127.0.0.1:32145/v1/saved-x-media");
});

test("normal desktop mode still uses the local PC classifications with collector enabled", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    collectorToken: "server-secret-token",
    collectorSettings: { enabled: true, baseUrl: "http://100.76.119.29:32146" },
  });
  harness.queueJson({
    entries: [{ id: "pc", kind: "root", name: "PC", parentId: null }],
  });

  const response = await harness.api.handleMessage({ type: "classifications:get" });

  assert.equal(response.ok, true);
  assert.equal(response.classificationSource, "app", "desktop must keep the direct PC source");
  assert.equal(response.entries[0].id, "pc");
  assert.equal(harness.fetchCalls[0].url, "http://127.0.0.1:32145/v1/classifications");
  assert.equal(
    harness.fetchCalls.some((call) => call.url.includes("100.76.119.29")),
    false,
    "desktop must not hit the VPS snapshot",
  );
});
