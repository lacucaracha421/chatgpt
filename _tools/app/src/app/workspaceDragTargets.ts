import type { AlbumEntry, ClassificationEntry } from "../library/types";
import type { ClassificationDropTarget, InternalDragPayload } from "../shared/interaction/pointerDrag";

export type SidebarDropTarget = Exclude<ClassificationDropTarget, { kind: "character" }>;

export function sidebarTargetAt(x: number, y: number, payload: InternalDragPayload, entries: ClassificationEntry[], albums: AlbumEntry[]): SidebarDropTarget | null {
  const element = document.elementFromPoint?.(x, y)?.closest<HTMLElement>("[data-classification-id], [data-album-id]");
  const kind = element?.dataset.albumId ? "album" : "classification";
  const entryId = kind === "album" ? element?.dataset.albumId : element?.dataset.classificationId;
  if (!element || !entryId) return null;
  const rect = element.getBoundingClientRect();
  const fraction = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  const position = payload.kind === "classification" && kind === "classification"
    ? fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : "inside"
    : "inside";
  const target = { kind, entryId, position, valid: true } as const;
  const valid = payload.kind === "assets"
    || payload.kind === kind && (kind === "album"
      ? validTreeDrop(payload.entryId, entryId, albums)
      : validClassificationDrop(payload.entryId, target, entries));
  return { ...target, valid };
}

function validClassificationDrop(entryId: string, target: SidebarDropTarget, entries: ClassificationEntry[]) {
  const entry = entries.find((candidate) => candidate.id === entryId);
  const destination = entries.find((candidate) => candidate.id === target.entryId);
  if (!entry || !destination || entry.id === destination.id) return false;
  const parentId = target.position === "inside" ? destination.id : destination.parentId;
  const parent = entries.find((candidate) => candidate.id === parentId);
  if (target.position === "inside" && entry.parentId === parentId) return false;
  if (isDescendant(parentId, entry.id, entries)) return false;
  if (entries.some((candidate) => candidate.id !== entry.id && candidate.parentId === parentId && candidate.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase())) return false;
  return entry.kind !== "work" || parent?.kind === "root";
}

function validTreeDrop(entryId: string, parentId: string, entries: Array<{ id: string; name: string; parentId: string | null }>) {
  const entry = entries.find((candidate) => candidate.id === entryId);
  const parent = entries.find((candidate) => candidate.id === parentId);
  return Boolean(entry && parent
    && entry.parentId !== parent.id
    && parent.id !== entry.id
    && !isDescendant(parent.id, entry.id, entries)
    && !entries.some((candidate) => candidate.id !== entry.id && candidate.parentId === parent.id && candidate.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase()));
}

function isDescendant(candidateId: string | null, ancestorId: string, entries: Array<{ id: string; parentId: string | null }>) {
  let current = entries.find((entry) => entry.id === candidateId);
  while (current) {
    if (current.id === ancestorId) return true;
    current = entries.find((entry) => entry.id === current?.parentId);
  }
  return false;
}

export function nativeDropClientPoint(position: { x: number; y: number }) {
  const scale = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  return { x: position.x / scale, y: position.y / scale };
}

export function sameAssetIds(left: string[] | null, right: string[]) {
  return Boolean(left && left.length === right.length && left.every((id, index) => id === right[index]));
}

export function outsideViewport(x: number, y: number) {
  return x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;
}
