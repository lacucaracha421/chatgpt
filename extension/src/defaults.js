(() => {
  "use strict";

  const DEFAULT_PREFERENCES = Object.freeze({
    saveMode: "auto",
    downloadFolder: "Lakomics",
    touchLongPressMs: 450,
    touchPersistent: true,
    suppressContextMenu: true,
    suppressDownloadUi: true,
    autoLikeOnSave: true,
  });

  const DEFAULT_REMOTE_SETTINGS = Object.freeze({
    enabled: false,
    baseUrl: "https://desktop-6oh3e09.tail0aa1a3.ts.net",
  });

  const DEFAULT_COLLECTOR_SETTINGS = Object.freeze({
    enabled: false,
    baseUrl: "http://100.76.119.29:32146",
  });

  const SECONDARY_SLOT_COUNT = 12;
  const LOCAL_ROOT_DEFINITIONS = Object.freeze([
    ["local:reverse", "리버스"],
    ["local:wuthering-waves", "명조"],
    ["local:zenless", "젠레스"],
    ["local:game", "게임"],
    ["local:manga", "만화"],
    ["local:other", "기타"],
  ]);

  function defaultLocalTree() {
    return {
      version: 1,
      roots: LOCAL_ROOT_DEFINITIONS.map(([id, name]) => ({
        id,
        name,
        secondarySlots: Array(SECONDARY_SLOT_COUNT).fill(null),
      })),
    };
  }

  function normalizePreferences(value = {}) {
    // `app` was used by older alpha builds. The current extension promises
    // automatic device fallback, so migrate that legacy value to `auto`.
    // Save modes: auto (PC direct → Cloud → device), pc ("PC 직접 연결만"),
    // cloud ("Cloud만"), download (브라우저 Download만 = legacy manual bypass).
    // 레거시 `app`(구 빌드의 app-only 저장 = 자동 폴백 의미)은 `auto`로 마이그레이션한다.
    // 새 `pc` 값만이 PC 직접 연결 전용 모드이며 구 저장값과 충돌하지 않는다.
    const saveMode = ["pc", "cloud", "download"].includes(value.saveMode) ? value.saveMode : DEFAULT_PREFERENCES.saveMode;
    const rawFolder = typeof value.downloadFolder === "string"
      ? value.downloadFolder.trim()
      : DEFAULT_PREFERENCES.downloadFolder;
    const downloadFolder = rawFolder || DEFAULT_PREFERENCES.downloadFolder;
    const numericLongPress = Number(value.touchLongPressMs);
    const touchLongPressMs = Number.isFinite(numericLongPress)
      ? Math.min(900, Math.max(220, Math.round(numericLongPress)))
      : DEFAULT_PREFERENCES.touchLongPressMs;
    return {
      saveMode,
      downloadFolder,
      touchLongPressMs,
      touchPersistent: value.touchPersistent !== false,
      suppressContextMenu: value.suppressContextMenu !== false,
      suppressDownloadUi: value.suppressDownloadUi !== false,
      autoLikeOnSave: value.autoLikeOnSave !== false,
    };
  }

  function normalizeRemoteSettings(value = {}) {
    const hasExplicitBaseUrl = value && Object.prototype.hasOwnProperty.call(value, "baseUrl");
    const requestedBaseUrl = hasExplicitBaseUrl ? value.baseUrl : DEFAULT_REMOTE_SETTINGS.baseUrl;
    const baseUrl = normalizeRemoteBaseUrl(requestedBaseUrl);
    return {
      enabled: value.enabled === true && Boolean(baseUrl),
      baseUrl,
    };
  }

  function normalizeRemoteBaseUrl(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || !host.endsWith(".ts.net")) return "";
      if (url.username || url.password || url.search || url.hash) return "";
      return `${url.protocol}//${url.host}`;
    } catch {
      return "";
    }
  }

  function normalizeCollectorSettings(value = {}) {
    const hasExplicitBaseUrl = value && Object.prototype.hasOwnProperty.call(value, "baseUrl");
    const requestedBaseUrl = hasExplicitBaseUrl ? value.baseUrl : DEFAULT_COLLECTOR_SETTINGS.baseUrl;
    const baseUrl = normalizeCollectorBaseUrl(requestedBaseUrl);
    return {
      enabled: value.enabled === true && Boolean(baseUrl),
      baseUrl,
    };
  }

  function normalizeCollectorBaseUrl(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      const isKnownVps = url.protocol === "http:" && host === "100.76.119.29" && url.port === "32146";
      const isTailnetHttps = url.protocol === "https:" && host.endsWith(".ts.net");
      if (!isKnownVps && !isTailnetHttps) return "";
      if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) return "";
      return `${url.protocol}//${url.host}`;
    } catch {
      return "";
    }
  }

  function normalizeLocalTree(value) {
    const defaults = defaultLocalTree();
    const roots = Array.isArray(value?.roots) ? value.roots : [];
    return {
      version: 1,
      roots: defaults.roots.map((fallback, index) => {
        const source = roots.find((entry) => entry?.id === fallback.id) ?? roots[index] ?? {};
        const name = cleanLabel(source.name) || fallback.name;
        const rawSlots = Array.isArray(source.secondarySlots) ? source.secondarySlots : [];
        const secondarySlots = Array.from({ length: SECONDARY_SLOT_COUNT }, (_, slot) => {
          const value = rawSlots[slot];
          if (typeof value === "string") return cleanLabel(value) || null;
          if (value && typeof value === "object") return cleanLabel(value.name) || null;
          return null;
        });
        return { id: fallback.id, name, secondarySlots };
      }),
    };
  }

  function localTreeEntries(value) {
    const tree = normalizeLocalTree(value);
    const entries = [];
    for (const root of tree.roots) {
      entries.push({ id: root.id, kind: "root", name: root.name, parentId: null });
      root.secondarySlots.forEach((name, index) => {
        if (!name) return;
        entries.push({
          id: localSecondaryId(root.id, index),
          kind: "tag",
          name,
          parentId: root.id,
        });
      });
    }
    return entries;
  }

  function localTreeLayout(value) {
    const tree = normalizeLocalTree(value);
    const parents = {
      __root__: [tree.roots.map((root) => root.id)],
      __pinned__: [tree.roots.map((root) => root.id)],
    };
    for (const root of tree.roots) {
      parents[root.id] = [root.secondarySlots.map((name, index) =>
        name ? localSecondaryId(root.id, index) : null)];
    }
    return { version: 1, parents };
  }

  function localSecondaryId(rootId, index) {
    return `${rootId}:secondary:${index}`;
  }

  function cleanLabel(value) {
    return typeof value === "string" ? value.trim().slice(0, 80) : "";
  }

  globalThis.LakomicsDefaults = {
    DEFAULT_PREFERENCES,
    DEFAULT_REMOTE_SETTINGS,
    DEFAULT_COLLECTOR_SETTINGS,
    SECONDARY_SLOT_COUNT,
    LOCAL_ROOT_DEFINITIONS,
    defaultLocalTree,
    normalizeRemoteSettings,
    normalizeRemoteBaseUrl,
    normalizeCollectorSettings,
    normalizeCollectorBaseUrl,
    normalizeLocalTree,
    localTreeEntries,
    localTreeLayout,
    localSecondaryId,
    normalizePreferences,
  };
})();
