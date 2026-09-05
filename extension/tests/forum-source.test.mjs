import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/forum-source.js", import.meta.url), "utf8");
function candidate(page, tagName, attrs = {}, generic = false) {
  const context = { URL, location: { href: page } };
  vm.runInNewContext(source, context);
  const node = { tagName, getAttribute: name => attrs[name] ?? null,
    textContent: attrs.text ?? "", querySelectorAll: () => [],
    closest(selector) {
      if (selector === "img, video, audio" && tagName !== "A") return node;
      if (selector === "a[href]" && tagName === "A") return node;
      return null;
    },
  };
  return generic ? context.LakomicsForumSource.findGenericCandidate(node) : context.LakomicsForumSource.findCandidate(node);
}

test("Arca prefers original media URL and retains signed query parameters", () => {
  const result = candidate("https://arca.live/b/art/123", "IMG", {
    src: "https://ac-p.namu.la/thumb.webp", "data-originalurl": "https://ac-o.namu.la/original.png?token=fixture",
  });
  assert.equal(result.source, "arca");
  assert.equal(result.sourceUrl, "https://arca.live/b/art/123");
  assert.equal(result.mediaUrl, "https://ac-o.namu.la/original.png?token=fixture&type=orig");
});

test("Arca original CDN keeps signed fields and normalizes duplicate original-size parameters", () => {
  const result = candidate("https://arca.live/b/art/123?p=1", "IMG", {
    src: "https://ac-o.arca.live/20260905sac/art.jpg?expires=123&key=fixture&type=orig&type=orig",
  });
  const url = new URL(result.mediaUrl);
  assert.equal(url.hostname, "ac-o.arca.live");
  assert.equal(url.searchParams.get("expires"), "123");
  assert.equal(url.searchParams.get("key"), "fixture");
  assert.deepEqual(url.searchParams.getAll("type"), ["orig"]);
});

test("DC desktop and mobile accept images and progressive video without X resolution", () => {
  for (const host of ["gall.dcinside.com", "m.dcinside.com"]) {
    assert.equal(candidate(`https://${host}/board/view/?id=art&no=1`, "IMG", {
      src: "https://dcimg1.dcinside.com/viewimage.php?id=fixture&no=1",
    }).source, "dcinside");
    assert.equal(candidate(`https://${host}/board/view/?id=art&no=1`, "VIDEO", {
      src: "https://vod.dcinside.com/movie.mp4",
    }).type, "video");
  }
});

test("audio and attachments retain their type and download filename", () => {
  assert.equal(candidate("https://arca.live/b/art/1", "A", { href: "/sound.flac" }).type, "audio");
  const result = candidate("https://arca.live/b/art/1", "A", { href: "/download/123", download: "그림.zip" });
  assert.equal(result.type, "file");
  assert.equal(result.filename, "그림.zip");
});

test("does not capture navigation, streaming, blob URLs or lookalike sites", () => {
  assert.equal(candidate("https://arca.live/b/art/1", "A", { href: "/b/art/2" }), null);
  for (const src of ["blob:https://arca.live/123", "https://cdn.example/video.m3u8", "https://cdn.example/video.mpd"]) {
    assert.equal(candidate("https://arca.live/b/art/1", "VIDEO", { src }), null);
  }
  assert.equal(candidate("https://arca.live.evil/b/art/1", "IMG", { src: "https://example.com/a.jpg" }), null);
});

test("manifest enables the common donut on HTTPS sites without duplicating X and Mobile handlers", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const script = manifest.content_scripts.find(entry => entry.js.includes("src/forum-source.js"));
  assert.deepEqual(script.matches, ["https://*/*"]);
  assert.deepEqual(script.exclude_matches, ["https://x.com/*", "https://twitter.com/*", "https://lacucaracha421.github.io/chatgpt/*"]);
  assert.ok(script.js.includes("src/content.js"));
  assert.ok(script.js.includes("src/gesture.js"));
  assert.ok(!script.js.includes("src/x-translate.js"));
});

test("generic sites detect full-size images, progressive video, audio and attachment links", () => {
  const page = "https://blog.example.com/posts/123";
  const image = candidate(page, "IMG", { src: "/small.jpg", srcset: "/small.jpg 320w, /large.jpg 1600w" }, true);
  assert.equal(image.source, "web");
  assert.equal(image.mediaUrl, "https://blog.example.com/large.jpg");
  assert.equal(image.sourceUrl, page);
  for (const [tag, attrs, type] of [
    ["VIDEO", { src: "https://cdn.example.com/media/video.webm" }, "video"],
    ["AUDIO", { src: "/sound.flac" }, "audio"],
    ["A", { href: "/download/123", download: "art.zip" }, "file"],
    ["A", { href: "https://cdn.example.com/original.png" }, "image"],
  ]) assert.equal(candidate(page, tag, attrs, true).type, type);
});

test("generic handling does not override X or accept streams, scripts and navigation links", () => {
  assert.equal(candidate("https://x.com/home", "IMG", { src: "https://pbs.twimg.com/avatar.jpg" }, true), null);
  for (const href of ["/posts/next", "javascript:alert(1)", "blob:https://blog.example.com/id", "/stream.m3u8"]) {
    assert.equal(candidate("https://blog.example.com/post/1", "A", { href }, true), null);
  }
  assert.equal(candidate("https://blog.example.com/post/1", "VIDEO", { src: "/stream.mpd" }, true), null);
});
