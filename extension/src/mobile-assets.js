// Lakomics Mobile — Full Cloud Library 브라우징 (Galaxy Tab)
//
// 데이터 원본은 배포된 Cloud Library API (VPS) 하나다. PC Lakomics와
// Cloud Capture Inbox는 라이브러리 열람 경로에 등장하지 않는다.
// 인증은 확장 서비스 워커만 수행하며, 페이지는 runtime message로 논리 op만 요청한다.
(() => {
  "use strict";

  const PAGE_ORIGIN = "https://lacucaracha421.github.io";
  const PAGE_PATH_PREFIX = "/chatgpt/";
  const REQUEST_TIMEOUT_MS = 15_000;
  const SORT_KEY = "lakomics.mobile.asset-sort.v1";

  if (location.origin !== PAGE_ORIGIN || !location.pathname.startsWith(PAGE_PATH_PREFIX)) return;

  const library = globalThis.LakomicsMobileLibrary;
  if (!library) return;
  const {
    createStore, GRID_MAX_TILES, loadGridThumbnail, swipeDirection, mobileMetadata,
    normalizeView, viewKey, createViewTransition, createViewerChrome, isNativeVideoControlHit,
  } = library;

  let renderTimer = null;
  let viewerGeneration = 0;
  let activeView = null;
  let viewerView = null;
  let viewerAssetId = null;
  let ticketInflight = new Map(); // `${assetId}:${variant}` → Promise
  let thumbnailObserver = null;
  let swipeStart = null;
  let activeSort = "newest";
  const viewTransition = createViewTransition();
  const viewerChrome = createViewerChrome({
    delayMs: 3200,
    onChange: (visible) => document.querySelector("#viewer")?.classList.toggle("viewer-chrome-visible", visible),
  });
  try {
    const savedSort = sessionStorage.getItem(SORT_KEY);
    if (savedSort === "oldest") activeSort = savedSort;
  } catch {}

  function clean(value, max = 1000) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }

  function installStyles() {
    if (document.querySelector("#lakomics-mobile-assets-style")) return;
    const style = document.createElement("style");
    style.id = "lakomics-mobile-assets-style";
    style.textContent = `
      .lakomics-live-video-thumb{position:absolute;inset:0;width:100%;height:100%;display:grid;place-items:center;background:linear-gradient(145deg,#16191e,#0d0f12);color:#cdd6e6}
      .lakomics-live-video-thumb svg{width:30px;height:30px;opacity:.9}
      .asset-tile[data-lib-kind="video"] img{position:absolute;inset:0;opacity:0}.asset-tile[data-lib-kind="video"].lakomics-tile-has-thumb img{opacity:1}.asset-tile.lakomics-tile-has-thumb .lakomics-live-video-thumb{display:none}
      .lakomics-live-media-mark{position:absolute;left:5px;bottom:5px;padding:2px 5px;border-radius:3px;background:rgba(5,6,8,.76);font-size:9px;color:#dce1e8;pointer-events:none}
      .lakomics-live-empty{grid-column:1/-1;min-height:160px;display:grid;place-items:center;text-align:center;color:#757c86;font-size:12px;padding:24px}
      .lakomics-live-loading{grid-column:1/-1;min-height:140px;display:grid;place-items:center;color:#777f89;font-size:12px}
      .lakomics-tile-failed img{opacity:0}.lakomics-tile-failed{background:repeating-linear-gradient(45deg,#16191e,#16191e 9px,#121417 9px,#121417 18px)}
      .lakomics-tile-retry{position:absolute;inset:0;display:grid;place-items:center;color:#98a0ab;font-size:11px;background:transparent;border:0}
      .asset-tile{cursor:pointer}
      .viewer-nav{position:absolute;z-index:2;top:50%;transform:translateY(-50%);width:44px;height:64px;border:0;border-radius:6px;background:rgba(0,0,0,.38);color:#fff;font-size:24px;display:grid;place-items:center}
      .viewer-top,.viewer-bottom,.viewer-nav{opacity:0;pointer-events:none;transition:opacity 150ms ease}
      .viewer.viewer-chrome-visible .viewer-top,.viewer.viewer-chrome-visible .viewer-bottom,.viewer.viewer-chrome-visible .viewer-nav{opacity:1;pointer-events:auto}
      .viewer-nav:active{background:rgba(0,0,0,.6)}
      #viewerPrev{left:8px}#viewerNext{right:8px}
      .viewer-media-wrap{position:absolute;inset:0;display:grid;place-items:center;overflow:auto;touch-action:pan-y pinch-zoom}
      .viewer-media-wrap img,.viewer-media-wrap video{max-width:100%;max-height:100%}
      .viewer-media-wrap.zoomable img{max-width:none;max-height:none;cursor:grab}
      #viewerSpinner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#aab1ba;font-size:12px;display:none}
      .asset-sort{min-height:32px;border:1px solid #2a2e34;border-radius:4px;background:#15171a;color:#f0f2f4;padding:4px 25px 4px 8px}
      .asset-sort:disabled{opacity:.55}.lakomics-grid-status{min-height:32px;border:0;background:transparent;color:#929aa5;font-size:11px}.lakomics-grid-status[data-error=true]{color:#d7a36e;text-decoration:underline}
      .viewer-details-toggle{width:38px;height:38px;padding:0;border:0;border-radius:4px;background:rgba(0,0,0,.35);color:#fff;font-size:18px}
      .viewer-details{position:absolute;z-index:5;left:0;right:0;bottom:0;max-height:min(62dvh,560px);overflow:auto;padding:12px 16px calc(18px + env(safe-area-inset-bottom));border-top:1px solid #2a2e34;border-radius:14px 14px 0 0;background:rgba(22,24,28,.98);box-shadow:0 -16px 40px rgba(0,0,0,.4);transform:translateY(105%);transition:transform 160ms ease}.viewer-details.open{transform:translateY(0)}
      .viewer-details-head{display:flex;align-items:center;margin-bottom:8px}.viewer-details-head strong{font-size:14px}.viewer-details-close{margin-left:auto;width:38px;height:38px;border:0;background:transparent;color:#9aa0a9;font-size:22px}
      .viewer-details-section{padding:11px 0;border-top:1px solid #22252a}.viewer-details-section h3{margin:0 0 7px;color:#9aa0a9;font-size:11px;font-weight:600}.viewer-details-row{display:grid;grid-template-columns:88px minmax(0,1fr);gap:10px;padding:4px 0}.viewer-details-label{color:#6f7680;font-size:11px}.viewer-details-value{min-width:0;color:#f0f2f4;font-size:12px;overflow-wrap:anywhere}.viewer-details-value a{color:#91b4ff}.viewer-details-chips{display:flex;flex-wrap:wrap;gap:5px}.viewer-details-chip{padding:4px 7px;border:1px solid #2a2e34;border-radius:99px;color:#d7dce4;font-size:11px}
      @media (prefers-reduced-motion:reduce){.viewer-nav{transition:none!important}}
    `;
    (document.head || document.documentElement).append(style);
  }

  function ensurePolishUi() {
    const toolbar = document.querySelector(".asset-toolbar");
    if (toolbar && !document.querySelector("#assetSort")) {
      const select = document.createElement("select");
      select.id = "assetSort";
      select.className = "asset-sort";
      select.setAttribute("aria-label", "에셋 정렬");
      for (const [value, label] of [["newest", "최신순"], ["oldest", "오래된순"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.append(option);
      }
      toolbar.append(select);
    }
    if (toolbar && !document.querySelector("#lakomicsGridStatus")) {
      const status = document.createElement("button");
      status.id = "lakomicsGridStatus";
      status.className = "lakomics-grid-status";
      status.hidden = true;
      toolbar.append(status);
    }
    const dialog = document.querySelector("#viewer");
    const top = dialog?.querySelector(".viewer-top");
    let toggle = document.querySelector("#viewerDetailsToggle");
    if (top && !toggle) {
      toggle = document.createElement("button");
      toggle.id = "viewerDetailsToggle";
      toggle.className = "viewer-details-toggle";
      toggle.setAttribute("aria-controls", "viewerDetails");
      toggle.setAttribute("aria-expanded", "false");
      top.insertBefore(toggle, top.querySelector("#viewerIndex"));
    }
    if (toggle) {
      toggle.setAttribute("aria-label", "정보");
      toggle.textContent = "ⓘ";
    }
    if (dialog && !document.querySelector("#viewerDetails")) {
      const sheet = document.createElement("aside");
      sheet.id = "viewerDetails";
      sheet.className = "viewer-details";
      sheet.setAttribute("aria-hidden", "true");
      const head = document.createElement("div");
      head.className = "viewer-details-head";
      const title = document.createElement("strong");
      title.textContent = "에셋 정보";
      const close = document.createElement("button");
      close.id = "viewerDetailsClose";
      close.className = "viewer-details-close";
      close.setAttribute("aria-label", "정보 닫기");
      close.textContent = "×";
      const content = document.createElement("div");
      content.id = "viewerDetailsContent";
      head.append(title, close);
      sheet.append(head, content);
      dialog.append(sheet);
    }
  }

  function runtimeRequest(type, payload = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result && typeof result === "object" ? result : { ok: false, code: "mobile_runtime_empty_response" });
      };
      const timer = setTimeout(() => finish({ ok: false, code: "mobile_runtime_timeout" }), REQUEST_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          if (chrome.runtime.lastError) return finish({ ok: false, code: "mobile_runtime_error" });
          finish(response);
        });
      } catch {
        finish({ ok: false, code: "mobile_runtime_error" });
      }
    });
  }

  const store = createStore({
    requestAssets: ({ viewType, classificationId, cursor, limit, sort }) => {
      const view = normalizeView(viewType === "recent" ? { type: "recent" } : { type: "classification", classificationId });
      return runtimeRequest("mobile-library:assets", { viewType: view.type, classificationId, cursor: cursor || undefined, limit, sort });
    },
    requestTicket: ({ assetId, variant }) =>
      runtimeRequest("mobile-library:media-ticket", { assetId, variant }),
  });

  function inflightTicket(key, loader) {
    const existing = ticketInflight.get(key);
    if (existing) return existing;
    const promise = loader().finally(() => ticketInflight.delete(key));
    ticketInflight.set(key, promise);
    return promise;
  }

  // --- 그리드 ---
  function selectedMobileView() {
    if (document.querySelector('#treeScroll .tree-row.selected[data-lakomics-live-view="recent"]')) return { type: "recent" };
    const row = document.querySelector("#treeScroll .tree-row.selected[data-lakomics-live-select]");
    const classificationId = clean(row?.dataset?.lakomicsLiveSelect, 240);
    return classificationId ? { type: "classification", classificationId } : null;
  }

  function selectedName(view) {
    if (normalizeView(view).type === "recent") return "최근 100개";
    return clean(document.querySelector("#treeScroll .tree-row.selected[data-lakomics-live-select] .tree-name")?.textContent, 120) || "분류";
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
        <img alt="" loading="lazy" decoding="async" data-lib-thumb="${id}">
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
    inflightTicket(key, () => loadGridThumbnail(asset, (assetId, variant) => store.ticketFor(assetId, variant)))
      .then((ticket) => {
        if (!ticket.ok) {
          img.closest(".asset-tile")?.classList.add("lakomics-tile-failed");
          return;
        }
        img.addEventListener("load", () => {
          img.closest(".asset-tile")?.classList.add("lakomics-tile-has-thumb");
        }, { once: true });
        img.addEventListener("error", () => {
          img.closest(".asset-tile")?.classList.add("lakomics-tile-failed");
        }, { once: true });
        img.src = ticket.url;
      });
  }

  function observeThumbnails(grid, scope) {
    thumbnailObserver?.disconnect();
    const images = [...grid.querySelectorAll("img[data-lib-thumb]")];
    const load = (img) => {
      const index = Number(img.closest("[data-lib-index]")?.dataset.libIndex);
      const asset = scope.items[index];
      if (asset) fillTileImage(img, asset);
    };
    if (typeof IntersectionObserver !== "function") {
      images.forEach(load);
      return;
    }
    thumbnailObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbnailObserver?.unobserve(entry.target);
        load(entry.target);
      }
    }, { root: null, rootMargin: "500px" });
    images.forEach((img) => thumbnailObserver.observe(img));
  }

  function renderGrid({ preserveScroll = false, view = viewTransition.visible() || activeView } = {}) {
    const grid = document.querySelector("#assetGrid");
    if (!grid) return;
    if (!view) return;
    const scope = store.getScope(view);
    if (!scope || !scope.loadedFirstPage) return;

    const previousScroll = grid.parentElement?.scrollTop ?? 0;
    const visible = scope.items;
    grid.innerHTML = visible.length
      ? visible.map((asset, index) => tileHtml(asset, index)).join("") + (scope.hasMore ? sentinelHtml() : "")
      : emptyHtml(selectedName(view));

    observeThumbnails(grid, scope);

    if (preserveScroll && grid.parentElement) grid.parentElement.scrollTop = previousScroll;
    observeSentinel(grid, view);
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
  function observeSentinel(grid, view) {
    sentinelObserver?.disconnect();
    const sentinel = grid.querySelector("#gridSentinel");
    if (!sentinel || !store.getScope(view)?.hasMore) return;
    sentinelObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      const scope = store.getScope(view);
      if (!scope?.hasMore || scope.loading) return;
      store.loadNextPage(view);
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

  function syncSortControl(view) {
    const sortSelect = document.querySelector("#assetSort");
    if (!sortSelect) return;
    const recent = normalizeView(view).type === "recent";
    sortSelect.disabled = recent;
    sortSelect.value = recent ? "newest" : activeSort;
  }

  function setTransitionStatus(message = "", error = false) {
    const status = document.querySelector("#lakomicsGridStatus");
    if (!status) return;
    status.hidden = !message;
    status.textContent = message;
    status.dataset.error = error ? "true" : "false";
  }

  async function openView(view, { force = false } = {}) {
    if (!view) return;
    view = normalizeView(view);
    activeView = view;
    syncSortControl(view);
    const request = viewTransition.begin(view);
    const requestedSort = view.type === "recent" ? "newest" : activeSort;
    const scope = store.getScope(view);
    const sortChanged = Boolean(scope && scope.sort !== requestedSort);
    if (scope?.loading && !scope.loadedFirstPage && !force && !sortChanged) {
      if (request.keepVisible) setTransitionStatus("불러오는 중…");
      else showGridLoading();
      const result = await store.waitForFirstPage(view);
      if (!viewTransition.isCurrent(request.token)) return;
      if (!result.ok) {
        viewTransition.fail(request.token);
        if (request.keepVisible) setTransitionStatus("로드 실패 · 다시 시도", true);
        else showGridError(result.code || "unknown");
        return;
      }
      if (!viewTransition.commit(request.token)) return;
      setTransitionStatus();
      renderGrid({ view });
      return;
    }
    if (!scope || sortChanged || force) {
      if (request.keepVisible) setTransitionStatus("불러오는 중…");
      else showGridLoading();
      const result = await store.loadFirstPage(view, { sort: requestedSort });
      if (!viewTransition.isCurrent(request.token)) return;
      if (!result.ok) {
        viewTransition.fail(request.token);
        if (request.keepVisible) setTransitionStatus("로드 실패 · 다시 시도", true);
        else showGridError(result.code || "unknown");
        return;
      }
      if (!viewTransition.commit(request.token)) return;
      setTransitionStatus();
      renderGrid({ view });
      return;
    }
    if (!viewTransition.commit(request.token)) return;
    setTransitionStatus();
    renderGrid({ view });
    const parent = document.querySelector("#assetGrid")?.parentElement;
    if (parent) parent.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: "instant" });
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
    prev.addEventListener("click", () => { viewerChrome.interact(); stepViewer(-1); });
    next.addEventListener("click", () => { viewerChrome.interact(); stepViewer(1); });
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
    const metadata = mobileMetadata(asset, globalThis.LakomicsMobileClassificationEntries || []);
    if (title) title.textContent = metadata.creator || asset.importSource || "라이브러리 에셋";
    const parts = [dateLabel(asset.collectedAt || asset.committedAt), sizeLabel(asset.sizeBytes)].filter(Boolean);
    if (meta) meta.textContent = parts.join(" · ");
    if (indexEl) indexEl.textContent = `${index + 1} · ${viewerKindLabel(asset)}`;
    renderViewerDetails(asset);
    ensureNavButtons();
    if (!dialog.open) {
      dialog.showModal();
      viewerChrome.open();
    }
    return { dialog, wrap, image, video, meta, indexEl };
  }

  function setDetailsOpen(open) {
    const sheet = document.querySelector("#viewerDetails");
    const toggle = document.querySelector("#viewerDetailsToggle");
    sheet?.classList.toggle("open", open);
    sheet?.setAttribute("aria-hidden", open ? "false" : "true");
    toggle?.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function appendDetailsSection(container, heading, rows) {
    if (!rows.length) return;
    const section = document.createElement("section");
    section.className = "viewer-details-section";
    const title = document.createElement("h3");
    title.textContent = heading;
    section.append(title);
    for (const row of rows) {
      const line = document.createElement("div");
      line.className = "viewer-details-row";
      const label = document.createElement("div");
      label.className = "viewer-details-label";
      label.textContent = row.label;
      const value = document.createElement("div");
      value.className = "viewer-details-value";
      value.textContent = row.value;
      line.append(label, value);
      section.append(line);
    }
    container.append(section);
  }

  function renderViewerDetails(asset) {
    const container = document.querySelector("#viewerDetailsContent");
    if (!container) return;
    container.textContent = "";
    const metadata = mobileMetadata(asset, globalThis.LakomicsMobileClassificationEntries || []);
    const sourceRows = [];
    if (metadata.sourceUrl) sourceRows.push({ label: "출처", value: metadata.sourceUrl, link: true });
    if (metadata.creator) sourceRows.push({ label: "제작자", value: metadata.creator });
    sourceRows.push(...metadata.source);
    appendDetailsSection(container, "출처", sourceRows);
    const sourceSection = container.lastElementChild;
    if (metadata.sourceUrl && sourceSection) {
      const value = sourceSection.querySelector(".viewer-details-value");
      if (value) {
        value.textContent = "";
        const link = document.createElement("a");
        link.href = metadata.sourceUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = metadata.sourceUrl;
        value.append(link);
      }
    }
    if (metadata.classifications.length) {
      const section = document.createElement("section");
      section.className = "viewer-details-section";
      const title = document.createElement("h3");
      title.textContent = "분류";
      const chips = document.createElement("div");
      chips.className = "viewer-details-chips";
      for (const path of metadata.classifications) {
        const chip = document.createElement("span");
        chip.className = "viewer-details-chip";
        chip.textContent = path;
        chips.append(chip);
      }
      section.append(title, chips);
      container.append(section);
    }
    appendDetailsSection(container, "파일", metadata.file);
    appendDetailsSection(container, "가져오기", metadata.imported);
  }

  async function showViewerAsset(view, assetId) {
    const generation = ++viewerGeneration;
    const scope = store.getScope(view);
    const index = store.indexOf(view, assetId);
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
    const view = viewerView;
    if (!view || !viewerAssetId) return;
    const neighbor = store.neighbor(view, viewerAssetId, direction);
    if (!neighbor) return;
    if (neighbor.pending) {
      const result = await store.loadNextPage(view);
      if (result.ok) {
        const after = store.neighbor(view, viewerAssetId, direction);
        if (after?.item) {
          viewerAssetId = after.item.id;
          showViewerAsset(view, viewerAssetId);
          return;
        }
      }
      const indexEl = document.querySelector("#viewerIndex");
      if (indexEl) indexEl.textContent = "마지막 에셋";
      return;
    }
    viewerAssetId = neighbor.item.id;
    showViewerAsset(view, viewerAssetId);
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
    viewerChrome.close();
    viewerView = null;
    viewerAssetId = null;
    setDetailsOpen(false);
    // 스크롤 위치 복원: 그리드 상태는 그대로 두고 위치만 되돌린다 (리패치 금지)
    const visibleView = viewTransition.visible();
    if (visibleView) {
      const grid = document.querySelector("#assetGrid");
      const wrap = grid?.parentElement;
      const saved = store.restoreScroll(visibleView);
      if (wrap) wrap.scrollTop = saved;
    }
  }

  // --- 이벤트 ---
  function installHooks() {
    installStyles();
    ensurePolishUi();
    const sortSelect = document.querySelector("#assetSort");
    if (sortSelect) {
      sortSelect.value = activeSort;
      sortSelect.addEventListener("change", async () => {
        if (normalizeView(activeView).type === "recent") return;
        activeSort = sortSelect.value === "oldest" ? "oldest" : "newest";
        try { sessionStorage.setItem(SORT_KEY, activeSort); } catch {}
        const view = activeView || selectedMobileView();
        if (view) await openView(view, { force: true });
      });
    }
    document.addEventListener("click", (event) => {
      const retry = event.target.closest?.("[data-grid-retry]");
      if (retry) {
        const view = activeView;
        if (view) openView(view, { force: true });
        return;
      }
      if (event.target.closest?.("#lakomicsGridStatus[data-error=true]")) {
        if (activeView) openView(activeView, { force: true });
        return;
      }

      const tile = event.target.closest?.("[data-lib-asset]");
      if (tile) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const view = viewTransition.visible();
        if (!view) return;
        viewerView = view;
        viewerAssetId = clean(tile.dataset.libAsset, 240);
        // 그리드 스크롤 저장 후 뷰어 열기
        const wrap = document.querySelector("#assetGrid")?.parentElement;
        if (wrap) store.saveScroll(view, wrap.scrollTop);
        showViewerAsset(view, viewerAssetId);
        return;
      }

      if (event.target.closest?.("#refreshBtn")) {
        const view = activeView || selectedMobileView();
        if (view) {
          store.clearTickets();
          openView(view, { force: true });
        }
      }
    }, true);

    const grid = document.querySelector("#assetGrid");
    if (grid) {
      const wrap = grid.parentElement;
      if (wrap) {
        wrap.addEventListener("scroll", () => {
          const visibleView = viewTransition.visible();
          if (visibleView) store.saveScroll(visibleView, wrap.scrollTop);
        }, { passive: true });
      }
    }

    document.querySelector("#viewer")?.addEventListener("close", handleViewerClose);
    document.querySelector("#viewer")?.addEventListener("click", (event) => {
      if (event.target.id === "viewer") event.currentTarget.close();
    });
    document.querySelector("#viewerDetailsToggle")?.addEventListener("click", () => {
      viewerChrome.hold();
      const open = document.querySelector("#viewerDetails")?.classList.contains("open") !== true;
      setDetailsOpen(open);
      if (!open) viewerChrome.interact();
    });
    document.querySelector("#viewerDetailsClose")?.addEventListener("click", () => {
      setDetailsOpen(false);
      viewerChrome.interact();
    });

    const viewerWrap = ensureViewerWrap();
    viewerWrap?.addEventListener("pointerdown", (event) => {
      const directControl = Boolean(event.target.closest?.("button,a,input,select,textarea,[role=button]"));
      const video = event.target.closest?.("video");
      const rect = video?.getBoundingClientRect?.();
      const nativeVideoControl = Boolean(video && isNativeVideoControlHit({
        clientY: event.clientY,
        top: rect?.top,
        bottom: rect?.bottom,
        paused: video.paused,
        currentTime: video.currentTime,
      }));
      const interactive = directControl || nativeVideoControl;
      swipeStart = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, interactive };
    });
    viewerWrap?.addEventListener("pointerup", (event) => {
      if (!swipeStart || swipeStart.pointerId !== event.pointerId) return;
      const completed = { ...swipeStart, endX: event.clientX, endY: event.clientY };
      const direction = swipeDirection(completed);
      swipeStart = null;
      if (direction) {
        viewerChrome.mediaTap({ swiped: true });
        stepViewer(direction);
        return;
      }
      const moved = Math.max(Math.abs(completed.endX - completed.startX), Math.abs(completed.endY - completed.startY)) > 10;
      viewerChrome.mediaTap({ interactive: completed.interactive, moved });
    });
    viewerWrap?.addEventListener("pointercancel", () => { swipeStart = null; });
    document.addEventListener("keydown", (event) => {
      if (!document.querySelector("#viewer")?.open) return;
      if (event.key === "ArrowLeft") stepViewer(-1);
      if (event.key === "ArrowRight") stepViewer(1);
    });

    // 스토어 이벤트 → 그리드 부분 갱신
    store.subscribe((event) => {
      if (!activeView || event.viewKey !== viewKey(activeView)) return;
      if (event.type === "loaded") {
        if (event.initial) return;
        const scope = store.getScope(activeView);
        if (scope && scope.items.length > GRID_MAX_TILES) {
          const drop = store.trimWindow(activeView, scope.items.length - GRID_MAX_TILES);
          if (drop > 0) {
            const grid = document.querySelector("#assetGrid");
            const tileHeight = grid?.firstElementChild?.offsetHeight || 0;
            const wrap = grid?.parentElement;
            if (wrap && tileHeight > 0) {
              wrap.scrollTop = Math.max(0, wrap.scrollTop - drop * tileHeight);
            }
          }
        }
        if (viewKey(viewTransition.visible()) === event.viewKey) renderGrid({ preserveScroll: true });
      } else if (event.type === "error") {
        if (!event.initial && !store.getScope(activeView)?.loadedFirstPage) showGridError(event.code);
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
      const view = selectedMobileView();
      if (view && (!activeView || viewKey(view) !== viewKey(activeView))) openView(view);
    }).observe(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    const initial = selectedMobileView();
    if (initial) openView(initial);
  }

  // mobile-bridge.js가 분류를 로드하면 초기 선택이 확정된다.
  new MutationObserver(() => {
    if (document.documentElement.dataset.lakomicsLiveClassifications === "connected") {
      setTimeout(observeTreeSelection, 50);
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-lakomics-live-classifications"] });

  function openAssetByIndex(view, index) {
    const asset = store.itemAt(view, index);
    if (!asset) return;
    viewerView = view;
    viewerAssetId = asset.id;
    showViewerAsset(view, asset.id);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { installHooks(); }, { once: true });
  } else {
    installHooks();
  }
})();
