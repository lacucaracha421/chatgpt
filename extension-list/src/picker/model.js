(() => {
  "use strict";
  // Pure helpers for the Arca Live picker panel (COLLECTOR-PICKER-001). Loaded in the service
  // worker (importScripts) and in the page's content script, so nothing here touches the DOM.
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  const BATCH = 18, MAX_BATCH = 24, MAX_EXCLUDE = 2000, SEEN_LIMIT = 1900;
  const VIEW_KEY = "lakomics:picker:view:v1";
  const PC_KEY = "lakomics:picker:pc-key:v1";
  const MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"];

  const validId = value => typeof value === "string" && ID.test(value);
  const clampInt = (value, fallback = 0) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : fallback;

  // The only page the panel and its PC requests are allowed from: a new Arca Live post.
  function isArcaWriteUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === "https:" && url.hostname === "arca.live" && !url.username && !url.password && /^\/b\/[^/]+\/write(?:\/|$)/.test(url.pathname);
    } catch { return false; }
  }

  // ---- PC service failures -------------------------------------------------------------
  // `offline` also covers a timeout: the panel treats both as "PC Lakomics is not answering".
  function mapFailure({ status = 0, code = "" } = {}) {
    if (code === "unpaired" || code === "no_key") return "unpaired";
    if (!status) return code === "timeout" ? "timeout" : "offline";
    if (status === 401) return "unpaired";
    if (status === 403) return "forbidden";
    if (status === 409) return "library";
    if (status === 413) return "tooLarge";
    if (status === 423) return code === "pickerPrivacyUnavailable" ? "privacyUnavailable" : "locked";
    if (status === 404) return code === "pickerAssetNotFound" ? "missing" : code === "classification_not_found" ? "folderGone" : code === "pickerScopeNotFound" ? "scopeGone" : "notFound";
    if (status === 400) return "invalid";
    return status >= 500 ? "server" : "unknown";
  }

  // Whole-panel states shown in place of the grid.
  const STATES = {
    offline: { title: "PC Lakomics에 연결되지 않음", hint: "PC에서 Lakomics를 켜면 바로 이어집니다", action: "retry" },
    timeout: { title: "PC Lakomics에 연결되지 않음", hint: "PC에서 Lakomics를 켜면 바로 이어집니다", action: "retry" },
    locked: { title: "PC Lakomics가 잠겨 있음", hint: "PC에서 비공개 모드가 켜져 있어 그림을 보여줄 수 없습니다", action: "retry" },
    privacyUnavailable: { title: "PC Lakomics가 잠겨 있음", hint: "PC Lakomics 창이 응답하지 않습니다. 창을 열어 두세요", action: "retry" },
    unpaired: { title: "연결 설정 필요", hint: "PC 연결 키를 확장 프로그램 설정에 붙여 넣으세요", action: "settings" },
    forbidden: { title: "연결 설정 필요", hint: "이 확장 프로그램의 ID가 PC Lakomics와 맞지 않습니다", action: "settings" },
    library: { title: "PC에서 라이브러리를 열어 주세요", hint: "라이브러리가 열려 있어야 그림을 고를 수 있습니다", action: "retry" },
    server: { title: "PC Lakomics에 문제가 생김", hint: "잠시 뒤 다시 시도하세요", action: "retry" },
    unknown: { title: "그림을 불러오지 못함", hint: "", action: "retry" },
  };
  const stateFor = kind => STATES[kind] || STATES.unknown;

  // One-line reasons on a failed job row.
  function jobReason(kind) {
    switch (kind) {
      case "timeout": case "editorTimeout": return "시간 초과";
      case "uploadFailed": return "아카라이브 업로드 실패";
      case "offline": case "privacyUnavailable": return "PC 연결 끊김";
      case "locked": return "PC 잠김";
      case "tooLarge": return "용량 초과";
      case "unsupported": return "형식 미지원";
      case "missing": case "notFound": return "원본 없음";
      case "ignored": return "편집기가 받지 않음";
      case "editor": return "본문 편집기를 찾지 못함";
      case "unpaired": case "forbidden": return "연결 설정 필요";
      default: return "실패";
    }
  }

  // ---- selection, seen set, jobs ---------------------------------------------------------
  function createSelection() {
    const order = [];
    return {
      ids: () => order.slice(),
      get size() { return order.length; },
      has: id => order.includes(id),
      numberOf: id => order.indexOf(id) + 1,
      add(id) { if (!order.includes(id)) order.push(id); return true; },
      remove(id) { const at = order.indexOf(id); if (at >= 0) order.splice(at, 1); return at >= 0; },
      toggle(id) { const at = order.indexOf(id); if (at >= 0) { order.splice(at, 1); return false; } order.push(id); return true; },
      clear() { order.length = 0; },
    };
  }

  // Pictures already shown in this panel session, oldest first.
  function createSeen(limit = SEEN_LIMIT) {
    const order = [];
    return {
      add(ids) {
        for (const id of ids) { const at = order.indexOf(id); if (at >= 0) order.splice(at, 1); order.push(id); }
        if (order.length > limit) order.splice(0, order.length - limit);
      },
      get size() { return order.length; },
      list: () => order.slice(),
      // Ids to send as `exclude` for an ordinary "다른 그림" request.
      exclude() { return order.slice(-MAX_EXCLUDE); },
      // Fill-up request: everything seen except the `need` least recently seen, plus what the
      // first answer already chose. The PC then picks from exactly that oldest remainder.
      fillExclude(chosen, need) {
        const picked = new Set(chosen);
        const allowed = new Set(order.filter(id => !picked.has(id)).slice(0, Math.max(0, need)));
        return [...order.filter(id => !allowed.has(id)), ...picked].slice(-MAX_EXCLUDE);
      },
    };
  }

  function createJobs() {
    let rows = [], stopped = false;
    return {
      start(ids) { rows = ids.map(id => ({ id, state: "wait", reason: "" })); stopped = false; },
      set(id, state, reason = "") { const row = rows.find(r => r.id === id); if (row) { row.state = state; row.reason = reason; } },
      stop() { stopped = true; },
      get stopped() { return stopped; },
      rows: () => rows.map(r => ({ ...r })),
      get(id) { return rows.find(r => r.id === id)?.state || null; },
      failed: () => rows.filter(r => r.state === "bad").map(r => r.id),
      counts() { const done = rows.filter(r => r.state === "ok" || r.state === "bad").length; return { done, total: rows.length, failed: rows.filter(r => r.state === "bad").length, ok: rows.filter(r => r.state === "ok").length }; },
      running: () => rows.some(r => r.state === "up"),
      pending: () => rows.some(r => r.state === "wait" || r.state === "up"),
      clear() { rows = []; stopped = false; },
    };
  }

  // ---- keyboard --------------------------------------------------------------------------
  function gridKey(event, { index = 0, count = 0, columns = 3 } = {}) {
    const key = event.key;
    if (event.ctrlKey || event.metaKey || event.altKey || !count) return null;
    const clamp = value => Math.max(0, Math.min(count - 1, value));
    switch (key) {
      case "ArrowRight": return { type: "move", index: clamp(index + 1) };
      case "ArrowLeft": return { type: "move", index: clamp(index - 1) };
      case "ArrowDown": return { type: "move", index: index + columns <= count - 1 ? index + columns : index };
      case "ArrowUp": return { type: "move", index: index - columns >= 0 ? index - columns : index };
      case "Home": return { type: "move", index: 0 };
      case "End": return { type: "move", index: count - 1 };
      case " ": case "Spacebar": return { type: "toggle" };
      case "Enter": return { type: "insert" };
      case "p": case "P": return { type: "preview" };
      case "r": case "R": return { type: "refresh" };
      default: return null;
    }
  }
  function trayKey(event, { index = 0, count = 0 } = {}) {
    if (event.ctrlKey || event.metaKey || event.altKey || !count) return null;
    if (event.key === "ArrowRight") return { type: "move", index: Math.min(count - 1, index + 1) };
    if (event.key === "ArrowLeft") return { type: "move", index: Math.max(0, index - 1) };
    if (event.key === "Delete" || event.key === "Backspace") return { type: "remove", index };
    return null;
  }

  // ---- folder tree -----------------------------------------------------------------------
  function normalize(text) { return String(text || "").normalize("NFC").toLowerCase(); }
  const cleanOrder = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const pcOrder = (a, b) => (cleanOrder(a.order) ?? Number.MAX_SAFE_INTEGER) - (cleanOrder(b.order) ?? Number.MAX_SAFE_INTEGER);
  function cleanFolders(entries) {
    const seen = new Set(), result = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || !validId(entry.id) || seen.has(entry.id) || typeof entry.name !== "string" || !entry.name.trim()) continue;
      seen.add(entry.id);
      result.push({
        id: entry.id, parentId: validId(entry.parentId) ? entry.parentId : null, name: entry.name.trim().slice(0, 200),
        path: (Array.isArray(entry.path) ? entry.path : [entry.name]).filter(part => typeof part === "string").map(part => part.slice(0, 200)).slice(0, 32),
        order: cleanOrder(entry.order), pinned: entry.pinned === true, pinOrder: cleanOrder(entry.pinOrder),
        imageCount: clampInt(entry.imageCount), imageCountWithDescendants: clampInt(entry.imageCountWithDescendants, clampInt(entry.imageCount)),
      });
    }
    return result;
  }
  // Rows of the popover: expanded branches, or while searching the matches and their ancestors.
  function folderRows(entries, { expanded = new Set(), query = "" } = {}) {
    const byParent = new Map(), byId = new Map(entries.map(entry => [entry.id, entry]));
    for (const entry of entries) {
      const parent = entry.parentId && byId.has(entry.parentId) ? entry.parentId : null;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(entry);
    }
    const needle = normalize(query.trim());
    const keep = new Set(), direct = new Set();
    if (needle) {
      for (const entry of entries) {
        if (!normalize(entry.name).includes(needle)) continue;
        direct.add(entry.id);
        for (let node = entry, guard = 0; node && guard < 40; node = byId.get(node.parentId), guard += 1) keep.add(node.id);
      }
    }
    const rows = [];
    (function walk(parent, depth) {
      for (const entry of byParent.get(parent) || []) {
        if (needle && !keep.has(entry.id)) continue;
        const children = (byParent.get(entry.id) || []).length > 0;
        const open = needle ? children && (byParent.get(entry.id) || []).some(child => keep.has(child.id)) : expanded.has(entry.id);
        const at = needle && direct.has(entry.id) ? normalize(entry.name).indexOf(needle) : -1;
        rows.push({ entry, depth, hasChildren: children, open, match: at >= 0 ? [at, at + needle.length] : null, ancestorOnly: Boolean(needle) && !direct.has(entry.id) });
        if (open) walk(entry.id, depth + 1);
      }
    })(null, 0);
    return rows;
  }
  function ancestorIds(entries, id) {
    const byId = new Map(entries.map(entry => [entry.id, entry])), result = [];
    for (let node = byId.get(id), guard = 0; node && node.parentId && guard < 40; node = byId.get(node.parentId), guard += 1) result.push(node.parentId);
    return result;
  }

  // ---- characters and groups ---------------------------------------------------------------
  // The PC lists them next to the folders: `{kind: "character"|"group", id, name, seriesId,
  // seriesPath, groupId, imageCount}`. They hang under their series folder in the popover.
  const SCOPE_KINDS = ["folder", "character", "group"];
  function cleanCharacters(entries) {
    const seen = new Set(), result = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || (entry.kind !== "character" && entry.kind !== "group") || !validId(entry.id) || !validId(entry.seriesId) || typeof entry.name !== "string" || !entry.name.trim()) continue;
      const key = entry.kind + ":" + entry.id;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        order: cleanOrder(entry.order),
        kind: entry.kind, id: entry.id, name: entry.name.trim().slice(0, 200), seriesId: entry.seriesId,
        seriesPath: (Array.isArray(entry.seriesPath) ? entry.seriesPath : []).filter(part => typeof part === "string").map(part => part.slice(0, 200)).slice(0, 32),
        groupId: entry.kind === "character" && validId(entry.groupId) ? entry.groupId : null, imageCount: clampInt(entry.imageCount),
      });
    }
    return result;
  }
  // `{kind, id}` of a remembered or chosen scope, or null.
  function cleanScope(value) {
    return value && typeof value === "object" && SCOPE_KINDS.includes(value.kind) && validId(value.id) ? { kind: value.kind, id: value.id } : null;
  }
  function findScope(folders, characters, scope) {
    if (!scope) return null;
    if (scope.kind === "folder") return folders.find(entry => entry.id === scope.id) || null;
    return characters.find(entry => entry.kind === scope.kind && entry.id === scope.id) || null;
  }
  // Breadcrumb parts of a scope: a folder's path, or series path > (group >) name.
  function scopeParts(folders, characters, scope) {
    const entry = findScope(folders, characters, scope);
    if (!entry) return [];
    if (scope.kind === "folder") return entry.path.length ? entry.path : [entry.name];
    const group = entry.groupId ? characters.find(item => item.kind === "group" && item.id === entry.groupId) : null;
    return [...entry.seriesPath, ...(group ? [group.name] : []), entry.name];
  }
  // The scope part of a batch request; folders keep their original shape.
  function batchTarget(scope, includeDescendants) {
    return scope.kind === "folder" ? { folderId: scope.id, includeDescendants: includeDescendants === true } : { scope: { kind: scope.kind, id: scope.id } };
  }
  function scopeCount(entry, kind, includeDescendants) {
    return kind === "folder" ? (includeDescendants ? entry.imageCountWithDescendants : entry.imageCount) : entry.imageCount;
  }

  // Rows of the popover tree. Folders as in `folderRows`; under a series folder its groups,
  // then its characters without a group, then its sub-folders. A group's own characters hang
  // under the group. Search returns only name matches, once each, with their path as `secondary`.
  function treeRows(folders, characters = [], { expanded = new Set(), query = "" } = {}) {
    folders = [...folders].sort(pcOrder);
    characters = [...characters].sort(pcOrder);
    const folderIds = new Set(folders.map(entry => entry.id));
    const byParent = new Map(), groupsOf = new Map(), looseOf = new Map(), membersOf = new Map(), groupById = new Map();
    const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
    for (const entry of folders) push(byParent, entry.parentId && folderIds.has(entry.parentId) ? entry.parentId : null, entry);
    const usable = characters.filter(entry => folderIds.has(entry.seriesId));
    for (const entry of usable) if (entry.kind === "group") groupById.set(entry.id, entry);
    for (const entry of usable) {
      if (entry.kind === "group") push(groupsOf, entry.seriesId, entry);
      else if (entry.groupId && groupById.has(entry.groupId) && groupById.get(entry.groupId).seriesId === entry.seriesId) push(membersOf, entry.groupId, entry);
      else push(looseOf, entry.seriesId, entry);
    }
    const needle = normalize(query.trim());
    const rows = [];
    const row = (entry, kind, depth, children, open, secondary) => {
      const at = needle ? normalize(entry.name).indexOf(needle) : -1;
      if (needle && at < 0) return;
      rows.push({ entry, kind, depth: needle ? 0 : depth, hasChildren: !needle && children, open: !needle && open, match: at >= 0 ? [at, at + needle.length] : null, ancestorOnly: false,
        secondary: needle ? (kind === "folder" ? entry.path.slice(0, -1).join(" › ") : secondary) : "" });
    };
    for (const entry of folders.filter(entry => entry.pinned === true && !needle)
      .sort((a, b) => (cleanOrder(a.pinOrder) ?? Number.MAX_SAFE_INTEGER) - (cleanOrder(b.pinOrder) ?? Number.MAX_SAFE_INTEGER))) {
      row(entry, "folder", 0, false, false, "");
      rows[rows.length - 1].section = "pinned";
    }
    (function walk(parent, depth) {
      for (const entry of byParent.get(parent) || []) {
        const groups = groupsOf.get(entry.id) || [];
        const loose = looseOf.get(entry.id) || [];
        const hasChildren = (groupsOf.get(entry.id) || []).length + (looseOf.get(entry.id) || []).length + (byParent.get(entry.id) || []).length > 0;
        const open = hasChildren && (Boolean(needle) || expanded.has(entry.id));
        row(entry, "folder", depth, hasChildren, open, "");
        if (!open) continue;
        for (const group of groups) {
          const members = membersOf.get(group.id) || [];
          const hasMembers = members.length > 0, groupOpen = hasMembers && (Boolean(needle) || expanded.has(group.id));
          row(group, "group", depth + 1, hasMembers, groupOpen, group.seriesPath.join(" › "));
          if (groupOpen) for (const member of members) row(member, "character", depth + 2, false, false, member.seriesPath.join(" › "));
        }
        for (const member of loose) row(member, "character", depth + 1, false, false, member.seriesPath.join(" › "));
        walk(entry.id, depth + 1);
      }
    })(null, 0);
    return rows;
  }

  // ---- no-blink busy label ---------------------------------------------------------------
  // Shown only after `delay` ms and, once shown, kept for at least `minShow` ms.
  function createDelayedBusy({ show, hide, delay = 400, minShow = 300, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let timer = null, hideTimer = null, shownAt = null, active = false;
    return {
      begin() {
        if (hideTimer) { clearTimer(hideTimer); hideTimer = null; }
        if (active) return;
        active = true;
        if (shownAt != null) return;
        timer = setTimer(() => { timer = null; if (active) { shownAt = now(); show(); } }, delay);
      },
      end() {
        if (!active) return;
        active = false;
        if (timer) { clearTimer(timer); timer = null; }
        if (shownAt == null) return;
        const wait = Math.max(0, minShow - (now() - shownAt));
        const finish = () => { hideTimer = null; shownAt = null; hide(); };
        if (wait > 0) hideTimer = setTimer(finish, wait); else finish();
      },
      get shown() { return shownAt != null; },
    };
  }

  // ---- bytes -----------------------------------------------------------------------------
  function toBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x4000) binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x4000));
    return btoa(binary);
  }
  function fromBase64(text) {
    const binary = atob(String(text || "")), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function formatCount(value) { return Math.max(0, Math.floor(Number(value) || 0)).toLocaleString("en-US"); }
  function formatBytes(value) {
    const n = Math.max(0, Number(value) || 0);
    return n >= 1048576 ? (n / 1048576).toFixed(1) + "MB" : Math.max(1, Math.round(n / 1024)) + "KB";
  }

  globalThis.LakomicsPickerModel = {
    ID, BATCH, MAX_BATCH, MAX_EXCLUDE, VIEW_KEY, PC_KEY, MIMES, validId, clampInt, isArcaWriteUrl, mapFailure, STATES, stateFor, jobReason,
    createSelection, createSeen, createJobs, gridKey, trayKey, cleanFolders, folderRows, ancestorIds, createDelayedBusy,
    SCOPE_KINDS, cleanCharacters, cleanScope, findScope, scopeParts, batchTarget, scopeCount, treeRows,
    toBase64, fromBase64, formatCount, formatBytes,
  };
})();
