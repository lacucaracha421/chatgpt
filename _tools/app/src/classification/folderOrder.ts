import type { ClassificationEntry } from "../library/types";
import type { ClassificationDropTarget } from "../shared/interaction/pointerDrag";
import type { UiPreferences } from "../preferences/uiPreferences";

export function applyInitialCountOrder(entries: ClassificationEntry[], preferences: UiPreferences): UiPreferences {
  if (preferences.classificationCountOrderApplied || entries.length === 0 || entries.some((entry) => !Number.isFinite(entry.assetCount))) return preferences;
  const ranks = new Map(preferences.classificationOrderIds.map((id, index) => [id, index]));
  const sorted = [...entries].sort((a, b) => b.assetCount! - a.assetCount!
    || (ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    || a.name.localeCompare(b.name, "ko"));
  return { ...preferences, classificationOrderIds: sorted.map((entry) => entry.id), classificationCountOrderApplied: true };
}

export function reorderFolders(entries: ClassificationEntry[], order: string[], sourceId: string, target: ClassificationDropTarget, parentId: string | null): string[] {
  const ranks = new Map(order.map((id, index) => [id, index]));
  const siblings = entries.filter((entry) => entry.parentId === parentId && entry.id !== sourceId)
    .sort((a, b) => (ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name, "ko"))
    .map((entry) => entry.id);
  const index = siblings.indexOf(target.entryId);
  siblings.splice(target.position === "inside" || index < 0 ? siblings.length : index + (target.position === "after" ? 1 : 0), 0, sourceId);
  const reordered = new Set(siblings);
  const existing = new Set(entries.map((entry) => entry.id));
  return [...order.filter((id) => existing.has(id) && !reordered.has(id)), ...siblings];
}
