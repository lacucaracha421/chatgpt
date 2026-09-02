// Lakomics Mobile — Cloud Library 스토어
//
// 순수 로직(테스트 대상): 페이지네이션 상태, 티켓 캐시, 뷰어 내비게이션.
// DOM/브릿지는 외부에서 주입한다:
//   - requestAssets({classificationId, cursor, limit}) → {ok, items, hasMore, nextCursor}
//   - requestTicket({assetId, variant})                → {ok, url, contentType, sizeBytes, expiresAt}
//
// 스토어 규칙:
//  - 분류별 독립 상태(items/cursor/hasMore/scroll), viewer 닫힘 후 복원.
//  - 중복 asset id는 append하지 않는다(재시도 중복 방지).
//  - has_more/next_cursor로만 계속 여부를 판단한다(개수 추론 금지).
//  - signed URL은 세션 메모리에만, 만료 인지(300s TTL 가정) 캐시.
//  - 그리드 DOM 상한: 초과 시 머리(head) 타일을 잘라내고 유효 시작 인덱스를 올린다.

const PAGE_SIZE = 100;
const GRID_MAX_TILES = 600;
const TICKET_TTL_MS = 290_000; // 서버 300s보다 여유 있게
const MOBILE_SORTS = new Set(["newest", "oldest"]);

function normalizeSort(sort) {
  return MOBILE_SORTS.has(sort) ? sort : "newest";
}

function normalizeView(view) {
  if (typeof view === "string" && view) return { type: "classification", classificationId: view };
  if (view?.type === "classification" && typeof view.classificationId === "string" && view.classificationId) {
    return { type: "classification", classificationId: view.classificationId };
  }
  if (view?.type === "home") return { type: "home" };
  if (view?.type === "revisit") return { type: "revisit" };
  return { type: "recent" };
}

function viewKey(view) {
  const normalized = normalizeView(view);
  if (normalized.type === "home") return "view:home";
  if (normalized.type === "recent") return "view:recent";
  if (normalized.type === "revisit") return "view:revisit";
  return `classification:${normalized.classificationId}`;
}

function restoreMobileView(saved, validIds) {
  const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
  if (saved?.view?.type === "home") return { type: "home" };
  if (saved?.view?.type === "recent") return { type: "recent" };
  if (saved?.view?.type === "revisit") return { type: "revisit" };
  if (saved?.view?.type === "classification" && valid.has(saved.view.classificationId)) {
    return { type: "classification", classificationId: saved.view.classificationId };
  }
  if (valid.has(saved?.selectedId)) return { type: "classification", classificationId: saved.selectedId };
  // 유효한 저장 상태가 없으면 Home이 기본 뷰다.
  return { type: "home" };
}

function createViewTransition(initialView = null) {
  let generation = 0;
  let visibleView = initialView == null ? null : normalizeView(initialView);
  let pending = null;
  return {
    begin(view) {
      pending = { token: ++generation, view: normalizeView(view) };
      return { token: pending.token, keepVisible: visibleView !== null };
    },
    commit(token) {
      if (!pending || pending.token !== token) return false;
      visibleView = pending.view;
      pending = null;
      return true;
    },
    fail(token) {
      if (!pending || pending.token !== token) return false;
      pending = null;
      return true;
    },
    isCurrent(token) { return pending?.token === token; },
    visible() { return visibleView; },
  };
}

function createViewerChrome({
  delayMs = 3200,
  setTimer = (callback, delay) => globalThis.setTimeout?.(callback, delay) ?? null,
  clearTimer = (timerId) => globalThis.clearTimeout?.(timerId),
  onChange = () => {},
} = {}) {
  let visible = false;
  let timer = null;
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const emit = (next) => {
    visible = next;
    onChange(visible);
  };
  const schedule = () => {
    cancel();
    if (visible) timer = setTimer(() => { timer = null; emit(false); }, delayMs);
  };
  const show = () => { cancel(); emit(true); schedule(); };
  return {
    open() { cancel(); emit(false); },
    close() { cancel(); emit(false); },
    mediaTap({ interactive = false, moved = false, swiped = false } = {}) {
      if (interactive || moved || swiped) return;
      if (visible) { cancel(); emit(false); } else show();
    },
    interact() { show(); },
    hold() { cancel(); if (!visible) emit(true); },
    resume() { schedule(); },
    visible() { return visible; },
  };
}

function isNativeVideoControlHit({ clientY, top, bottom, paused = false, currentTime = 0 } = {}) {
  const y = Number(clientY);
  const start = Number(top);
  const end = Number(bottom);
  if (![y, start, end].every(Number.isFinite) || end <= start) return true;
  if (paused && Number(currentTime) <= 0) return true;
  const controlBand = Math.min(64, Math.max(40, (end - start) * 0.2));
  return y >= end - controlBand;
}

async function loadGridThumbnail(asset, loader) {
  if (!asset?.id || typeof loader !== "function") return { ok: false, code: "invalid_thumbnail_request" };
  const result = await loader(asset.id, "thumbnail");
  if (!result?.ok) return result || { ok: false, code: "thumbnail_failed" };
  if (typeof result.url !== "string" || !/^https?:\/\//.test(result.url) || !String(result.contentType || "").startsWith("image/")) {
    return { ok: false, code: "invalid_thumbnail_ticket" };
  }
  return result;
}

function swipeDirection({ startX, startY, endX, endY, interactive = false } = {}) {
  if (interactive) return 0;
  const dx = Number(endX) - Number(startX);
  const dy = Number(endY) - Number(startY);
  if (![dx, dy].every(Number.isFinite) || Math.abs(dx) < 56 || Math.abs(dx) <= Math.abs(dy) * 1.2) return 0;
  return dx < 0 ? 1 : -1;
}

function safeHttpUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : "";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1_073_741_824) return `${Math.round(bytes / 1_048_576)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function formatDate(value, dateOnly = false) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  return dateOnly ? new Date(time).toLocaleDateString("ko-KR") : new Date(time).toLocaleString("ko-KR");
}

function classificationPaths(ids, entries) {
  const byId = new Map((entries || []).filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  return (ids || []).flatMap((id) => {
    const names = [];
    const seen = new Set();
    let entry = byId.get(id);
    while (entry && !seen.has(entry.id)) {
      seen.add(entry.id);
      if (entry.name) names.unshift(entry.name);
      entry = entry.parentId ? byId.get(entry.parentId) : null;
    }
    return names.length ? [names.join(" › ")] : [];
  });
}

function mobileMetadata(asset = {}, classifications = []) {
  const name = String(asset.creatorName || "").trim();
  const rawHandle = String(asset.creatorHandle || "").trim();
  const handle = rawHandle ? (rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`) : "";
  const creator = name && handle ? `${name} (${handle})` : name || handle;
  const importKey = String(asset.importSource || "").trim().toLowerCase();
  const importLabels = {
    direct: "직접 추가",
    browser_extension: "브라우저 확장",
    metadata_import: "메타데이터 가져오기",
    legacy_lakomics: "구버전 Lakomics 이전",
  };
  const source = [];
  const published = formatDate(asset.sourcePublishedAt);
  if (published) source.push({ label: "게시 시각", value: published });
  const file = [];
  const kind = String(asset.kind || "").toUpperCase();
  const contentType = String(asset.contentType || "").trim();
  if (kind || contentType) file.push({ label: "형식", value: [kind, contentType].filter(Boolean).join(" · ") });
  if (Number.isFinite(asset.width) && Number.isFinite(asset.height)) file.push({ label: "해상도", value: `${asset.width} × ${asset.height}` });
  const size = formatBytes(asset.sizeBytes);
  if (size) file.push({ label: "크기", value: size });
  if (Number.isFinite(asset.durationMs)) file.push({ label: "재생 시간", value: `${Math.round(asset.durationMs / 1000)}초` });
  const imported = [];
  const collected = formatDate(asset.collectedAt, true);
  if (collected) imported.push({ label: "가져온 날짜", value: collected });
  if (importLabels[importKey]) imported.push({ label: "가져온 방식", value: importLabels[importKey] });
  return {
    creator,
    sourceUrl: safeHttpUrl(asset.sourceUrl),
    classifications: classificationPaths(asset.classificationIds, classifications),
    source,
    file,
    imported,
  };
}

function createStore({ requestAssets, requestVirtualView, requestTicket } = {}) {
  const scopes = new Map(); // viewKey → scope state
  const tickets = new Map(); // `${assetId}:${variant}` → {url, contentType, sizeBytes, expiresAt}
  let listeners = new Set();

  function notify(event) {
    for (const listener of listeners) listener(event);
  }

  function scopeOf(view, sort = "newest") {
    const normalizedView = normalizeView(view);
    const key = viewKey(normalizedView);
    const resolvedSort = normalizedView.type === "recent" ? "newest" : normalizeSort(sort);
    let scope = scopes.get(key);
    if (!scope) {
      scope = {
        view: normalizedView,
        viewKey: key,
        classificationId: normalizedView.type === "classification" ? normalizedView.classificationId : null,
        sort: resolvedSort,
        items: [],
        seenIds: new Set(),
        cursor: null,
        hasMore: true,
        loading: false,
        loadedFirstPage: false,
        error: null,
        scrollTop: 0,
        loadGeneration: 0,
      };
      scopes.set(key, scope);
    }
    return scope;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getScope(view) {
    return scopes.get(viewKey(view)) || null;
  }

  function reset(view) {
    const normalizedView = normalizeView(view);
    const key = viewKey(normalizedView);
    scopes.delete(key);
    notify({ type: "reset", view: normalizedView, viewKey: key, classificationId: normalizedView.classificationId ?? null });
  }

  async function loadPage(view, { cursor = null, sort } = {}) {
    const normalizedView = normalizeView(view);
    const key = viewKey(normalizedView);
    const recent = normalizedView.type === "recent" || normalizedView.type === "home" || normalizedView.type === "revisit";
    const virtualView = normalizedView.type === "home" || normalizedView.type === "revisit";
    const resolvedSort = recent ? "newest" : normalizeSort(sort || scopes.get(key)?.sort);
    const scope = scopeOf(normalizedView, resolvedSort);
    if (scope.loading) return { ok: false, code: "already_loading" };
    if (!scope.hasMore && cursor === scope.cursor && scope.loadedFirstPage) {
      return { ok: true, appended: 0 };
    }
    const generation = ++scope.loadGeneration;
    scope.loading = true;
    scope.error = null;
    const initial = !scope.loadedFirstPage;
    notify({ type: "loading", view: normalizedView, viewKey: key, classificationId: scope.classificationId, initial });
    let result;
    try {
      result = virtualView
        ? await requestVirtualView(normalizedView, PAGE_SIZE)
        : await requestAssets({
            viewType: normalizedView.type,
            classificationId: scope.classificationId ?? undefined,
            cursor: recent ? null : cursor,
            limit: PAGE_SIZE,
            sort: resolvedSort,
          });
    } catch (error) {
      result = { ok: false, code: error?.name === "AbortError" ? "timeout" : "request_failed" };
    }
    if (generation !== scope.loadGeneration) {
      return { ok: false, code: "stale" };
    }
    scope.loading = false;
    if (!result.ok) {
      scope.error = result.code || "request_failed";
      notify({ type: "error", view: normalizedView, viewKey: key, classificationId: scope.classificationId, code: scope.error, initial });
      return result;
    }
    let appended = 0;
    const resultItems = recent ? (result.items || []).slice(0, PAGE_SIZE) : (result.items || []);
    for (const item of resultItems) {
      if (!item || typeof item.id !== "string" || !item.id) continue;
      if (scope.seenIds.has(item.id)) continue;
      scope.seenIds.add(item.id);
      scope.items.push(item);
      appended += 1;
    }
    scope.hasMore = recent ? false : result.hasMore === true;
    scope.cursor = scope.hasMore ? result.nextCursor : null;
    scope.loadedFirstPage = true;
    notify({ type: "loaded", view: normalizedView, viewKey: key, classificationId: scope.classificationId, appended, total: scope.items.length, hasMore: scope.hasMore, initial });
    return { ok: true, appended };
  }

  async function loadFirstPage(view, { sort = "newest" } = {}) {
    reset(view);
    const promise = loadPage(view, { cursor: null, sort });
    const scope = getScope(view);
    if (scope) scope.firstPagePromise = promise;
    return promise.finally(() => {
      const current = getScope(view);
      if (current?.firstPagePromise === promise) current.firstPagePromise = null;
    });
  }

  function waitForFirstPage(view) {
    return getScope(view)?.firstPagePromise || Promise.resolve({ ok: false, code: "no_first_page_request" });
  }

  async function loadNextPage(view) {
    const scope = scopes.get(viewKey(view));
    if (!scope || !scope.hasMore || scope.loading) return { ok: false, code: "no_next_page" };
    return loadPage(view, { cursor: scope.cursor, sort: scope.sort });
  }

  function saveScroll(view, scrollTop) {
    const scope = scopes.get(viewKey(view));
    if (scope) scope.scrollTop = scrollTop;
  }

  function restoreScroll(view) {
    return scopes.get(viewKey(view))?.scrollTop ?? 0;
  }

  // --- 미디어 티켓 캐시 ---
  async function ticketFor(assetId, variant, { force = false } = {}) {
    const key = `${assetId}:${variant}`;
    if (!force) {
      const cached = tickets.get(key);
      if (cached && cached.expiresAt > Date.now() + 5_000) return { ok: true, ...cached, cached: true };
    }
    const result = await requestTicket({ assetId, variant });
    if (!result.ok) return result;
    const entry = {
      url: result.url,
      contentType: result.contentType,
      sizeBytes: result.sizeBytes,
      expiresAt: Date.parse(result.expiresAt || "") || Date.now() + TICKET_TTL_MS,
    };
    tickets.set(key, entry);
    return { ok: true, ...entry };
  }

  function cachedTicket(assetId, variant) {
    const cached = tickets.get(`${assetId}:${variant}`);
    if (cached && cached.expiresAt > Date.now() + 5_000) return { ok: true, ...cached };
    return null;
  }

  function clearTickets() {
    tickets.clear();
  }

  // --- 뷰어 내비게이션 ---
  function neighbor(view, assetId, direction) {
    const scope = scopes.get(viewKey(view));
    if (!scope) return null;
    const index = scope.items.findIndex((item) => item.id === assetId);
    if (index < 0) return null;
    const nextIndex = index + direction;
    if (nextIndex < 0) return null;
    if (nextIndex >= scope.items.length) {
      if (!scope.hasMore) return null;
      return { pending: true };
    }
    return { item: scope.items[nextIndex], index: nextIndex };
  }

  function itemAt(view, index) {
    return scopes.get(viewKey(view))?.items[index] ?? null;
  }

  function indexOf(view, assetId) {
    return scopes.get(viewKey(view))?.items.findIndex((item) => item.id === assetId) ?? -1;
  }

  function trimWindow(view, keepFrom) {
    // 상한 초과 시 머리 절단: 반환된 offset 이후가 실제 items[0]
    const scope = scopes.get(viewKey(view));
    if (!scope) return 0;
    const drop = Math.max(0, Math.min(keepFrom, scope.items.length - 1));
    if (drop <= 0) return 0;
    for (const item of scope.items.slice(0, drop)) scope.seenIds.delete(item.id);
    scope.items.splice(0, drop);
    return drop;
  }

  return {
    subscribe,
    scopeOf,
    getScope,
    reset,
    loadFirstPage,
    waitForFirstPage,
    loadNextPage,
    loadPage,
    saveScroll,
    restoreScroll,
    ticketFor,
    cachedTicket,
    clearTickets,
    neighbor,
    itemAt,
    indexOf,
    trimWindow,
    PAGE_SIZE,
  };
}
// 테스트와 mobile-assets.js 양쪽에서 접근 가능하도록 전역 노출
globalThis.LakomicsMobileLibrary = {
  createStore, PAGE_SIZE, GRID_MAX_TILES, TICKET_TTL_MS,
  loadGridThumbnail, swipeDirection, mobileMetadata,
  normalizeView, viewKey, restoreMobileView, createViewTransition, createViewerChrome, isNativeVideoControlHit,
};
