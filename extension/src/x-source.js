(() => {
  "use strict";

  function findCandidate(target) {
    const image = target?.closest?.("img");
    if (!image) return null;
    const mediaUrl = normalizeMediaUrl(imageSource(image));
    if (!mediaUrl) return null;
    const sourceUrl = findPostUrl(image);
    if (!sourceUrl) return null;
    return { image, mediaUrl, sourceUrl };
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

  function findPostUrl(image) {
    const direct = image.closest?.('a[href*="/status/"]');
    const article = image.closest?.("article");
    const links = [direct, ...(article?.querySelectorAll?.('a[href*="/status/"]') ?? [])]
      .filter(Boolean);
    for (const link of links) {
      const href = link.getAttribute?.("href") || link.href || "";
      let url;
      try {
        url = new URL(href, globalThis.location?.href ?? "https://x.com/");
      } catch {
        continue;
      }
      if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) continue;
      const match = url.pathname.match(/^\/[^/]+\/status\/\d+(?:\/photo\/\d+)?/);
      if (!match) continue;
      return `https://x.com${match[0]}`;
    }
    return null;
  }

  function extensionFromPath(pathname) {
    return pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? null;
  }

  globalThis.LakomicsXSource = { findCandidate };
})();
