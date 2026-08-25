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
  createGalleryStore,
  nextAutoHarvestState,
  parseStatusHref,
  pruneSavedEntries,
  selectedTabIsFirst,
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
