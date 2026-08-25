import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
const layoutSource = fs.readFileSync(new URL("../src/layout.js", import.meta.url), "utf8");
const defaultsSource = fs.readFileSync(new URL("../src/defaults.js", import.meta.url), "utf8");

test("keeps the connection token inside the service worker", async () => {
  const harness = createHarness({ connectionToken: "0123456789abcdef0123456789abcdef" });
  harness.queueJson({ entries: [] });

  const settings = await harness.api.handleMessage({ type: "settings:get" });
  const classifications = await harness.api.handleMessage({ type: "classifications:get" });

  assert.equal(settings.ok, true);
  assert.equal(settings.tokenConfigured, true);
  assert.equal(settings.preferences.saveMode, "auto");
  assert.equal(settings.preferences.touchLongPressMs, 450);
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
  assert.deepEqual(harness.storage.pinnedClassificationIds, ["reverse"]);
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
  assert.deepEqual(response.pinnedIds, ["reverse"]);
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
  assert.deepEqual(plain(offline.layout), customLayout);
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

test("remote first-level ring keeps the preferred six-category order", async () => {
  const harness = createHarness({
    connectionToken: "0123456789abcdef0123456789abcdef",
    remoteSettings: { enabled: true, baseUrl: "https://laku.tail0aa1a3.ts.net" },
    pinnedClassificationIds: ["reverse", "ww", "zzz"],
  });
  harness.queueJson({
    entries: [
      { id: "game", kind: "root", name: "게임", parentId: null },
      { id: "manga", kind: "root", name: "만화", parentId: null },
      { id: "other", kind: "root", name: "기타", parentId: null },
      { id: "reverse", kind: "tag", name: "리버스", parentId: "game" },
      { id: "ww", kind: "tag", name: "명조", parentId: "game" },
      { id: "zzz", kind: "tag", name: "젠레스", parentId: "game" },
    ],
  });

  const response = await harness.api.handleMessage({ type: "classifications:refresh" });
  assert.equal(response.classificationSource, "remote");
  const firstPage = response.layout.parents.__pinned__[0];
  const byId = new Map(response.entries.map((entry) => [entry.id, entry.name]));
  assert.deepEqual(plain(firstPage.map((id) => id ? byId.get(id) : null)), [
    "리버스", "명조", "젠레스", "게임", "만화", "기타",
  ]);
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
    },
  });

  assert.equal(response.filename, "Lakomics/게임/artist_900_1_PAIR (1).jpg");
  assert.equal(harness.downloadCalls[1].filename, "Lakomics/게임/artist_900_1_PAIR (1).json");
  assert.equal(harness.downloadCalls[1].conflictAction, "overwrite");
  const metadata = JSON.parse(decodeURIComponent(harness.downloadCalls[1].url.split(",", 2)[1]));
  assert.equal(metadata.filename, "Lakomics/게임/artist_900_1_PAIR (1).jpg");
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
  assert.equal(settings.remote.baseUrl, "https://laku.tail0aa1a3.ts.net");
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

test("toolbar click opens the extension options page", async () => {
  const harness = createHarness();

  await harness.clickAction();

  assert.equal(harness.optionsOpened, 1);
});

function createHarness(initialStorage = {}) {
  const storage = { ...initialStorage };
  const responses = [];
  const fetchCalls = [];
  const clock = { now: 0 };
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
      id: "nclkmjmmlcdaeomgadndeangccfidfbk",
      onMessage: { addListener() {} },
      async openOptionsPage() { optionsOpened += 1; },
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
