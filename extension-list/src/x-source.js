(() => {
  "use strict";

  function findCandidate(target) {
    const imageCandidate = findImageCandidate(target);
    if (imageCandidate) return imageCandidate;
    const videoCandidate = findVideoCandidate(target);
    if (videoCandidate) return videoCandidate;
    return null;
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
      source: "x",
      type: "image",
      element: image,
      image,
      mediaUrl,
      sourceUrl: source.sourceUrl,
      author: source.author,
      postId: source.postId,
      mediaIndex: source.mediaIndex,
      publishedAt: publishedAtFor(image),
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
    const video = findVideoElement(target) ?? target?.closest?.('[data-testid="videoPlayer"], [data-testid="videoComponent"], [data-testid^="video-player-mini-ui-"]');
    if (!video) return null;
    const source = findVideoPostSource(video);
    if (!source) return null;
    return {
      source: "x",
      type: "video",
      element: interactionElementForVideo(video),
      video,
      // A player that already exposes a validated progressive MP4 needs no lookup,
      // so a logged-in or restricted tweet is collectable without the public
      // endpoint. Playback identity stays `video`; only the bytes are kept.
      mediaUrl: progressiveVideoUrl(video),
      sourceUrl: source.sourceUrl,
      author: source.author,
      postId: source.postId,
      mediaIndex: source.mediaIndex,
      overallMediaIndex: source.mediaIndex,
      publishedAt: publishedAtFor(video),
    };
  }

  // Accept only a progressive MP4 on X's video CDN, never a manifest, and never a URL
  // carrying a fragment. X mounts the still poster as `poster`, which is not a video
  // resource and is not read here. A `<source>` child is read because X uses one when
  // the player exposes no `src` attribute.
  function progressiveVideoUrl(element) {
    const video = element?.closest?.("video") ?? element?.querySelector?.("video") ?? null;
    const values = [
      video?.currentSrc,
      video?.src,
      video?.getAttribute?.("src"),
      ...[...(video?.querySelectorAll?.("source") ?? [])].map((node) => node.getAttribute?.("src")),
      element?.getAttribute?.("src"),
    ];
    for (const value of values) {
      let url;
      try { url = new URL(String(value || ""), globalThis.location?.href ?? "https://x.com/"); } catch { continue; }
      if (url.protocol === "https:" && !url.username && !url.password && !url.hash
        && url.hostname === "video.twimg.com" && /\.mp4$/i.test(url.pathname)) {
        return url.href;
      }
    }
    return null;
  }

  function publishedAtFor(element) {
    const time = postScope(element)?.querySelector?.("time[datetime]");
    return time?.getAttribute?.("datetime") || null;
  }

  function postScope(element) {
    const article = element?.closest?.("article");
    // Quote cards are not necessarily nested articles. Stop at their own link
    // container so their media ordinal and timestamp cannot come from the parent.
    const quote = element?.closest?.('[data-testid="quoteTweet"], [data-testid="quotedTweet"], div[role="link"]');
    return quote && (!article || article.contains(quote)) ? quote : article;
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
    return video.closest?.('[data-testid="videoPlayer"], [data-testid="videoComponent"]') ?? video;
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
    if (direct && postScope(element.closest?.('a[href*="/status/"]')) === postScope(element)) {
      const mediaIndex = (direct.mediaKind === kind ? direct.mediaIndex : null) ?? inferMediaIndex(element, mediaUrl, kind);
      return withMediaIndex(direct, mediaIndex, kind);
    }

    const article = postScope(element);
    const links = [...(article?.querySelectorAll?.('a[href*="/status/"]') ?? [])]
      .filter(link => !link.closest || postScope(link) === article);
    const parsed = links.map(parseStatusLink).filter(Boolean);
    if (!parsed.length) return null;

    const inferredIndex = inferMediaIndex(element, mediaUrl, kind);
    if (inferredIndex !== null) {
      const exact = parsed.find((entry) => entry.mediaKind === kind && entry.mediaIndex === inferredIndex);
      if (exact) return withMediaIndex(exact, inferredIndex, kind);
    }

    const sameKind = parsed.find((entry) => entry.mediaKind === kind && entry.mediaIndex !== null);
    const preferred = sameKind ?? parsed.find((entry) => entry.mediaIndex === null) ?? parsed[0];
    const mediaIndex = kind === "video" ? inferredIndex ?? (preferred.mediaKind === kind ? preferred.mediaIndex : null)
      : preferred.mediaKind === kind ? preferred.mediaIndex ?? inferredIndex : inferredIndex;
    return withMediaIndex(preferred, mediaIndex, kind);
  }

  function findVideoPostSource(video) {
    const source = findPostSource(video, null, "video");
    // X quote cards can omit every status link. The mini-player carries the
    // video post ID; only inspect this video's player, never the outer tweet.
    const player = video.closest?.('[data-testid="videoPlayer"], [data-testid="videoComponent"]') ?? video;
    const marker = player.matches?.('[data-testid^="video-player-mini-ui-"]') ? player : player.querySelector?.('[data-testid^="video-player-mini-ui-"]');
    const postId = marker?.getAttribute?.('data-testid')?.match(/^video-player-mini-ui-(\d+)$/)?.[1];
    if (!postId || source?.postId === postId) return source;
    const avatar = postScope(video)?.querySelector?.('[data-testid^="UserAvatar-Container-"]');
    const author = avatar?.getAttribute?.('data-testid')?.match(/^UserAvatar-Container-([A-Za-z0-9_]{1,15})$/)?.[1] || 'i';
    return withMediaIndex({author, postId, sourceUrl:`https://x.com/${author}/status/${postId}`}, inferOverallMediaIndex(video, "video"), "video");
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
    if (kind === "video") return inferOverallMediaIndex(element, kind);
    return inferPhotoIndex(element, mediaUrl);
  }

  function inferPhotoIndex(image, mediaUrl) {
    const article = postScope(image);
    if (!article?.querySelectorAll) return null;
    const images = [...article.querySelectorAll("img")];
    const uniqueMedia = [];
    const seen = new Set();
    for (const item of images) {
      if (postScope(item) !== article) continue;
      const normalized = normalizeMediaUrl(imageSource(item));
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      uniqueMedia.push(normalized);
    }
    const index = uniqueMedia.indexOf(mediaUrl);
    return index >= 0 ? index + 1 : null;
  }

  // X permalinks number the complete media sequence, including stills. Keep the
  // same identity in the permalink, candidate and endpoint lookup.
  function inferOverallMediaIndex(element, kind) {
    const article = postScope(element);
    const direct = findDirectStatusLink(element, kind);
    if (direct?.mediaKind === kind && direct.mediaIndex > 0
      && postScope(element.closest?.('a[href*="/status/"]')) === article) return direct.mediaIndex;
    if (!article?.querySelectorAll) return null;
    const inScope = node => postScope(node) === article;
    const players = [...article.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"], video')].filter(inScope);
    const containers = players.filter(node => !players.some(parent => parent !== node && parent.contains(node)));
    const seen = new Set();
    const stills = [...article.querySelectorAll("img")].filter(inScope).filter(image => {
      if (containers.some(player => player.contains(image))) return false;
      const url = normalizeMediaUrl(imageSource(image));
      if (!url || seen.has(url)) return false;
      seen.add(url); return true;
    });
    // A detached media permalink is attributable only when this post has one
    // player and one unambiguous video link. Never borrow another player's link.
    if (kind === "video" && containers.length === 1) {
      const links = [...article.querySelectorAll('a[href*="/status/"]')].filter(inScope).map(parseStatusLink).filter(Boolean);
      const videoLinks = links.filter(link => link.mediaKind === "video" && link.mediaIndex > 0);
      const identities = new Set(videoLinks.map(link => `${link.postId}:${link.mediaIndex}`));
      const postIds = new Set(links.map(link => link.postId));
      if (identities.size === 1 && postIds.size === 1) return videoLinks[0].mediaIndex;
    }
    const media = [...stills, ...containers].sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
    const index = media.findIndex(node => node === element || node.contains(element));
    return index >= 0 ? index + 1 : null;
  }

  function extensionFromPath(pathname) {
    return pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? null;
  }

  globalThis.LakomicsXSource = {
    postScope,
    findCandidate,
    inferOverallMediaIndex,
    inferMediaIndex,
    normalizeMediaUrl,
    parseStatusLink,
  };
})();
