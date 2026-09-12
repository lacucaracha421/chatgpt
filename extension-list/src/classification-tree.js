(() => {
  "use strict";

  function cleanEntries(entries) {
    const seen = new Set();
    return (Array.isArray(entries) ? entries : []).filter((entry) => {
      if (!entry || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return typeof entry.name === "string" && entry.name.trim().length > 0;
    }).map((entry) => ({ ...entry, name: entry.name.trim(), parentId: typeof entry.parentId === "string" && entry.parentId ? entry.parentId : null }));
  }

  function cleanIds(ids, live = null) {
    const seen = new Set();
    return (Array.isArray(ids) ? ids : []).filter((id) => {
      if (typeof id !== "string" || !id || seen.has(id) || (live && !live.has(id))) return false;
      seen.add(id); return true;
    });
  }

  function normalizeProfile(value = {}) {
    const order = {};
    if (value.listOrder && typeof value.listOrder === "object" && !Array.isArray(value.listOrder)) {
      for (const [parent, ids] of Object.entries(value.listOrder)) {
        if (typeof parent === "string" && parent) order[parent] = cleanIds(ids);
      }
    }
    return {
      schemaVersion: 1,
      revision: Math.max(0, Number(value.revision) || 0),
      pinnedClassificationIds: cleanIds(value.pinnedClassificationIds),
      listOrder: order,
      preferences: {
        autoLikeOnSave: value.preferences?.autoLikeOnSave !== false,
        xTranslateEnabled: value.preferences?.xTranslateEnabled !== false,
      },
    };
  }

  function createModel(entries, profile = {}) {
    const liveEntries = cleanEntries(entries);
    const byId = new Map(liveEntries.map((entry) => [entry.id, entry]));
    const normalized = normalizeProfile(profile);
    const groups = new Map();
    for (const entry of liveEntries) {
      const key = entry.parentId ?? "__root__";
      const values = groups.get(key) || [];
      values.push(entry); groups.set(key, values);
    }

    function ordered(parentId = null) {
      const key = parentId ?? "__root__";
      const siblings = [...(groups.get(key) || [])];
      const rank = new Map((normalized.listOrder[key] || []).map((id, index) => [id, index]));
      const original = new Map(siblings.map((entry, index) => [entry.id, index]));
      siblings.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        || (original.get(a.id) ?? 0) - (original.get(b.id) ?? 0));
      return siblings;
    }

    function rootItems() {
      const pinned = cleanIds(normalized.pinnedClassificationIds, byId).map((id) => byId.get(id)).filter(Boolean);
      const pinnedSet = new Set(pinned.map((entry) => entry.id));
      const items = [
        ...pinned.map((entry) => ({ entry, shortcut: true })),
        ...ordered(null).filter((entry) => !pinnedSet.has(entry.id)).map((entry) => ({ entry, shortcut: false })),
      ];
      const rank = new Map((normalized.listOrder.__root__ || []).map((id, index) => [id, index]));
      if (!pinned.some(entry => rank.has(entry.id))) return items;
      return items.sort((a, b) => (rank.get(a.entry.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.entry.id) ?? Number.MAX_SAFE_INTEGER));
    }

    function children(parentId) { return ordered(parentId); }
    function hasChildren(id) { return children(id).length > 0; }
    function path(id) {
      const result = [], seen = new Set();
      let current = byId.get(id) || null;
      while (current && !seen.has(current.id) && result.length < 32) {
        seen.add(current.id); result.unshift(current); current = current.parentId ? byId.get(current.parentId) || null : null;
      }
      return result;
    }
    function reorder(parentId, id, targetIndex) {
      const key = parentId ?? "__root__";
      const ids = ordered(parentId).map((entry) => entry.id);
      const from = ids.indexOf(id);
      const to = Math.max(0, Math.min(ids.length - 1, Number(targetIndex) || 0));
      if (from < 0 || from === to) return normalized.listOrder;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      return { ...normalized.listOrder, [key]: ids };
    }
    return { entries: liveEntries, profile: normalized, byId, ordered, rootItems, children, hasChildren, path, reorder };
  }

  // Snapshot refresh keeps positions; portable pin/order edits explicitly reset
  // the affected page layout. Removed folders leave holes for new folders.
  function reconcileArcLayout(entries, profile = {}, previous = {}) {
    const model = createModel(entries, profile);
    const layout = Object.create(null);
    const parents = new Set([null, ...model.entries.map(entry => entry.parentId)]);
    for (const parent of parents) {
      const key = parent ?? "__root__";
      const ids = parent === null ? model.rootItems().map(item => item.entry.id) : model.children(parent).map(entry => entry.id);
      const intent = JSON.stringify([parent === null ? model.profile.pinnedClassificationIds : [], model.profile.listOrder[key] || []]);
      const old = previous?.[key];
      if (!old || old.intent !== intent || !Array.isArray(old.slots)) {
        layout[key] = { intent, slots: ids };
        continue;
      }
      const remaining = new Set(ids);
      const slots = old.slots.map(id => remaining.delete(id) ? id : null);
      for (const id of ids) {
        if (!remaining.has(id)) continue;
        const hole = slots.indexOf(null);
        if (hole < 0) slots.push(id); else slots[hole] = id;
      }
      layout[key] = { intent, slots };
    }
    return layout;
  }

  // Hiding a parent also hides pinned descendants, without changing membership.
  function visibleEntries(entries, hiddenIds = []) {
    const model = createModel(entries);
    const hidden = new Set(cleanIds(hiddenIds));
    return model.entries.filter(entry => !model.path(entry.id).some(ancestor => hidden.has(ancestor.id)));
  }

  globalThis.LakomicsClassificationTree = { visibleEntries, cleanEntries, cleanIds, normalizeProfile, createModel, reconcileArcLayout };
})();
