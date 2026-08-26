(() => {
  "use strict";

  const ROOT = "__root__";
  const PINNED = "__pinned__";
  const PIN_ONLY_FIRST_LEVEL_NAMES = new Set(["리버스", "명조", "젠레스"].map(normalizeName));

  function slotCount(childCount) {
    return childCount <= 6 ? 6 : 12;
  }

  function reconcileLayout(entries, storedLayout) {
    const groups = groupByParent(entries);
    const storedParents = storedLayout?.version === 1 && storedLayout.parents
      ? storedLayout.parents
      : {};
    const parents = {};
    for (const [key, children] of groups) {
      parents[key] = reconcileParent(children, storedParents[key]);
    }
    return { version: 1, parents };
  }

  function resetLayout(entries) {
    const parents = {};
    for (const [key, children] of groupByParent(entries)) {
      const count = slotCount(children.length);
      const pageCount = Math.max(1, Math.ceil(children.length / count));
      const slots = Array(pageCount * count).fill(null);
      children.forEach((entry, index) => { slots[index] = entry.id; });
      parents[key] = chunk(slots, count);
    }
    return { version: 1, parents };
  }

  function getLevel(entries, layout, parentId, requestedPage) {
    const storedPages = layout?.parents?.[parentKey(parentId)];
    const directChildren = entries.filter((entry) => entry.parentId === parentId);
    // Prefer the live parent/child tree. If a pinned first-level item was moved or
    // recreated and the backend relationship briefly disagrees with the persisted
    // radial layout, keep the user's existing submenu usable by recovering only IDs
    // that still exist in the current entry set. This is deliberately a fallback:
    // once real direct children are present they always win.
    const children = directChildren.length
      ? directChildren
      : recoverStoredChildren(entries, storedPages);
    // Always reconcile against the live/recovered tree. Cached/older layouts can be
    // missing a page for a pinned child (for example 리버스/명조/젠레스), which
    // used to make an existing submenu render as an empty ring until refresh.
    const pages = reconcileParent(children, storedPages);
    const count = pages[0]?.length ?? slotCount(children.length);
    const pageCount = Math.max(1, pages.length);
    const page = Math.min(Math.max(0, Number(requestedPage) || 0), pageCount - 1);
    const byId = new Map(children.map((entry) => [entry.id, entry]));
    const ids = [...(pages[page] ?? [])];
    while (ids.length < count) ids.push(null);
    return {
      parentId,
      page,
      pageCount,
      slotCount: count,
      slots: ids.slice(0, count).map((id) => id ? byId.get(id) ?? null : null),
    };
  }

  function getCompactLevel(entries, layout, parentId, requestedPage) {
    const level = getLevel(entries, layout, parentId, requestedPage);
    const slots = level.slots.filter(Boolean);
    return {
      ...level,
      slotCount: slots.length,
      slots,
    };
  }


  function recoverStoredChildren(entries, storedPages) {
    if (!Array.isArray(storedPages)) return [];
    const byId = new Map((Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.id === "string")
      .map((entry) => [entry.id, entry]));
    const recovered = [];
    const seen = new Set();
    for (const id of storedPages.flat()) {
      if (typeof id !== "string" || seen.has(id)) continue;
      const entry = byId.get(id);
      if (!entry) continue;
      seen.add(id);
      recovered.push(entry);
    }
    return recovered;
  }

  function moveSlot(layout, parentId, fromIndex, toIndex) {
    const next = JSON.parse(JSON.stringify(layout));
    const key = parentKey(parentId);
    const pages = next.parents?.[key];
    if (!pages) return next;
    const pageSize = pages[0]?.length ?? 0;
    const flat = pages.flat();
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
      || fromIndex < 0 || toIndex < 0
      || fromIndex >= flat.length || toIndex >= flat.length) {
      return next;
    }
    [flat[fromIndex], flat[toIndex]] = [flat[toIndex], flat[fromIndex]];
    next.parents[key] = chunk(flat, pageSize);
    return next;
  }

  function isFirstLevelVisible(entry, pinnedIds) {
    if (!entry || typeof entry.id !== "string") return false;
    if (pinnedIds?.has(entry.id)) return true;
    if (entry.parentId !== null) return false;
    // These promoted work shortcuts used to leak into the first ring through the
    // local/offline fallback even when the user had not pinned their real app entry.
    // Keep them hidden until an explicit pin exists; ordinary roots remain visible.
    return !PIN_ONLY_FIRST_LEVEL_NAMES.has(normalizeName(entry.name));
  }

  function normalizeName(value) {
    return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }

  function getPinnedLevel(entries, layout, pinnedIds, requestedPage) {
    const pinnedSet = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
    const children = entries.filter((entry) => isFirstLevelVisible(entry, pinnedSet));
    const count = slotCount(children.length);
    const pages = reconcileParent(children, layout?.parents?.[PINNED]);
    const pageCount = Math.max(1, pages.length);
    const page = Math.min(Math.max(0, Number(requestedPage) || 0), pageCount - 1);
    const byId = new Map(children.map((entry) => [entry.id, entry]));
    const ids = [...(pages[page] ?? [])];
    while (ids.length < count) ids.push(null);
    return {
      parentId: PINNED,
      page,
      pageCount,
      slotCount: count,
      slots: ids.slice(0, count).map((id) => id ? byId.get(id) ?? null : null),
    };
  }

  function reorderPinned(layout, entries, pinnedIds) {
    const pinnedSet = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
    const children = entries.filter((entry) => isFirstLevelVisible(entry, pinnedSet));
    const count = slotCount(children.length);
    const pages = layout?.parents?.[PINNED] ?? [Array(count).fill(null)];
    const oldFlat = pages.flat();
    const byId = new Map(children.map((entry) => [entry.id, entry]));
    const ordered = [];
    for (const id of oldFlat) {
      if (id && byId.has(id)) { ordered.push(id); byId.delete(id); }
    }
    for (const entry of children) {
      if (byId.has(entry.id)) { ordered.push(entry.id); byId.delete(entry.id); }
    }
    const pageCount = Math.max(1, Math.ceil(ordered.length / count));
    const capacity = pageCount * count;
    while (ordered.length < capacity) ordered.push(null);
    const next = JSON.parse(JSON.stringify(layout));
    next.parents[PINNED] = chunk(ordered, count);
    return next;
  }

  function reconcileParent(children, storedPages) {
    // Keep an explicitly arranged twelve-slot submenu sparse instead of collapsing
    // it to six slots, while still healing stale/missing child ids.
    const storedSlotCount = Array.isArray(storedPages?.[0]) ? storedPages[0].length : 0;
    const count = storedSlotCount === 12 ? 12 : slotCount(children.length);
    const pageCount = Math.max(1, Math.ceil(children.length / count));
    const capacity = pageCount * count;
    const slots = Array(capacity).fill(null);
    const valid = new Set(children.map((entry) => entry.id));
    const placed = new Set();
    const displaced = [];
    const oldSlots = Array.isArray(storedPages) ? storedPages.flat() : [];

    oldSlots.forEach((id, index) => {
      if (typeof id !== "string" || !valid.has(id) || placed.has(id)) return;
      placed.add(id);
      if (index < capacity && slots[index] === null) slots[index] = id;
      else displaced.push(id);
    });

    const waiting = [
      ...displaced,
      ...children.map((entry) => entry.id).filter((id) => !placed.has(id)),
    ];
    for (const id of waiting) {
      const empty = slots.indexOf(null);
      if (empty === -1) break;
      slots[empty] = id;
    }
    return chunk(slots, count);
  }

  function groupByParent(entries) {
    const groups = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry.id !== "string") continue;
      const key = parentKey(entry.parentId ?? null);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    return groups;
  }

  function parentKey(parentId) {
    return parentId === null ? ROOT : parentId;
  }

  function chunk(values, size) {
    const pages = [];
    for (let index = 0; index < values.length; index += size) {
      pages.push(values.slice(index, index + size));
    }
    return pages;
  }

  globalThis.LakomicsRadial = {
    ROOT,
    PINNED,
    slotCount,
    reconcileLayout,
    resetLayout,
    getLevel,
    getCompactLevel,
    getPinnedLevel,
    reorderPinned,
    moveSlot,
  };
})();
