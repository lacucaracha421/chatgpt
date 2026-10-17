import type { CasePlatform } from "./case/CollectionCase";
import { casePixels } from "./case/caseDimensions";

/** What the packing needs from a work; the shelf component adds the rest. */
export type PackedWork = { id: string; platform: CasePlatform };
export type ShelfGroup<W extends PackedWork> = { label: string; works: W[] };

/** Vertical rhythm of the spine shelf, in px (spec: docs/prototypes/spine-shelf-20261017). */
export const SPINE_SHELF = {
  /** Room above a row for the hover lift and the pulled-out cover. */
  rowTop: 16,
  plank: 6,
  /** Plank to the next row's tallest case. */
  rowGap: 24,
  labelHeight: 40,
  top: 8,
  bottom: 32,
  /** Cases touch: the seam between two spines is one line. */
  seam: 1,
} as const;

export type PackedCell<W extends PackedWork> = { work: W; x: number; width: number; height: number; coverWidth: number; row: number; column: number };
export type PackedRow<W extends PackedWork> = { kind: "row"; index: number; top: number; height: number; board: number; cells: PackedCell<W>[] };
export type PackedLabel = { kind: "label"; top: number; height: number; label: string; count: number };
export type PackedEntry<W extends PackedWork> = PackedRow<W> | PackedLabel;
export type PackedShelf<W extends PackedWork> = {
  entries: PackedEntry<W>[]; rows: PackedRow<W>[]; order: string[]; cells: Map<string, PackedCell<W>>; height: number;
};

/**
 * Packs each group left to right in list order. A new row starts when the next spine would cross the right
 * edge; a row is as tall as its tallest case, so a Nintendo row stands lower than a DVD row. Pure arithmetic
 * from the platform sizes and the width, with no per-spine measurement.
 */
export function packSpineShelf<W extends PackedWork>(groups: ShelfGroup<W>[], available: number, scale: number): PackedShelf<W> {
  const entries: PackedEntry<W>[] = [], rows: PackedRow<W>[] = [], order: string[] = [], cells = new Map<string, PackedCell<W>>();
  let top: number = SPINE_SHELF.top;
  for (const group of groups) {
    if (!group.works.length) continue;
    if (group.label) { entries.push({ kind: "label", top, height: SPINE_SHELF.labelHeight, label: group.label, count: group.works.length }); top += SPINE_SHELF.labelHeight; }
    const groupRows: PackedRow<W>[] = [];
    let row: PackedRow<W> | null = null, x = 0;
    for (const work of group.works) {
      const size = casePixels(work.platform, scale);
      if (!row || x + size.spine > available) {
        row = { kind: "row", index: rows.length + groupRows.length, top: 0, height: 0, board: 0, cells: [] };
        groupRows.push(row); x = 0;
      }
      row.cells.push({ work, x, width: size.spine, height: size.height, coverWidth: size.width, row: row.index, column: row.cells.length });
      x += size.spine + SPINE_SHELF.seam;
    }
    for (const packed of groupRows) {
      packed.board = Math.max(...packed.cells.map(cell => cell.height));
      packed.top = top;
      packed.height = SPINE_SHELF.rowTop + packed.board + SPINE_SHELF.plank + SPINE_SHELF.rowGap;
      top += packed.height;
      for (const cell of packed.cells) { cells.set(cell.work.id, cell); order.push(cell.work.id); }
      entries.push(packed); rows.push(packed);
    }
  }
  return { entries, rows, order, cells, height: top + SPINE_SHELF.bottom };
}

/** Hit slop between two neighbouring spines, in px; there is none past the first and last spine. */
const TOUCH_SLOP = 2;

/**
 * The case a tablet tap at `x` in the row band means: the spine under it, with a small slop only toward a neighbour.
 * Empty shelf past the last spine (or before the first) belongs to no case, so it stays empty space.
 */
export function cellAtX<W extends PackedWork>(row: PackedRow<W> | undefined, x: number): PackedCell<W> | null {
  if (!row) return null;
  const last = row.cells.length - 1;
  let best: PackedCell<W> | null = null, distance = Infinity;
  for (const [index, cell] of row.cells.entries()) {
    if (x < cell.x - (index > 0 ? TOUCH_SLOP : 0) || x > cell.x + cell.width + (index < last ? TOUCH_SLOP : 0)) continue;
    const gap = Math.abs(cell.x + cell.width / 2 - x);
    if (gap < distance) { distance = gap; best = cell; }
  }
  return best;
}

/** The case in `row` whose centre is nearest `x` (arrow keys up/down). */
export function nearestCell<W extends PackedWork>(row: PackedRow<W> | undefined, x: number): PackedCell<W> | null {
  if (!row) return null;
  let best: PackedCell<W> | null = null, distance = Infinity;
  for (const cell of row.cells) {
    const gap = Math.abs(cell.x + cell.width / 2 - x);
    if (gap < distance) { distance = gap; best = cell; }
  }
  return best;
}
