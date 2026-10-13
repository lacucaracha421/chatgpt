/**
 * Shared order rules (user-accepted design, 2026-10-13). A card reorders inside its own band.
 * Series shelves keep groups before loose characters and leave their other cards fixed;
 * plain-folder shelves reorder their child folders. The DOM gesture lives in `shelfDrag.ts`.
 */

/** The draggable bands of folder and character shelves. */
export type OrderKind = "group" | "character" | "folder";
export type OrderMove = "prev" | "next" | "first" | "last";

export const SHELF_MOVE_ITEMS: { move: OrderMove; label: string; shortcut?: string }[] = [
  { move: "prev", label: "앞으로", shortcut: "Alt+←" },
  { move: "next", label: "뒤로", shortcut: "Alt+→" },
  { move: "first", label: "맨 앞으로" },
  { move: "last", label: "맨 뒤로" },
];
export const SHELF_KEY_MOVES: Record<string, OrderMove> = { ArrowLeft: "prev", ArrowRight: "next", Home: "first", End: "last" };

/** A card must be held this long without moving before it lifts; moving earlier pans the shelf as before. */
export const HOLD_MS = 250;
export const PRESS_SLOP_PX = 4;
/** Auto-scroll zones at both ends of the shelf while a card is carried. */
export const EDGE_ZONE_PX = 48;
/** The central share of a group card that means "put in this group". */
export const INTO_GROUP_ZONE = 0.6;

/** `ids` after `id` takes `index` (clamped); `null` when nothing moves or `id` is not listed. */
export function movedToIndex(ids: readonly string[], id: string, index: number): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(ids.length - 1, index));
  if (to === from) return null;
  const rest = ids.filter(value => value !== id);
  rest.splice(to, 0, id);
  return rest;
}

/** The band after a one-step or end-to-end move; `null` when the card is already there. */
export function movedIds(ids: readonly string[], id: string, move: OrderMove): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = move === "prev" ? from - 1 : move === "next" ? from + 1 : move === "first" ? 0 : ids.length - 1;
  return to < 0 || to >= ids.length ? null : movedToIndex(ids, id, to);
}

/** Whether `move` would change the band (a menu item is disabled when it would not). */
export const canMove = (ids: readonly string[], id: string, move: OrderMove) => movedIds(ids, id, move) !== null;

/** A card's place in content coordinates (the left edge is measured from the start of the scrolling track). */
export type SlotBox = { id: string; left: number; width: number };

/**
 * Where the carried card would land among its band: the number of the other cards whose middle is
 * before `x` (content coordinates), so 0 is the front and `slots.length - 1` the back.
 */
export function insertionIndex(slots: readonly SlotBox[], draggedId: string, x: number): number {
  return slots.filter(slot => slot.id !== draggedId && slot.left + slot.width / 2 < x).length;
}

/** Whether `x` (same coordinates as the slot) is in the central share of the slot. */
export function inCentralZone(left: number, width: number, x: number, share = INTO_GROUP_ZONE): boolean {
  const margin = width * (1 - share) / 2;
  return x >= left + margin && x <= left + width - margin;
}

/**
 * How far each card of the band shifts (px, content coordinates) while the carried card is over
 * `targetIndex`: the neighbours between the old and the new place step aside by one slot and the
 * carried card's own (placeholder) slot moves to the gap. Cards that stay are absent.
 */
export function slideOffsets(slots: readonly SlotBox[], draggedId: string, targetIndex: number): Map<string, number> {
  const offsets = new Map<string, number>();
  const next = movedToIndex(slots.map(slot => slot.id), draggedId, targetIndex);
  if (!next) return offsets;
  next.forEach((id, index) => {
    const slot = slots.find(item => item.id === id)!;
    const shift = slots[index]!.left - slot.left;
    if (shift !== 0) offsets.set(id, shift);
  });
  return offsets;
}

/** Scroll speed (px per frame, negative to the left) for a pointer near the shelf's ends; 0 elsewhere. */
export function edgeScrollSpeed(x: number, left: number, right: number, zone = EDGE_ZONE_PX, max = 16): number {
  if (x < left || x > right) return 0;
  if (x < left + zone) return -Math.max(1, Math.round(max * (left + zone - x) / zone));
  if (x > right - zone) return Math.max(1, Math.round(max * (x - (right - zone)) / zone));
  return 0;
}

/** The spoken result of a keyboard move: "<이름>, 캐릭터 3번째". */
export function orderAnnouncement(kind: OrderKind, name: string, index: number): string {
  return `${name}, ${kind === "group" ? "그룹" : kind === "folder" ? "폴더" : "캐릭터"} ${index + 1}번째`;
}

/**
 * `items` with the ones listed in `ids` rearranged into that order. The listed items keep the
 * slots they occupy in the list (the others stay where they are); an id without an item is skipped
 * and an item missing from `ids` is left alone.
 */
export function withListedOrder<T extends { id: string }>(items: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const order = [...new Set(ids)].flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  const listed = new Set(order.map(item => item.id));
  let next = 0;
  const result = items.map(item => listed.has(item.id) ? order[next++]! : item);
  return result.every((item, index) => item === items[index]) ? items as T[] : result;
}

/**
 * `targets` with one series' band rearranged into the order of `ids`: only that series' characters
 * named in `ids` take part, so other series (and a character that has since left the band) are untouched.
 */
export function withCharacterOrder<T extends { id: string; seriesClassificationId: string | null }>(targets: readonly T[], seriesId: string, ids: readonly string[]): T[] {
  const named = new Set(ids);
  const own = targets.filter(target => target.seriesClassificationId === seriesId && named.has(target.id));
  const ordered = withListedOrder(own, ids);
  if (ordered === own) return targets as T[];
  const own2 = new Set(own.map(target => target.id));
  let next = 0;
  return targets.map(target => own2.has(target.id) ? ordered[next++]! : target);
}
