import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const frameSource = fs.readFileSync(new URL("../src/mobile-api-frame.js", import.meta.url), "utf8");
const storeSource = fs.readFileSync(new URL("../src/mobile-library-store.js", import.meta.url), "utf8");
const assetsSource = fs.readFileSync(new URL("../src/mobile-assets.js", import.meta.url), "utf8");
const bridgeSource = fs.readFileSync(new URL("../src/mobile-bridge.js", import.meta.url), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

const PAGE_ORIGIN = "https://lacucaracha421.github.io";

// frame.js는 window.addEventListener("message")를 직접 호출한다. vm 컨텍스트에
// 최소 window 구현을 제공해 리스너를 캡처한다.
function createMessageCaptureContext({ storage, fetch, clockNow = Date.now() } = {}) {
  const messageListeners = [];
  const context = {
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(names.filter((name) => name in storage).map((name) => [name, storage[name]]));
          },
          async set(values) { Object.assign(storage, values); },
        },
      },
    },
    fetch,
    URL,
    URLSearchParams,
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    globalThis: null,
  };
  const postTargets = [];
  // frame.js는 window.addEventListener와 window.parent를 모두 참조한다.
  const parentRef = { postMessage(message, origin) { postTargets.slice().forEach((t) => t(message, origin)); } };
  const windowRef = {
    addEventListener(type, listener) {
      if (type === "message") messageListeners.push(listener);
    },
    parent: parentRef,
  };
  context.window = windowRef;
  context.parent = parentRef;
  context.globalThis = context;
  return {
    context,
    messageListeners,
    postTargets,
    async dispatch(message, sender) {
      for (const listener of messageListeners) await listener(message);
    },
  };
}

test("mobile library bridge ops call the deployed Cloud Library endpoints", async () => {
  const storage = {
    collectorToken: "tok-123",
    collectorSettings: { baseUrl: "http://100.76.119.29:32146" },
  };
  const fetchCalls = [];
  const responses = [
    { body: { items: [{ id: "c1", name: "리버스", kind: "tag", asset_count: 1588, parent_id: null, sort_index: 0 }], published_at: "2026-09-02T00:00:00+00:00" } },
    { body: { items: [{ id: "a1", kind: "image", classification_ids: ["c1"], original_available: true, thumbnail_available: true }], has_more: true, next_cursor: "CUR1" } },
    { body: { url: "https://r2.example/signed/thumbnail", content_type: "image/webp", size_bytes: 9000, expires_at: "2026-09-02T00:05:00Z", variant: "thumbnail" } },
  ];
  const fetchImpl = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const body = next.body ?? {};
    return {
      ok: true,
      status: 200,
      statusText: "",
      url,
      headers: { entries() { return [][Symbol.iterator](); } },
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  };
  const { context, messageListeners } = createMessageCaptureContext({ storage, fetch: fetchImpl });
  vm.runInNewContext(frameSource, context, { filename: "mobile-api-frame.js" });
  assert.equal(messageListeners.length, 1);

  // event.source !== window.parent 모킹 문제: frame.js는 event.source !== window.parent를 검사한다.
  // 컨텍스트에서 window.parent는 parent postMessage 객체이므로, source를 동일 객체로 전달한다.
  async function op(payload) {
    const requestId = "req-2";
    const replyPromise = new Promise((resolve) => {
      context.parent.postMessage = (message, origin) => {
        if (message.source === "lakomics-mobile-api" && message.requestId === requestId) resolve(message.result);
      };
    });
    for (const listener of messageListeners) {
      listener({
        source: context.parent,
        origin: PAGE_ORIGIN,
        data: { source: "lakomics-mobile-content", requestId, ...payload },
      });
    }
    return replyPromise;
  }

  const cls = await op({ op: "library:classifications" });
  assert.equal(cls.ok, true);
  assert.equal(cls.items.length, 1);
  assert.equal(cls.items[0].assetCount, 1588);
  assert.equal(fetchCalls.at(-1).url, "http://100.76.119.29:32146/v1/library/classifications");

  const assets = await op({ op: "library:assets", classificationId: "c1", limit: 100 });
  assert.equal(assets.ok, true);
  assert.equal(assets.hasMore, true);
  assert.equal(assets.nextCursor, "CUR1");
  assert.equal(fetchCalls.at(-1).url, "http://100.76.119.29:32146/v1/library/assets?classification_id=c1&limit=100");

  const ticket = await op({ op: "library:media-ticket", assetId: "a1", variant: "thumbnail" });
  assert.equal(ticket.ok, true);
  assert.equal(ticket.url, "https://r2.example/signed/thumbnail");
  assert.equal(fetchCalls.at(-1).options.method, "POST");
  assert.deepEqual(JSON.parse(fetchCalls.at(-1).options.body), { variant: "thumbnail" });

  // 페이지 응답에 토큰/헤더 시크릿이 포함되지 않는다
  assert.equal(JSON.stringify(cls).includes("tok-123"), false);
  assert.equal(JSON.stringify(assets).includes("tok-123"), false);
  assert.equal(JSON.stringify(ticket).includes("tok-123"), false);
});

test("bridge rejects invalid variants, asset ids, and classification ids without fetching", async () => {
  const storage = { collectorToken: "tok", collectorSettings: { baseUrl: "http://100.76.119.29:32146" } };
  const fetchCalls = [];
  const fetchImpl = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    return {
      ok: true, status: 200, statusText: "", url,
      headers: { entries() { return [][Symbol.iterator](); } },
      async json() { return {}; }, async text() { return "{}"; },
    };
  };
  const { context, messageListeners } = createMessageCaptureContext({ storage, fetch: fetchImpl });
  vm.runInNewContext(frameSource, context, { filename: "mobile-api-frame.js" });

  async function op(payload) {
    const requestId = "req-x";
    const replyPromise = new Promise((resolve) => {
      context.parent.postMessage = (message) => {
        if (message.source === "lakomics-mobile-api" && message.requestId === requestId) resolve(message.result);
      };
    });
    for (const listener of messageListeners) {
      listener({ source: context.parent, origin: PAGE_ORIGIN, data: { source: "lakomics-mobile-content", requestId, ...payload } });
    }
    return replyPromise;
  }

  const badVariant = await op({ op: "library:media-ticket", assetId: "a1", variant: "originals/x" });
  assert.equal(badVariant.ok, false);
  assert.equal(badVariant.code, "invalid_media_variant");

  const badAsset = await op({ op: "library:media-ticket", assetId: "", variant: "thumbnail" });
  assert.equal(badAsset.ok, false);
  assert.equal(badAsset.code, "invalid_asset_id");

  const badClassification = await op({ op: "library:assets", classificationId: "  " });
  assert.equal(badClassification.ok, false);
  assert.equal(badClassification.code, "invalid_classification_id");

  const unknownOp = await op({ op: "captures:list" });
  assert.equal(unknownOp.ok, false);
  assert.equal(unknownOp.code, "unknown_mobile_api_operation");

  // 어떤 fetch도 발생하지 않았다 (임의 경로 프록시 불가)
  assert.equal(fetchCalls.length, 0);

  const wrongOriginReply = await new Promise((resolve) => {
    context.parent.postMessage = (message) => resolve(message);
    for (const listener of messageListeners) {
      listener({ source: context.parent, origin: "https://evil.example", data: { source: "lakomics-mobile-content", requestId: "req-y", op: "library:classifications" } });
    }
    // origin 불일치 시 frame은 응답하지 않는다.
    setTimeout(() => resolve(null), 50);
  });
  assert.equal(wrongOriginReply, null);
});

test("manifest loads the store before the bridge and the frame stays web-accessible", () => {
  const mobileScripts = manifest.content_scripts.find((cs) => cs.matches.includes("https://lacucaracha421.github.io/chatgpt/*"));
  assert.ok(mobileScripts);
  assert.equal(mobileScripts.js[0], "src/mobile-library-store.js");
  assert.ok(mobileScripts.js.includes("src/mobile-bridge.js"));
  assert.ok(mobileScripts.js.includes("src/mobile-assets.js"));
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ["mobile-api-frame.html", "src/mobile-api-frame.js"]);
});

test("mobile-assets no longer references Cloud Capture browsing", () => {
  assert.doesNotMatch(assetsSource, /captures:list|capture:ticket|\/v1\/captures|pbs\.twimg\.com/);
  assert.match(assetsSource, /library:assets/);
  assert.match(assetsSource, /library:media-ticket/);
  assert.match(frameSource, /\/v1\/library\/classifications/);
  assert.doesNotMatch(frameSource, /\/v1\/captures/);
  assert.match(bridgeSource, /library:classifications/);
  assert.doesNotMatch(bridgeSource, /classifications:get|classifications:refresh|sendRuntimeMessage/);
});

// --- 스토어 테스트 ---
function createStoreHarness(pageSize = 100, total = 250) {
  const assetIds = Array.from({ length: total }, (_, i) => `asset-${String(i + 1).padStart(4, "0")}`);
  const pages = [];
  const ticketCalls = [];
  let cursorCounter = 0;
  const store = globalThis.LakomicsMobileLibrary.createStore({
    requestAssets: async ({ cursor, limit, sort }) => {
      const start = pages.length * pageSize;
      const items = assetIds.slice(start, start + limit).map((id) => ({
        id,
        kind: "image",
        contentType: "image/jpeg",
        sizeBytes: 123,
        classificationIds: ["c1"],
        originalAvailable: true,
        thumbnailAvailable: true,
      }));
      pages.push({ cursor, limit, sort, ids: items.map((item) => item.id) });
      const hasMore = start + limit < total;
      const nextCursor = hasMore ? `cursor-${++cursorCounter}` : null;
      return { ok: true, items, hasMore, nextCursor };
    },
    requestTicket: async ({ assetId, variant }) => {
      ticketCalls.push({ assetId, variant });
      return {
        ok: true,
        url: `https://r2.example/${assetId}/${variant}`,
        contentType: "image/webp",
        sizeBytes: 500,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    },
  });
  return { store, pages, ticketCalls, assetIds };
}

test("store paginates by has_more and terminates without inferring counts", async () => {
  setupStoreVm();
  const { store, pages } = createStoreHarness(100, 250);
  await store.loadFirstPage("c1");
  assert.equal(pages.length, 1);
  await store.loadNextPage("c1");
  await store.loadNextPage("c1");
  const scope = store.getScope("c1");
  assert.equal(scope.items.length, 250);
  assert.equal(scope.hasMore, false);
  assert.equal(scope.cursor, null);
  // has_more=false 이후 추가 로드 시도는 no-op
  const extra = await store.loadNextPage("c1");
  assert.equal(extra.ok, false);
  assert.equal(extra.code, "no_next_page");
  assert.equal(pages.length, 3);
});

test("changing sort discards the old cursor and starts a clean first page", async () => {
  setupStoreVm();
  const { store, pages } = createStoreHarness(100, 250);
  await store.loadFirstPage("c1", { sort: "newest" });
  await store.loadNextPage("c1");
  await store.loadFirstPage("c1", { sort: "oldest" });

  assert.equal(pages.at(-1).cursor, null);
  assert.equal(pages.at(-1).sort, "oldest");
  assert.equal(store.getScope("c1").sort, "oldest");
  assert.equal(store.getScope("c1").items[0].id, "asset-0201");
});

test("Recent view requests global newest 100 once and caps the result", async () => {
  setupStoreVm();
  const calls = [];
  const store = globalThis.LakomicsMobileLibrary.createStore({
    requestAssets: async (request) => {
      calls.push(request);
      return {
        ok: true,
        items: Array.from({ length: 120 }, (_, index) => ({ id: `recent-${index + 1}` })),
        hasMore: true,
        nextCursor: "must-not-be-used",
      };
    },
    requestTicket: async () => ({ ok: false, code: "unused" }),
  });

  await store.loadFirstPage({ type: "recent" }, { sort: "oldest" });
  const scope = store.getScope({ type: "recent" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].viewType, "recent");
  assert.equal(calls[0].classificationId, undefined);
  assert.equal(calls[0].sort, "newest");
  assert.equal(calls[0].limit, 100);
  assert.equal(scope.items.length, 100);
  assert.equal(scope.hasMore, false);
  assert.equal((await store.loadNextPage({ type: "recent" })).code, "no_next_page");
});

test("view transition keeps the old grid until one current replacement commits", () => {
  setupStoreVm();
  const transition = globalThis.LakomicsMobileLibrary.createViewTransition({ type: "classification", classificationId: "A" });
  const request = transition.begin({ type: "classification", classificationId: "B" });

  assert.equal(request.keepVisible, true);
  assert.equal(transition.visible().classificationId, "A");
  assert.equal(transition.commit(request.token), true);
  assert.equal(transition.visible().classificationId, "B");
  assert.equal(transition.commit(request.token), false, "a response may replace the grid only once");
});

test("view transition ignores stale responses and rapid A to B to C ends on C", () => {
  setupStoreVm();
  const transition = globalThis.LakomicsMobileLibrary.createViewTransition({ type: "classification", classificationId: "A" });
  const requestB = transition.begin({ type: "classification", classificationId: "B" });
  const requestC = transition.begin({ type: "classification", classificationId: "C" });

  assert.equal(transition.commit(requestB.token), false);
  assert.equal(transition.visible().classificationId, "A");
  assert.equal(transition.commit(requestC.token), true);
  assert.equal(transition.visible().classificationId, "C");
});

test("reselecting an in-flight view waits for its first page and commits the latest selection", async () => {
  setupStoreVm();
  let resolveA;
  const store = globalThis.LakomicsMobileLibrary.createStore({
    requestAssets: () => new Promise((resolve) => { resolveA = resolve; }),
    requestTicket: async () => ({ ok: false }),
  });
  const transition = globalThis.LakomicsMobileLibrary.createViewTransition({ type: "classification", classificationId: "old" });
  const viewA = { type: "classification", classificationId: "A" };
  const firstA = transition.begin(viewA);
  const loading = store.loadFirstPage(viewA);
  transition.begin({ type: "classification", classificationId: "B" });
  const latestA = transition.begin(viewA);
  const waiting = store.waitForFirstPage(viewA);

  resolveA({ ok: true, items: [{ id: "a1" }], hasMore: false, nextCursor: null });
  assert.equal((await waiting).ok, true);
  await loading;
  assert.equal(transition.commit(firstA.token), false);
  assert.equal(transition.commit(latestA.token), true);
  assert.equal(transition.visible().classificationId, "A");
  assert.equal(store.getScope(viewA).items.map((item) => item.id).join(","), "a1");
});

test("failed replacement keeps the old view and a retry can commit cleanly", () => {
  setupStoreVm();
  const transition = globalThis.LakomicsMobileLibrary.createViewTransition({ type: "classification", classificationId: "A" });
  const failed = transition.begin({ type: "classification", classificationId: "B" });
  assert.equal(transition.fail(failed.token), true);
  assert.equal(transition.visible().classificationId, "A");
  const retry = transition.begin({ type: "classification", classificationId: "B" });
  assert.equal(transition.commit(retry.token), true);
  assert.equal(transition.visible().classificationId, "B");
});

test("saved real classification wins, otherwise Mobile restores Recent", () => {
  setupStoreVm();
  const restore = globalThis.LakomicsMobileLibrary.restoreMobileView;
  assert.equal(restore({ selectedId: "c2" }, new Set(["c1", "c2"])).classificationId, "c2");
  assert.equal(restore({ selectedId: "deleted" }, new Set(["c1", "c2"])).type, "recent");
  assert.equal(restore({}, new Set(["c1", "c2"])).type, "recent");
  assert.equal(restore({}, new Set()).type, "recent");
});

test("viewer chrome starts hidden, toggles on taps, and auto-hides", () => {
  setupStoreVm();
  const scheduled = [];
  const states = [];
  const chromeState = globalThis.LakomicsMobileLibrary.createViewerChrome({
    delayMs: 3200,
    setTimer: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    clearTimer: () => {},
    onChange: (visible) => states.push(visible),
  });

  chromeState.open();
  assert.equal(chromeState.visible(), false);
  chromeState.mediaTap();
  assert.equal(chromeState.visible(), true);
  assert.equal(scheduled.at(-1).delay, 3200);
  chromeState.mediaTap();
  assert.equal(chromeState.visible(), false);
  chromeState.mediaTap();
  scheduled.at(-1).callback();
  assert.equal(chromeState.visible(), false);
  assert.deepEqual(states, [false, true, false, true, false]);
});

test("viewer chrome ignores buttons, swipes, movement, and video controls", () => {
  setupStoreVm();
  const chromeState = globalThis.LakomicsMobileLibrary.createViewerChrome({ onChange: () => {} });
  chromeState.open();
  chromeState.mediaTap({ interactive: true });
  chromeState.mediaTap({ swiped: true });
  chromeState.mediaTap({ moved: true });
  assert.equal(chromeState.visible(), false);
  chromeState.interact();
  assert.equal(chromeState.visible(), true, "button interaction reveals and resets chrome without toggling it");
});

test("native video controls are protected while the playing video surface remains a chrome tap", () => {
  setupStoreVm();
  const hit = globalThis.LakomicsMobileLibrary.isNativeVideoControlHit;
  assert.equal(hit({ clientY: 490, top: 100, bottom: 500, paused: false, currentTime: 12 }), true);
  assert.equal(hit({ clientY: 250, top: 100, bottom: 500, paused: false, currentTime: 12 }), false);
  assert.equal(hit({ clientY: 250, top: 100, bottom: 500, paused: true, currentTime: 0 }), true);
});

test("video grid thumbnails request only the thumbnail variant and preserve failure", async () => {
  setupStoreVm();
  const calls = [];
  const success = await globalThis.LakomicsMobileLibrary.loadGridThumbnail(
    { id: "video-1", kind: "video" },
    async (assetId, variant) => {
      calls.push({ assetId, variant });
      return { ok: true, url: "https://r2.example/video-1/thumb.webp", contentType: "image/webp" };
    },
  );
  const failure = await globalThis.LakomicsMobileLibrary.loadGridThumbnail(
    { id: "video-2", kind: "video" },
    async (assetId, variant) => {
      calls.push({ assetId, variant });
      return { ok: false, code: "unavailable" };
    },
  );

  assert.deepEqual(calls, [
    { assetId: "video-1", variant: "thumbnail" },
    { assetId: "video-2", variant: "thumbnail" },
  ]);
  assert.equal(success.url, "https://r2.example/video-1/thumb.webp");
  assert.equal(failure.ok, false);
});

test("swipe navigation requires dominant horizontal travel and ignores video controls", () => {
  setupStoreVm();
  const swipe = globalThis.LakomicsMobileLibrary.swipeDirection;
  assert.equal(swipe({ startX: 200, startY: 100, endX: 110, endY: 112 }), 1);
  assert.equal(swipe({ startX: 100, startY: 100, endX: 190, endY: 92 }), -1);
  assert.equal(swipe({ startX: 100, startY: 100, endX: 130, endY: 101 }), 0);
  assert.equal(swipe({ startX: 100, startY: 100, endX: 160, endY: 170 }), 0);
  assert.equal(swipe({ startX: 200, startY: 100, endX: 110, endY: 100, interactive: true }), 0);
});

test("mobile metadata follows PC labels, fallbacks, classifications, and safe source URLs", () => {
  setupStoreVm();
  const metadata = globalThis.LakomicsMobileLibrary.mobileMetadata({
    id: "a1",
    kind: "video",
    contentType: "video/mp4",
    sizeBytes: 1_048_576,
    collectedAt: "2026-09-02T00:00:00Z",
    sourcePublishedAt: "2026-09-01T12:30:00Z",
    sourceUrl: "https://x.com/example/status/1",
    creatorName: "Example Artist",
    creatorHandle: "@example",
    importSource: "browser_extension",
    classificationIds: ["child", "missing"],
  }, [
    { id: "root", name: "게임", parentId: null },
    { id: "child", name: "명조", parentId: "root" },
  ]);

  assert.equal(metadata.creator, "Example Artist (@example)");
  assert.equal(metadata.sourceUrl, "https://x.com/example/status/1");
  assert.deepEqual(metadata.classifications, ["게임 › 명조"]);
  assert.equal(metadata.file.find((row) => row.label === "형식").value, "VIDEO · video/mp4");
  assert.equal(metadata.file.find((row) => row.label === "크기").value, "1 MB");
  assert.ok(metadata.source.find((row) => row.label === "게시 시각").value);
  assert.ok(metadata.imported.find((row) => row.label === "가져온 날짜").value);
  assert.equal(metadata.imported.find((row) => row.label === "가져온 방식").value, "브라우저 확장");

  const missing = globalThis.LakomicsMobileLibrary.mobileMetadata({
    id: "a2", kind: "image", sourceUrl: "javascript:alert(1)", classificationIds: [],
  }, []);
  assert.equal(missing.creator, "");
  assert.equal(missing.sourceUrl, "");
  assert.deepEqual(missing.classifications, []);
});

test("mobile asset source includes real video thumbnails, fallback, swipe hooks, and details sheet", () => {
  assert.match(assetsSource, /data-lib-thumb/);
  assert.match(assetsSource, /lakomics-live-video-thumb/);
  assert.match(assetsSource, /pointerdown/);
  assert.match(assetsSource, /pointerup/);
  assert.match(assetsSource, /viewer-details/);
  assert.match(mobilePageSource, /최신순/);
  assert.match(mobilePageSource, /오래된순/);
});

test("viewer uses hidden chrome and an accessible icon without visible information text", () => {
  assert.match(assetsSource, /viewer-chrome-visible/);
  assert.match(assetsSource, /aria-label", "정보"/);
  assert.match(assetsSource, /textContent = "ⓘ"/);
  assert.doesNotMatch(assetsSource, /toggle\.textContent = "정보"/);
  assert.doesNotMatch(mobilePageSource, /viewer-details-toggle"[^>]*>정보</);
  assert.match(assetsSource, /isNativeVideoControlHit/);
  assert.match(assetsSource, /button,a,input,select,textarea/);
});

test("Recent 100 is a special top-level view with fixed newest sorting", () => {
  assert.match(bridgeSource, /data-lakomics-live-view="recent"/);
  assert.match(bridgeSource, /최근 100개/);
  assert.match(assetsSource, /sortSelect\.disabled/);
  assert.match(assetsSource, /viewType: view\.type/);
  assert.doesNotMatch(bridgeSource, /!response\?\.ok \|\| !entries\.length/);
});

test("store drops duplicate asset ids on retried pages", async () => {
  setupStoreVm();
  let call = 0;
  const store = globalThis.LakomicsMobileLibrary.createStore({
    requestAssets: async () => {
      call += 1;
      // 재시도 시 같은 아이템을 다시 반환하는 서버/네트워크 시나리오
      return {
        ok: true,
        items: [{ id: "dup-1" }, { id: "dup-2" }],
        hasMore: call < 2,
        nextCursor: call < 2 ? "c" : null,
      };
    },
    requestTicket: async () => ({ ok: false, code: "unused" }),
  });
  await store.loadFirstPage("c1");
  await store.loadNextPage("c1");
  const scope = store.getScope("c1");
  assert.deepEqual(scope.items.map((item) => item.id).join(","), "dup-1,dup-2");
});

test("store caches media tickets per asset+variant and reuses within TTL", async () => {
  setupStoreVm();
  const { store, ticketCalls } = createStoreHarness(10, 5);
  const first = await store.ticketFor("a1", "thumbnail");
  const second = await store.ticketFor("a1", "thumbnail");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(ticketCalls.length, 1);
  const original = await store.ticketFor("a1", "original");
  assert.equal(original.url.includes("original"), true);
  assert.equal(ticketCalls.length, 2);
});

test("store neighbor navigation crosses page boundaries via loadNextPage", async () => {
  setupStoreVm();
  const { store, pages } = createStoreHarness(100, 150);
  await store.loadFirstPage("c1");
  const atBoundary = store.neighbor("c1", "asset-0100", 1);
  assert.equal(atBoundary.pending, true);
  await store.loadNextPage("c1");
  const after = store.neighbor("c1", "asset-0100", 1);
  assert.equal(after.item.id, "asset-0101");
  assert.equal(pages.length, 2);
  const last = store.neighbor("c1", "asset-0150", 1);
  assert.equal(last, null);
});

test("store trims window head beyond the bounded grid", async () => {
  setupStoreVm();
  const { store } = createStoreHarness(100, 700);
  await store.loadFirstPage("c1");
  await store.loadNextPage("c1");
  await store.loadNextPage("c1");
  await store.loadNextPage("c1");
  await store.loadNextPage("c1");
  await store.loadNextPage("c1");
  await store.loadNextPage("c1");
  const scope = store.getScope("c1");
  assert.equal(scope.items.length, 700);
  const dropped = store.trimWindow("c1", 700 - globalThis.LakomicsMobileLibrary.GRID_MAX_TILES);
  assert.equal(dropped, 700 - 600);
  assert.equal(scope.items.length, 600);
  assert.equal(scope.items[0].id, "asset-0101");
  // 잘린 id는 seen에서 제거되어 다시 로드될 수 있다
  assert.equal(scope.seenIds.has("asset-0001"), false);
});

// 스토어 소스를 전역 컨텍스트에 로드
function setupStoreVm() {
  if (globalThis.LakomicsMobileLibrary) return;
  const context = { console, globalThis: null };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(storeSource, context, { filename: "mobile-library-store.js" });
  globalThis.LakomicsMobileLibrary = context.globalThis.LakomicsMobileLibrary;
}
const mobilePageSource = fs.readFileSync(new URL("../../mobile/index.html", import.meta.url), "utf8");
const mobileShellSource = fs.readFileSync(new URL("../../mobile/mobile-shell.js", import.meta.url), "utf8");

test("mobile uses the runtime bridge and keeps the static shell interactive", () => {
  assert.match(assetsSource, /chrome\.runtime\.sendMessage/);
  assert.match(mobilePageSource, /mobile-shell\.js/);
  assert.match(mobileShellSource, /\[data-nav\]/);
  assert.match(mobileShellSource, /\[data-go\]/);
  assert.match(mobileShellSource, /#categoryOpen/);
  assert.match(mobileShellSource, /#viewerClose/);
  assert.match(mobilePageSource, /\["connected", "failed"\]/);
});

test("mobile page has explicit host access and exposes an injection probe", () => {
  assert.ok(manifest.host_permissions.includes("https://lacucaracha421.github.io/*"));
  assert.match(bridgeSource, /data-lakomics-extension-bridge/);
});


test("mobile content scripts use runtime messaging instead of iframe postMessage", () => {
  assert.match(bridgeSource, /chrome\.runtime\.sendMessage/);
  assert.match(assetsSource, /chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(bridgeSource, /frameRequest\(/);
  assert.doesNotMatch(assetsSource, /frameRequest\(/);
});
