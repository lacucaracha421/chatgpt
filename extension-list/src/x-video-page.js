(() => {
  "use strict";
  const REQUEST = "lakomics:x-video:request", RESPONSE = "lakomics:x-video:response";
  const MAX_POSTS = 200, MAX_MEDIA = 16, MAX_JSON_CHARS = 2_000_000, MAX_NODES = 20000;
  const mediaByPost = new Map();

  function progressiveUrl(value) {
    if (typeof value !== "string" || value.length > 4096) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "video.twimg.com"
        && !url.username && !url.password && !url.hash && /\.mp4$/i.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }
  function bestVariant(media, postId) {
    if (!["video", "animated_gif"].includes(media?.type)
      || (media.source_status_id_str && media.source_status_id_str !== postId)) return null;
    return (Array.isArray(media.video_info?.variants) ? media.video_info.variants : [])
      .filter(item => item?.content_type === "video/mp4" && progressiveUrl(item.url))
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))
      .map(item => progressiveUrl(item.url))[0] || null;
  }
  function remember(tweet) {
    const id = tweet.rest_id;
    const legacy = tweet.legacy;
    const media = legacy?.extended_entities?.media;
    if (typeof id !== "string" || !/^\d{1,25}$/.test(id)
      || (legacy?.id_str && legacy.id_str !== id)
      || !Array.isArray(media) || !media.length || media.length > MAX_MEDIA) return;
    // Keep photo and unavailable entries as holes: the URL ordinal counts all media.
    const urls = media.map(item => bestVariant(item, id));
    mediaByPost.delete(id);
    mediaByPost.set(id, urls);
    while (mediaByPost.size > MAX_POSTS) mediaByPost.delete(mediaByPost.keys().next().value);
  }
  function ingest(data) {
    const stack = [data];
    let remaining = MAX_NODES;
    // Tweets can sit inside timeline entries, quote/retweet results or visibility
    // wrappers. Only a tweet's own rest_id + legacy media pair establishes identity.
    while (stack.length && remaining-- > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      remember(node);
      for (const value of Object.values(node)) {
        if (value && typeof value === "object" && stack.length < MAX_NODES) stack.push(value);
      }
    }
  }
  function ingestText(text) {
    if (typeof text !== "string" || text.length > MAX_JSON_CHARS) return;
    try { ingest(JSON.parse(text)); } catch {}
  }
  function isTweetEndpoint(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && /^\/i\/api\/graphql\//.test(url.pathname);
    } catch { return false; }
  }
  function lookup(postId, mediaIndex) {
    if (typeof postId !== "string" || !/^\d{1,25}$/.test(postId)
      || !Number.isInteger(mediaIndex) || mediaIndex < 1 || mediaIndex > MAX_MEDIA) return null;
    return mediaByPost.get(postId)?.[mediaIndex - 1] || null;
  }

  document.addEventListener(REQUEST, event => {
    if (typeof event.detail !== "string" || event.detail.length > 256) return;
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (typeof request?.requestId !== "string" || request.requestId.length > 64) return;
    const { requestId, postId, mediaIndex } = request;
    const mediaUrl = lookup(postId, mediaIndex);
    // A bridge reply is data, not permission to save. No credentials or raw tweet
    // payloads cross into the extension; the worker still validates the CDN URL.
    document.dispatchEvent(new CustomEvent(RESPONSE, {
      detail: JSON.stringify({ requestId, postId, mediaIndex, mediaUrl }),
    }));
  });

  // Observe copies of responses the page requested itself. Do not read request
  // headers/cookies, issue extra requests, consume the original body or await parsing.
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    globalThis.fetch = function (...args) {
      const pending = Reflect.apply(originalFetch, this, args);
      Promise.resolve(pending).then(response => {
        if (!response.ok || !isTweetEndpoint(response.url)) return;
        const length = Number(response.headers.get("content-length"));
        if (length > MAX_JSON_CHARS) return;
        return response.clone().text().then(ingestText);
      }).catch(() => {});
      return pending;
    };
  }
  const xhrPrototype = globalThis.XMLHttpRequest?.prototype;
  if (xhrPrototype) {
    const originalOpen = xhrPrototype.open, observed = new WeakSet();
    xhrPrototype.open = function (...args) {
      const result = Reflect.apply(originalOpen, this, args);
      if (!observed.has(this)) {
        observed.add(this);
        this.addEventListener("load", () => {
          try {
            if (this.status < 200 || this.status >= 300 || !isTweetEndpoint(this.responseURL)) return;
            if (!this.responseType || this.responseType === "text") ingestText(this.responseText);
            else if (this.responseType === "json") {
              const text = JSON.stringify(this.response);
              if (text.length <= MAX_JSON_CHARS) ingest(this.response);
            }
          } catch {}
        });
      }
      return result;
    };
  }
  if (globalThis.__LAKOMICS_TEST__) globalThis.LakomicsXVideoPage = { ingestText, lookup };
})();
