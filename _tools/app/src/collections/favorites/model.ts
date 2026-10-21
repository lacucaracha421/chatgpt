import type { CharacterTarget } from "../../characters/api";
import type { ClassificationEntry, FavoriteCommand, FavoriteEntry } from "../../library/types";
import { daysUntil } from "../../shared/displayDate";

export function representativeAsset(entry: Pick<FavoriteEntry, "coverAssetId"> | undefined, target: Pick<CharacterTarget, "thumbnailAssetId">, firstAssetId?: string | null): string | null {
  return entry?.coverAssetId ?? target.thumbnailAssetId ?? firstAssetId ?? null;
}

/** Leap-day birthdays wait for the next actual February 29, rather than silently becoming March 1. */
export function birthdayDays(month?: number | null, day?: number | null, now = new Date()): number | null {
  if (!month || !day) return null;
  for (let year = now.getFullYear(); year <= now.getFullYear() + 8; year++) {
    const date: Date = new Date(year, month - 1, day);
    if (date.getMonth() !== month - 1 || date.getDate() !== day) continue;
    const days = daysUntil(date, now)!;
    if (days >= 0) return days <= 30 ? days : null;
  }
  return null;
}

export function containerId(target: CharacterTarget, classifications: ClassificationEntry[]): string | null {
  let folder = classifications.find(item => item.id === target.seriesClassificationId);
  while (folder?.parentId) folder = classifications.find(item => item.id === folder!.parentId);
  return folder?.isContainer ? folder.id : null;
}

export function favoriteScopes(targets: CharacterTarget[], classifications: ClassificationEntry[]) {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const id = containerId(target, classifications);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [{ value: "all", label: "전체", count: targets.length }, ...classifications
    .filter(folder => !folder.parentId && folder.isContainer && counts.has(folder.id))
    .map(folder => ({ value: folder.id, label: folder.name, count: counts.get(folder.id)! }))];
}

/** Replace only the visible slots. Hidden entries (including deleted characters) keep their places. */
export function reorderCommand(entries: FavoriteEntry[], visibleIds: readonly string[], reorderedIds: readonly string[]): FavoriteCommand | null {
  if (visibleIds.length !== reorderedIds.length || new Set(reorderedIds).size !== visibleIds.length
    || reorderedIds.some(id => !visibleIds.includes(id))) return null;
  const visible = new Set(visibleIds);
  let index = 0;
  const ids = entries.map(entry => visible.has(entry.characterId) ? reorderedIds[index++] : entry.characterId);
  return ids.every((id, i) => id === entries[i].characterId) ? null : { op: "order", ids };
}
