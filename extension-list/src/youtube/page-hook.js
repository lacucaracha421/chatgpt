// Runs in the page's MAIN world (classic script). Copies YouTube's timedtext responses to the
// isolated content script and performs same-origin fetches / player lookups on its behalf.
(() => {
  "use strict";

  const TAG = "__lakomics_youtube_v1__";
  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;

  function post(message) {
    window.postMessage({ tag: TAG, dir: "toIso", ...message }, window.location.origin);
  }

  // Captions can arrive before the isolated script listens, so the last few are kept for it.
  const recent = [];
  function postTimedtext(url, text) {
    if (!isAllowedFetchUrl(url) || typeof text !== "string" || text.length > 5 * 1024 * 1024) return;
    recent.push({ url, text });
    while (recent.length > 8 || recent.reduce((sum, item) => sum + item.text.length, 0) > 5 * 1024 * 1024) recent.shift();
    post({ type: "timedtext", url, text });
  }

  function absolute(url) {
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return String(url);
    }
  }

  function isTimedtext(url) {
    return typeof url === "string" && isAllowedFetchUrl(url);
  }

  // Only plain youtube.com timedtext URLs may be fetched on request of the content script.
  function isAllowedFetchUrl(url) {
    if (typeof url !== "string" || url.length > 8192) return false;
    try {
      const u = new URL(url, window.location.href);
      return u.origin === "https://www.youtube.com" && !u.username && !u.password && !u.hash && u.pathname === "/api/timedtext";
    } catch {
      return false;
    }
  }

  // XMLHttpRequest
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const abs = absolute(url);
      if (isTimedtext(abs)) {
        this.addEventListener("load", () => {
          try {
            let text = "";
            if (this.responseType === "" || this.responseType === "text") text = this.responseText;
            else if (this.responseType === "json") text = JSON.stringify(this.response);
            else if (this.responseType === "arraybuffer") text = new TextDecoder().decode(this.response);
            if (text) postTimedtext(abs, text);
          } catch {
            // ignore: never break the page
          }
        });
      }
    } catch {
      // ignore
    }
    return origOpen.apply(this, arguments);
  };

  // fetch
  window.fetch = function (input) {
    const promise = origFetch.apply(this, arguments);
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
      const url = raw ? absolute(raw) : "";
      if (isTimedtext(url)) {
        promise
          .then((res) => res.clone().text())
          .then((text) => {
            if (text) postTimedtext(url, text);
          })
          .catch(() => {});
      }
    } catch {
      // ignore
    }
    return promise;
  };

  // Requests from the isolated world.
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.tag !== TAG || data.dir !== "toPage") return;
    if (typeof data.id !== "string" || data.id.length > 100) return;

    if (data.type === "getRecent") {
      post({ type: "recent", id: data.id, items: recent.slice() });
    } else if (data.type === "getMeta") {
      let meta = null;
      try {
        const details = document.getElementById("movie_player")?.getPlayerResponse()?.videoDetails;
        if (details && details.videoId === data.videoId) {
          const { videoId, title, author, shortDescription, keywords } = details;
          const bounded = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";
          meta = { videoId: bounded(videoId, 100), title: bounded(title, 1000), author: bounded(author, 500),
            shortDescription: bounded(shortDescription, 10000),
            keywords: Array.isArray(keywords) ? keywords.slice(0, 100).map(word => bounded(word, 500)) : [] };
        }
      } catch {
        // Missing player metadata must never break caption acquisition.
      }
      post({ type: "meta", id: data.id, meta });
    } else if (data.type === "getTracks") {
      let videoId = null;
      let tracks = [];
      try {
        const player = document.getElementById("movie_player");
        const response = player && player.getPlayerResponse ? player.getPlayerResponse() : null;
        videoId = (response && response.videoDetails && response.videoDetails.videoId) || null;
        const list =
          response &&
          response.captions &&
          response.captions.playerCaptionsTracklistRenderer &&
          response.captions.playerCaptionsTracklistRenderer.captionTracks;
        tracks = (Array.isArray(list) ? list : []).slice(0, 100).filter(t => t && isAllowedFetchUrl(t.baseUrl) &&
          typeof t.languageCode === "string" && t.languageCode.length <= 80 &&
          (t.kind == null || typeof t.kind === "string" && t.kind.length <= 80)).map((t) => ({
          baseUrl: t.baseUrl,
          languageCode: t.languageCode,
          kind: t.kind || null,
          isDefault: t.isDefault === true,
        }));
      } catch {
        // ignore
      }
      post({ type: "tracks", id: data.id, videoId, tracks });
    } else if (data.type === "fetchText") {
      if (!isAllowedFetchUrl(data.url)) {
        post({ type: "fetchResult", id: data.id, ok: false, text: "" });
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const res = await origFetch.call(window, data.url, { credentials: "include", redirect: "error", signal: controller.signal });
        const text = await res.text();
        if (text.length > 5 * 1024 * 1024) throw new Error("caption too large");
        post({ type: "fetchResult", id: data.id, ok: res.ok, text });
      } catch {
        post({ type: "fetchResult", id: data.id, ok: false, text: "" });
      } finally { clearTimeout(timer); }
    }
  });
})();
