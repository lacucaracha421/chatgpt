// Lakomics Mobile — Full Cloud Library 브라우징 (Galaxy Tab)
//
// 데이터 원본은 배포된 Cloud Library API (VPS) 하나다. PC Lakomics와
// Cloud Capture Inbox는 라이브러리 열람 경로에 등장하지 않는다.
// 인증은 확장 컨텍스트(mobile-api-frame)만 수행하며, 페이지는 논리 op만 요청한다.
(() => {
  "use strict";

  const PAGE_ORIGIN = "https://lacucaracha421.github.io";
  const PAGE_PATH_PREFIX = "/chatgpt/";
  const FRAME_PATH = "mobile-api-frame.html";
  const REQUEST_TIMEOUT_MS = 15_000;

  if (location.origin !== PAGE_ORIGIN || !location.pathname.startsWith(PAGE_PATH_PREFIX)) return;

  const library = globalThis.LakomicsMobileLibrary;
  if (!library) return;
  const { createStore, GRID_MAX_TILES } = library;

  let frame = null;
  let frameReadyPromise = null;
  let requestSequence = 0;
  const pendingRequests = new Map();
  let renderTimer = null;
  let viewerGeneration = 0;
  let activeClassificationId = null;
  let viewerClassificationId = null;
  let viewerAssetId = null;
  let ticketInflight = new Map(); // `${assetId}:${variant}` → Promise

  function clean(value, max = 1000) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function installStyles() {
    if (document.querySelector("#lakomics-mobile-assets-style")) return;
    const style = document.createElement("style");
    style.id = "lakomics-mobile-assets-style";
    style.textContent = `
      .lakomics-live-video-thumb{width:100%;height:100%;display:grid;place-items:center;background:linear-gradient(145deg,#16191e,#0d0f12);color:#cdd6e6}
      .lakomics-live-video-thumb svg{width:30px;height:30px;opacity:.9}
      .lakomics-live-media-mark{position:absolute;left:5px;bottom:5px;padding:2px 5px;border-radius:3px;background:rgba(5,6,8,.76);font-size:9px;color:#dce1e8;pointer-events:none}
      .lakomics-live-empty{grid-column:1/-1;min-height:160px;display:grid;place-items:center;text-align:center;color:#757c86;font-size:12px;padding:24px}
      .lakomics-live-loading{grid-column:1/-1;min-height:140px;display:grid;place-items:center;color:#777f89;font-size:12px}
      .lakomics-tile-failed img{opacity:0}.lakomics-tile-failed{background:repeating-linear-gradient(45deg,#16191e,#16191e 9px,#121417 9px,#121417 18px)}
      .lakomics-tile-retry{position:absolute;inset:0;display:grid;place-items:center;color:#98a0ab;font-size:11px;background:transparent;border:0}
      .asset-tile{cursor:pointer}
      .viewer-nav{position:absolute;z-index:2;top:50%;transform:translateY(-50%);width:44px;height:64px;border:0;border-radius:6px;background:rgba(0,0,0,.38);color:#fff;font-size:24px;display:grid;place-items:center}
      .viewer-nav:active{background:rgba(0,0,0,.6)}
      #viewerPrev{left:8px}#viewerNext{right:8px}
      .viewer-media-wrap{position:absolute;inset:0;display:grid;place-items:center;overflow:auto}
      .viewer-media-wrap img,.viewer-media-wrap video{max-width:100%;max-height:100%}
      .viewer-media-wrap.zoomable img{max-width:none;max-height:none;cursor:grab}
      #viewerSpinner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#aab1ba;font-size:12px;display:none}
      @media (prefers-reduced-motion:reduce){.viewer-nav{transition:none!important}}
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

  // --- 스토어 (브릿지 주입) ---
  const store = createStore({
    requestAssets: ({ classificationId, cursor, limit }) =>
      frameRequest("library:assets", { classificationId, cursor: cursor || undefined, limit }),
    requestTicket: ({ assetId, variant }) =>
      frameRequest("library:media-ticket", { assetId, variant }),
  });

  function inflightTicket(key, loader) {
    const existing = ticketInflight.get(key);
    if (existing) return existing;
    const promise = loader().finally(() => ticketInflight.delete(key));
    ticketInflight.set(key, promise);
    return promise;
  }

  // --- 그리드 ---
  function selectedLiveRow() {
    return document.querySelector("#treeScroll .tree-row.selected[data-lakomics-live-select]");
  }

  function selectedClassificationId() {
    return clean(selectedLiveRow()?.dataset?.lakomicsLiveSelect, 240) || null;
  }

  function selectedName() {
    return clean(selectedLiveRow()?.querySelector(".tree-name")?.textContent, 120) || "분류";
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function dateLabel(value) {
    const ms = Date.parse(value || "");
    if (!Number.isFinite(ms)) return "";
    try {
      return new Date(ms).toLocaleString("ko-KR", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function sizeLabel(bytes) {
    if (!Number.isFinite(bytes) || bytes === null) return "";
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function tileHtml(asset, index) {
    const id = escapeHtml(asset.id);
    if (asset.kind === "video") {
      return `<button class="asset-tile" data-lib-index="${index}" data-lib-asset="${id}" aria-label="라이브러리 영상" data-lib-kind="video">
        <span class="lakomics-live-video-thumb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/></svg></span>
        <span class="lakomics-live-media-mark">VIDEO</span>
      </button>`;
    }
    const mark = asset.kind === "gif" ? "GIF" : "";
    return `<button class="asset-tile" data-lib-index="${index}" data-lib-asset="${id}" data-lib-kind="${escapeHtml(asset.kind || "image")}">
      <img alt="" loading="lazy" decoding="async" data-lib-thumb="${id}">
      ${mark ? `<span class="lakomics-live-media-mark">${mark}</span>` : ""}
    </button>`;
  }

  function sentinelHtml() {
    return `<div class="lakomics-live-loading" id="gridSentinel" data-sentinel="1">불러오는 중…</div>`;
  }

  function gridErrorHtml(code) {
    return `<div class="lakomics-live-empty">에셋을 불러오지 못했습니다.<br><span data-error-code>${escapeHtml(clean(code, 80) || "unknown")}</span><br><button class="lakomics-tile-retry" style="position:static;margin-top:8px;border:1px solid #3a4048;border-radius:4px;padding:6px 14px" data-grid-retry>다시 시도</button></div>`;
  }

  function emptyHtml(name) {
    return `<div class="lakomics-live-empty"><strong>${escapeHtml(name)}</strong><br>커밋된 라이브러리 에셋이 아직 없습니다.</div>`;
  }

  function fillTileImage(img, asset) {
    const key = `${asset.id}:thumbnail`;
    inflightTicket(key, () => store.ticketFor(asset.id, "thumbnail"))
      .then((ticket) => {
        if (!ticket.ok) {
          img.closest(".asset-tile")?.classList.add("lakomics-tile-failed");
          return;
        }
        img.src = ticket.url;
        img.addEventListener("error", () => {
          img.closest(".asset-tile")?.classList.add("lakomics-tile-failed");
        }, { once: true });
      });
  }

  function renderGrid({ preserveScroll = false } = {}) {
    const grid = document.querySelector("#assetGrid");
    if (!grid) return;
    const classificationId = activeClassificationId;
    if (!classificationId) return;
    const scope = store.getScope(classificationId);
    if (!scope || !scope.loadedFirstPage) return;

    const previousScroll = grid.parentElement?.scrollTop ?? 0;
    const visible = scope.items;
    grid.innerHTML = visible.length
      ? visible.map((asset, index) => tileHtml(asset, index)).join("") + (scope.hasMore ? sentinelHtml() : "")
      : emptyHtml(selectedName());

    grid.querySelectorAll("img[data-lib-thumb]").forEach((img) => {
      const assetId = img.dataset.libThumb;
      const index = Number(img.closest("[data-lib-index]")?.dataset.libIndex);
      const asset = scope.items[index];
      if (asset) fillTileImage(img, asset);
    });

    if (preserveScroll && grid.parentElement) grid.parentElement.scrollTop = previousScroll;
    observeSentinel(grid, classificationId);
    const total = document.querySelector("#assetTotal");
    if (total) {
      const label = `${visible.length.toLocaleString()}개 표시${scope.hasMore ? " (더 있음)" : ""}`;
      total.textContent = scope.loadedFirstPage ? label : total.textContent;
    }
  }

  function scheduleRender(preserveScroll = false) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderGrid({ preserveScroll }), 45);
  }

  let sentinelObserver = null;
  function observeSentinel(grid, classificationId) {
    sentinelObserver?.disconnect();
    const sentinel = grid.querySelector("#gridSentinel");
    if (!sentinel || !store.getScope(classificationId)?.hasMore) return;
    sentinelObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      const scope = store.getScope(classificationId);
      if (!scope?.hasMore || scope.loading) return;
      store.loadNextPage(classificationId);
    }, { rootMargin: "600px" });
    sentinelObserver.observe(sentinel);
  }

  function showGridError(code) {
    const grid = document.querySelector("#assetGrid");
    if (!grid) return;
    grid.innerHTML = gridErrorHtml(code);
  }

  function showGridLoading() {
    const grid = document.querySelector("#assetGrid");
    if (!grid) return;
    grid.innerHTML = `<div class="lakomics-live-loading">라이브러리 에셋 불러오는 중…</div>`;
  }

  async function openClassification(classificationId, { force = false } = {}) {
    if (!classificationId) return;
    activeClassificationId = classificationId;
    const scope = store.getScope(classificationId);
    if (!scope || force) {
      showGridLoadingOrEmpty(classificationId);
      const result = await store.loadFirstPage(classificationId);
      if (activeClassificationId !== classificationId) return;
      if (!result.ok) showGridError(result.code || "unknown");
      else renderGrid();
      return;
    }
    renderGrid();
    const parent = document.querySelector("#assetGrid")?.parentElement;
    if (parent) parent.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function showGridLoadingOrEmpty(classificationId) {
    const scope = store.getScope(classificationId);
    if (scope?.loadedFirstPage) renderGrid();
    else showGridLoading();
  }

  function ensureViewerWrap() {
    const dialog = document.querySelector("#viewer");
    if (!dialog) return null;
    let wrap = dialog.querySelector(".viewer-media-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "viewer-media-wrap";
      const spinner = document.createElement("div");
      spinner.id = "viewerSpinner";
      spinner.textContent = "불러오는 중…";
      wrap.append(spinner);
      const top = dialog.querySelector(".viewer-top");
      if (top) dialog.insertBefore(wrap, top.nextSibling);
      else dialog.append(wrap);
      const image = dialog.querySelector("#viewerImage");
      const video = ensureVideoElement();
      if (image) wrap.append(image);
      if (video) wrap.append(video);
    }
    return wrap;
  }

  function ensureVideoElement() {
    let video = document.querySelector("#lakomicsLiveVideo");
    if (video) return video;
    const dialog = document.querySelector("#viewer");
    if (!dialog) return null;
    video = document.createElement("video");
    video.id = "lakomicsLiveVideo";
    video.className = "viewer-media";
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.style.display = "none";
    return video;
  }

  function ensureNavButtons() {
    const dialog = document.querySelector("#viewer");
    if (!dialog) return;
    if (dialog.querySelector("#viewerPrev")) return;
    const prev = document.createElement("button");
    prev.id = "viewerPrev";
    prev.className = "viewer-nav";
    prev.textContent = "‹";
    prev.setAttribute("aria-label", "이전 에셋");
    const next = document.createElement("button");
    next.id = "viewerNext";
    next.className = "viewer-nav";
    next.textContent = "›";
    next.setAttribute("aria-label", "다음 에셋");
    dialog.append(prev, next);
    prev.addEventListener("click", () => stepViewer(-1));
    next.addEventListener("click", () => stepViewer(1));
  }

  function viewerKindLabel(asset) {
    if (asset.kind === "video") return "VIDEO";
    if (asset.kind === "gif") return "GIF";
    return "IMAGE";
  }

  function setViewerSpinner(visible) {
    const spinner = document.querySelector("#viewerSpinner");
    if (spinner) spinner.style.display = visible ? "block" : "none";
  }

  function prepareViewer(asset, index) {
    const dialog = document.querySelector("#viewer");
    const wrap = ensureViewerWrap();
    const image = dialog.querySelector("#viewerImage");
    const video = ensureVideoElement();
    const title = document.querySelector("#viewerTitle");
    const meta = document.querySelector("#viewerMeta");
    const indexEl = document.querySelector("#viewerIndex");
    if (!dialog || !wrap || !image) return null;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.style.display = "none";
    }
    image.style.display = "none";
    image.removeAttribute("src");
    wrap.classList.remove("zoomable");
    if (title) title.textContent = asset.creatorName || asset.importSource || "라이브러리 에셋";
    const parts = [dateLabel(asset.collectedAt || asset.committedAt), sizeLabel(asset.sizeBytes)].filter(Boolean);
    if (meta) meta.textContent = parts.join(" · ");
    if (indexEl) indexEl.textContent = `${index + 1} · ${viewerKindLabel(asset)}`;
    ensureNavButtons();
    if (!dialog.open) dialog.showModal();
    return { dialog, wrap, image, video, meta, indexEl };
  }

  async function showViewerAsset(classificationId, assetId) {
    const generation = ++viewerGeneration;
    const scope = store.getScope(classificationId);
    const index = store.indexOf(classificationId, assetId);
    if (!scope || index < 0) return;
    const asset = scope.items[index];
    const viewer = prepareViewer(asset, index);
    if (!viewer) return;
    setViewerSpinner(true);

    const variant = "original";
    const ticket = await inflightTicket(`${assetId}:${variant}`, () => store.ticketFor(assetId, variant));
    if (generation !== viewerGeneration || !viewer.dialog.open) return;
    setViewerSpinner(false);
    if (!ticket.ok) {
      if (viewer.meta) viewer.meta.textContent = `원본 로드 실패 · ${clean(ticket.code, 80) || "unknown"}`;
      return;
    }
    if (asset.kind === "video") {
      if (!viewer.video) return;
      viewer.video.style.display = "block";
      viewer.video.src = ticket.url;
      viewer.video.load();
      viewer.video.play().catch(() => {});
    } else {
      viewer.image.style.display = "block";
      viewer.image.src = ticket.url;
      viewer.wrap.classList.add("zoomable");
    }
  }

  async function stepViewer(direction) {
    const classificationId = viewerClassificationId;
    if (!classificationId || !viewerAssetId) return;
    const neighbor = store.neighbor(classificationId, viewerAssetId, direction);
    if (!neighbor) return;
    if (neighbor.pending) {
      const result = await store.loadNextPage(classificationId);
      if (result.ok) {
        const after = store.neighbor(classificationId, viewerAssetId, direction);
        if (after?.item) {
          viewerAssetId = after.item.id;
          showViewerAsset(classificationId, viewerAssetId);
          return;
        }
      }
      const indexEl = document.querySelector("#viewerIndex");
      if (indexEl) indexEl.textContent = "마지막 에셋";
      return;
    }
    viewerAssetId = neighbor.item.id;
    showViewerAsset(classificationId, viewerAssetId);
  }

  function handleViewerClose() {
    viewerGeneration += 1;
    const video = document.querySelector("#lakomicsLiveVideo");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    const image = document.querySelector("#viewerImage");
    if (image) {
      image.removeAttribute("src");
    }
    viewerClassificationId = null;
    viewerAssetId = null;
    // 스크롤 위치 복원: 그리드 상태는 그대로 두고 위치만 되돌린다 (리패치 금지)
    if (activeClassificationId) {
      const grid = document.querySelector("#assetGrid");
      const wrap = grid?.parentElement;
      const saved = store.restoreScroll(activeClassificationId);
      if (wrap) wrap.scrollTop = saved;
    }
  }

  // --- 이벤트 ---
  function installHooks() {
    installStyles();
    ensureFrame().catch(() => {});

    document.addEventListener("click", (event) => {
      const retry = event.target.closest?.("[data-grid-retry]");
      if (retry) {
        const classificationId = activeClassificationId;
        if (classificationId) {
          store.reset(classificationId);
          openClassification(classificationId, { force: true });
        }
        return;
      }

      const tile = event.target.closest?.("[data-lib-asset]");
      if (tile) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const classificationId = activeClassificationId;
        if (!classificationId) return;
        viewerClassificationId = classificationId;
        viewerAssetId = clean(tile.dataset.libAsset, 240);
        // 그리드 스크롤 저장 후 뷰어 열기
        const wrap = document.querySelector("#assetGrid")?.parentElement;
        if (wrap) store.saveScroll(classificationId, wrap.scrollTop);
        showViewerAsset(classificationId, viewerAssetId);
        return;
      }

      if (event.target.closest?.("[data-lakomics-live-select]")) {
        const id = selectedClassificationId();
        if (id) openClassification(id);
        return;
      }
      if (event.target.closest?.("#refreshBtn")) {
        const id = activeClassificationId || selectedClassificationId();
        if (id) {
          store.clearTickets();
          openClassification(id, { force: true });
        }
      }
    }, true);

    const grid = document.querySelector("#assetGrid");
    if (grid) {
      const wrap = grid.parentElement;
      if (wrap) {
        wrap.addEventListener("scroll", () => {
          if (activeClassificationId) store.saveScroll(activeClassificationId, wrap.scrollTop);
        }, { passive: true });
      }
    }

    document.querySelector("#viewer")?.addEventListener("close", handleViewerClose);
    document.querySelector("#viewer")?.addEventListener("click", (event) => {
      if (event.target.id === "viewer") event.currentTarget.close();
    });

    // 스토어 이벤트 → 그리드 부분 갱신
    store.subscribe((event) => {
      if (event.classificationId !== activeClassificationId) return;
      if (event.type === "loaded") {
        const scope = store.getScope(activeClassificationId);
        if (scope && scope.items.length > GRID_MAX_TILES) {
          const drop = store.trimWindow(activeClassificationId, scope.items.length - GRID_MAX_TILES);
          if (drop > 0) {
            const grid = document.querySelector("#assetGrid");
            const tileHeight = grid?.firstElementChild?.offsetHeight || 0;
            const wrap = grid?.parentElement;
            if (wrap && tileHeight > 0) {
              wrap.scrollTop = Math.max(0, wrap.scrollTop - drop * tileHeight);
            }
          }
        }
        renderGrid({ preserveScroll: !event.initial });
      } else if (event.type === "error") {
        if (!store.getScope(activeClassificationId)?.loadedFirstPage) showGridError(event.code);
      }
    });

    observeTreeSelection();
  }

  function observeTreeSelection() {
    const tree = document.querySelector("#treeScroll");
    if (!tree) {
      setTimeout(observeTreeSelection, 100);
      return;
    }
    new MutationObserver(() => {
      const id = selectedClassificationId();
      if (id && id !== activeClassificationId) openClassification(id);
    }).observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    const initial = selectedClassificationId();
    if (initial) openClassification(initial);
  }

  // mobile-bridge.js가 분류를 로드하면 초기 선택이 확정된다.
  new MutationObserver(() => {
    if (document.documentElement.dataset.lakomicsLiveClassifications === "connected") {
      setTimeout(observeTreeSelection, 50);
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-lakomics-live-classifications"] });

  function openAssetByIndex(classificationId, index) {
    const asset = store.itemAt(classificationId, index);
    if (!asset) return;
    viewerClassificationId = classificationId;
    viewerAssetId = asset.id;
    showViewerAsset(classificationId, asset.id);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { installHooks(); }, { once: true });
  } else {
    installHooks();
  }
})();