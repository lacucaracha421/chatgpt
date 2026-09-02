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

function createStore({ requestAssets, requestTicket } = {}) {
  const scopes = new Map(); // classificationId → scope state
  const tickets = new Map(); // `${assetId}:${variant}` → {url, contentType, sizeBytes, expiresAt}
  let listeners = new Set();

  function notify(event) {
    for (const listener of listeners) listener(event);
  }

  function scopeOf(classificationId) {
    let scope = scopes.get(classificationId);
    if (!scope) {
      scope = {
        classificationId,
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
      scopes.set(classificationId, scope);
    }
    return scope;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getScope(classificationId) {
    return scopes.get(classificationId) || null;
  }

  function reset(classificationId) {
    scopes.delete(classificationId);
    notify({ type: "reset", classificationId });
  }

  async function loadPage(classificationId, { cursor = null } = {}) {
    const scope = scopeOf(classificationId);
    if (scope.loading) return { ok: false, code: "already_loading" };
    if (!scope.hasMore && cursor === scope.cursor && scope.loadedFirstPage) {
      return { ok: true, appended: 0 };
    }
    const generation = ++scope.loadGeneration;
    scope.loading = true;
    scope.error = null;
    notify({ type: "loading", classificationId, initial: !scope.loadedFirstPage });
    let result;
    try {
      result = await requestAssets({
        classificationId,
        cursor,
        limit: PAGE_SIZE,
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
      notify({ type: "error", classificationId, code: scope.error });
      return result;
    }
    let appended = 0;
    for (const item of result.items || []) {
      if (!item || typeof item.id !== "string" || !item.id) continue;
      if (scope.seenIds.has(item.id)) continue;
      scope.seenIds.add(item.id);
      scope.items.push(item);
      appended += 1;
    }
    scope.hasMore = result.hasMore === true;
    scope.cursor = scope.hasMore ? result.nextCursor : null;
    scope.loadedFirstPage = true;
    notify({ type: "loaded", classificationId, appended, total: scope.items.length, hasMore: scope.hasMore });
    return { ok: true, appended };
  }

  async function loadFirstPage(classificationId) {
    reset(classificationId);
    return loadPage(classificationId, { cursor: null });
  }

  async function loadNextPage(classificationId) {
    const scope = scopes.get(classificationId);
    if (!scope || !scope.hasMore || scope.loading) return { ok: false, code: "no_next_page" };
    return loadPage(classificationId, { cursor: scope.cursor });
  }

  function saveScroll(classificationId, scrollTop) {
    const scope = scopes.get(classificationId);
    if (scope) scope.scrollTop = scrollTop;
  }

  function restoreScroll(classificationId) {
    return scopes.get(classificationId)?.scrollTop ?? 0;
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
  function neighbor(classificationId, assetId, direction) {
    const scope = scopes.get(classificationId);
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

  function itemAt(classificationId, index) {
    return scopes.get(classificationId)?.items[index] ?? null;
  }

  function indexOf(classificationId, assetId) {
    return scopes.get(classificationId)?.items.findIndex((item) => item.id === assetId) ?? -1;
  }

  function trimWindow(classificationId, keepFrom) {
    // 상한 초과 시 머리 절단: 반환된 offset 이후가 실제 items[0]
    const scope = scopes.get(classificationId);
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
globalThis.LakomicsMobileLibrary = { createStore, PAGE_SIZE, GRID_MAX_TILES, TICKET_TTL_MS };
