export type SelectionState = {
  ids: ReadonlySet<string>;
  anchorId: string | null;
  focusId: string | null;
};

export type SelectionGesture = { toggle: boolean; range: boolean };

export function emptySelection(): SelectionState {
  return { ids: new Set(), anchorId: null, focusId: null };
}

export function applySelectionGesture(
  state: SelectionState,
  orderedIds: readonly string[],
  id: string,
  gesture: SelectionGesture,
): SelectionState {
  if (!orderedIds.includes(id)) return reconcileSelection(state, orderedIds);
  if (gesture.range) {
    const anchorId = state.anchorId && orderedIds.includes(state.anchorId) ? state.anchorId : id;
    const rangeIds = inclusiveRange(orderedIds, anchorId, id);
    return {
      ids: gesture.toggle ? new Set([...state.ids, ...rangeIds]) : new Set(rangeIds),
      anchorId,
      focusId: id,
    };
  }
  if (gesture.toggle) {
    const nextIds = new Set(state.ids);
    if (nextIds.has(id)) nextIds.delete(id);
    else nextIds.add(id);
    return { ids: nextIds, anchorId: id, focusId: id };
  }
  return { ids: new Set([id]), anchorId: id, focusId: id };
}

export function selectAllLoaded(
  state: SelectionState,
  orderedIds: readonly string[],
): SelectionState {
  if (orderedIds.length === 0) return emptySelection();
  const anchorId = state.anchorId && orderedIds.includes(state.anchorId)
    ? state.anchorId
    : orderedIds[0];
  return { ids: new Set(orderedIds), anchorId, focusId: orderedIds[orderedIds.length - 1] ?? anchorId };
}

export function reconcileSelection(
  state: SelectionState,
  orderedIds: readonly string[],
): SelectionState {
  const loaded = new Set(orderedIds);
  const ids = new Set([...state.ids].filter((id) => loaded.has(id)));
  const fallback = orderedIds.find((id) => ids.has(id)) ?? null;
  return {
    ids,
    anchorId: state.anchorId && ids.has(state.anchorId) ? state.anchorId : fallback,
    focusId: state.focusId && ids.has(state.focusId) ? state.focusId : fallback,
  };
}

export function moveSelectionFocus(
  state: SelectionState,
  orderedIds: readonly string[],
  delta: number,
  extend: boolean,
): SelectionState {
  if (orderedIds.length === 0) return emptySelection();
  const currentIndex = Math.max(0, orderedIds.indexOf(state.focusId ?? ""));
  const nextIndex = Math.max(0, Math.min(orderedIds.length - 1, currentIndex + delta));
  const nextId = orderedIds[nextIndex];
  if (!nextId) return emptySelection();
  return applySelectionGesture(state, orderedIds, nextId, { toggle: false, range: extend });
}

function inclusiveRange(orderedIds: readonly string[], from: string, to: string): string[] {
  const first = orderedIds.indexOf(from);
  const last = orderedIds.indexOf(to);
  if (first < 0 || last < 0) return [];
  return orderedIds.slice(Math.min(first, last), Math.max(first, last) + 1);
}
