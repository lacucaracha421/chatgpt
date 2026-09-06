import { describe, expect, it } from "vitest";
import type { AssetSummary } from "../library/types";
import { buildMasonryLayout, collectedDate, masonryMove } from "./masonryLayout";

const item = (id: string, day = 5, height = 300) => ({ id, width: 200, height, collectedAt: new Date(2026, 8, day, 21, 7).toISOString() } as AssetSummary);
describe("date masonry", () => {
  it("keeps earlier positions when a page extends the same date", () => {
    const first = [item("a"), item("b", 5, 80), item("c")];
    const initial = buildMasonryLayout(first, 640, 180, 20, true, true);
    const appended = buildMasonryLayout([...first, item("d"), item("e", 4)], 640, 180, 20, true, true);
    expect(appended.tiles.slice(0, 3)).toEqual(initial.tiles);
    expect(appended.headings).toHaveLength(2);
    expect(appended.headings[1].top).toBeGreaterThanOrEqual(Math.max(...appended.tiles.slice(0, 4).map((tile) => tile.top + tile.height)));
  });
  it("uses equal widths and preserves source aspect ratios without overlap", () => {
    const result = buildMasonryLayout([item("a"), item("b", 5, 80), item("c"), item("d")], 600, 180, 20, true, true);
    expect(new Set(result.tiles.map((tile) => tile.width)).size).toBe(1);
    for (const tile of result.tiles) {
      expect(tile.imageHeight / tile.width).toBeCloseTo(tile.asset.height / tile.asset.width);
      expect(tile.left + tile.width).toBeLessThanOrEqual(600);
      for (const other of result.tiles.filter((entry) => entry.index > tile.index && entry.left === tile.left)) expect(other.top).toBeGreaterThanOrEqual(tile.top + tile.height + 20);
    }
  });
  it("does not regroup random or favorite order", () => {
    const result = buildMasonryLayout([item("a", 4), item("b", 5), item("c", 4)], 600, 180, 20, false, false);
    expect(result.headings).toEqual([]);
    expect(result.tiles.map((tile) => tile.asset.id)).toEqual(["a", "b", "c"]);
  });
  it("shares local date and 24-hour time and handles missing timestamps", () => {
    expect(collectedDate(item("a").collectedAt)).toMatchObject({ key: "2026.09.05", time: "21:07" });
    expect(collectedDate(null)).toMatchObject({ time: "—", label: "수집일 미상" });
    expect(collectedDate("invalid").time).toBe("—");
  });
  it("moves vertically in the same visual column", () => {
    const result = buildMasonryLayout([item("a"), item("b"), item("c"), item("d")], 400, 180, 20, true, true);
    expect(masonryMove(result.tiles, "a", 1)).toBe(2);
    expect(masonryMove(result.tiles, "c", -1)).toBe(-2);
  });
});
