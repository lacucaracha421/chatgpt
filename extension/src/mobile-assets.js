(() => {
  "use strict";

  const PAGE_ORIGIN = "https://lacucaracha421.github.io";
  const PAGE_PATH_PREFIX = "/chatgpt/";
  const FRAME_PATH = "mobile-api-frame.html";
  const CAPTURE_LIMIT = 500;
  const GRID_LIMIT = 40;
  const CACHE_MS = 30_000;
  const REQUEST_TIMEOUT_MS = 15_000;

  if (location.origin !== PAGE_ORIGIN || !location.pathname.startsWith(PAGE_PATH_PREFIX)) return;

  let frame = null;
  let frameReadyPromise = null;
  let requestSequence = 0;
  const pendingRequests = new Map();
  let captureCache = [];
  let captureCachedAt = 0;
  let captureLoadPromise = null;
  let renderTimer = null;
  let viewerGeneration = 0;

  function clean(value, max = 1000) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function installStyles() {
    if (document.querySelector("#lakomics-mobile-assets-style")) return;
    const style = document.createElement("style");
    style.id = "lakomics-mobile-assets-style";
    style.textContent = `
      #assetGrid[data-lakomics-live-assets="1"] .asset-tile{background:#15171a}
      .lakomics-live-video-thumb{width:100%;height:100%;display:grid;place-items:center;background:linear-gradient(145deg,#16191e,#0d0f12);color:#cdd6e6}
      .lakomics-live-video-thumb svg{width:30px;height:30px;opacity:.9}
      .lakomics-live-media-mark{position:absolute;left:5px;bottom:5px;padding:2px 5px;border-radius:3px;background:rgba(5,6,8,.76);font-size:9px;color:#dce1e8;pointer-events:none}
      .lakomics-live-empty{grid-column:1/-1;min-height:160px;display:grid;place-items:center;text-align:center;color:#757c86;font-size:12px;padding:24px}
      .lakomics-live-loading{grid-column:1/-1;min-height:140px;display:grid;place-items:center;color:#777f89;font-size:12px}
      #lakomicsLiveVideo{background:#050607}
    `;
    (document.head || document.documentElement).append(style);
  }

  function ensureFrame() {
    if (frameReadyPromise) return frameReadyPromise;
    frameReadyPromise = new Promise((resolve, reject) => {
      const mount = () => {
        if (!document.documentElement) {
          setTimeout(mount, 25);
          return;
        }
        frame = document.createElement("iframe");
        frame.id = "lakomics-mobile-api-frame";
        frame.src = chrome.runtime.getURL(FRAME_PATH);
        frame.hidden = true;
        frame.setAttribute("aria-hidden", "true");
        frame.style.display = "none";
        frame.addEventListener("load", () => resolve(frame), { once: true });
        frame.addEventListener("error", () => reject(new Error("mobile_api_frame_failed")), { once: true });
        document.documentElement.append(frame);
      };
      mount();
    });
    return frameReadyPromise;
  }

  window.addEventListener("message", (event) => {
    if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.source !== "lakomics-mobile-api") return;
    const requestId = clean(data.requestId, 120);
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(data.result && typeof data.result === "object"
      ? data.result
      : { ok: false, code: "mobile_api_empty_response" });
  });

  async function frameRequest(op, payload = {}) {
    try {
      await ensureFrame();
    } catch {
      return { ok: false, code: "mobile_api_frame_failed" };
    }
    const requestId = `m${Date.now().toString(36)}-${(++requestSequence).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve({ ok: false, code: "mobile_api_timeout" });
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(requestId, { resolve, timer });
      frame.contentWindow.postMessage({
        source: "lakomics-mobile-content",
        requestId,
        op,
        ...payload,
      }, "*");
    });
  }

  async function loadCaptures(force = false) {
    const now = Date.now();
    if (!force && captureCache.length && now - captureCachedAt < CACHE_MS) return captureCache;
    if (!force && captureLoadPromise) return captureLoadPromise;

    captureLoadPromise = (async () => {
      const result = await frameRequest("captures:list", { limit: CAPTURE_LIMIT });
      if (!result.ok || !Array.isArray(result.items)) {
        throw new Error(clean(result.code, 80) || "captures_load_failed");
      }
      captureCache = result.items.slice().sort((a, b) => {
        const bt = Date.parse(b.createdAt || "") || 0;
        const at = Date.parse(a.createdAt || "") || 0;
        return bt - at;
      });
      captureCachedAt = Date.now();
      return captureCache;
    })();

    try {
      return await captureLoadPromise;
    } finally {
      captureLoadPromise = null;
    }
  }

  function selectedLiveRow() {
    return document.querySelector("#treeScroll .tree-row.selected[data-lakomics-live-select]");
  }

  function selectedSubtreeIds() {
    const row = selectedLiveRow();
    const selectedId = clean(row?.dataset?.lakomicsLiveSelect, 240);
    if (!selectedId) return null;
    const root = row.closest(".tree-node[data-live-node]");
    if (!root) return new Set([selectedId]);
    const ids = new Set([selectedId]);
    root.querySelectorAll(".tree-node[data-live-node]").forEach((node) => {
      const id = clean(node.dataset.liveNode, 240);
      if (id) ids.add(id);
    });
    return ids;
  }

  function selectedName() {
    return clean(selectedLiveRow()?.querySelector(".tree-name")?.textContent, 120) || "분류";
  }

  function classificationName(id) {
    const target = [...document.querySelectorAll("#treeScroll .tree-node[data-live-node]")]
      .find((node) => node.dataset.liveNode === id);
    return clean(target?.querySelector(":scope > .tree-row .tree-name")?.textContent, 120) || "";
  }

  function xImageUrl(value, size) {
    const raw = clean(value, 3000);
    if (!raw) return "";
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:") return "";
      if (url.hostname === "pbs.twimg.com") {
        url.searchParams.set("name", size);
      }
      return url.href;
    } catch {
      return "";
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function tileHtml(capture) {
    const id = escapeHtml(capture.id);
    if (capture.mediaType === "video") {
      return `<button class="asset-tile" data-lakomics-live-capture="${id}" aria-label="실제 저장 영상">
        <span class="lakomics-live-video-thumb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/></svg></span>
        <span class="lakomics-live-media-mark">VIDEO</span>
      </button>`;
    }
    const thumb = xImageUrl(capture.mediaUrl, "small");
    if (!thumb) {
      return `<button class="asset-tile" data-lakomics-live-capture="${id}" aria-label="실제 저장 이미지"><span class="lakomics-live-video-thumb">IMAGE</span></button>`;
    }
    return `<button class="asset-tile" data-lakomics-live-capture="${id}" aria-label="실제 저장 이미지"><img src="${escapeHtml(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="lakomics-live-media-mark">X</span></button>`;
  }

  function updateLiveUi(matchCount, visibleCount) {
    const label = document.querySelector(".sync-state span:last-child");
    const banner = document.querySelector(".prototype-banner");
    const total = document.querySelector("#assetTotal");
    if (label) label.textContent = "실데이터 연결됨";
    if (banner) banner.textContent = "Galaxy Tab S11용 Mobile prototype · 분류와 Cloud Capture 에셋은 실제 Lakomics 데이터입니다.";
    if (total && total.textContent === "에셋 연결 전") {
      total.textContent = `${matchCount.toLocaleString()} Cloud`;
    }
    document.documentElement.dataset.lakomicsLiveAssets = visibleCount ? "connected" : "empty";
  }

  function showLoadFailure(code) {
    const grid = document.querySelector("#assetGrid");
    if (!grid) return;
    grid.dataset.lakomicsLiveAssets = "1";
    grid.innerHTML = `<div class="lakomics-live-empty">실제 에셋을 불러오지 못했습니다.<br>${escapeHtml(code || "unknown")}</div>`;
    const label = document.querySelector(".sync-state span:last-child");
    if (label) label.textContent = "에셋 연결 실패";
    document.documentElement.dataset.lakomicsLiveAssets = "failed";
  }

  async function renderLiveAssets({ force = false } = {}) {
    if (document.documentElement.dataset.lakomicsLiveClassifications !== "connected") return;
    const grid = document.querySelector("#assetGrid");
    if (!grid || !selectedLiveRow()) return;
    grid.dataset.lakomicsLiveAssets = "1";
    if (!captureCache.length) grid.innerHTML = '<div class="lakomics-live-loading">실제 에셋 불러오는 중…</div>';

    let captures;
    try {
      captures = await loadCaptures(force);
    } catch (error) {
      showLoadFailure(error instanceof Error ? error.message : String(error));
      return;
    }

    const ids = selectedSubtreeIds();
    if (!ids) return;
    const matches = captures.filter((capture) => ids.has(capture.classificationId));
    const visible = matches.slice(0, GRID_LIMIT);
    grid.innerHTML = visible.length
      ? visible.map(tileHtml).join("")
      : `<div class="lakomics-live-empty"><strong>${escapeHtml(selectedName())}</strong><br>Cloud Capture로 저장된 에셋이 아직 없습니다.</div>`;
    updateLiveUi(matches.length, visible.length);
  }

  function creatorHandle(sourceUrl) {
    try {
      const parts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
      return parts[0] ? `@${parts[0]}` : "X 저장 미디어";
    } catch {
      return "X 저장 미디어";
    }
  }

  function dateLabel(value) {
    const ms = Date.parse(value || "");
    if (!Number.isFinite(ms)) return "";
    try {
      return new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function ensureVideoElement() {
    let video = document.querySelector("#lakomicsLiveVideo");
    if (video) return video;
    const image = document.querySelector("#viewerImage");
    if (!image) return null;
    video = document.createElement("video");
    video.id = "lakomicsLiveVideo";
    video.className = "viewer-media";
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.style.display = "none";
    image.insertAdjacentElement("afterend", video);
    return video;
  }

  function prepareViewer(capture) {
    const dialog = document.querySelector("#viewer");
    const image = document.querySelector("#viewerImage");
    const video = ensureVideoElement();
    const title = document.querySelector("#viewerTitle");
    const meta = document.querySelector("#viewerMeta");
    const index = document.querySelector("#viewerIndex");
    if (!dialog || !image) return null;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.style.display = "none";
    }
    image.style.display = "none";
    image.removeAttribute("src");
    if (title) title.textContent = creatorHandle(capture.sourceUrl);
    const parts = [classificationName(capture.classificationId), dateLabel(capture.createdAt)].filter(Boolean);
    if (meta) meta.textContent = parts.join(" · ");
    if (index) index.textContent = capture.mediaType === "video" ? "VIDEO" : "IMAGE";
    if (!dialog.open) dialog.showModal();
    return { dialog, image, video, meta };
  }

  async function openLiveCapture(captureId) {
    const capture = captureCache.find((item) => item.id === captureId);
    if (!capture) return;
    const generation = ++viewerGeneration;
    const viewer = prepareViewer(capture);
    if (!viewer) return;

    if (capture.mediaType === "image") {
      viewer.image.style.display = "block";
      viewer.image.src = xImageUrl(capture.mediaUrl, "orig") || capture.mediaUrl;
      return;
    }

    if (viewer.meta) viewer.meta.textContent = `${viewer.meta.textContent}${viewer.meta.textContent ? " · " : ""}영상 불러오는 중…`;
    const ticket = await frameRequest("capture:ticket", { captureId });
    if (generation !== viewerGeneration || !viewer.dialog.open) return;
    if (!ticket.ok || !ticket.url || !viewer.video) {
      if (viewer.meta) viewer.meta.textContent = `영상 로드 실패 · ${clean(ticket.code, 80) || "unknown"}`;
      return;
    }
    viewer.video.style.display = "block";
    viewer.video.src = ticket.url;
    viewer.video.load();
    viewer.video.play().catch(() => {});
  }

  function scheduleRender(force = false) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderLiveAssets({ force }), force ? 120 : 45);
  }

  function installHooks() {
    installStyles();
    ensureFrame().catch(() => {});

    document.addEventListener("click", (event) => {
      const liveTile = event.target.closest?.("[data-lakomics-live-capture]");
      if (liveTile) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openLiveCapture(liveTile.dataset.lakomicsLiveCapture);
        return;
      }

      if (event.target.closest?.("[data-lakomics-live-select]")) {
        scheduleRender(false);
      }
      if (event.target.closest?.("#refreshBtn")) {
        captureCache = [];
        captureCachedAt = 0;
        scheduleRender(true);
      }
    }, true);

    const observeTree = () => {
      const tree = document.querySelector("#treeScroll");
      if (!tree) {
        setTimeout(observeTree, 100);
        return;
      }
      new MutationObserver(() => scheduleRender(false)).observe(tree, { childList: true, subtree: true });
      scheduleRender(false);
    };
    observeTree();

    new MutationObserver(() => scheduleRender(false)).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-lakomics-live-classifications"],
    });

    document.querySelector("#viewer")?.addEventListener("close", () => {
      viewerGeneration += 1;
      const video = document.querySelector("#lakomicsLiveVideo");
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installHooks, { once: true });
  } else {
    installHooks();
  }
})();
