(() => {
  "use strict";

  const ROOT = "__root__";
  const PINNED = "__pinned__";

  function slotCount(childCount) {
    return childCount <= 6 ? 6 : 12;
  }

  function reconcileLayout(entries, storedLayout) {
    const storedParents = storedLayout?.version === 1 && storedLayout.parents
      ? storedLayout.parents
      : {};
    const groups = groupByParent(entries);
    const liveIds = new Set((Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.id === "string")
      .map((entry) => entry.id));
    const parentKeys = new Set(groups.keys());
    for (const key of Object.keys(storedParents)) {
      if (key !== PINNED && (key === ROOT || liveIds.has(key))) parentKeys.add(key);
    }
    const parents = {};
    for (const key of parentKeys) {
      const children = radialChildren(entries, storedParents, key);
      if (children.length === 0) continue;
      parents[key] = reconcileParent(children, storedParents[key]);
    }
    if (Array.isArray(storedParents[PINNED])) {
      parents[PINNED] = storedParents[PINNED].map((page) => Array.isArray(page) ? [...page] : []);
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
    const key = parentKey(parentId);
    const storedParents = layout?.parents ?? {};
    const storedPages = storedParents[key];
    const children = radialChildren(entries, storedParents, key);
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

  function radialChildren(entries, storedParents, key) {
    const liveEntries = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.id === "string");
    const byId = new Map(liveEntries.map((entry) => [entry.id, entry]));
    const storedIds = Array.isArray(storedParents?.[key]) ? storedParents[key].flat() : [];
    const children = [];
    const placed = new Set();

    for (const id of storedIds) {
      const entry = byId.get(id);
      if (!entry || placed.has(id)) continue;
      placed.add(id);
      children.push(entry);
    }

    const explicitlyPlacedElsewhere = new Set();
    for (const [parent, pages] of Object.entries(storedParents ?? {})) {
      if (parent === ROOT || parent === PINNED || parent === key
        || !byId.has(parent) || !Array.isArray(pages)) continue;
      for (const id of pages.flat()) if (byId.has(id)) explicitlyPlacedElsewhere.add(id);
    }

    const canonicalParentId = key === ROOT ? null : key;
    for (const entry of liveEntries) {
      if (entry.parentId !== canonicalParentId || placed.has(entry.id)
        || explicitlyPlacedElsewhere.has(entry.id)) continue;
      placed.add(entry.id);
      children.push(entry);
    }
    return children;
  }

  function getCompactLevel(entries, layout, parentId, requestedPage, excludedIds = []) {
    const excluded = new Set(Array.isArray(excludedIds) ? excludedIds : []);
    const visibleEntries = excluded.size
      ? entries.filter((entry) => !excluded.has(entry?.id))
      : entries;
    const level = getLevel(visibleEntries, layout, parentId, requestedPage);
    const slots = level.slots.filter(Boolean);
    return {
      ...level,
      slotCount: slots.length,
      slots,
    };
  }


  function usageBucket(value) {
    const raw = typeof value === "object" && value !== null ? value.count : value;
    const count = Math.max(0, Math.floor(Number(raw) || 0));
    return count > 0 ? Math.floor(Math.log2(count + 1)) : 0;
  }

  function centerOutIndices(count) {
    const size = Math.max(0, Math.floor(Number(count) || 0));
    const indices = [];
    if (size === 0) return indices;
    if (size % 2 === 1) {
      const center = Math.floor(size / 2);
      indices.push(center);
      for (let offset = 1; indices.length < size; offset += 1) {
        if (center - offset >= 0) indices.push(center - offset);
        if (center + offset < size) indices.push(center + offset);
      }
      return indices;
    }
    const left = size / 2 - 1;
    const right = size / 2;
    indices.push(left, right);
    for (let offset = 1; indices.length < size; offset += 1) {
      if (left - offset >= 0) indices.push(left - offset);
      if (right + offset < size) indices.push(right + offset);
    }
    return indices;
  }

  function adaptiveSecondaryLayout(entries, layout, usageById = {}, hiddenIds = []) {
    const liveEntries = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.id === "string");
    const next = reconcileLayout(liveEntries, layout);
    const hidden = new Set(Array.isArray(hiddenIds) ? hiddenIds : []);
    const groups = groupByParent(liveEntries);

    for (const [key, children] of groups) {
      if (key === ROOT || children.length < 2) continue;
      const hasHiddenChild = children.some((entry) => hidden.has(entry.id));
      const visibleBuckets = new Set(children
        .filter((entry) => !hidden.has(entry.id))
        .map((entry) => usageBucket(usageById?.[entry.id])));
      if (!hasHiddenChild && visibleBuckets.size <= 1) continue;

      const pages = reconcileParent(children, next.parents[key]);
      const pageSize = pages[0]?.length ?? slotCount(children.length);
      const flat = pages.flat();
      const currentPosition = new Map();
      flat.forEach((id, index) => { if (typeof id === "string") currentPosition.set(id, index); });

      const priorityPositions = [];
      for (let start = 0; start < flat.length; start += pageSize) {
        const localCount = Math.min(pageSize, flat.length - start);
        for (const localIndex of centerOutIndices(localCount)) priorityPositions.push(start + localIndex);
      }
      const easeRankByPosition = new Map(priorityPositions.map((position, rank) => [position, rank]));
      const canonicalIndex = new Map(children.map((entry, index) => [entry.id, index]));
      const ids = children.map((entry) => entry.id);
      ids.sort((a, b) => {
        const hiddenDelta = Number(hidden.has(a)) - Number(hidden.has(b));
        if (hiddenDelta !== 0) return hiddenDelta;
        const bucketDelta = usageBucket(usageById?.[b]) - usageBucket(usageById?.[a]);
        if (bucketDelta !== 0) return bucketDelta;
        const aEase = easeRankByPosition.get(currentPosition.get(a)) ?? Number.MAX_SAFE_INTEGER;
        const bEase = easeRankByPosition.get(currentPosition.get(b)) ?? Number.MAX_SAFE_INTEGER;
        if (aEase !== bEase) return aEase - bEase;
        return (canonicalIndex.get(a) ?? 0) - (canonicalIndex.get(b) ?? 0);
      });

      const ranked = Array(flat.length).fill(null);
      ids.forEach((id, index) => {
        const target = priorityPositions[index];
        if (target !== undefined) ranked[target] = id;
      });
      next.parents[key] = chunk(ranked, pageSize);
    }
    return next;
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
    return entry.parentId === null || pinnedIds?.has(entry.id);
  }

  function getFirstLevelPinCandidates(entries, pinnedIds) {
    const pinnedSet = new Set(Array.isArray(pinnedIds) ? pinnedIds : []);
    return (Array.isArray(entries) ? entries : []).filter((entry) =>
      entry && typeof entry.id === "string" && entry.parentId !== null && !pinnedSet.has(entry.id)
    );
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
    getFirstLevelPinCandidates,
    reorderPinned,
    usageBucket,
    centerOutIndices,
    adaptiveSecondaryLayout,
    moveSlot,
  };
})();
