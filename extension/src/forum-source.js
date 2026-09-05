(() => {
  "use strict";

  function siteFor(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return null;
      if (url.hostname === "arca.live") return "arca";
      if (["gall.dcinside.com", "m.dcinside.com"].includes(url.hostname)) return "dcinside";
    } catch {}
    return null;
  }

  function directUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value, globalThis.location?.href);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      if (/\.(m3u8|mpd)(?:$|[?#])/i.test(url.href)) return null;
      return url.href;
    } catch { return null; }
  }

  function fileType(value) {
    const path = new URL(value).pathname;
    if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(path)) return "image";
    if (/\.(mp4|webm|mov|m4v)$/i.test(path)) return "video";
    if (/\.(mp3|m4a|ogg|wav|flac|aac)$/i.test(path)) return "audio";
    return "file";
  }

  function largestSrcset(value) {
    return String(value || "").split(",").map(part => {
      const [url, size = "1x"] = part.trim().split(/\s+/);
      return { url, size: Number.parseFloat(size) * (size.endsWith("x") ? 1000 : 1) };
    }).filter(item => directUrl(item.url) && Number.isFinite(item.size))
      .sort((a, b) => b.size - a.size)[0]?.url;
  }

  function findCandidate(target, allowGeneric = false) {
    const sourceUrl = globalThis.location?.href;
    const source = siteFor(sourceUrl) ?? (allowGeneric && directUrl(sourceUrl) ? "web" : null);
    if (!source) return null;
    if (source === "web" && ["x.com", "twitter.com"].includes(new URL(sourceUrl).hostname)) return null;
    const media = target?.closest?.("img, video, audio")
      ?? target?.closest?.(".video-js")?.querySelector?.("video");
    const link = target?.closest?.("a[href]");
    let element = media;
    let mediaUrl = null;
    let type;
    let filename = null;
    if (media) {
      type = String(media.tagName).toLowerCase() === "img" ? "image" : String(media.tagName).toLowerCase();
      const linked = directUrl(link?.getAttribute?.("href"));
      mediaUrl = type === "image" && linked && fileType(linked) === "image" ? linked : null;
      mediaUrl ??= [media.getAttribute?.("data-originalurl"), media.getAttribute?.("data-original"), media.getAttribute?.("data-src"),
        type === "image" ? largestSrcset(media.getAttribute?.("srcset")) : null,
        media.currentSrc, media.src, media.getAttribute?.("src"),
        ...Array.from(media.querySelectorAll?.("source[src]") ?? [], (node) => node.getAttribute("src")),
      ].map(directUrl).find(Boolean);
    } else if (link) {
      mediaUrl = directUrl(link.getAttribute("href"));
      if (!mediaUrl) return null;
      const url = new URL(mediaUrl);
      const download = link.getAttribute("download");
      if (download === null && fileType(mediaUrl) === "file"
        && !/\.(zip|7z|rar|pdf|txt|json|csv|psd|clip|epub|torrent)$/i.test(url.pathname)
        && !/\/(?:download|file_down)(?:\.|\/|$)/i.test(url.pathname)) return null;
      element = link;
      type = fileType(mediaUrl);
      const label = link.textContent?.trim() || "";
      filename = download || (/\.[a-z0-9]{1,8}$/i.test(label) ? label : null);
    }
    if (!mediaUrl || !element) return null;
    // Arca's image CDN exposes the original with type=orig; preserve signatures and formats.
    const url = new URL(mediaUrl);
    if (source === "arca" && (url.hostname === "ac-o.arca.live" || /^(ac-[a-z0-9-]+|ac)\.namu\.la$/.test(url.hostname))) {
      url.searchParams.set("type", "orig");
    }
    return { source, type, element, mediaUrl: url.href, sourceUrl, filename };
  }

  globalThis.LakomicsForumSource = { findCandidate, findGenericCandidate: target => findCandidate(target, true), siteFor };
})();
