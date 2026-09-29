import { describe, expect, it } from "vitest";
import type { AssetSummary } from "../library/types";
import { buildJustifiedRows } from "./justifiedRows";
import { buildJustifiedGalleryRows } from "./galleryRows";

const item = (id: string, day: number, width = 100, height = 100) => ({
  id,
  width,
  height,
  collectedAt: new Date(2026, 8, day, 21, 7).toISOString(),
} as AssetSummary);

describe("date justified rows", () => {
  it("packs consecutive small date groups into one target-height row with separate headings", () => {
    const items = [1, 2, 3, 4].map((day) => item(`asset-${day}`, day));
    const rows = buildJustifiedGalleryRows(items, 600, 100, 8, true, false);

    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBe(100);
    expect(rows[0].dateHeadings).toHaveLength(4);
    expect(rows[0].dateHeadings?.map(({ left, width, count }) => ({ left, width, count }))).toEqual([
      { left: 0, width: 100, count: 1 },
      { left: 132, width: 100, count: 1 },
      { left: 264, width: 100, count: 1 },
      { left: 396, width: 100, count: 1 },
    ]);
    expect(rows[0].dateHeadings?.every((heading, index, headings) => index === 0 || heading.left >= headings[index - 1].left + headings[index - 1].width)).toBe(true);
  });

  it("keeps a large date group's first row heading full width", () => {
    const items = Array.from({ length: 4 }, (_, index) => item(`large-${index}`, 1));
    const rows = buildJustifiedGalleryRows(items, 300, 100, 8, true, false);

    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].dateHeadings).toEqual([expect.objectContaining({ left: 0, width: 300, count: 4 })]);
    expect(rows.slice(1).every((row) => !row.dateHeadings)).toBe(true);
  });

  it("matches the ordinary justified rows when dates are not grouped", () => {
    const items = [item("a", 1), item("b", 2), item("c", 3)];
    expect(buildJustifiedGalleryRows(items, 600, 100, 8, false, false)).toEqual(buildJustifiedRows(items, 600, 100, 8));
  });
});
