(() => {
  "use strict";

  function findCandidate(target) {
    const videoCandidate = findVideoCandidate(target);
    if (videoCandidate) return videoCandidate;
    return findImageCandidate(target);
  }

  function findImageCandidate(target) {
    const image = target?.closest?.("img");
    if (!image) return null;
    const mediaUrl = normalizeMediaUrl(
      image.getAttribute?.("data-lakomics-media-url") || imageSource(image),
    );
    if (!mediaUrl) return null;
    const source = explicitImageSource(image) ?? findPostSource(image, mediaUrl, "photo");
    if (!source) return null;
    return {
      type: "image",
      element: image,
      image,
      mediaUrl,
      sourceUrl: source.sourceUrl,
      author: source.author,
      postId: source.postId,
      mediaIndex: source.mediaIndex,
    };
  }

  function explicitImageSource(image) {
    const sourceUrl = image.getAttribute?.("data-lakomics-source-url") || "";
    if (!sourceUrl) return null;
    const parsed = parseStatusLink({
      getAttribute(name) { return name === "href" ? sourceUrl : null; },
      href: sourceUrl,
    });
    if (!parsed) return null;

    const explicitAuthor = image.getAttribute?.("data-lakomics-author") || parsed.author;
    const explicitPostId = image.getAttribute?.("data-lakomics-post-id") || parsed.postId;
    const rawIndex = Number.parseInt(image.getAttribute?.("data-lakomics-media-index") || "", 10);
    const mediaIndex = Number.isInteger(rawIndex) && rawIndex > 0
      ? rawIndex
      : parsed.mediaIndex;
    return withMediaIndex({
      ...parsed,
      author: explicitAuthor,
      postId: explicitPostId,
    }, mediaIndex, "photo");
  }

  function findVideoCandidate(target) {
    const video = findVideoElement(target);
    if (!video) return null;
    const source = findVideoPostSource(video);
    if (!source) return null;
    return {
      type: "video",
      element: interactionElementForVideo(video),
      video,
      mediaUrl: null,
      sourceUrl: source.sourceUrl,
      author: source.author,
      postId: source.postId,
      mediaIndex: source.mediaIndex,
    };
  }

  function findVideoElement(target) {
    if (!target) return null;
    const direct = target.closest?.("video");
    if (direct) return direct;

    const player = target.closest?.('[data-testid="videoPlayer"]');
    const playerVideo = player?.querySelector?.("video");
    if (playerVideo) return playerVideo;

    let node = target;
    const article = target.closest?.("article") ?? null;
    for (let depth = 0; node && depth < 4; depth += 1) {
      if (node === article) break;
      const candidate = node.querySelector?.("video");
      if (candidate) return candidate;
      node = node.parentElement ?? null;
    }
    return null;
  }

  function interactionElementForVideo(video) {
    return video.closest?.('[data-testid="videoPlayer"]') ?? video;
  }

  function imageSource(image) {
    return largestSrcsetUrl(image.getAttribute?.("srcset") ?? "")
      || image.currentSrc
      || image.src
      || image.getAttribute?.("data-src")
      || "";
  }

  function largestSrcsetUrl(srcset) {
    let bestUrl = "";
    let bestScore = -1;
    for (const part of String(srcset).split(",")) {
      const [url, descriptor = "1x"] = part.trim().split(/\s+/);
      if (!url) continue;
      const score = descriptor.endsWith("w")
        ? Number.parseInt(descriptor, 10)
        : Number.parseFloat(descriptor) * 1_000;
      if (Number.isFinite(score) && score > bestScore) {
        bestUrl = url;
        bestScore = score;
      }
    }
    return bestUrl;
  }

  function normalizeMediaUrl(value) {
    let url;
    try {
      url = new URL(value, globalThis.location?.href ?? "https://x.com/");
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/")) {
      return null;
    }
    let format = (url.searchParams.get("format") ?? extensionFromPath(url.pathname) ?? "jpg").toLowerCase();
    if (format === "jpeg" || format === "jpe") format = "jpg";
    if (!["jpg", "png", "webp", "gif"].includes(format)) format = "jpg";
    url.searchParams.set("format", format);
    url.searchParams.set("name", "orig");
    return url.href;
  }

  function findPostSource(element, mediaUrl, kind) {
    const direct = findDirectStatusLink(element, kind);
    if (direct) {
      const mediaIndex = direct.mediaIndex ?? inferMediaIndex(element, mediaUrl, kind);
      return withMediaIndex(direct, mediaIndex, kind);
    }

    const article = element.closest?.("article");
    const links = [...(article?.querySelectorAll?.('a[href*="/status/"]') ?? [])];
    const parsed = links.map(parseStatusLink).filter(Boolean);
    if (!parsed.length) return null;

    const inferredIndex = inferMediaIndex(element, mediaUrl, kind);
    if (inferredIndex !== null) {
      const exact = parsed.find((entry) => entry.mediaKind === kind && entry.mediaIndex === inferredIndex);
      if (exact) return withMediaIndex(exact, inferredIndex, kind);
    }

    const sameKind = parsed.find((entry) => entry.mediaKind === kind && entry.mediaIndex !== null);
    const preferred = sameKind ?? parsed.find((entry) => entry.mediaIndex === null) ?? parsed[0];
    return withMediaIndex(preferred, preferred.mediaKind === kind ? preferred.mediaIndex ?? inferredIndex : inferredIndex, kind);
  }

  function findVideoPostSource(video) {
    return findPostSource(video, null, "video");
  }

  function findDirectStatusLink(element, kind) {
    const mediaSelector = kind === "video"
      ? 'a[href*="/status/"][href*="/video/"]'
      : 'a[href*="/status/"][href*="/photo/"]';
    return parseStatusLink(element.closest?.(mediaSelector))
      ?? parseStatusLink(element.closest?.('a[href*="/status/"]'));
  }

  function parseStatusLink(link) {
    if (!link) return null;
    const href = link.getAttribute?.("href") || link.href || "";
    let url;
    try {
      url = new URL(href, globalThis.location?.href ?? "https://x.com/");
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/(photo|video)\/(\d+))?/);
    if (!match) return null;
    const mediaIndex = match[4] ? Number.parseInt(match[4], 10) : null;
    return {
      author: match[1],
      postId: match[2],
      mediaKind: match[3] ?? null,
      mediaIndex,
    };
  }

  function withMediaIndex(source, mediaIndex, mediaKind = source.mediaKind) {
    const safeIndex = Number.isInteger(mediaIndex) && mediaIndex > 0 ? mediaIndex : null;
    const safeKind = mediaKind === "video" ? "video" : mediaKind === "photo" ? "photo" : null;
    const suffix = safeIndex === null || !safeKind ? "" : `/${safeKind}/${safeIndex}`;
    return {
      author: source.author,
      postId: source.postId,
      mediaKind: safeKind,
      mediaIndex: safeIndex,
      sourceUrl: `https://x.com/${source.author}/status/${source.postId}${suffix}`,
    };
  }

  function inferMediaIndex(element, mediaUrl, kind) {
    if (kind === "video") return inferVideoIndex(element);
    return inferPhotoIndex(element, mediaUrl);
  }

  function inferPhotoIndex(image, mediaUrl) {
    const article = image.closest?.("article");
    if (!article?.querySelectorAll) return null;
    const images = [...article.querySelectorAll("img")];
    const uniqueMedia = [];
    const seen = new Set();
    for (const item of images) {
      const normalized = normalizeMediaUrl(imageSource(item));
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      uniqueMedia.push(normalized);
    }
    const index = uniqueMedia.indexOf(mediaUrl);
    return index >= 0 ? index + 1 : null;
  }

  function inferVideoIndex(video) {
    const article = video.closest?.("article");
    if (!article?.querySelectorAll) return 1;
    const players = [...article.querySelectorAll('[data-testid="videoPlayer"]')];
    const currentPlayer = video.closest?.('[data-testid="videoPlayer"]');
    if (currentPlayer && players.length) {
      const index = players.indexOf(currentPlayer);
      if (index >= 0) return index + 1;
    }
    const videos = [...article.querySelectorAll("video")];
    const index = videos.indexOf(video);
    return index >= 0 ? index + 1 : 1;
  }

  function extensionFromPath(pathname) {
    return pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? null;
  }

  globalThis.LakomicsXSource = {
    findCandidate,
    inferMediaIndex,
    normalizeMediaUrl,
    parseStatusLink,
  };
})();
