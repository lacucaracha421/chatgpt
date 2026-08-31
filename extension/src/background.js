(() => {
  "use strict";

  if (typeof importScripts === "function") {
    if (!globalThis.LakomicsRadial) importScripts("layout.js");
    if (!globalThis.LakomicsDefaults) importScripts("defaults.js");
  }

  const LOCAL_API_BASE_URL = "http://127.0.0.1:32145";
  const PC_EXTENSION_ID = "nclkmjmmlcdaeomgadndeangccfidfbk";
  const REMOTE_SETTINGS_KEY = "remoteSettings";
  const COLLECTOR_SETTINGS_KEY = "collectorSettings";
  const COLLECTOR_TOKEN_KEY = "collectorToken";
  const CACHE_MS = 30_000;
  const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
  const APP_LAYOUT_KEY = "radialLayout";
  const APP_PINNED_KEY = "pinnedClassificationIds";
  const LOCAL_LAYOUT_KEY = "localRadialLayout"; // legacy alpha storage
  const LOCAL_TREE_KEY = "localClassificationTree";
  const RECENT_BROWSER_SAVES_KEY = "recentBrowserSaves";
  const LAST_APP_CLASSIFICATIONS_KEY = "lastAppClassifications";
  const LAST_CLOUD_CLASSIFICATIONS_KEY = "lastCloudClassifications";
  const LAST_APP_SAVED_X_MEDIA_KEY = "lastAppSavedXMediaIndex";
  const API_REQUEST_TIMEOUT_MS = 8000;
  const COLLECTOR_IMAGE_REQUEST_TIMEOUT_MS = 45_000;
  const COLLECTOR_VIDEO_REQUEST_TIMEOUT_MS = 5 * 60_000;
  const COLLECTOR_SUPPORTED_MEDIA_TYPES = new Set(["image", "video", "animated_gif"]);
  const COLLECTOR_FALLBACK_DIAGNOSTICS_KEY = "lakomicsCollectorFallbackDiagnostics";
  const COLLECTOR_FALLBACK_DIAGNOSTICS_LIMIT = 20;
  // 영상 원본은 Tailscale 터널 경유로 8초를 쉽게 상회한다. PC가 받는 중이면 기다린다.
  const INGESTION_TIMEOUT_MS = 120_000;
  const INGESTION_RETRY_DELAY_MS = 700;
  // 연속 실패 후 타임아웃 8초를 매번 채우지 않게 한다. 이 시간 동안은
  // 저장된 스냅샷/기기 폴백을 바로 쓰고, 수집 자체는 계속 시도한다.
  const OFFLINE_BACKOFF_MS = 60_000;
  const RECENT_DUPLICATE_MS = 10_000;
  const X_SYNDICATION_ENDPOINT = "https://cdn.syndication.twimg.com/tweet-result";
  let classificationCache = null;
  let classificationCachedAt = 0;
  let classificationCacheBaseUrl = null;
  // 엔드포인트별 마지막 실패. { baseUrl, code, failedAt } 또는 null.
  let lastConnectionFailure = null;
  let classificationRefreshPromise = null;
  let classificationRefreshBaseUrl = null;
  let lastClassificationProbe = null;
  let browserDownloadQueue = Promise.resolve();
  const pendingFilenameSuggestions = [];
  const FILENAME_SUGGESTION_TTL_MS = 15_000;
  async function handleMessage(message) {
    switch (message?.type) {
      case "settings:get": {
        const stored = await chrome.storage.local.get([
          "connectionToken", "preferences", REMOTE_SETTINGS_KEY, COLLECTOR_SETTINGS_KEY, COLLECTOR_TOKEN_KEY,
        ]);
        return {
          ok: true,
          tokenConfigured: TOKEN_PATTERN.test(stored.connectionToken ?? ""),
          collectorTokenConfigured: Boolean(normalizeCollectorToken(stored[COLLECTOR_TOKEN_KEY])),
          preferences: globalThis.LakomicsDefaults.normalizePreferences(stored.preferences),
          remote: globalThis.LakomicsDefaults.normalizeRemoteSettings(stored[REMOTE_SETTINGS_KEY]),
          collector: globalThis.LakomicsDefaults.normalizeCollectorSettings(stored[COLLECTOR_SETTINGS_KEY]),
          downloadsApiAvailable: Boolean(chrome.downloads?.download),
          downloadsUiApiAvailable: Boolean(chrome.downloads?.setUiOptions),
          lastConnectionFailure: lastConnectionFailure
            ? { code: lastConnectionFailure.code, failedAt: lastConnectionFailure.failedAt }
            : null,
        };
      }
      case "settings:set-token": {
        const token = String(message.token ?? "").trim();
        if (!TOKEN_PATTERN.test(token)) {
          return { ok: false, code: "invalid_connection_key" };
        }
        await chrome.storage.local.set({ connectionToken: token });
        resetClassificationCache();
        return { ok: true };
      }
      case "settings:set-collector-token": {
        const token = normalizeCollectorToken(message.token);
        if (!token) return { ok: false, code: "invalid_collector_token" };
        await chrome.storage.local.set({ [COLLECTOR_TOKEN_KEY]: token });
        return { ok: true };
      }
      case "settings:set-collector": {
        const requested = {
          enabled: message.collector?.enabled === true,
          baseUrl: message.collector?.baseUrl,
        };
        const collector = globalThis.LakomicsDefaults.normalizeCollectorSettings(requested);
        if (requested.enabled && !collector.baseUrl) {
          return { ok: false, code: "invalid_collector_url" };
        }
        await chrome.storage.local.set({ [COLLECTOR_SETTINGS_KEY]: collector });
        return { ok: true, collector };
      }
      case "settings:set-preferences": {
        if (isUnsupportedAbsoluteDownloadFolder(message.preferences?.downloadFolder)) {
          return { ok: false, code: "absolute_download_path_unsupported" };
        }
        const preferences = globalThis.LakomicsDefaults.normalizePreferences(message.preferences);
        await chrome.storage.local.set({ preferences });
        const downloadUiControl = await applyDownloadUiPreference(preferences.suppressDownloadUi);
        resetClassificationCache();
        return { ok: true, preferences, downloadUiControl };
      }
      case "settings:set-remote": {
        const requested = {
          enabled: message.remote?.enabled === true,
          baseUrl: message.remote?.baseUrl,
        };
        const remote = globalThis.LakomicsDefaults.normalizeRemoteSettings(requested);
        if (requested.enabled && !remote.baseUrl) {
          return { ok: false, code: "invalid_remote_url" };
        }
        await chrome.storage.local.set({ [REMOTE_SETTINGS_KEY]: remote });
        resetClassificationCache();
        return { ok: true, remote };
      }
      case "connection-backup:export": {
        const stored = await chrome.storage.local.get(["connectionToken", REMOTE_SETTINGS_KEY]);
        const token = String(stored.connectionToken ?? "");
        if (!TOKEN_PATTERN.test(token)) return { ok: false, code: "connection_key_missing" };
        return {
          ok: true,
          backup: {
            version: 1,
            connectionToken: token,
            remote: globalThis.LakomicsDefaults.normalizeRemoteSettings(stored[REMOTE_SETTINGS_KEY]),
          },
        };
      }
      case "connection-backup:import": {
        const backup = message.backup;
        if (!backup || backup.version !== 1 || !TOKEN_PATTERN.test(String(backup.connectionToken ?? ""))) {
          return { ok: false, code: "invalid_connection_backup" };
        }
        const remote = globalThis.LakomicsDefaults.normalizeRemoteSettings(backup.remote);
        await chrome.storage.local.set({
          connectionToken: String(backup.connectionToken),
          [REMOTE_SETTINGS_KEY]: remote,
        });
        resetClassificationCache();
        return { ok: true, remote };
      }
      case "remote:test":
        return testRemoteConnection();
      case "collector:test":
        return testCollectorConnection();
      case "xtranslate:http":
        return translateHttpRequest(message.request);
      case "layout:get": {
        const { radialLayout } = await chrome.storage.local.get([APP_LAYOUT_KEY]);
        return {
          ok: true,
          layout: validLayout(radialLayout) ? radialLayout : { version: 1, parents: {} },
        };
      }
      case "layout:set": {
        if (!validLayout(message.layout)) {
          return { ok: false, code: "invalid_layout" };
        }
        await chrome.storage.local.set({ [APP_LAYOUT_KEY]: message.layout });
        if (classificationCache) classificationCache.layout = message.layout;
        await updateLastAppSnapshot({ layout: message.layout });
        return { ok: true };
      }
      case "radial-state:set": {
        if (!validLayout(message.layout) || !Array.isArray(message.pinnedIds)) {
          return { ok: false, code: "invalid_radial_state" };
        }
        const pinnedIds = normalizePinnedIds(message.pinnedIds);
        await chrome.storage.local.set({ [APP_LAYOUT_KEY]: message.layout, [APP_PINNED_KEY]: pinnedIds });
        if (classificationCache) { classificationCache.layout = message.layout; classificationCache.pinnedIds = pinnedIds; }
        await updateLastAppSnapshot({ layout: message.layout, pinnedIds });
        return { ok: true, pinnedIds };
      }
      case "classifications:get":
        return activeClassifications(false);
      case "classifications:refresh":
        return activeClassifications(true);
      case "saved-index:get":
        return savedXMediaIndex();
      case "pinned:get":
        return { ok: true, pinnedIds: await loadPinned(APP_PINNED_KEY) };
      case "pinned:set": {
        if (!Array.isArray(message.pinnedIds)) return { ok: false, code: "invalid_pinned" };
        const pinnedIds = normalizePinnedIds(message.pinnedIds);
        await chrome.storage.local.set({ [APP_PINNED_KEY]: pinnedIds });
        if (classificationCache) classificationCache.pinnedIds = pinnedIds;
        await updateLastAppSnapshot({ pinnedIds });
        return { ok: true };
      }
      case "local-tree:get":
        return { ok: true, tree: await loadLocalTree() };
      case "local-tree:set": {
        const tree = globalThis.LakomicsDefaults.normalizeLocalTree(message.tree);
        await chrome.storage.local.set({ [LOCAL_TREE_KEY]: tree });
        return { ok: true, tree };
      }
      case "local-tree:reset": {
        const tree = globalThis.LakomicsDefaults.defaultLocalTree();
        await chrome.storage.local.set({ [LOCAL_TREE_KEY]: tree });
        return { ok: true, tree };
      }
      case "local-tree:copy-app": {
        const response = await appClassifications(true);
        if (!response.ok) return response;
        const tree = localTreeFromApp(response.entries, response.layout, response.pinnedIds);
        await chrome.storage.local.set({ [LOCAL_TREE_KEY]: tree });
        return { ok: true, tree };
      }
      case "collector:diagnostics": {
        const stored = await chrome.storage.local.get([COLLECTOR_FALLBACK_DIAGNOSTICS_KEY]);
        return {
          ok: true,
          entries: Array.isArray(stored[COLLECTOR_FALLBACK_DIAGNOSTICS_KEY])
            ? stored[COLLECTOR_FALLBACK_DIAGNOSTICS_KEY]
            : [],
        };
      }
      case "ingestion:create":
        return saveMedia(message.payload ?? {});
      default:
        return { ok: false, code: "unknown_message" };
    }
  }

  /// VPS에 게시된 분류 스냅샷을 조회한다. 인증은 Collector 토큰(Bearer) 하나고
  /// PC 연결 없이 동작한다. 30초 메모리 캐시와 오프라인 백오프는 PC 경로와 같은
  /// 규칙을 따른다. 성공 시 스냅샷을 저장해 VPS 장애 시 cloud-cache로 쓴다.
  async function cloudClassifications(force) {
    const collector = await loadCollectorSettings();
    const now = Date.now();
    if (!force && classificationCache && classificationCacheBaseUrl === collector.baseUrl
      && now - classificationCachedAt <= CACHE_MS) {
      return { ok: true, classificationSource: "cloud", ...classificationCache };
    }
    if (!force && inOfflineBackoff(collector, now)) {
      const cached = await cloudCachedClassifications();
      if (cached) return cached;
    }
    const response = await collectorRequest("/v1/classifications", {}, collector.baseUrl);
    if (!response.ok) {
      if (force) return response;
      const cached = await cloudCachedClassifications();
      if (cached) return cached;
      return response;
    }
    const entries = Array.isArray(response.entries) ? response.entries : [];
    const rawPinnedIds = await loadPinned(APP_PINNED_KEY);
    const repaired = repairPinnedIds(entries, rawPinnedIds, entries);
    const stored = await chrome.storage.local.get([APP_LAYOUT_KEY]);
    const sourceLayout = validLayout(stored[APP_LAYOUT_KEY]) ? stored[APP_LAYOUT_KEY] : null;
    let layout = globalThis.LakomicsRadial.reconcileLayout(entries, sourceLayout);
    layout = globalThis.LakomicsRadial.reorderPinned(layout, entries, repaired.pinnedIds);
    classificationCache = { entries, layout, pinnedIds: repaired.pinnedIds };
    classificationCachedAt = now;
    classificationCacheBaseUrl = collector.baseUrl;
    await chrome.storage.local.set({
      [LAST_CLOUD_CLASSIFICATIONS_KEY]: {
        version: 1, baseUrl: collector.baseUrl, entries, savedAt: now,
      },
    });
    return { ok: true, classificationSource: "cloud", ...classificationCache };
  }

  async function cloudCachedClassifications() {
    const collector = await loadCollectorSettings();
    const stored = await chrome.storage.local.get([
      LAST_CLOUD_CLASSIFICATIONS_KEY, APP_LAYOUT_KEY, APP_PINNED_KEY,
    ]);
    const snapshot = stored[LAST_CLOUD_CLASSIFICATIONS_KEY];
    if (!snapshot || snapshot.version !== 1 || snapshot.baseUrl !== collector.baseUrl
      || !Array.isArray(snapshot.entries) || !snapshot.entries.length) return null;
    const entries = snapshot.entries.filter((entry) => entry && typeof entry.id === "string");
    if (!entries.length) return null;
    const pinnedIds = normalizePinnedIds(Array.isArray(stored[APP_PINNED_KEY]) ? stored[APP_PINNED_KEY] : []);
    const sourceLayout = validLayout(stored[APP_LAYOUT_KEY]) ? stored[APP_LAYOUT_KEY] : null;
    let layout = globalThis.LakomicsRadial.reconcileLayout(entries, sourceLayout);
    layout = globalThis.LakomicsRadial.reorderPinned(layout, entries, pinnedIds);
    return { ok: true, classificationSource: "cloud-cache", entries, layout, pinnedIds,
      cachedAt: Number(snapshot.savedAt) || null };
  }

  let androidRuntimePromise = null;
  /// 안드로이드(모바il) 런타임인지 한 번만 조회한다. getPlatformInfo가 없는
  /// 환경(구버전 테스트 샌드박스 등)은 데스크톱으로 취급해 기존 경로를 유지한다.
  function isAndroidRuntime() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime
        || typeof chrome.runtime.getPlatformInfo !== "function") {
        return Promise.resolve(false);
      }
      if (!androidRuntimePromise) {
        androidRuntimePromise = new Promise((resolve) => {
          try {
            chrome.runtime.getPlatformInfo((info) => {
              resolve(String(info?.os ?? "").toLowerCase() === "android");
            });
          } catch {
            resolve(false);
          }
        });
      }
      return androidRuntimePromise;
    } catch {
      return Promise.resolve(false);
    }
  }

  async function activeClassifications(force) {
    const preferences = await loadPreferences();
    if (preferences.saveMode === "download") return localClassifications();

    // 모바일(원격 Collector) 전용 클라우드 경로. VPS는 PC가 매 폴 게시하는
    // 분류 스냅샷을 저장하고, 확장은 Collector 엔드포인트+토큰만으로 조회한다.
    // 목적은 PC 없이(전원이 꺼진 상태에서도) 모바일 donut을 그리는 것이므로
    // 데스크톱의 정상 경로는 바꾸지 않는다. PC의 로컬 라이브러리가 분류의
    // 원본이며 엔트리 스키마는 PC API와 동일해 ID 체계가 하나뿐이다.
    const collector = await loadCollectorSettings();
    if (collector.enabled && collector.baseUrl && await isAndroidRuntime()) {
      const cloud = await cloudClassifications(force);
      if (cloud.ok) return cloud;
      // VPS 불가 시에도 PC 엔드포인트·스냅샷·로컬 트리 폴백이 그대로 이어진다.
    }

    const { connectionToken } = await chrome.storage.local.get(["connectionToken"]);
    if (!TOKEN_PATTERN.test(connectionToken ?? "")) return localClassifications("connection_key_missing");
    const endpoint = await activeApiEndpoint();

    // The radial menu must not wait for a dead PC/Tailscale backend. If we have
    // a good persisted app snapshot for this exact endpoint, use it immediately
    // and refresh in the background. A snapshot from another PC/Remote URL must
    // never leak into the current connection.
    // 직전 실패가 잡혔으면(offline backoff) 네트워크 probe를 바로 던지지 않는다:
    // 8초 타임아웃을 채우지 않고 저장된 스냅샷/기기 폴백을 즉시 쓴다.
    const now = Date.now();
    const backingOff = inOfflineBackoff(endpoint, now);
    if (!force) {
      if (classificationCache && classificationCacheBaseUrl === endpoint.baseUrl
        && now - classificationCachedAt <= CACHE_MS) {
        return appClassifications(false);
      }
      const cached = backingOff
        ? await lastAppClassifications(lastConnectionFailure?.code ?? null, endpoint.baseUrl)
        : await lastAppClassifications(null, endpoint.baseUrl);
      if (cached) {
        if (!backingOff) void refreshAppClassificationsInBackground(endpoint);
        return cached;
      }
    }

    const response = await appClassifications(force, endpoint);
    if (response.ok) {
      recordConnectionSuccess(endpoint);
      return response;
    }
    recordConnectionFailure(endpoint, response.code || "app_offline");

    const cached = await lastAppClassifications(response.code, endpoint.baseUrl);
    if (cached) return cached;
    return localClassifications(response.code);
  }


  function inOfflineBackoff(endpoint, now = Date.now()) {
    return Boolean(
      lastConnectionFailure
      && lastConnectionFailure.baseUrl === endpoint.baseUrl
      && now - lastConnectionFailure.failedAt < OFFLINE_BACKOFF_MS,
    );
  }

  function recordConnectionFailure(endpoint, code, now = Date.now()) {
    lastConnectionFailure = { baseUrl: endpoint.baseUrl, code, failedAt: now };
  }

  function recordConnectionSuccess(endpoint) {
    if (lastConnectionFailure?.baseUrl === endpoint.baseUrl) lastConnectionFailure = null;
  }

  async function refreshAppClassificationsInBackground(endpoint = null) {
    const target = endpoint ?? await activeApiEndpoint();
    if (classificationRefreshPromise && classificationRefreshBaseUrl === target.baseUrl) {
      return classificationRefreshPromise;
    }
    const startedBaseUrl = target.baseUrl;
    const promise = appClassifications(true, target)
      .then((response) => {
        lastClassificationProbe = { response, checkedAt: Date.now(), baseUrl: startedBaseUrl };
        return response;
      })
      .catch(() => {
        const response = { ok: false, code: "app_offline" };
        lastClassificationProbe = { response, checkedAt: Date.now(), baseUrl: startedBaseUrl };
        return response;
      })
      .finally(() => {
        if (classificationRefreshPromise === promise) {
          classificationRefreshPromise = null;
          classificationRefreshBaseUrl = null;
        }
      });
    classificationRefreshPromise = promise;
    classificationRefreshBaseUrl = startedBaseUrl;
    return promise;
  }

  async function appClassifications(force, explicitEndpoint = null) {
    const now = Date.now();
    const endpoint = explicitEndpoint ?? await activeApiEndpoint();
    if (!force && classificationCache && classificationCacheBaseUrl === endpoint.baseUrl
      && now - classificationCachedAt <= CACHE_MS) {
      return { ok: true, classificationSource: endpoint.source, ...classificationCache };
    }
    const response = await apiRequest("/v1/classifications", {}, endpoint.baseUrl);
    if (!response.ok) {
      recordConnectionFailure(endpoint, response.code || "app_offline");
      return response;
    }
    recordConnectionSuccess(endpoint);
    const entries = Array.isArray(response.entries) ? response.entries : [];
    const stored = await chrome.storage.local.get([APP_LAYOUT_KEY, LAST_APP_CLASSIFICATIONS_KEY]);
    const radialLayout = stored[APP_LAYOUT_KEY];
    const snapshot = stored[LAST_APP_CLASSIFICATIONS_KEY];
    const previousEntries = snapshot?.version === 2 && snapshot.baseUrl === endpoint.baseUrl && Array.isArray(snapshot.entries)
      ? snapshot.entries
      : (classificationCacheBaseUrl === endpoint.baseUrl && Array.isArray(classificationCache?.entries) ? classificationCache.entries : []);
    const rawPinnedIds = await loadPinned(APP_PINNED_KEY);
    const repaired = repairPinnedIds(entries, rawPinnedIds, previousEntries);
    const remappedLayout = remapLayoutSlotIds(radialLayout, repaired.idRemap);
    let layout = globalThis.LakomicsRadial.reconcileLayout(entries, remappedLayout);
    layout = globalThis.LakomicsRadial.reorderPinned(layout, entries, repaired.pinnedIds);
    const statePatch = {};
    if (JSON.stringify(layout) !== JSON.stringify(radialLayout)) statePatch[APP_LAYOUT_KEY] = layout;
    if (JSON.stringify(repaired.pinnedIds) !== JSON.stringify(rawPinnedIds)) statePatch[APP_PINNED_KEY] = repaired.pinnedIds;
    if (Object.keys(statePatch).length) await chrome.storage.local.set(statePatch);
    classificationCache = { entries, layout, pinnedIds: repaired.pinnedIds };
    classificationCachedAt = now;
    classificationCacheBaseUrl = endpoint.baseUrl;
    await chrome.storage.local.set({
      [LAST_APP_CLASSIFICATIONS_KEY]: {
        version: 2, baseUrl: endpoint.baseUrl, endpointSource: endpoint.source,
        entries, layout, pinnedIds: repaired.pinnedIds, savedAt: now,
      },
    });
    return { ok: true, classificationSource: endpoint.source, ...classificationCache };
  }

  async function savedXMediaIndex() {
    const endpoint = await activeApiEndpoint();
    // 포커스마다 호출되므로 offline backoff 중에는 8초 타임아웃을 기다리지 않고
    // 저장된 스냅샷을 즉시 쓴다.
    if (inOfflineBackoff(endpoint)) {
      return cachedSavedIndex(endpoint, "backoff");
    }
    const response = await apiRequest("/v1/saved-x-media", {}, endpoint.baseUrl);
    if (response.ok) {
      recordConnectionSuccess(endpoint);
      const savedKeys = normalizeSavedXMediaKeys(response.keys);
      const snapshot = {
        version: 1,
        baseUrl: endpoint.baseUrl,
        endpointSource: endpoint.source,
        savedKeys,
        savedAt: Date.now(),
      };
      await chrome.storage.local.set({ [LAST_APP_SAVED_X_MEDIA_KEY]: snapshot });
      return { ok: true, authoritative: true, indexSource: endpoint.source, savedKeys };
    }
    recordConnectionFailure(endpoint, response.code || "app_offline");
    return cachedSavedIndex(endpoint, response.code || "app_offline");
  }

  async function cachedSavedIndex(endpoint, fallbackCode) {
    const stored = await chrome.storage.local.get([LAST_APP_SAVED_X_MEDIA_KEY]);
    const snapshot = stored[LAST_APP_SAVED_X_MEDIA_KEY];
    if (snapshot?.version === 1 && snapshot.baseUrl === endpoint.baseUrl && Array.isArray(snapshot.savedKeys)) {
      return {
        ok: true,
        authoritative: true,
        indexSource: "app-cache",
        savedKeys: normalizeSavedXMediaKeys(snapshot.savedKeys),
        cachedAt: Number(snapshot.savedAt) || null,
        fallbackCode,
      };
    }
    return { ok: false, code: fallbackCode };
  }

  function normalizeSavedXMediaKeys(keys) {
    return [...new Set((Array.isArray(keys) ? keys : [])
      .filter((key) => typeof key === "string" && /^\d+:\d+$/.test(key)))];
  }

  function savedXMediaKeyFromSourceUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) return "";
      const match = url.pathname.match(/^\/[^/]+\/status\/(\d+)\/photo\/(\d+)/);
      if (!match || Number(match[2]) <= 0) return "";
      return `${match[1]}:${Number(match[2])}`;
    } catch {
      return "";
    }
  }

  async function rememberSavedXMediaSource(sourceUrl) {
    const key = savedXMediaKeyFromSourceUrl(sourceUrl);
    if (!key) return;
    const endpoint = await activeApiEndpoint();
    const stored = await chrome.storage.local.get([LAST_APP_SAVED_X_MEDIA_KEY]);
    const snapshot = stored[LAST_APP_SAVED_X_MEDIA_KEY];
    if (!snapshot || snapshot.version !== 1 || snapshot.baseUrl !== endpoint.baseUrl) return;
    const savedKeys = normalizeSavedXMediaKeys([...(snapshot.savedKeys ?? []), key]);
    await chrome.storage.local.set({
      [LAST_APP_SAVED_X_MEDIA_KEY]: { ...snapshot, savedKeys, savedAt: Date.now() },
    });
  }

  function normalizePinnedIds(ids) {
    return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string" && id))];
  }

  function repairPinnedIds(entries, pinnedIds, previousEntries) {
    const normalized = normalizePinnedIds(pinnedIds);
    if (!Array.isArray(entries) || entries.length === 0) {
      return { pinnedIds: normalized, idRemap: new Map() };
    }
    const current = new Map(entries.filter((e) => e && typeof e.id === "string").map((e) => [e.id, e]));
    const previous = new Map((Array.isArray(previousEntries) ? previousEntries : []).filter((e) => e && typeof e.id === "string").map((e) => [e.id, e]));
    const byName = new Map();
    for (const entry of current.values()) {
      const key = normalizeEntryName(entry.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(entry);
    }
    const next = [];
    const idRemap = new Map();
    for (const id of normalized) {
      let resolved = current.has(id) ? id : null;
      if (!resolved) {
        const old = previous.get(id);
        const matches = old ? (byName.get(normalizeEntryName(old.name)) ?? []) : [];
        if (matches.length === 1) { resolved = matches[0].id; idRemap.set(id, resolved); }
      }
      if (resolved && !next.includes(resolved)) next.push(resolved);
    }
    return { pinnedIds: next, idRemap };
  }

  function normalizeEntryName(value) {
    return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  function remapLayoutSlotIds(layout, idRemap) {
    if (!validLayout(layout) || !(idRemap instanceof Map) || idRemap.size === 0) return layout;
    const next = JSON.parse(JSON.stringify(layout));
    for (const pages of Object.values(next.parents ?? {})) {
      if (!Array.isArray(pages)) continue;
      for (const page of pages) {
        if (!Array.isArray(page)) continue;
        for (let i = 0; i < page.length; i += 1) if (idRemap.has(page[i])) page[i] = idRemap.get(page[i]);
      }
    }
    return next;
  }

  async function lastAppClassifications(fallbackCode = null, expectedBaseUrl = null) {
    const stored = await chrome.storage.local.get([LAST_APP_CLASSIFICATIONS_KEY, APP_LAYOUT_KEY, APP_PINNED_KEY]);
    let snapshot = stored[LAST_APP_CLASSIFICATIONS_KEY];
    if (snapshot?.version === 1 && expectedBaseUrl && Array.isArray(snapshot.entries)
      && validLayout(snapshot.layout) && Array.isArray(snapshot.pinnedIds)) {
      snapshot = { ...snapshot, version: 2, baseUrl: expectedBaseUrl,
        endpointSource: expectedBaseUrl === LOCAL_API_BASE_URL ? "app" : "remote" };
      await chrome.storage.local.set({ [LAST_APP_CLASSIFICATIONS_KEY]: snapshot });
    }
    if (!snapshot || snapshot.version !== 2 || typeof snapshot.baseUrl !== "string"
      || !Array.isArray(snapshot.entries) || !validLayout(snapshot.layout)) return null;
    if (expectedBaseUrl && snapshot.baseUrl !== expectedBaseUrl) return null;
    const entries = snapshot.entries.filter((entry) => entry && typeof entry.id === "string");
    if (!entries.length) return null;
    const pinnedIds = normalizePinnedIds(Array.isArray(stored[APP_PINNED_KEY]) ? stored[APP_PINNED_KEY] : snapshot.pinnedIds);
    const sourceLayout = validLayout(stored[APP_LAYOUT_KEY]) ? stored[APP_LAYOUT_KEY] : snapshot.layout;
    let layout = globalThis.LakomicsRadial.reconcileLayout(entries, sourceLayout);
    layout = globalThis.LakomicsRadial.reorderPinned(layout, entries, pinnedIds);
    return { ok: true, classificationSource: "app-cache", entries, layout, pinnedIds,
      cachedAt: Number(snapshot.savedAt) || null, ...(fallbackCode ? { fallbackCode } : {}) };
  }

  async function updateLastAppSnapshot(patch) {
    const endpoint = await activeApiEndpoint();
    const stored = await chrome.storage.local.get([LAST_APP_CLASSIFICATIONS_KEY]);
    const snapshot = stored[LAST_APP_CLASSIFICATIONS_KEY];
    if (!snapshot || snapshot.version !== 2 || snapshot.baseUrl !== endpoint.baseUrl
      || !Array.isArray(snapshot.entries)) return;
    const next = { ...snapshot, ...patch, savedAt: Date.now() };
    if (!validLayout(next.layout) || !Array.isArray(next.pinnedIds)) return;
    await chrome.storage.local.set({ [LAST_APP_CLASSIFICATIONS_KEY]: next });
  }


  async function localClassifications(fallbackCode = null) {
    const tree = await loadLocalTree();
    const entries = globalThis.LakomicsDefaults.localTreeEntries(tree);
    const layout = globalThis.LakomicsDefaults.localTreeLayout(tree);
    return {
      ok: true,
      classificationSource: "local",
      entries,
      layout,
      pinnedIds: [],
      ...(fallbackCode ? { fallbackCode } : {}),
    };
  }

  async function loadLocalTree() {
    const stored = await chrome.storage.local.get([LOCAL_TREE_KEY]);
    const tree = globalThis.LakomicsDefaults.normalizeLocalTree(stored[LOCAL_TREE_KEY]);
    if (JSON.stringify(tree) !== JSON.stringify(stored[LOCAL_TREE_KEY])) {
      await chrome.storage.local.set({ [LOCAL_TREE_KEY]: tree });
    }
    return tree;
  }

  function localTreeFromApp(entries, layout, pinnedIds) {
    const tree = globalThis.LakomicsDefaults.defaultLocalTree();
    const firstLevel = globalThis.LakomicsRadial.getPinnedLevel(entries, layout, pinnedIds, 0);
    tree.roots.forEach((root, index) => {
      const sourceRoot = firstLevel.slots[index];
      if (!sourceRoot) return;
      root.name = sourceRoot.name || root.name;
      const childLevel = globalThis.LakomicsRadial.getLevel(entries, layout, sourceRoot.id, 0);
      root.secondarySlots = Array.from(
        { length: globalThis.LakomicsDefaults.SECONDARY_SLOT_COUNT },
        (_, slot) => childLevel.slots[slot]?.name ?? null,
      );
    });
    return globalThis.LakomicsDefaults.normalizeLocalTree(tree);
  }

  async function saveMedia(payload) {
    const preferences = await loadPreferences();
    const prepared = await prepareMediaPayload(payload);
    if (!prepared.ok) return prepared;
    const mediaPayload = prepared.payload;
    const classificationSource = mediaPayload.classificationSource === "local" ? "local" : "app";

    if (preferences.saveMode === "download") {
      return browserDownload(mediaPayload, preferences);
    }

    // Collector is transport-independent from the classification source. A local
    // fallback tree must not silently force browser download while Collector is enabled.
    if (collectorSupportsMedia(mediaPayload)) {
      const collector = await loadCollectorSettings();
      if (collector.enabled) {
        const captured = await captureWithCollector(mediaPayload, collector);
        if (captured.ok) {
          await rememberSavedXMediaSource(mediaPayload.sourceUrl);
          return captured;
        }
        if (["collector_timeout", "collector_offline"].includes(captured.code)) {
          const confirmed = await confirmCollectorCapture(mediaPayload, collector);
          if (confirmed.ok) {
            await rememberSavedXMediaSource(mediaPayload.sourceUrl);
            return confirmed;
          }
        }
        return browserDownload(mediaPayload, preferences, captured.code || "collector_failed");
      }
    }

    if (classificationSource === "local") {
      return browserDownload(mediaPayload, preferences);
    }

    // Never let an earlier classifications probe decide where the media is saved.
    // Proton/Tailscale can briefly recover between the menu opening and the actual
    // save, so always make a real ingestion attempt first.
    const ingestionRequest = () => ({
      method: "POST",
      body: JSON.stringify(stripExtensionFields(mediaPayload)),
      timeoutMs: INGESTION_TIMEOUT_MS,
    });
    let appResponse = await apiRequest("/v1/ingestions", ingestionRequest());
    if (appResponse.ok || !shouldFallbackToBrowserDownload(appResponse)) {
      const normalized = normalizeAppMediaResponse(appResponse, mediaPayload);
      if (normalized.ok && normalized.status !== "review_pending") {
        await rememberSavedXMediaSource(mediaPayload.sourceUrl);
      }
      return normalized;
    }

    const firstFallbackCode = appResponse.code || "app_offline";
    // 터널 복구는 수 초가 걸린다. 1회 700ms 재시도는 지나가는 순간을 못 잡으므로
    // 넉넉한 간격으로 총 3회까지 시도한 뒤 기기 폴백으로 넘어간다.
    await retryDelay(INGESTION_RETRY_DELAY_MS);
    appResponse = await apiRequest("/v1/ingestions", ingestionRequest());
    if (appResponse.ok || !shouldFallbackToBrowserDownload(appResponse)) {
      const normalized = normalizeAppMediaResponse(appResponse, mediaPayload);
      if (normalized.ok && normalized.status !== "review_pending") {
        await rememberSavedXMediaSource(mediaPayload.sourceUrl);
      }
      return normalized;
    }
    await retryDelay(INGESTION_RETRY_DELAY_MS * 3);
    appResponse = await apiRequest("/v1/ingestions", ingestionRequest());
    if (appResponse.ok || !shouldFallbackToBrowserDownload(appResponse)) {
      const normalized = normalizeAppMediaResponse(appResponse, mediaPayload);
      if (normalized.ok && normalized.status !== "review_pending") {
        await rememberSavedXMediaSource(mediaPayload.sourceUrl);
      }
      return normalized;
    }
    return browserDownload(mediaPayload, preferences, firstFallbackCode);
  }

  function shouldFallbackToBrowserDownload(response) {
    if (!response || response.ok) return false;
    // A dead local server is a network error. Tailscale Serve, however, can keep
    // answering while its local backend is down and surface that as an HTTP
    // gateway/server error. In automatic mode both mean the same thing to the
    // collector: Lakomics cannot accept the item right now, so save it locally.
    if (response.code === "app_offline" || response.code === "request_failed") return true;
    const status = Number(response.httpStatus);
    return Number.isFinite(status) && status >= 500 && status <= 599;
  }

  async function retryDelay(milliseconds) {
    if (!(milliseconds > 0) || typeof setTimeout !== "function") return;
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function normalizeAppMediaResponse(response, payload) {
    if (!response?.ok && response?.code === "invalid_media_url"
      && (payload?.mediaType === "video" || payload?.mediaType === "animated_gif")) {
      return { ...response, code: "pc_video_api_unsupported" };
    }
    return response;
  }

  async function prepareMediaPayload(payload) {
    const mediaType = payload.mediaType === "video" || payload.mediaType === "animated_gif"
      ? payload.mediaType
      : "image";
    if (mediaType === "image") return { ok: true, payload: { ...payload, mediaType } };
    if (typeof payload.mediaUrl === "string" && payload.mediaUrl.startsWith("https://video.twimg.com/")) {
      return { ok: true, payload: { ...payload, mediaType } };
    }
    return resolveXVideoPayload({ ...payload, mediaType });
  }

  async function resolveXVideoPayload(payload) {
    const source = parseSourceUrl(payload.sourceUrl);
    const postId = String(payload.postId ?? source.postId ?? "");
    if (!/^\d+$/.test(postId)) return { ok: false, code: "video_unavailable" };

    let response;
    try {
      const token = computeSyndicationToken(postId);
      const url = `${X_SYNDICATION_ENDPOINT}?id=${encodeURIComponent(postId)}&token=${encodeURIComponent(token)}`;
      response = await fetch(url, { method: "GET" });
    } catch {
      return { ok: false, code: "video_info_failed" };
    }
    if (!response?.ok) {
      return { ok: false, code: response?.status === 404 || response?.status === 403 ? "video_unavailable" : "video_info_failed" };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: false, code: "video_info_failed" };
    }
    if (!data || data.__typename === "TweetTombstone") return { ok: false, code: "video_unavailable" };

    const videos = extractSyndicationVideos(data);
    if (!videos.length) return { ok: false, code: "video_unavailable" };
    const requestedIndex = Number(payload.mediaIndex);
    const videoIndex = Number.isInteger(requestedIndex) && requestedIndex > 0 ? requestedIndex - 1 : 0;
    const selected = videos[videoIndex] ?? videos[0];
    if (!selected?.url) return { ok: false, code: "video_unavailable" };

    return {
      ok: true,
      payload: {
        ...payload,
        mediaType: selected.kind,
        mediaUrl: selected.url,
        mediaIndex: videoIndex + 1,
        videoMetadata: {
          bitrate: selected.bitrate,
          width: selected.width,
          height: selected.height,
          durationMs: selected.durationMs,
        },
      },
    };
  }

  function computeSyndicationToken(postId) {
    const numeric = Number(postId) / 1e15;
    return (numeric * Math.PI).toString(36).replace(/(0+|\.)/g, "") || "a";
  }

  function extractSyndicationVideos(data) {
    const results = [];
    const mediaList = Array.isArray(data?.mediaDetails)
      ? data.mediaDetails
      : Array.isArray(data?.entities?.media) ? data.entities.media : [];
    for (const media of mediaList) {
      const entry = bestMp4Variant(media?.video_info?.variants);
      if (!entry) continue;
      const original = media?.original_info ?? {};
      results.push({
        ...entry,
        kind: media?.type === "animated_gif" ? "animated_gif" : "video",
        width: positiveNumber(original.width) ?? dimensionFromVideoUrl(entry.url)?.width ?? null,
        height: positiveNumber(original.height) ?? dimensionFromVideoUrl(entry.url)?.height ?? null,
        durationMs: positiveNumber(media?.video_info?.duration_millis),
      });
    }
    if (!results.length && Array.isArray(data?.video?.variants)) {
      const entry = bestMp4Variant(data.video.variants);
      if (entry) {
        const dimensions = dimensionFromVideoUrl(entry.url);
        results.push({
          ...entry,
          kind: "video",
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          durationMs: null,
        });
      }
    }
    return results;
  }

  function bestMp4Variant(variants) {
    if (!Array.isArray(variants)) return null;
    const candidates = variants
      .filter((variant) => variant?.content_type === "video/mp4" && typeof variant.url === "string" && variant.url.startsWith("https://"))
      .map((variant) => ({ url: variant.url, bitrate: positiveNumber(variant.bitrate) ?? 0 }))
      .sort((a, b) => b.bitrate - a.bitrate);
    return candidates[0] ?? null;
  }

  function dimensionFromVideoUrl(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/\/(\d+)x(\d+)\//);
      if (!match) return null;
      return { width: Number(match[1]), height: Number(match[2]) };
    } catch {
      return null;
    }
  }

  function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function normalizeDownloadMatchUrl(value) {
    const raw = String(value ?? "");
    if (!raw) return "";
    try {
      const url = new URL(raw);
      url.hash = "";
      return url.href;
    } catch {
      return raw;
    }
  }

  function pruneFilenameSuggestions(now = Date.now()) {
    for (let index = pendingFilenameSuggestions.length - 1; index >= 0; index -= 1) {
      if (now - pendingFilenameSuggestions[index].createdAt > FILENAME_SUGGESTION_TTL_MS) {
        pendingFilenameSuggestions.splice(index, 1);
      }
    }
  }

  function queueFilenameSuggestion(url, filename, conflictAction = "uniquify") {
    pruneFilenameSuggestions();
    const record = {
      url: normalizeDownloadMatchUrl(url),
      filename: String(filename ?? ""),
      conflictAction,
      createdAt: Date.now(),
    };
    pendingFilenameSuggestions.push(record);
    return record;
  }

  function removeFilenameSuggestion(record) {
    const index = pendingFilenameSuggestions.indexOf(record);
    if (index >= 0) pendingFilenameSuggestions.splice(index, 1);
  }

  function takeFilenameSuggestion(downloadItem) {
    pruneFilenameSuggestions();
    const urls = new Set([
      normalizeDownloadMatchUrl(downloadItem?.url),
      normalizeDownloadMatchUrl(downloadItem?.finalUrl),
    ].filter(Boolean));
    const index = pendingFilenameSuggestions.findIndex((record) => urls.has(record.url));
    if (index < 0) return null;
    return pendingFilenameSuggestions.splice(index, 1)[0];
  }

  function installDownloadFilenameSuggestionListener() {
    const event = chrome.downloads?.onDeterminingFilename;
    if (!event?.addListener) return false;
    event.addListener((downloadItem, suggest) => {
      const record = takeFilenameSuggestion(downloadItem);
      if (!record) return;
      try {
        suggest({
          filename: record.filename,
          conflictAction: record.conflictAction,
        });
      } catch (error) {
        console.warn("[Lakomics] filename suggestion failed", error);
        try { suggest(); } catch {}
      }
    });
    return true;
  }

  async function downloadWithPreferredFilename({ url, filename, conflictAction = "uniquify", saveAs = false }) {
    const record = queueFilenameSuggestion(url, filename, conflictAction);
    try {
      return await chrome.downloads.download({ url, filename, conflictAction, saveAs });
    } catch (error) {
      removeFilenameSuggestion(record);
      throw error;
    }
  }

  function browserDownload(payload, preferences, fallbackCode = null) {
    const job = browserDownloadQueue
      .catch(() => undefined)
      .then(() => browserDownloadUnlocked(payload, preferences, fallbackCode));
    browserDownloadQueue = job.then(() => undefined, () => undefined);
    return job;
  }

  async function browserDownloadUnlocked(payload, preferences, fallbackCode = null) {
    if (typeof payload.mediaUrl !== "string" || !payload.mediaUrl.startsWith("https://")) {
      return { ok: false, code: "invalid_media_url" };
    }
    if (!chrome.downloads?.download) {
      return {
        ok: false,
        code: "downloads_api_unavailable",
        mediaUrl: payload.mediaUrl,
        filename: buildDownloadFilename(payload, preferences),
      };
    }

    const requestedFilename = buildDownloadFilename(payload, preferences);
    const requestedMetadataFilename = replaceExtension(requestedFilename, "json");
    const recentKey = recentSaveKey(payload);
    const recent = await loadRecentSave(recentKey);

    if (recent?.imageDownloaded && recent?.metadataDownloaded) {
      return {
        ok: true,
        status: "duplicate_recent",
        filename: recent.filename ?? requestedFilename,
        metadataFilename: recent.metadataFilename ?? requestedMetadataFilename,
        ...(fallbackCode ? { fallbackCode } : {}),
      };
    }

    if (
      recent?.imageDownloaded
      && !recent?.metadataDownloaded
      && recent.filename
      && recent.metadataFilename
    ) {
      try {
        const metadataDownloadId = await downloadWithPreferredFilename({
          url: jsonDataUrl(buildSidecarMetadata(payload, recent.filename)),
          filename: recent.metadataFilename,
          conflictAction: recent.filenameResolved ? "overwrite" : "uniquify",
          saveAs: false,
        });
        await markRecentSave(recentKey, {
          ...recent,
          metadataDownloaded: true,
          metadataDownloadId,
        });
        return {
          ok: true,
          status: "metadata_repaired",
          downloadId: recent.downloadId ?? null,
          metadataDownloadId,
          filename: recent.filename,
          metadataFilename: recent.metadataFilename,
          ...(fallbackCode ? { fallbackCode } : {}),
        };
      } catch (error) {
        return {
          ok: false,
          code: "metadata_download_failed",
          imageDownloaded: true,
          downloadId: recent.downloadId ?? null,
          filename: recent.filename,
          metadataFilename: recent.metadataFilename,
          ...(typeof error?.message === "string" ? { message: error.message } : {}),
          ...(fallbackCode ? { fallbackCode } : {}),
        };
      }
    }

    try {
      const downloadId = await downloadWithPreferredFilename({
        url: payload.mediaUrl,
        filename: requestedFilename,
        conflictAction: "uniquify",
        saveAs: false,
      });

      const resolved = await resolveDownloadedFilename(downloadId, requestedFilename);
      const filename = resolved.filename;
      const metadataFilename = replaceExtension(filename, "json");
      const metadata = buildSidecarMetadata(payload, filename);

      await markRecentSave(recentKey, {
        imageDownloaded: true,
        metadataDownloaded: false,
        downloadId,
        filename,
        metadataFilename,
        filenameResolved: resolved.resolved,
        folderPreserved: resolved.folderPreserved,
      });

      let metadataDownloadId = null;
      try {
        metadataDownloadId = await downloadWithPreferredFilename({
          url: jsonDataUrl(metadata),
          filename: metadataFilename,
          conflictAction: resolved.resolved ? "overwrite" : "uniquify",
          saveAs: false,
        });
      } catch (error) {
        return {
          ok: false,
          code: "metadata_download_failed",
          imageDownloaded: true,
          downloadId,
          filename,
          metadataFilename,
          ...(typeof error?.message === "string" ? { message: error.message } : {}),
          ...(fallbackCode ? { fallbackCode } : {}),
        };
      }

      await markRecentSave(recentKey, {
        imageDownloaded: true,
        metadataDownloaded: true,
        downloadId,
        metadataDownloadId,
        filename,
        metadataFilename,
        filenameResolved: resolved.resolved,
        folderPreserved: resolved.folderPreserved,
      });

      return {
        ok: true,
        status: "downloaded",
        downloadId,
        metadataDownloadId,
        filename,
        metadataFilename,
        folderPreserved: resolved.folderPreserved,
        ...(fallbackCode ? { fallbackCode } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        code: "download_failed",
        filename: requestedFilename,
        ...(typeof error?.message === "string" ? { message: error.message } : {}),
        ...(fallbackCode ? { fallbackCode } : {}),
      };
    }
  }

  async function resolveDownloadedFilename(downloadId, requestedFilename) {
    if (!chrome.downloads?.search) {
      return {
        filename: requestedFilename,
        resolved: false,
        folderPreserved: null,
      };
    }
    try {
      const items = await chrome.downloads.search({ id: downloadId });
      const actual = Array.isArray(items) ? items[0]?.filename : null;
      if (typeof actual !== "string" || !actual) {
        return { filename: requestedFilename, resolved: false, folderPreserved: null };
      }

      const actualNormalized = actual.replace(/\\/g, "/");
      const requestedNormalized = String(requestedFilename ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
      const basename = actualNormalized.split("/").filter(Boolean).at(-1);
      if (!basename) return { filename: requestedFilename, resolved: false, folderPreserved: null };

      const requestedSlash = requestedNormalized.lastIndexOf("/");
      const requestedFolder = requestedSlash >= 0 ? requestedNormalized.slice(0, requestedSlash) : "";
      const actualSlash = actualNormalized.lastIndexOf("/");
      const actualFolder = actualSlash >= 0 ? actualNormalized.slice(0, actualSlash) : "";
      const actualFolderLower = actualFolder.toLocaleLowerCase("en-US");
      const requestedFolderLower = requestedFolder.toLocaleLowerCase("en-US");
      const folderPreserved = !requestedFolder
        || actualFolderLower === requestedFolderLower
        || actualFolderLower.endsWith(`/${requestedFolderLower}`);

      const filename = folderPreserved && requestedFolder
        ? `${requestedFolder}/${basename}`
        : basename;

      if (!folderPreserved) {
        console.warn("[Lakomics] browser flattened the requested download folder", {
          requested: requestedFilename,
          actualBasename: basename,
        });
      }

      return {
        filename,
        resolved: true,
        folderPreserved,
      };
    } catch {
      return { filename: requestedFilename, resolved: false, folderPreserved: null };
    }
  }

  async function applyDownloadUiPreference(suppress) {
    if (!chrome.downloads?.setUiOptions) return { ok: false, code: "downloads_ui_api_unavailable" };
    try {
      await chrome.downloads.setUiOptions({ enabled: !suppress });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: "downloads_ui_control_failed",
        ...(typeof error?.message === "string" ? { message: error.message } : {}),
      };
    }
  }

  async function syncDownloadUiPreference() {
    try {
      const preferences = await loadPreferences();
      await applyDownloadUiPreference(preferences.suppressDownloadUi);
    } catch {}
  }

  function recentSaveKey(payload) {
    return `${payload.classificationId ?? ""}\u0000${payload.mediaUrl ?? ""}`;
  }

  async function loadRecentSave(key) {
    const stored = await chrome.storage.local.get([RECENT_BROWSER_SAVES_KEY]);
    const source = stored[RECENT_BROWSER_SAVES_KEY];
    const recent = source && typeof source === "object" && !Array.isArray(source) ? { ...source } : {};
    const now = Date.now();
    let changed = false;
    for (const [entryKey, entry] of Object.entries(recent)) {
      if (!entry || typeof entry.savedAt !== "number" || now - entry.savedAt > RECENT_DUPLICATE_MS) {
        delete recent[entryKey];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ [RECENT_BROWSER_SAVES_KEY]: recent });
    return recent[key] ?? null;
  }

  async function markRecentSave(key, value) {
    const stored = await chrome.storage.local.get([RECENT_BROWSER_SAVES_KEY]);
    const source = stored[RECENT_BROWSER_SAVES_KEY];
    const recent = source && typeof source === "object" && !Array.isArray(source) ? { ...source } : {};
    const now = Date.now();
    for (const [entryKey, entry] of Object.entries(recent)) {
      if (!entry || typeof entry.savedAt !== "number" || now - entry.savedAt > RECENT_DUPLICATE_MS) {
        delete recent[entryKey];
      }
    }
    recent[key] = { ...value, savedAt: now };
    await chrome.storage.local.set({ [RECENT_BROWSER_SAVES_KEY]: recent });
  }

  function buildDownloadFilename(payload, preferences) {
    const root = sanitizePath(preferences.downloadFolder || "Lakomics");
    const rawPath = Array.isArray(payload.classificationPath) && payload.classificationPath.length
      ? payload.classificationPath
      : [payload.classificationName || "기타"];
    const classificationPath = rawPath
      .filter((value) => typeof value === "string" && value.trim())
      .map(sanitizeSegment)
      .filter(Boolean);
    const folders = classificationPath.length ? classificationPath : ["기타"];
    const source = parseSourceUrl(payload.sourceUrl);
    const media = parseMediaUrl(payload.mediaUrl);
    const parts = [source.author, source.postId, source.mediaIndex, media.token]
      .filter(Boolean)
      .map(sanitizeSegment);
    const base = parts.join("_") || `lakomics_${Date.now()}`;
    return `${root}/${folders.join("/")}/${base}.${media.extension}`;
  }

  function replaceExtension(filename, extension) {
    return String(filename).replace(/\.[^/.]+$/, `.${extension}`);
  }

  function buildSidecarMetadata(payload, filename) {
    const source = parseSourceUrl(payload.sourceUrl);
    const video = payload.videoMetadata && typeof payload.videoMetadata === "object" ? payload.videoMetadata : null;
    return {
      schemaVersion: 1,
      source: typeof payload.source === "string" ? payload.source : "x",
      sourceUrl: payload.sourceUrl ?? null,
      mediaUrl: payload.mediaUrl ?? null,
      mediaType: payload.mediaType ?? "image",
      classificationId: payload.classificationId ?? null,
      classificationName: payload.classificationName ?? "기타",
      classificationPath: Array.isArray(payload.classificationPath)
        ? payload.classificationPath.filter((value) => typeof value === "string" && value)
        : [payload.classificationName ?? "기타"],
      author: payload.author ?? source.author,
      postId: payload.postId ?? source.postId,
      mediaIndex: payload.mediaIndex ?? (source.mediaIndex === null ? null : Number(source.mediaIndex)),
      publishedAt: payload.publishedAt ?? null,
      ...(video ? { video: {
        bitrate: video.bitrate ?? null,
        width: video.width ?? null,
        height: video.height ?? null,
        durationMs: video.durationMs ?? null,
      } } : {}),
      filename,
      savedAt: new Date().toISOString(),
    };
  }

  function jsonDataUrl(value) {
    const json = JSON.stringify(value, null, 2);
    return `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  }

  function parseSourceUrl(value) {
    try {
      const url = new URL(value);
      const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)(?:\/(?:photo|video)\/(\d+))?/);
      return match
        ? { author: match[1], postId: match[2], mediaIndex: match[3] ?? null }
        : { author: null, postId: null, mediaIndex: null };
    } catch {
      return { author: null, postId: null, mediaIndex: null };
    }
  }

  function parseMediaUrl(value) {
    try {
      const url = new URL(value);
      const token = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.[^.]+$/, "") || "media";
      let extension = (url.searchParams.get("format") || url.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "jpg").toLowerCase();
      if (extension === "jpeg" || extension === "jpe") extension = "jpg";
      if (!/^[a-z0-9]{2,5}$/.test(extension)) extension = "jpg";
      return { token, extension };
    } catch {
      return { token: "media", extension: "jpg" };
    }
  }

  function isUnsupportedAbsoluteDownloadFolder(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return false;
    return /^(?:[a-zA-Z]:[\\/]|[\\/]|file:|content:)/i.test(raw)
      || /^(?:storage\/emulated\/0|sdcard)(?:\/|$)/i.test(raw.replace(/\\/g, "/"));
  }

  function sanitizePath(value) {
    const parts = String(value).split(/[\\/]+/).map(sanitizeSegment).filter(Boolean);
    return parts.length ? parts.join("/") : "Lakomics";
  }

  function sanitizeSegment(value) {
    return String(value)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 80) || "기타";
  }

  function stripExtensionFields(payload) {
    const {
      classificationName: _classificationName,
      classificationPath: _classificationPath,
      classificationSource: _classificationSource,
      mediaType: _mediaType,
      author: _author,
      postId: _postId,
      mediaIndex: _mediaIndex,
      videoMetadata: _videoMetadata,
      ...rest
    } = payload;
    return rest;
  }

  async function loadPreferences() {
    const { preferences } = await chrome.storage.local.get(["preferences"]);
    return globalThis.LakomicsDefaults.normalizePreferences(preferences);
  }

  async function loadPinned(key) {
    const stored = await chrome.storage.local.get([key]);
    const value = stored[key];
    return Array.isArray(value) ? value : [];
  }

  function validLayout(layout) {
    if (!layout || layout.version !== 1 || !layout.parents || typeof layout.parents !== "object") {
      return false;
    }
    return Object.values(layout.parents).every((pages) =>
      Array.isArray(pages) && pages.every((page) =>
        Array.isArray(page) && page.every((id) => id === null || typeof id === "string")));
  }

  function resetClassificationCache() {
    classificationCache = null;
    classificationCachedAt = 0;
    classificationCacheBaseUrl = null;
    classificationRefreshPromise = null;
    classificationRefreshBaseUrl = null;
    lastClassificationProbe = null;
    lastConnectionFailure = null;
  }

  function normalizeCollectorToken(value) {
    const token = typeof value === "string" ? value.trim() : "";
    if (!token || token.length > 1024 || /[\r\n]/.test(token)) return "";
    return token;
  }

  async function loadCollectorSettings() {
    const stored = await chrome.storage.local.get([COLLECTOR_SETTINGS_KEY]);
    return globalThis.LakomicsDefaults.normalizeCollectorSettings(stored[COLLECTOR_SETTINGS_KEY]);
  }

  async function testCollectorConnection() {
    const collector = await loadCollectorSettings();
    if (!collector.enabled || !collector.baseUrl) return { ok: false, code: "collector_not_configured" };
    const response = await collectorRequest("/v1/captures?limit=1", {}, collector.baseUrl);
    if (!response.ok) return response;
    return { ok: true, baseUrl: collector.baseUrl, status: "ready" };
  }

  /// Collector 폴백 시 마지막 실패 진단을 보존한다. 토큰·URL·원본 payload는 기록하지 않는다.
  async function recordCollectorFallback(code, mediaType, response = null) {
    const entry = {
      code,
      mediaType: mediaType ?? "image",
      at: new Date().toISOString(),
      ...(Number.isFinite(response?.httpStatus) ? { httpStatus: response.httpStatus } : {}),
      ...(typeof response?.message === "string" ? { message: response.message } : {}),
    };
    try {
      const stored = await chrome.storage.local.get([COLLECTOR_FALLBACK_DIAGNOSTICS_KEY]);
      const entries = Array.isArray(stored[COLLECTOR_FALLBACK_DIAGNOSTICS_KEY])
        ? stored[COLLECTOR_FALLBACK_DIAGNOSTICS_KEY]
        : [];
      entries.unshift(entry);
      await chrome.storage.local.set({
        [COLLECTOR_FALLBACK_DIAGNOSTICS_KEY]: entries.slice(0, COLLECTOR_FALLBACK_DIAGNOSTICS_LIMIT),
      });
    } catch {}
  }

  function collectorSupportsMedia(payload) {
    return COLLECTOR_SUPPORTED_MEDIA_TYPES.has(payload?.mediaType ?? "image");
  }

  async function captureWithCollector(payload, explicitCollector = null) {
    const collector = explicitCollector ?? await loadCollectorSettings();
    if (!collector.enabled || !collector.baseUrl) {
      await recordCollectorFallback("collector_not_configured", payload.mediaType);
      return { ok: false, code: "collector_not_configured" };
    }
    if (!collectorSupportsMedia(payload)) {
      await recordCollectorFallback("collector_media_unsupported", payload.mediaType);
      return { ok: false, code: "collector_media_unsupported" };
    }
    const response = await collectorRequest(
      "/v1/captures",
      {
        method: "POST",
        timeoutMs: payload.mediaType === "image"
          ? COLLECTOR_IMAGE_REQUEST_TIMEOUT_MS
          : COLLECTOR_VIDEO_REQUEST_TIMEOUT_MS,
        body: JSON.stringify({
          source_url: payload.sourceUrl,
          media_url: payload.mediaUrl,
          classification_id: payload.classificationId,
          published_at: payload.publishedAt ?? null,
          media_type: payload.mediaType === "image" ? "image" : "video",
        }),
      },
      collector.baseUrl,
    );
    if (!response.ok) {
      await recordCollectorFallback(response.code || "collector_request_failed", payload.mediaType, response);
      return response;
    }
    if (typeof response.capture?.id !== "string" || !response.capture.id
      || !["pending", "imported"].includes(response.capture.status)) {
      await recordCollectorFallback("collector_request_failed", payload.mediaType, response);
      return { ok: false, code: "collector_request_failed" };
    }
    return {
      ok: true,
      status: response.created === false ? "capture_duplicate" : "captured",
      captureId: response.capture?.id ?? null,
      captureStatus: response.capture?.status ?? "pending",
    };
  }

  async function confirmCollectorCapture(payload, collector) {
    const query = [
      ["source_url", payload.sourceUrl],
      ["media_url", payload.mediaUrl],
      ["classification_id", payload.classificationId],
    ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
    const response = await collectorRequest(
      `/v1/captures?${query}&limit=1`,
      {},
      collector.baseUrl,
    );
    if (!response.ok || !Array.isArray(response.items)) {
      return { ok: false, code: response.code || "collector_request_failed" };
    }
    const capture = response.items.find((item) => item?.source_url === payload.sourceUrl
      && item?.media_url === payload.mediaUrl
      && item?.classification_id === payload.classificationId);
    if (typeof capture?.id !== "string" || !capture.id) {
      return { ok: false, code: "collector_request_failed" };
    }
    return {
      ok: true,
      status: "capture_duplicate",
      captureId: capture.id,
      captureStatus: capture.status ?? "pending",
    };
  }

  async function collectorRequest(path, init = {}, explicitBaseUrl = null) {
    const stored = await chrome.storage.local.get([COLLECTOR_TOKEN_KEY]);
    const token = normalizeCollectorToken(stored[COLLECTOR_TOKEN_KEY]);
    if (!token) return { ok: false, code: "collector_token_missing" };
    const collector = explicitBaseUrl ? null : await loadCollectorSettings();
    const baseUrl = explicitBaseUrl ?? collector?.baseUrl;
    if (!baseUrl) return { ok: false, code: "collector_not_configured" };
    const headers = { Authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const timeoutMs = Number.isFinite(init.timeoutMs) ? init.timeoutMs : API_REQUEST_TIMEOUT_MS;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller && typeof setTimeout === "function"
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      let body = {};
      try {
        body = await response.json();
      } catch {}
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403
          ? "collector_unauthorized"
          : "collector_request_failed";
        return {
          ok: false,
          code,
          httpStatus: Number(response.status) || null,
          ...(typeof body.detail === "string" ? { message: body.detail } : {}),
        };
      }
      return { ok: true, ...body };
    } catch (error) {
      return { ok: false, code: error?.name === "AbortError" ? "collector_timeout" : "collector_offline" };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function loadRemoteSettings() {
    const stored = await chrome.storage.local.get([REMOTE_SETTINGS_KEY]);
    return globalThis.LakomicsDefaults.normalizeRemoteSettings(stored[REMOTE_SETTINGS_KEY]);
  }

  async function activeApiEndpoint() {
    const remote = await loadRemoteSettings();
    if (remote.enabled && remote.baseUrl) {
      return { baseUrl: remote.baseUrl, source: "remote" };
    }
    return { baseUrl: LOCAL_API_BASE_URL, source: "app" };
  }

  async function testRemoteConnection() {
    const remote = await loadRemoteSettings();
    if (!remote.enabled || !remote.baseUrl) return { ok: false, code: "remote_not_configured" };
    const health = await apiRequest("/v1/health", {}, remote.baseUrl);
    if (health.ok) {
      return {
        ok: true,
        baseUrl: remote.baseUrl,
        health: {
          status: health.status ?? "ready",
          apiVersion: health.apiVersion ?? null,
          capabilities: Array.isArray(health.capabilities) ? health.capabilities : [],
        },
      };
    }
    // alpha.10-era Lakomics has no /v1/health. A successful authenticated
    // classifications response still proves the Tailscale tunnel is usable.
    if (health.code === "not_found") {
      const legacy = await apiRequest("/v1/classifications", {}, remote.baseUrl);
      if (legacy.ok) {
        return {
          ok: true,
          baseUrl: remote.baseUrl,
          legacyHealth: true,
          health: { status: "ready", apiVersion: 1, capabilities: ["classifications", "ingestion"] },
        };
      }
      return legacy;
    }
    return health;
  }

  const X_TRANSLATE_ALLOWED_HOSTS = new Set([
    "ollama.com",
    "generativelanguage.googleapis.com",
    "ai-gateway.vercel.sh",
    "openrouter.ai",
  ]);

  function isAllowedTranslateUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:" && X_TRANSLATE_ALLOWED_HOSTS.has(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  async function translateHttpRequest(request = {}) {
    const url = String(request.url || "");
    if (!isAllowedTranslateUrl(url)) return { ok: false, code: "xtranslate_url_blocked" };

    const method = String(request.method || "GET").toUpperCase();
    if (!new Set(["GET", "POST"]).has(method)) {
      return { ok: false, code: "xtranslate_method_blocked" };
    }

    const rawHeaders = request.headers && typeof request.headers === "object" ? request.headers : {};
    const headers = {};
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (/^(?:host|cookie|origin|referer|sec-)/i.test(name)) continue;
      headers[String(name)] = String(value);
    }

    const requestedTimeout = Number(request.timeout);
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.min(90_000, Math.max(1_000, Math.round(requestedTimeout)))
      : 90_000;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const response = await fetch(url, {
        method,
        headers,
        ...(method === "GET" || request.data == null ? {} : { body: String(request.data) }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const responseText = await response.text();
      const responseHeaders = response.headers && typeof response.headers.entries === "function"
        ? Array.from(response.headers.entries()).map(([name, value]) => `${name}: ${value}`).join("\\r\\n")
        : "";
      return {
        ok: true,
        status: Number(response.status || 0),
        statusText: String(response.statusText || ""),
        responseText,
        responseHeaders,
        finalUrl: String(response.url || url),
      };
    } catch (error) {
      return {
        ok: false,
        code: error?.name === "AbortError" ? "xtranslate_timeout" : "xtranslate_network_error",
        message: String(error?.message || error || "network error"),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function apiRequest(path, init = {}, explicitBaseUrl = null) {
    const { connectionToken } = await chrome.storage.local.get(["connectionToken"]);
    if (!TOKEN_PATTERN.test(connectionToken ?? "")) {
      return { ok: false, code: "connection_key_missing" };
    }
    const baseUrl = explicitBaseUrl ?? (await activeApiEndpoint()).baseUrl;
    const headers = {
      Authorization: `Bearer ${connectionToken}`,
      "X-Lakomics-Extension-Id": PC_EXTENSION_ID,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const timeoutMs = Number.isFinite(init.timeoutMs) ? init.timeoutMs : API_REQUEST_TIMEOUT_MS;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller && typeof setTimeout === "function"
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      let body;
      try {
        body = await response.json();
      } catch (error) {
        if (controller?.signal?.aborted || error?.name === "AbortError") {
          return { ok: false, code: "app_offline" };
        }
        body = {};
      }
      if (!response.ok) {
        return {
          ok: false,
          code: typeof body.code === "string" ? body.code : "request_failed",
          httpStatus: Number(response.status) || null,
          ...(typeof body.message === "string" ? { message: body.message } : {}),
        };
      }
      return { ok: true, ...body };
    } catch {
      return { ok: false, code: "app_offline" };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  installDownloadFilenameSuggestionListener();
  void syncDownloadUiPreference();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse, () => sendResponse({ ok: false, code: "worker_failed" }));
    return true;
  });

  chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsBackground = {
      handleMessage,
      buildDownloadFilename,
      buildSidecarMetadata,
      jsonDataUrl,
      stripExtensionFields,
      applyDownloadUiPreference,
      prepareMediaPayload,
      extractSyndicationVideos,
      computeSyndicationToken,
      activeApiEndpoint,
      testRemoteConnection,
      testCollectorConnection,
      captureWithCollector,
      isAllowedTranslateUrl,
      translateHttpRequest,
      normalizeDownloadMatchUrl,
      takeFilenameSuggestion,
      resolveDownloadedFilename,
      normalizeSavedXMediaKeys,
      savedXMediaKeyFromSourceUrl,
    };
  }
})();
