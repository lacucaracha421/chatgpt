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

test("Assets view model restores recent/classification only (Home is a top-level tab)", () => {
  setupStoreVm();
  const restore = globalThis.LakomicsMobileLibrary.restoreMobileView;
  assert.equal(restore({ view: { type: "recent" } }, new Set()).type, "recent");
  assert.equal(restore({ selectedId: "c2" }, new Set(["c1", "c2"])).classificationId, "c2");
  assert.equal(restore({ selectedId: "deleted" }, new Set(["c1", "c2"])).type, "recent");
  assert.equal(restore({}, new Set(["c1", "c2"])).type, "recent");
  assert.equal(restore({}, new Set()).type, "recent");
  // 이전 alpha의 home/revisit 저장 상태는 Assets 모델로 안전히 낙향한다.
  assert.equal(restore({ view: { type: "home" } }, new Set()).type, "recent");
  assert.equal(restore({ view: { type: "revisit" } }, new Set()).type, "recent");
});

test("store batch tickets dedupe inflight work and merge cached + fetched results", async () => {
  setupStoreVm();
  const { createStore } = globalThis.LakomicsMobileLibrary;
  let batchCalls = 0;
  const store = createStore({
    requestAssets: async () => ({ ok: true, items: [], hasMore: false, nextCursor: null }),
    requestVirtualView: async () => ({ ok: true, items: [], hasMore: false, nextCursor: null }),
    requestTickets: async (requests) => {
      batchCalls += 1;
      return {
        ok: true,
        items: requests.map((entry) => ({
          asset_id: entry.assetId, variant: entry.variant, ok: true,
          url: `https://r2/${entry.assetId}`, expiresAt: new Date(Date.now() + 300_000).toISOString(),
        })),
      };
    },
    requestTicket: async () => ({ ok: false, code: "single_not_used" }),
  });
  const r1 = await store.ticketsFor([{ assetId: "a", variant: "thumbnail" }, { assetId: "b", variant: "thumbnail" }]);
  assert.equal(r1.ok, true);
  const r2 = await store.ticketsFor([{ assetId: "a", variant: "thumbnail" }, { assetId: "b", variant: "thumbnail" }]);
  assert.equal(r2.ok, true);
  assert.equal(batchCalls, 1, "second call must be served from the session cache");
});

test("overlapping thumbnail batches dedupe every inflight key", async () => {
  setupStoreVm();
  const { createStore } = globalThis.LakomicsMobileLibrary;
  let batchCalls = 0;
  let releaseBatch;
  const gate = new Promise((resolve) => { releaseBatch = resolve; });
  const store = createStore({
    requestAssets: async () => ({ ok: true, items: [], hasMore: false, nextCursor: null }),
    requestVirtualView: async () => ({ ok: true, items: [], hasMore: false, nextCursor: null }),
    requestTickets: async (requests) => {
      batchCalls += 1;
      await gate;
      return {
        ok: true,
        items: requests.map((entry) => ({
          asset_id: entry.assetId, variant: entry.variant, ok: true,
          url: `https://r2/${entry.assetId}`, expiresAt: new Date(Date.now() + 300_000).toISOString(),
        })),
      };
    },
    requestTicket: async () => ({ ok: false, code: "single_not_used" }),
  });
  const first = store.ticketsFor([
    { assetId: "overlap-a", variant: "thumbnail" },
    { assetId: "overlap-b", variant: "thumbnail" },
  ]);
  await Promise.resolve();
  const second = store.ticketsFor([{ assetId: "overlap-b", variant: "thumbnail" }]);
  releaseBatch();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(batchCalls, 1, "every key in the first batch must be registered before awaiting it");
});

test("mobile-assets has no undefined Home initialization references", () => {
  // 15.50에서 installHomeDashboard()/setHomeDiagnostic()이 정의 없이 호출되어
  // installHooks가 observeTreeSelection 직후 ReferenceError로 중단됐다.
  assert.doesNotMatch(assetsSource, /\binstallHomeDashboard\b/);
  // setHomeDiagnostic은 정의와 호출이 모두 존재해야 한다.
  assert.match(assetsSource, /function setHomeDiagnostic\(/);
  assert.match(assetsSource, /setHomeDiagnostic\(/);
  // initializeHomeOnce/installHomeTrigger는 정의 + 호출이 쌍으로 존재한다.
  assert.match(assetsSource, /function initializeHomeOnce\(/);
  assert.match(assetsSource, /function installHomeTrigger\(/);
  assert.match(assetsSource, /installHomeTrigger\(\);/);
  assert.match(assetsSource, /initializeHomeOnce\(\);/);
  // installHooks가 observeTreeSelection 후 Home 트리거에 도달한다 (순서 보장).
  const hooksBody = assetsSource.slice(
    assetsSource.indexOf("function installHooks()"),
    assetsSource.indexOf("function observeTreeSelection()"),
  );
  assert.ok(hooksBody.indexOf("observeTreeSelection();") < hooksBody.indexOf("installHomeTrigger();"));
});

test("initial active Home loads first page and renders without tab switching", async () => {
  setupStoreVm();
  const { createStore } = globalThis.LakomicsMobileLibrary;
  const calls = [];
  const store = createStore({
    requestAssets: async () => ({ ok: true, items: [], hasMore: false, nextCursor: null }),
    requestVirtualView: async (view, limit) => {
      calls.push({ virtual: view.type, limit });
      return {
        ok: true,
        items: [{ id: "h1" }, { id: "h2" }],
        hasMore: false,
        nextCursor: null,
      };
    },
    requestTicket: async () => ({ ok: false, code: "unused" }),
    requestTickets: async () => ({ ok: false, code: "unused" }),
  });
  // 초기 active Home은 store.loadFirstPage({type:"home"}) → requestVirtualView
  // → mobile-library:assets recent preview 순서로 로드된다 (탭 전환 불필요).
  await store.loadFirstPage({ type: "home" });
  const scope = store.getScope({ type: "home" });
  assert.equal(scope.loadedFirstPage, true);
  assert.equal(JSON.stringify(scope.items.map((item) => item.id)), JSON.stringify(["h1", "h2"]));
  assert.equal(JSON.stringify(calls), JSON.stringify([{ virtual: "home", limit: 100 }]));
});

test("failed initial Home load produces a defined diagnostic, not a throw", async () => {
  setupStoreVm();
  const { createStore } = globalThis.LakomicsMobileLibrary;
  const store = createStore({
    requestAssets: async () => ({ ok: true, items: [], hasMore: false, nextCursor: null }),
    requestVirtualView: async () => ({ ok: false, code: "home_failed" }),
    requestTicket: async () => ({ ok: false, code: "unused" }),
    requestTickets: async () => ({ ok: false, code: "unused" }),
  });
  const result = await store.loadFirstPage({ type: "home" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "home_failed");
  // 확장측 setHomeDiagnostic이 이 실패를 #homeLoading 진단으로 안전히 변환한다.
  assert.match(assetsSource, /function setHomeDiagnostic/);
});

test("manifest is production-only for Mobile host access", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const mobile = manifest.content_scripts.find((cs) => cs.matches.includes("https://lacucaracha421.github.io/chatgpt/*"));
  assert.ok(mobile);
  assert.equal(manifest.host_permissions.includes("http://100.86.19.36/*"), false);
  assert.equal(mobile.matches.some((match) => match.includes("mobile-preview")), false);
});

test("page allowlist accepts only canonical production Mobile pages", () => {
  const pages = [{ origin: "https://lacucaracha421.github.io", pathPrefix: "/chatgpt/" }];
  const allowed = (origin, path) => pages.some((page) => origin === page.origin && path.startsWith(page.pathPrefix));
  assert.equal(allowed("https://lacucaracha421.github.io", "/chatgpt/"), true);
  assert.equal(allowed("https://lacucaracha421.github.io", "/chatgpt/mobile/"), true);
  assert.equal(allowed("https://lacucaracha421.github.io", "/mobile-preview/"), false);
  assert.equal(allowed("http://100.86.19.36:32147", "/mobile-preview/"), false);
  assert.equal(allowed("https://example.com", "/chatgpt/"), false);
});

test("home sections fail independently (revisit error keeps recent rail)", async () => {
  setupStoreVm();
  const { createStore } = globalThis.LakomicsMobileLibrary;
  const store = createStore({
    requestAssets: async () => ({
      ok: true, items: [{ id: "r1" }, { id: "r2" }], hasMore: false, nextCursor: null,
    }),
    requestVirtualView: async (view) => (
      view.type === "home"
        ? { ok: true, items: [{ id: "r1" }, { id: "r2" }], hasMore: false, nextCursor: null }
        : { ok: false, code: "revisit_failed" }
    ),
    requestTickets: async () => ({ ok: false, code: "failed" }),
    requestTicket: async () => ({ ok: false, code: "failed" }),
  });
  await store.loadFirstPage({ type: "home" });
  const scope = store.getScope({ type: "home" });
  assert.equal(scope.items.length, 2);
  assert.equal(scope.items[0].id, "r1");
  // Home 데이터 로드는 성공 — 다시보기 rail의 API 실패는 renderHome에서
  // rail 단위로 격리되어 최근 추가 rail을 유지한다 (UI 레벨 검증).
  assert.equal(await store.ticketFor("r1", "thumbnail").then((r) => r.ok), false);
});

test("home/revisit virtual views use requestVirtualView and never send classification ids", async () => {
  setupStoreVm();
  const { createStore } = globalThis.LakomicsMobileLibrary;
  const calls = [];
  const store = createStore({
    requestAssets: ({ viewType, classificationId }) => {
      calls.push({ viewType, classificationId });
      return { ok: true, items: [], hasMore: false, nextCursor: null };
    },
    requestVirtualView: async (view) => {
      calls.push({ virtual: view.type });
      return { ok: true, items: [{ id: "h1" }], hasMore: false, nextCursor: null };
    },
    requestTicket: async () => ({ ok: false, code: "unused" }),
  });
  await store.loadFirstPage({ type: "home" });
  await store.loadFirstPage({ type: "revisit" });
  await store.loadFirstPage({ type: "classification", classificationId: "c1" });
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([
      { virtual: "home" },
      { virtual: "revisit" },
      { viewType: "classification", classificationId: "c1" },
    ]),
  );
});

test("home store scope is bounded: has_more stays false for virtual views", async () => {
  setupStoreVm();
  const { createStore } = globalThis.LakomicsMobileLibrary;
  const store = createStore({
    requestAssets: async () => ({ ok: true, items: [], hasMore: false, nextCursor: null }),
    requestVirtualView: async () => ({
      ok: true,
      items: [{ id: "a" }, { id: "b" }],
      // 서버가 실수로 has_more를 true로 보내도 가상 뷰는 페이지네이션하지 않는다.
      hasMore: true,
      nextCursor: "x",
    }),
    requestTicket: async () => ({ ok: false, code: "unused" }),
  });
  await store.loadFirstPage({ type: "home" });
  const scope = store.getScope({ type: "home" });
  assert.equal(scope.hasMore, false);
  assert.equal(scope.items.length, 2);
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
  // 페이지 소유 진단: #homeLoading 기반, 확장 probe/live-classifications 상태 확인.
  assert.match(mobilePageSource, /#homeLoading/);
  assert.match(mobilePageSource, /lakomicsExtensionBridge === "loaded"/);
  assert.match(mobilePageSource, /lakomicsLiveClassifications/);
  assert.doesNotMatch(mobilePageSource, /prototype-banner/);
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


test("home, recent, revisit, and classifications use distinct store keys", () => {
  setupStoreVm();
  const { viewKey } = globalThis.LakomicsMobileLibrary;
  assert.equal(viewKey({ type: "home" }), "view:home");
  assert.equal(viewKey({ type: "recent" }), "view:recent");
  assert.equal(viewKey({ type: "revisit" }), "view:revisit");
  assert.equal(viewKey({ type: "classification", classificationId: "c1" }), "classification:c1");
  assert.equal(new Set([
    viewKey({ type: "home" }),
    viewKey({ type: "recent" }),
    viewKey({ type: "revisit" }),
    viewKey({ type: "classification", classificationId: "c1" }),
  ]).size, 4);
});


test("home renders recent before revisit resolves and revisit failure keeps recent", async () => {
  setupStoreVm();
  // renderHome의 핵심 계약은 store scope 데이터가 있으면 Recent를 즉시 그리는 것.
  // (renderHome은 DOM 의존이라 여기서는 store 계약 + 소스 정적 검증으로 커버한다.)
  assert.match(assetsSource, /container\.innerHTML = recentHtml \+ revisitPlaceholder/);
  assert.match(assetsSource, /커밋된 라이브러리 에셋이 아직 없습니다/);
  assert.match(assetsSource, /revisitTarget\.outerHTML = homeSectionHtml\(/);
  // Recent가 렌더되면 전역 타임아웃이 해제된다.
  assert.match(assetsSource, /clearHomeDiagnostic\(\)/);
  // Revisit 실패 rail이 Recent를 덮지 않는다 — outerHTML로 rail만 교체.
  assert.match(assetsSource, /다시보기를 불러오지 못했습니다/);
});

test("home Recent/Revisit cache, retry, refresh, and diagnostic container are coherent", () => {
  assert.match(assetsSource, /const HOME_CACHE_TTL_MS = 45_000/);
  assert.match(assetsSource, /recentAt: 0, revisitAt: 0/);
  assert.match(assetsSource, /function homeRecentCacheValid\(/);
  assert.match(assetsSource, /function homeRevisitCacheValid\(/);
  assert.match(assetsSource, /function invalidateHomeCache\(\{ recent = true, revisit = true \} = \{\}\)/);
  assert.match(assetsSource, /invalidateHomeCache\(\{ recent: false, revisit: true \}\)/);
  assert.match(assetsSource, /initializeHomeOnce\(\{ forceRecent: true \}\)/);
  assert.match(assetsSource, /function isHomeActive\(\)/);
  assert.match(assetsSource, /return document\.querySelector\("#homeDashboard"\);/);
  assert.doesNotMatch(assetsSource, /#homeDashboard"\) \|\| document\.querySelector\("#assetGrid"/);
  assert.doesNotMatch(assetsSource, /removeAttribute\("id"\)/);
});

test("creator groups render as separate rails with display fallbacks", () => {
  assert.ok(assetsSource.includes("for (const group of creatorBundle?.groups || [])"));
  assert.match(assetsSource, /function creatorDisplay\(group\)/);
  assert.ok(assetsSource.includes('return `${name} (@${handle})`'));
  assert.ok(assetsSource.includes('return `@${handle}`'));
  assert.ok(assetsSource.includes('data-home-open-creator'));
});

test("Home detail uses a vertical asset grid, viewer rail context, and progressive cursor loading", () => {
  assert.ok(assetsSource.includes('class="asset-grid home-detail__grid"'));
  assert.ok(assetsSource.includes("function loadHomeDetailNext()"));
  assert.ok(assetsSource.includes("data-home-detail-sentinel"));
  assert.ok(assetsSource.includes("homeDetailState.items.push"));
  assert.ok(assetsSource.includes("homeRailContexts.set(key, state.items)"));
  assert.doesNotMatch(assetsSource, /container\.innerHTML = homeRailHtml\(title, items/);
});

test("thumbnail observers are container-scoped and use the batch ticket store", () => {
  assert.match(assetsSource, /const thumbnailObservers = new WeakMap\(\)/);
  assert.match(assetsSource, /store\.ticketsFor\(/);
  assert.doesNotMatch(assetsSource, /thumbnailObserver\?\.disconnect\(\)/);
});

test("date and creator 모두 보기 routes are strictly validated in the service worker", () => {
  const workerSource = fs.readFileSync(new URL("../src/background-worker.js", import.meta.url), "utf8");
  assert.ok(workerSource.includes("mobile-library:assets-url"));
  assert.ok(workerSource.includes('/v1/library/revisit/date'));
  assert.ok(workerSource.includes("creatorKey = decodeURIComponent(match[1])"));
  assert.ok(workerSource.includes("validateMobileLibraryAssetsPath"));
  assert.ok(workerSource.includes("validDetailQuery"));
  assert.match(workerSource, /invalid_assets_url/);
});
