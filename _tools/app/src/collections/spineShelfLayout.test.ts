import { describe, expect, it } from "vitest";
import type { CasePlatform } from "./case/CollectionCase";
import { cellAtX, nearestCell, packSpineShelf, SPINE_SHELF, spineScaleForView, type PackedWork } from "./spineShelfLayout";

const works = (count: number, platform: CasePlatform = "pc", prefix = "w"): PackedWork[] => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, platform }));

it("starts a new row when the next spine would cross the right edge, keeping list order", () => {
  // A DVD case at 1.0 px/mm is 14px thick; with a 1px seam, 10 fit in 150px and the 11th starts a row.
  const packed = packSpineShelf([{ label: "", works: works(25) }], 150, 1);
  expect(packed.rows.map(row => row.cells.length)).toEqual([10, 10, 5]);
  expect(packed.order).toEqual(works(25).map(work => work.id));
  expect(packed.rows[1].cells[0].x).toBe(0);
});

it("makes a Nintendo row lower than a DVD row and pushes the next row below it", () => {
  const packed = packSpineShelf([{ label: "", works: [...works(5, "sw", "n"), ...works(5, "pc", "d")] }], 40, 1);
  const nintendo = packed.rows[0], dvd = packed.rows.find(row => row.cells.some(cell => cell.work.platform === "pc"))!;
  expect(nintendo.board).toBeLessThan(dvd.board);
  expect(nintendo.height).toBe(SPINE_SHELF.rowTop + nintendo.board + SPINE_SHELF.plank + SPINE_SHELF.rowGap);
  expect(packed.rows[1].top).toBe(nintendo.top + nintendo.height);
});

it("puts a label band above each group and never mixes groups in a row", () => {
  const packed = packSpineShelf([{ label: "닌텐도", works: works(3, "sw", "n") }, { label: "", works: [] }, { label: "PS · Xbox · PC", works: works(3, "ps5", "p") }], 400, 1.1);
  expect(packed.entries.map(entry => entry.kind)).toEqual(["label", "row", "label", "row"]);
  expect(packed.rows.map(row => row.cells.map(cell => cell.work.id))).toEqual([["n0", "n1", "n2"], ["p0", "p1", "p2"]]);
  expect(packed.rows[0].top).toBe(SPINE_SHELF.top + SPINE_SHELF.labelHeight);
});

it("finds the nearest case in a row for arrow keys and taps", () => {
  const packed = packSpineShelf([{ label: "", works: works(10) }], 1000, 1);
  const row = packed.rows[0];
  expect(nearestCell(row, 0)?.work.id).toBe("w0");
  expect(nearestCell(row, 15 * 4 + 7)?.work.id).toBe("w4");
  expect(nearestCell(row, 9999)?.work.id).toBe("w9");
  expect(nearestCell(undefined, 10)).toBeNull();
});

it("resolves a tap to the spine under it, and to nothing on the bare shelf beyond the first or last spine", () => {
  const row = packSpineShelf([{ label: "", works: works(10) }], 1000, 1).rows[0];
  expect(cellAtX(row, 15 * 4 + 7)?.work.id).toBe("w4");
  expect(cellAtX(row, 0)?.work.id).toBe("w0");
  const end = row.cells[9].x + row.cells[9].width;
  expect(cellAtX(row, end)?.work.id).toBe("w9");
  expect(cellAtX(row, end + 3)).toBeNull();
  expect(cellAtX(row, 9999)).toBeNull();
  expect(cellAtX(row, -3)).toBeNull();
  expect(cellAtX(undefined, 10)).toBeNull();
});

describe("spineScaleForView", () => {
  it("keeps the chosen size when the pulled-out case fits and shrinks it on a short list", () => {
    const pull = { grow: 1.28, lift: 12 };
    expect(spineScaleForView(1.3, 900, pull)).toBe(1.3);
    const short = spineScaleForView(3.15, 520, pull);
    expect(short).toBeLessThan(3.15);
    expect(190 * short * pull.grow + pull.lift).toBeLessThanOrEqual(520);
    expect(spineScaleForView(3.15, 0, pull)).toBe(3.15);
  });
});
