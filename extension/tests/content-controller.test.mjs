import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const layoutSource = fs.readFileSync(new URL("../src/layout.js", import.meta.url), "utf8");
const gestureSource = fs.readFileSync(new URL("../src/gesture.js", import.meta.url), "utf8");
const contentSource = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");

test("auto-like clicks only the matching visible post and never unlikes an existing like", () => {
  const api = loadContent(async () => ({ ok: true }));
  let clicks = 0;
  const matchingLink = { getAttribute: () => "/artist/status/123/photo/1" };
  const otherLink = { getAttribute: () => "/other/status/999" };
  const likeButton = { click() { clicks += 1; } };
  const article = {
    querySelectorAll() { return [matchingLink]; },
    querySelector(selector) {
      if (selector === '[data-testid="unlike"]') return null;
      if (selector === '[data-testid="like"]') return likeButton;
      return null;
    },
  };
  const otherArticle = {
    querySelectorAll() { return [otherLink]; },
    querySelector() { return null; },
  };
  const root = { querySelectorAll() { return [otherArticle, article]; } };

  assert.equal(api.findTweetArticleForPost(root, "123"), article);
  assert.deepEqual(plain(api.autoLikeVisiblePost(root, "123")), { ok: true, status: "dom_click_sent" });
  assert.equal(clicks, 1);

  article.querySelector = (selector) => selector === '[data-testid="unlike"]' ? {} : likeButton;
  assert.deepEqual(plain(api.autoLikeVisiblePost(root, "123")), { ok: true, status: "already_liked" });
  assert.equal(clicks, 1);
  assert.deepEqual(plain(api.autoLikeVisiblePost(root, "404")), { ok: false, status: "not_found" });
});

test("FavoriteTweet API fallback uses the logged-in X session and csrf cookie", async () => {
  const api = loadContent(async () => ({ ok: true }));
  let request = null;
  const fetchFn = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      async json() { return { data: { favorite_tweet: "Done" } }; },
    };
  };
  const result = await api.favoriteTweetViaWebApi({
    postId: "123",
    fetchFn,
    cookieString: "foo=1; ct0=csrf-token-xyz; bar=2",
    origin: "https://x.com",
    language: "ko-KR",
  });
  assert.deepEqual(plain(result), { ok: true, status: "api_liked" });
  assert.match(request.url, /\/FavoriteTweet$/);
  assert.equal(request.options.credentials, "include");
  assert.equal(request.options.headers["x-csrf-token"], "csrf-token-xyz");
  assert.equal(request.options.headers["x-twitter-client-language"], "ko");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.variables.tweet_id, "123");
  assert.equal(payload.queryId, api.X_FAVORITE_TWEET_QUERY_ID);
});


test("auto-like falls back to FavoriteTweet API when the tweet is no longer in the DOM", async () => {
  const api = loadContent(async () => ({ ok: true }));
  const root = { querySelectorAll() { return []; } };
  let calls = 0;
  const result = await api.autoLikePost({
    root,
    postId: "456",
    cookieString: "ct0=token",
    origin: "https://x.com",
    waitMs: 0,
    fetchFn: async () => {
      calls += 1;
      return { ok: true, status: 200, async json() { return { data: { favorite_tweet: "Done" } }; } };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(plain(result), { ok: true, status: "api_liked", method: "api", domStatus: "not_found" });
});


test("auto-like diagnostics preserve X HTTP failures without failing Lakomics save", async () => {
  const api = loadContent(async () => ({ ok: true }));
  const result = await api.autoLikePost({
    root: { querySelectorAll() { return []; } },
    postId: "789",
    cookieString: "ct0=token",
    origin: "https://x.com",
    waitMs: 0,
    fetchFn: async () => ({ ok: false, status: 403 }),
  });
  assert.deepEqual(plain(result), {
    ok: false,
    status: "api_http_failed",
    httpStatus: 403,
    method: "api_fallback",
    domStatus: "not_found",
  });
  assert.equal(api.autoLikeFeedback(result), "저장 완료 · 좋아요 실패(HTTP 403)");
});


test("sends one final selection and cancellation sends nothing", async () => {
  const sent = [];
  const api = loadContent(async (payload) => { sent.push(payload); return { ok: true, status: "added" }; });
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const candidate = {
    mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig",
    sourceUrl: "https://x.com/user/status/1/photo/1",
  };
  const entries = [{ id: "tag", kind: "tag", name: "Tag", parentId: null }];
  const layout = api.radial.resetLayout(entries);

  controller.begin(candidate, { x: 100, y: 100 }, entries, layout);
  controller.move({ x: 100, y: 16 }, 0);
  await controller.release();
  await controller.release();
  assert.equal(sent.length, 1);
  assert.deepEqual(plain(sent[0]), {
    source: "x",
    mediaType: "image",
    mediaUrl: candidate.mediaUrl,
    sourceUrl: candidate.sourceUrl,
    author: null,
    postId: null,
    mediaIndex: null,
    classificationId: "tag",
    classificationName: "Tag",
    classificationPath: ["Tag"],
    classificationSource: "app",
  });

  controller.begin(candidate, { x: 100, y: 100 }, entries, layout);
  controller.move({ x: 100, y: 16 }, 0);
  controller.cancel();
  await controller.release();
  assert.equal(sent.length, 1);
});

test("retry resends the identical failed payload", async () => {
  const sent = [];
  const api = loadContent(async (payload) => {
    sent.push(payload);
    return sent.length === 1 ? { ok: false, code: "download_failed" } : { ok: true, status: "added" };
  });
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const entries = [{ id: "tag", kind: "tag", name: "Tag", parentId: null }];
  const candidate = { mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig", sourceUrl: "https://x.com/u/status/1" };
  controller.begin(candidate, { x: 0, y: 0 }, entries, api.radial.resetLayout(entries));
  controller.move({ x: 0, y: -84 }, 0);
  await controller.release();
  await controller.retry();

  assert.equal(sent.length, 2);
  assert.deepEqual(plain(sent[1]), plain(sent[0]));
});

test("worker transport failures remain retryable", async () => {
  const sent = [];
  const statuses = [];
  const api = loadContent(async (payload) => {
    sent.push(payload);
    if (sent.length === 1) throw new Error("worker stopped");
    return { ok: true, status: "added" };
  });
  const controller = api.createCollectorController({
    send: api.send,
    status(message, retry) { statuses.push({ message, retry }); },
    snapshot: api.snapshot,
  });
  const entries = [{ id: "tag", kind: "tag", name: "Tag", parentId: null }];
  const candidate = { mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig", sourceUrl: "https://x.com/u/status/1" };
  controller.begin(candidate, { x: 0, y: 0 }, entries, api.radial.resetLayout(entries));
  controller.move({ x: 0, y: -84 }, 0);

  assert.deepEqual(plain(await controller.release()), { ok: false, code: "worker_failed" });
  assert.equal(statuses.at(-1).retry, true);
  assert.deepEqual(plain(await controller.retry()), { ok: true, status: "added" });
  assert.deepEqual(plain(sent[1]), plain(sent[0]));
});


test("partial metadata failure is retryable without pretending the image failed", () => {
  const api = loadContent(async () => ({ ok: true }));
  const feedback = api.feedbackFor({ ok: false, code: "metadata_download_failed", imageDownloaded: true });
  assert.equal(feedback.message, "미디어는 저장됐지만 JSON 저장에 실패했습니다");
  assert.equal(feedback.retry, true);
  assert.equal(api.feedbackFor({ ok: true, status: "metadata_repaired" }).message, "JSON 저장 완료");
  assert.equal(api.feedbackFor({ ok: true, status: "duplicate_recent" }).message, "방금 저장한 미디어입니다");
  assert.equal(
    api.feedbackFor({ ok: true, status: "downloaded", fallbackCode: "app_offline" }).message,
    "Lakomics 연결 불가 · 기기에 저장됨",
  );
});

test("video selections preserve post identity while deferring the final media URL", async () => {
  const sent = [];
  const api = loadContent(async (payload) => { sent.push(payload); return { ok: true, status: "downloaded" }; });
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const entries = [{ id: "video", kind: "tag", name: "영상", parentId: null }];
  const candidate = {
    type: "video",
    mediaUrl: null,
    sourceUrl: "https://x.com/artist/status/555/video/2",
    author: "artist",
    postId: "555",
    mediaIndex: 2,
  };
  controller.begin(candidate, { x: 0, y: 0 }, entries, api.radial.resetLayout(entries));
  controller.move({ x: 0, y: -84 }, 0);
  await controller.release();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].mediaType, "video");
  assert.equal(sent[0].mediaUrl, null);
  assert.equal(sent[0].postId, "555");
  assert.equal(sent[0].mediaIndex, 2);
});



test("nested local selections include the full classification path", async () => {
  const sent = [];
  const api = loadContent(async (payload) => { sent.push(payload); return { ok: true, status: "downloaded" }; });
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const entries = [
    { id: "root", kind: "root", name: "명조", parentId: null },
    { id: "child", kind: "tag", name: "카멜리아", parentId: "root" },
  ];
  const layout = {
    version: 1,
    parents: {
      __pinned__: [["root", null, null, null, null, null]],
      root: [["child", null, null, null, null, null, null, null, null, null, null, null]],
    },
  };
  controller.begin(
    { mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig", sourceUrl: "https://x.com/u/status/1/photo/1" },
    { x: 100, y: 100 }, entries, layout, [], "local", { openImmediately: true },
  );
  controller.move({ x: 100, y: 21 }, 0);
  assert.deepEqual(plain(controller.activate()), { type: "expand", classificationId: "root" });
  const angles = api.gesture.secondaryAngles(0, 6, 12);
  const angle = angles[0].center;
  const r = (118 + 180) / 2;
  controller.move({ x: 100 + Math.cos(angle) * r, y: 100 + Math.sin(angle) * r }, 1);
  assert.deepEqual(plain(controller.activate()), { type: "select", classificationId: "child" });
  await Promise.resolve();
  assert.deepEqual(plain(sent[0].classificationPath), ["명조", "카멜리아"]);
});

test("touch center selects the expanded parent classification", async () => {
  const sent = [];
  const api = loadContent(async (payload) => { sent.push(payload); return { ok: true, status: "downloaded" }; });
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const entries = [
    { id: "parent", kind: "root", name: "명조", parentId: null },
    { id: "child", kind: "tag", name: "카멜리아", parentId: "parent" },
  ];
  const layout = api.radial.resetLayout(entries);
  controller.begin(
    { mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig", sourceUrl: "https://x.com/u/status/1/photo/1" },
    { x: 100, y: 100 }, entries, layout, [], "local",
    { openImmediately: true, centerSelectsExpandedParent: true },
  );
  controller.move({ x: 100, y: 21 }, 0);
  assert.deepEqual(plain(controller.activate()), { type: "expand", classificationId: "parent" });
  controller.move({ x: 100, y: 100 }, 1);
  assert.deepEqual(plain(controller.activate()), { type: "select", classificationId: "parent" });
  await Promise.resolve();
  assert.equal(sent[0].classificationId, "parent");
  assert.deepEqual(plain(sent[0].classificationPath), ["명조"]);
});

test("touch activation keeps the controller alive while expanding, then submits a child", async () => {
  const sent = [];
  const api = loadContent(async (payload) => { sent.push(payload); return { ok: true, status: "added" }; });
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const entries = [
    { id: "parent", kind: "root", name: "Parent", parentId: null },
    { id: "child", kind: "tag", name: "Child", parentId: "parent" },
  ];
  const layout = api.radial.resetLayout(entries);
  controller.begin(
    { mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig", sourceUrl: "https://x.com/u/status/1/photo/1" },
    { x: 100, y: 100 }, entries, layout, [], "app", { openImmediately: true },
  );
  controller.move({ x: 100, y: 21 }, 0);
  assert.deepEqual(plain(controller.activate()), { type: "expand", classificationId: "parent" });
  assert.equal(sent.length, 0);

  const angles = api.gesture.secondaryAngles(0, 6, 6);
  const angle = angles[0].center;
  const r = (118 + 180) / 2;
  controller.move({ x: 100 + Math.cos(angle) * r, y: 100 + Math.sin(angle) * r }, 1);
  assert.deepEqual(plain(controller.activate()), { type: "select", classificationId: "child" });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].classificationId, "child");
});

test("click suppression consumes only the first click after a radial drag", () => {
  const api = loadContent(async () => ({ ok: true }));
  const suppressor = api.createClickSuppressor();
  const ordinary = clickEvent();
  assert.equal(suppressor.consume(ordinary), false);
  assert.equal(ordinary.defaultPrevented, false);
  assert.equal(ordinary.immediatePropagationStopped, false);

  suppressor.arm();
  const synthetic = { ...clickEvent(), isTrusted: false };
  assert.equal(suppressor.consume(synthetic), false);
  assert.equal(synthetic.defaultPrevented, false);
  assert.equal(synthetic.immediatePropagationStopped, false);

  const first = clickEvent();
  assert.equal(suppressor.consume(first), true);
  assert.equal(first.defaultPrevented, true);
  assert.equal(first.immediatePropagationStopped, true);

  const second = clickEvent();
  assert.equal(suppressor.consume(second), false);
  assert.equal(second.defaultPrevented, false);
  assert.equal(second.immediatePropagationStopped, false);
});

test("secondary ring expands on dwell and renders child slots", async () => {
  const api = loadContent(async () => ({ ok: true, status: "added" }));
  const controller = api.createCollectorController({ send: api.send, status() {}, snapshot: api.snapshot });
  const entries = [
    { id: "parent", kind: "root", name: "Parent", parentId: null },
    { id: "child", kind: "tag", name: "Child", parentId: "parent" },
  ];
  const layout = api.radial.resetLayout(entries);
  controller.begin({ mediaUrl: "https://x.com/img.jpg", sourceUrl: "https://x.com/u/1" }, { x: 100, y: 100 }, entries, layout);
  controller.move({ x: 100, y: 16 }, 0);
  controller.tick(300);
  const lastSnapshot = api.lastSnapshot;
  assert.notEqual(lastSnapshot.secondaryLevel, null);
  assert.equal(lastSnapshot.secondaryLevel.slots[0].id, "child");
});

test("mobile radial origin is clamped so the full menu stays inside the viewport", () => {
  const api = loadContent(async () => ({ ok: true }));
  assert.deepEqual(plain(api.clampRadialOrigin({ x: 20, y: 20 }, 800, 1280)), { x: 228, y: 228 });
  assert.deepEqual(plain(api.clampRadialOrigin({ x: 790, y: 1270 }, 800, 1280)), { x: 572, y: 1052 });
  assert.deepEqual(plain(api.clampRadialOrigin({ x: 400, y: 640 }, 800, 1280)), { x: 400, y: 640 });
});

test("mobile radial origin falls back to the viewport center when the viewport is narrower than the menu", () => {
  const api = loadContent(async () => ({ ok: true }));
  assert.deepEqual(plain(api.clampRadialOrigin({ x: 10, y: 250 }, 360, 500)), { x: 180, y: 250 });
});

function loadContent(send) {
  const context = {
    URL,
    setTimeout,
    globalThis: null,
    __LAKOMICS_TEST__: true,
    __send: send,
  };
  context.globalThis = context;
  vm.runInNewContext(layoutSource, context, { filename: "layout.js" });
  vm.runInNewContext(gestureSource, context, { filename: "gesture.js" });
  vm.runInNewContext(contentSource, context, { filename: "content.js" });
  let lastSnapshot = null;
  return {
    ...context.LakomicsContent,
    radial: context.LakomicsRadial,
    gesture: context.LakomicsGesture,
    send,
    snapshot(next) { lastSnapshot = next; },
    get lastSnapshot() { return lastSnapshot; },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function clickEvent() {
  return {
    defaultPrevented: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
  };
}

test("controller keeps a mobile pending selection alive until center confirms it", async () => {
  const sent = [];
  const snapshots = [];
  const api = loadContent(async (payload) => { sent.push(payload); return { ok: true, status: "downloaded" }; });
  const controller = api.createCollectorController({
    send: api.send,
    status() {},
    snapshot(value) { snapshots.push(plain(value)); },
  });
  const entries = [{ id: "leaf", kind: "tag", name: "Leaf", parentId: null }];
  const layout = api.radial.resetLayout(entries);
  controller.begin(
    { mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig", sourceUrl: "https://x.com/u/status/1/photo/1" },
    { x: 100, y: 100 }, entries, layout, [], "local",
    { openImmediately: true, centerSelectsExpandedParent: true, confirmSelectionWithCenter: true },
  );
  controller.move({ x: 100, y: 21 }, 0);
  assert.deepEqual(plain(controller.activate()), { type: "pending", classificationId: "leaf" });
  assert.equal(sent.length, 0);
  assert.equal(snapshots.at(-1).pendingClassificationId, "leaf");
  controller.move({ x: 100, y: 100 }, 1);
  assert.deepEqual(plain(controller.activate()), { type: "select", classificationId: "leaf" });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].classificationId, "leaf");
});


test("successful image saves notify the gallery marker, but review-pending does not", async () => {
  const marked = [];
  const api = loadContent(async () => ({ ok: true, status: "downloaded" }));
  const controller = api.createCollectorController({
    send: api.send,
    status() {},
    snapshot: api.snapshot,
    saved(payload, response) { marked.push({ payload, response }); },
  });
  const entries = [{ id: "tag", kind: "tag", name: "Tag", parentId: null }];
  const candidate = { mediaUrl: "https://pbs.twimg.com/media/A?format=jpg&name=orig", sourceUrl: "https://x.com/u/status/1" };
  controller.begin(candidate, { x: 0, y: 0 }, entries, api.radial.resetLayout(entries));
  controller.move({ x: 0, y: -84 }, 0);
  await controller.release();
  assert.equal(marked.length, 1);
  assert.equal(marked[0].payload.mediaUrl, candidate.mediaUrl);

  const pendingMarked = [];
  const pending = api.createCollectorController({
    send: async () => ({ ok: true, status: "review_pending" }),
    status() {},
    snapshot: api.snapshot,
    saved(payload) { pendingMarked.push(payload); },
  });
  pending.begin(candidate, { x: 0, y: 0 }, entries, api.radial.resetLayout(entries));
  pending.move({ x: 0, y: -84 }, 0);
  await pending.release();
  assert.equal(pendingMarked.length, 0);
});
