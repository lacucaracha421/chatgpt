import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetSummary } from "../library/types";
import { buildMasonryLayout, collectedDate, headingWeekday, masonryMove } from "./masonryLayout";

const item = (id: string, day = 5, height = 300) => ({ id, width: 200, height, collectedAt: new Date(2026, 8, day, 21, 7).toISOString() } as AssetSummary);
afterEach(() => vi.useRealTimers());
describe("date masonry", () => {
  it("uses the shared app date without changing grouping keys or geometry", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 23));
    const items = [item("a"), item("b"), item("c", 4)];
    const current = buildMasonryLayout(items, 640, 180, 20, true, true);
    expect(current.headings.map(heading => heading.label)).toEqual(["9.5", "9.4"]);
    expect(collectedDate(items[0].collectedAt)).toMatchObject({ key: "2026.09.05", label: "9.5", time: "21:07", full: "9.5 21:07" });
    const fullDates = buildMasonryLayout(items, 640, 180, 20, true, true, true);
    expect(fullDates.headings.map(heading => heading.label)).toEqual(["9.5", "9.4"]);
    expect(fullDates.tiles).toEqual(current.tiles);
    vi.setSystemTime(new Date(2027, 0, 1));
    const next = buildMasonryLayout(items, 640, 180, 20, true, true);
    expect(next.headings.map(heading => heading.label)).toEqual(["2026.9.5", "2026.9.4"]);
    expect(next.tiles).toEqual(current.tiles);
    expect(collectedDate(items[0].collectedAt).full).toBe("2026.9.5 21:07");
    expect(next.headings.map(({ label: _label, ...heading }) => heading)).toEqual(current.headings.map(({ label: _label, ...heading }) => heading));
  });
  it("marks today and otherwise the local weekday, with the group count", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 5, 23));
    const result = buildMasonryLayout([item("a"), item("b"), item("c", 4)], 640, 180, 20, true, true);
    expect(result.headings.map(({ weekday, count }) => [weekday, count])).toEqual([["오늘", 2], ["금", 1]]);
    expect(headingWeekday("")).toBe("");
  });
  it("packs five single-asset dates into one band and starts a seven-item date in the next band", () => {
    const items = [
      ...[5, 4, 3, 2, 1].map((day, index) => item(`small-${index}`, day)),
      ...Array.from({ length: 7 }, (_, index) => item(`large-${index}`, 0)),
    ];
    const result = buildMasonryLayout(items, 1_200, 180, 20, true, true);
    const firstBand = result.headings.slice(0, 5);

    expect(firstBand.every((heading) => heading.top === 0)).toBe(true);
    expect(new Set(firstBand.map((heading) => heading.left)).size).toBe(5);
    expect(firstBand.every((heading) => heading.width < 1_200)).toBe(true);
    expect(result.headings[5]).toMatchObject({ left: 0, width: 1_200 });
    expect(result.headings[5].top).toBeGreaterThan(0);
    expect(result.tiles.slice(0, 5).map((tile) => tile.left)).toEqual(firstBand.map((heading) => heading.left));
    expect(result.tiles.slice(5).every((tile) => tile.left + tile.width <= 1_200)).toBe(true);
  });
  it("packs date segments left to right while preserving a new band for overflow", () => {
    const result = buildMasonryLayout([item("a", 5, 80), item("b", 5, 300), item("c", 4), item("d", 3)], 640, 180, 20, true, true);
    expect(result.headings.slice(0, 2)).toEqual([
      expect.objectContaining({ left: 0, width: 420, top: 0 }),
      expect.objectContaining({ left: 440, width: 200, top: 0 }),
    ]);
    expect(result.headings[2].left).toBe(0);
    expect(result.headings[2].top).toBeGreaterThan(0);
    expect(result.tiles.map((tile) => tile.asset.id)).toEqual(["a", "b", "c", "d"]);
  });
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

it("uses exactly the requested number of columns regardless of the pixel target", () => {
  const items = Array.from({ length: 24 }, (_, index) => ({ id: String(index), width: 100, height: 100, collectedAt: "2026-10-01" })) as Parameters<typeof buildMasonryLayout>[0];
  for (const count of [3, 6, 12]) {
    const layout = buildMasonryLayout(items, 1200, 180, 2, false, false, false, count);
    expect(new Set(layout.tiles.map(tile => tile.left)).size).toBe(count);
    expect(layout.tiles[0].width * count + 2 * (count - 1)).toBeCloseTo(1200);
  }
});
