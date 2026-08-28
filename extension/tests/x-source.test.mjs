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
    datetime: "2026-08-01T10:20:30.000Z",
  }));

  assert.equal(candidate.mediaUrl, "https://pbs.twimg.com/media/ABC?format=jpg&name=orig");
  assert.equal(candidate.sourceUrl, "https://x.com/user/status/123/photo/1");
  assert.equal(candidate.publishedAt, "2026-08-01T10:20:30.000Z");
});

test("publish timestamp stays empty when the tweet has no time element", () => {
  const candidate = findCandidate(fakePhoto({
    src: "https://pbs.twimg.com/media/ABC?format=jpg&name=small",
    href: "https://x.com/user/status/123/photo/1",
  }));

  assert.equal(candidate.publishedAt, null);
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
  assert.equal(candidate.sourceUrl, "https://x.com/user/status/456/photo/1");
});

function fakePhoto({ src, currentSrc = "", srcset = "", href, datetime = "" }) {
  const link = { getAttribute: (name) => name === "href" ? href : null, href };
  let image;
  const article = {
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      return [link];
    },
    querySelector(selector) {
      if (selector === "time[datetime]") {
        return datetime ? { getAttribute: (name) => name === "datetime" ? datetime : null } : null;
      }
      return null;
    },
  };
  image = {
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

test("infers a stable photo index for each image in a multi-image post", () => {
  const gallery = fakeGallery({
    href: "https://x.com/artist/status/999",
    media: [
      "https://pbs.twimg.com/media/ONE?format=jpg&name=small",
      "https://pbs.twimg.com/media/TWO?format=png&name=small",
      "https://pbs.twimg.com/media/THREE?format=webp&name=small",
    ],
  });

  const first = findCandidate(gallery.targets[0]);
  const second = findCandidate(gallery.targets[1]);
  const third = findCandidate(gallery.targets[2]);

  assert.equal(first.sourceUrl, "https://x.com/artist/status/999/photo/1");
  assert.equal(second.sourceUrl, "https://x.com/artist/status/999/photo/2");
  assert.equal(third.sourceUrl, "https://x.com/artist/status/999/photo/3");
  assert.equal(first.mediaIndex, 1);
  assert.equal(second.mediaIndex, 2);
  assert.equal(third.mediaIndex, 3);
  assert.notEqual(first.mediaUrl, second.mediaUrl);
  assert.notEqual(second.mediaUrl, third.mediaUrl);
});

function fakeGallery({ href, media }) {
  const postLink = { getAttribute: (name) => name === "href" ? href : null, href };
  const images = [];
  const article = {
    querySelectorAll(selector) {
      if (selector === "img") return images;
      if (selector.startsWith('a[')) return [postLink];
      return [];
    },
  };

  for (const src of media) {
    const image = {
      src,
      currentSrc: src,
      getAttribute(name) {
        if (name === "srcset") return "";
        if (name === "data-src") return null;
        return null;
      },
      closest(selector) {
        if (selector === "img") return image;
        if (selector === "article") return article;
        if (selector.startsWith("a[")) return postLink;
        return null;
      },
    };
    images.push(image);
  }

  return {
    targets: images.map((image) => ({ closest: (selector) => selector === "img" ? image : null })),
  };
}

test("detects a video when the long-press target is an overlay inside X videoPlayer", () => {
  const fixture = fakeVideoPost({
    href: "https://x.com/artist/status/555/video/1",
    videoCount: 1,
    targetIndex: 0,
  });

  const candidate = findCandidate(fixture.target);

  assert.equal(candidate.type, "video");
  assert.equal(candidate.mediaUrl, null);
  assert.equal(candidate.sourceUrl, "https://x.com/artist/status/555/video/1");
  assert.equal(candidate.author, "artist");
  assert.equal(candidate.postId, "555");
  assert.equal(candidate.mediaIndex, 1);
});

test("infers the video ordinal when X exposes only a bare status link", () => {
  const fixture = fakeVideoPost({
    href: "https://x.com/artist/status/777",
    videoCount: 2,
    targetIndex: 1,
  });

  const candidate = findCandidate(fixture.target);

  assert.equal(candidate.type, "video");
  assert.equal(candidate.sourceUrl, "https://x.com/artist/status/777/video/2");
  assert.equal(candidate.mediaIndex, 2);
});

function fakeVideoPost({ href, videoCount, targetIndex }) {
  const postLink = { getAttribute: (name) => name === "href" ? href : null, href };
  const players = [];
  const videos = [];
  const article = {
    querySelectorAll(selector) {
      if (selector === '[data-testid="videoPlayer"]') return players;
      if (selector === "video") return videos;
      if (selector.startsWith('a[')) return [postLink];
      return [];
    },
  };

  for (let index = 0; index < videoCount; index += 1) {
    let player;
    const video = {
      closest(selector) {
        if (selector === "video") return video;
        if (selector === '[data-testid="videoPlayer"]') return player;
        if (selector === "article") return article;
        if (selector.startsWith('a[')) return null;
        return null;
      },
    };
    player = {
      parentElement: article,
      querySelector(selector) { return selector === "video" ? video : null; },
      closest(selector) {
        if (selector === '[data-testid="videoPlayer"]') return player;
        if (selector === "article") return article;
        if (selector.startsWith('a[')) return null;
        return null;
      },
    };
    videos.push(video);
    players.push(player);
  }

  const player = players[targetIndex];
  const target = {
    parentElement: player,
    closest(selector) {
      if (selector === "video") return null;
      if (selector === '[data-testid="videoPlayer"]') return player;
      if (selector === "article") return article;
      if (selector.startsWith('a[')) return null;
      return null;
    },
    querySelector() { return null; },
  };
  return { target };
}

test("does not treat ordinary tweet text as a video target just because the article contains video", () => {
  const fixture = fakeVideoPost({
    href: "https://x.com/artist/status/888/video/1",
    videoCount: 1,
    targetIndex: 0,
  });
  const article = fixture.target.closest("article");
  const textTarget = {
    parentElement: article,
    closest(selector) {
      if (selector === "article") return article;
      return null;
    },
    querySelector() { return null; },
  };

  assert.equal(findCandidate(textTarget), null);
});

test("gallery images preserve explicit post metadata for the existing radial save flow", () => {
  const attrs = {
    "data-lakomics-media-url": "https://pbs.twimg.com/media/GALLERY?format=png&name=small",
    "data-lakomics-source-url": "https://x.com/galleryuser/status/999",
    "data-lakomics-author": "galleryuser",
    "data-lakomics-post-id": "999",
    "data-lakomics-media-index": "3",
  };
  const image = {
    src: "https://pbs.twimg.com/media/GALLERY?format=png&name=small",
    currentSrc: "",
    getAttribute(name) { return attrs[name] ?? null; },
    closest(selector) {
      if (selector === "img") return image;
      return null;
    },
  };
  const target = { closest: (selector) => selector === "img" ? image : null };
  const candidate = findCandidate(target);

  assert.equal(candidate.type, "image");
  assert.equal(candidate.mediaUrl, "https://pbs.twimg.com/media/GALLERY?format=png&name=orig");
  assert.equal(candidate.sourceUrl, "https://x.com/galleryuser/status/999/photo/3");
  assert.equal(candidate.author, "galleryuser");
  assert.equal(candidate.postId, "999");
  assert.equal(candidate.mediaIndex, 3);
});
