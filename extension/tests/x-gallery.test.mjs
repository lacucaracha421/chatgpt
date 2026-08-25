import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/x-gallery.js", import.meta.url), "utf8");
const context = {
  URL,
  globalThis: null,
  __LAKOMICS_TEST__: true,
  location: { href: "https://x.com/home", pathname: "/home" },
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "x-gallery.js" });
const {
  AUTO_TARGET_NEW_IMAGES,
  GALLERY_INITIAL_RENDER_ITEMS,
  GALLERY_RENDER_BATCH_ITEMS,
  LIKE_FILTER_THRESHOLDS,
  createGalleryStore,
  galleryItemKey,
  extractLikeCount,
  formatLikeCount,
  matchesLikeFilter,
  nextAutoHarvestState,
  parseCompactMetric,
  parseStatusHref,
  pruneSavedEntries,
  selectedTabIsFirst,
  takeUnrenderedGalleryItems,
} = context.LakomicsXGallery;

test("parses X status/photo URLs without depending on the UI language", () => {
  const parsed = parseStatusHref("https://twitter.com/user/status/123/photo/2?ref=home");
  assert.equal(parsed.username, "user");
  assert.equal(parsed.tweetId, "123");
  assert.equal(parsed.photoIndex, 1);
  assert.equal(parsed.postUrl, "https://x.com/user/status/123");
});

test("For You detection helper treats only the first selected home tab as active", () => {
  const tab = (selected) => ({ getAttribute: (name) => name === "aria-selected" ? selected : null });
  assert.equal(selectedTabIsFirst([tab("true"), tab("false")]), true);
  assert.equal(selectedTabIsFirst([tab("false"), tab("true")]), false);
});

test("gallery store deduplicates posts and media URLs while accepting later images", () => {
  let changes = 0;
  const store = createGalleryStore(() => { changes += 1; });
  assert.equal(store.upsert({
    tweetId: "1",
    username: "u",
    author: "@u",
    postUrl: "https://x.com/u/status/1",
    collectedAt: 10,
    images: [{ url: "https://pbs.twimg.com/media/A?format=jpg&name=orig", index: 1 }],
  }), true);
  assert.equal(store.upsert({
    tweetId: "1",
    username: "u",
    author: "@u",
    postUrl: "https://x.com/u/status/1",
    collectedAt: 20,
    images: [{ url: "https://pbs.twimg.com/media/A?format=jpg&name=orig", index: 1 }],
  }), false);
  assert.equal(store.upsert({
    tweetId: "1",
    username: "u",
    author: "@u",
    postUrl: "https://x.com/u/status/1",
    collectedAt: 20,
    images: [{ url: "https://pbs.twimg.com/media/B?format=jpg&name=orig", index: 2 }],
  }), true);
  assert.equal(store.imageCount(), 2);
  assert.equal(store.postCount(), 1);
  assert.equal(changes, 2);
});

test("auto harvest stops at its image target, on stalled feed, and when leaving For You", () => {
  assert.equal(AUTO_TARGET_NEW_IMAGES, 100);
  assert.equal(nextAutoHarvestState({
    currentCount: 110,
    targetCount: 110,
    noProgressRounds: 0,
    elapsedMs: 1000,
    stillForYou: true,
    moved: true,
  }).done, true);
  assert.equal(nextAutoHarvestState({
    currentCount: 20,
    targetCount: 110,
    noProgressRounds: 8,
    elapsedMs: 1000,
    stillForYou: true,
    moved: true,
  }).done, true);
  assert.equal(nextAutoHarvestState({
    currentCount: 20,
    targetCount: 110,
    noProgressRounds: 0,
    elapsedMs: 1000,
    stillForYou: false,
    moved: true,
  }).done, true);
  assert.equal(nextAutoHarvestState({
    currentCount: 20,
    targetCount: 110,
    noProgressRounds: 0,
    elapsedMs: 1000,
    stillForYou: true,
    moved: true,
  }).done, false);
});


test("saved-media history drops expired entries and caps recent markers", () => {
  const now = 200 * 24 * 60 * 60 * 1000;
  const recent = {};
  for (let index = 0; index < 3010; index += 1) recent[`url-${index}`] = now - index;
  recent.expired = now - 91 * 24 * 60 * 60 * 1000;
  const pruned = pruneSavedEntries(recent, now);
  assert.equal(Object.keys(pruned).length, 3000);
  assert.equal("expired" in pruned, false);
  assert.equal("url-0" in pruned, true);
  assert.equal("url-3009" in pruned, false);
});


test("incremental gallery batching keeps already-rendered media out of later batches", () => {
  assert.equal(GALLERY_INITIAL_RENDER_ITEMS, 36);
  assert.equal(GALLERY_RENDER_BATCH_ITEMS, 24);
  const items = Array.from({ length: 70 }, (_, index) => ({
    tweetId: String(index),
    imageIndex: 1,
    imageUrl: `https://pbs.twimg.com/media/${index}?format=jpg&name=orig`,
  }));
  const rendered = new Set();
  const initial = takeUnrenderedGalleryItems(items, rendered, GALLERY_INITIAL_RENDER_ITEMS);
  assert.equal(initial.length, 36);
  for (const item of initial) rendered.add(galleryItemKey(item));
  const next = takeUnrenderedGalleryItems(items, rendered, GALLERY_RENDER_BATCH_ITEMS);
  assert.equal(next.length, 24);
  assert.equal(next[0].tweetId, "36");
  assert.equal(next.at(-1).tweetId, "59");
});

test("gallery store reports only newly-added media to incremental renderer", () => {
  const changes = [];
  const store = createGalleryStore((change) => changes.push(change));
  store.upsert({
    tweetId: "9",
    username: "u",
    author: "@u",
    postUrl: "https://x.com/u/status/9",
    collectedAt: 100,
    images: [{ url: "A", index: 1 }],
  });
  store.upsert({
    tweetId: "9",
    username: "u",
    author: "@u",
    postUrl: "https://x.com/u/status/9",
    collectedAt: 110,
    images: [{ url: "A", index: 1 }, { url: "B", index: 2 }],
  });
  assert.equal(changes.length, 2);
  assert.equal(changes[0].type, "upsert");
  assert.deepEqual(Array.from(changes[0].items, (item) => item.imageUrl), ["A"]);
  assert.deepEqual(Array.from(changes[1].items, (item) => item.imageUrl), ["B"]);
});


test("like-count parser handles X raw counts and compact Korean/Japanese/English forms", () => {
  assert.equal(parseCompactMetric("1,234 Likes. Liked"), 1234);
  assert.equal(parseCompactMetric("1.2K Likes"), 1200);
  assert.equal(parseCompactMetric("2.5만 좋아요"), 25000);
  assert.equal(parseCompactMetric("3.4万 件のいいね"), 34000);
  assert.equal(parseCompactMetric("좋아요"), null);
  assert.deepEqual(Array.from(LIKE_FILTER_THRESHOLDS), [0, 1000, 5000, 10000]);
});

test("like extractor prefers stable like/unlike test ids without depending on UI language", () => {
  const button = {
    getAttribute: (name) => name === "aria-label" ? "좋아요 5,432개. 좋아요 취소" : null,
    innerText: "5.4K",
    textContent: "5.4K",
  };
  const article = { querySelector: () => button };
  assert.equal(extractLikeCount(article), 5432);
  assert.equal(extractLikeCount({ querySelector: () => null }), null);
});

test("gallery keeps all images but exposes minimum-like filtering and metadata upgrades", () => {
  const store = createGalleryStore(() => {});
  store.upsert({
    tweetId: "low", username: "a", author: "@a", postUrl: "https://x.com/a/status/1",
    collectedAt: 10, likeCount: 900, images: [{ url: "A", index: 1 }],
  });
  store.upsert({
    tweetId: "high", username: "b", author: "@b", postUrl: "https://x.com/b/status/2",
    collectedAt: 20, likeCount: 6000, images: [{ url: "B", index: 1 }, { url: "C", index: 2 }],
  });
  assert.equal(store.imageCount(), 3);
  assert.equal(store.imageCount(1000), 2);
  assert.equal(store.imageCount(5000), 2);
  assert.equal(store.imageCount(10000), 0);
  assert.equal(matchesLikeFilter({ likeCount: null }, 1000), false);
  assert.equal(formatLikeCount(null), "—");

  store.upsert({
    tweetId: "low", username: "a", author: "@a", postUrl: "https://x.com/a/status/1",
    collectedAt: 30, likeCount: 1200, images: [{ url: "A", index: 1 }],
  });
  assert.equal(store.imageCount(1000), 3);
  assert.equal(store.flatImages().find((item) => item.tweetId === "low").likeCount, 1200);
});
