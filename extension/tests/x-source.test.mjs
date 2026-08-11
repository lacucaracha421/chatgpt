import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/x-source.js", import.meta.url), "utf8");
const context = { URL, globalThis: null };
context.globalThis = context;
vm.runInNewContext(source, context, { filename: "x-source.js" });
const { findCandidate } = context.LakomicsXSource;

test("normalizes the largest X media image and nearest post URL", () => {
  const candidate = findCandidate(fakePhoto({
    src: "https://pbs.twimg.com/media/ABC?format=jpg&name=small",
    srcset: "https://pbs.twimg.com/media/ABC?format=jpg&name=small 400w, https://pbs.twimg.com/media/ABC?format=jpg&name=large 1200w",
    href: "https://twitter.com/user/status/123/photo/1?ref=timeline",
  }));

  assert.equal(candidate.mediaUrl, "https://pbs.twimg.com/media/ABC?format=jpg&name=orig");
  assert.equal(candidate.sourceUrl, "https://x.com/user/status/123/photo/1");
});

test("rejects avatars, video thumbnails, misleading hosts, and missing posts", () => {
  assert.equal(findCandidate(fakePhoto({
    src: "https://pbs.twimg.com/profile_images/avatar.jpg",
    href: "https://x.com/user/status/1",
  })), null);
  assert.equal(findCandidate(fakePhoto({
    src: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/X.jpg",
    href: "https://x.com/user/status/1",
  })), null);
  assert.equal(findCandidate(fakePhoto({
    src: "https://pbs.twimg.com.evil/media/ABC.jpg",
    href: "https://x.com/user/status/1",
  })), null);
  assert.equal(findCandidate(fakePhoto({
    src: "https://pbs.twimg.com/media/ABC.jpg",
    href: "https://x.com/home",
  })), null);
});

test("falls back to currentSrc and normalizes supported extensions", () => {
  const candidate = findCandidate(fakePhoto({
    src: "https://pbs.twimg.com/media/ABC.webp",
    currentSrc: "https://pbs.twimg.com/media/ABC.webp",
    href: "/user/status/456",
  }));

  assert.equal(candidate.mediaUrl, "https://pbs.twimg.com/media/ABC.webp?format=webp&name=orig");
  assert.equal(candidate.sourceUrl, "https://x.com/user/status/456");
});

function fakePhoto({ src, currentSrc = "", srcset = "", href }) {
  const link = { getAttribute: (name) => name === "href" ? href : null, href };
  const article = { querySelectorAll: () => [link] };
  const image = {
    src,
    currentSrc,
    getAttribute(name) {
      if (name === "srcset") return srcset;
      if (name === "data-src") return null;
      return null;
    },
    closest(selector) {
      if (selector === "img") return image;
      if (selector === "article") return article;
      if (selector.startsWith("a[")) return link;
      return null;
    },
  };
  return { closest: (selector) => selector === "img" ? image : null };
}
