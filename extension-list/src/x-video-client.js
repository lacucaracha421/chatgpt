(() => {
  "use strict";
  const REQUEST = "lakomics:x-video:request", RESPONSE = "lakomics:x-video:response";

  function progressiveUrl(value) {
    if (typeof value !== "string" || value.length > 4096) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "video.twimg.com"
        && !url.username && !url.password && !url.hash && /\.mp4$/i.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }
  async function resolve(candidate) {
    if (candidate?.source !== "x" || candidate.type !== "video" || progressiveUrl(candidate.mediaUrl)) return candidate;
    const { postId, overallMediaIndex: mediaIndex } = candidate;
    if (typeof postId !== "string" || !/^\d{1,25}$/.test(postId)
      || !Number.isInteger(mediaIndex) || mediaIndex < 1 || mediaIndex > 16) return candidate;
    try {
      const source = new URL(candidate.sourceUrl);
      const match = source.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/video\/(\d+))?\/?$/);
      if (source.protocol !== "https:" || !["x.com", "twitter.com"].includes(source.hostname)
        || source.username || source.password || !match || match[1] !== postId
        || (match[2] && Number(match[2]) !== mediaIndex)) return candidate;
    } catch { return candidate; }

    const requestId = crypto.randomUUID();
    return new Promise(finish => {
      const complete = mediaUrl => {
        clearTimeout(timer);
        document.removeEventListener(RESPONSE, onResponse);
        finish(mediaUrl ? { ...candidate, mediaUrl } : candidate);
      };
      const onResponse = event => {
        if (typeof event.detail !== "string" || event.detail.length > 4608) return;
        let reply;
        try { reply = JSON.parse(event.detail); } catch { return; }
        if (reply?.requestId !== requestId || reply.postId !== postId || reply.mediaIndex !== mediaIndex) return;
        complete(progressiveUrl(reply.mediaUrl));
      };
      const timer = setTimeout(() => complete(null), 300);
      document.addEventListener(RESPONSE, onResponse);
      document.dispatchEvent(new CustomEvent(REQUEST, { detail: JSON.stringify({ requestId, postId, mediaIndex }) }));
    });
  }
  globalThis.LakomicsXVideo = { resolve };
})();
