/** A group as the order helpers see it. */
type OrderedGroup = { id: string; seriesId: string };

/** Ids of one series' groups, in the order the list shows them. */
export function seriesGroupIds(groups: readonly OrderedGroup[], seriesId: string): string[] {
  return groups.filter(group => group.seriesId === seriesId).map(group => group.id);
}

/** The series' group ids after `groupId` is dropped before or after `targetId`; `null` when nothing moves or either is not in the series. */
export function movedGroupIds(groups: readonly OrderedGroup[], seriesId: string, groupId: string, targetId: string, position: "before" | "after"): string[] | null {
  const ids = seriesGroupIds(groups, seriesId);
  if (groupId === targetId || !ids.includes(groupId) || !ids.includes(targetId)) return null;
  const rest = ids.filter(id => id !== groupId);
  rest.splice(rest.indexOf(targetId) + (position === "after" ? 1 : 0), 0, groupId);
  return rest.every((id, index) => id === ids[index]) ? null : rest;
}

/** The series' group ids after `groupId` moves one place up (-1) or down (1); `null` at the end of the list. */
export function steppedGroupIds(groups: readonly OrderedGroup[], seriesId: string, groupId: string, step: -1 | 1): string[] | null {
  const ids = seriesGroupIds(groups, seriesId);
  const index = ids.indexOf(groupId);
  const neighbour = ids[index + step];
  return index < 0 || neighbour === undefined ? null : movedGroupIds(groups, seriesId, groupId, neighbour, step < 0 ? "before" : "after");
}

/**
 * `groups` with one series' groups in the order of `ids`. The series' slots in the list stay
 * where they are (other series are untouched); a group missing from `ids` (made since) follows
 * the listed ones, and an id with no group (removed since) is skipped.
 */
export function withGroupOrder<T extends OrderedGroup>(groups: readonly T[], seriesId: string, ids: readonly string[]): T[] {
  const own = groups.filter(group => group.seriesId === seriesId);
  const rank = (group: T) => { const at = ids.indexOf(group.id); return at < 0 ? ids.length : at; };
  const ordered = own.map((group, index) => ({ group, index })).sort((a, b) => rank(a.group) - rank(b.group) || a.index - b.index).map(item => item.group);
  if (ordered.every((group, index) => group === own[index])) return groups as T[];
  let next = 0;
  return groups.map(group => group.seriesId === seriesId ? ordered[next++]! : group);
}
