import { describe, expect, it } from "vitest";
import { buildJustifiedRows } from "./justifiedRows";

describe("buildJustifiedRows", () => {
  it("fills a completed row without changing aspect ratios", () => {
    const rows = buildJustifiedRows(
      [
        { id: "a", width: 400, height: 200 },
        { id: "b", width: 200, height: 200 },
        { id: "c", width: 300, height: 200 },
      ],
      900,
      180,
      8,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].items[0].width / rows[0].height).toBeCloseTo(2, 2);
    const used =
      rows[0].items.reduce((sum, item) => sum + item.width, 0) +
      8 * (rows[0].items.length - 1);
    expect(used).toBeCloseTo(900, 0);
  });

  it("keeps the final incomplete row at target height", () => {
    const rows = buildJustifiedRows(
      [{ id: "a", width: 400, height: 200 }],
      900,
      180,
      8,
    );

    expect(rows[0].height).toBe(180);
  });

  it("starts another row after the completed row", () => {
    const rows = buildJustifiedRows(
      [
        { id: "a", width: 400, height: 200 },
        { id: "b", width: 400, height: 200 },
        { id: "c", width: 400, height: 200 },
        { id: "d", width: 100, height: 200 },
      ],
      900,
      180,
      8,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(rows[1].items.map((item) => item.id)).toEqual(["d"]);
    expect(rows[1].height).toBe(180);
  });

  it("keeps a final row below ninety percent at target height", () => {
    const rows = buildJustifiedRows(
      [{ id: "a", width: 899, height: 100 }],
      1_000,
      100,
      0,
    );

    expect(rows[0].height).toBe(100);
  });

  it("completes a final row at the ninety percent boundary", () => {
    const rows = buildJustifiedRows(
      [{ id: "a", width: 900, height: 100 }],
      1_000,
      100,
      0,
    );

    expect(rows[0].height).toBeCloseTo(111.11, 2);
    expect(rows[0].items[0].width).toBeCloseTo(1_000, 2);
  });

  it.each([
    [0, 100, 8],
    [-1, 100, 8],
    [Number.NaN, 100, 8],
    [Number.POSITIVE_INFINITY, 100, 8],
    [1_000, 0, 8],
    [1_000, Number.NaN, 8],
    [1_000, Number.POSITIVE_INFINITY, 8],
    [1_000, 100, -1],
    [1_000, 100, Number.NaN],
    [1_000, 100, Number.POSITIVE_INFINITY],
    [1_000, 100, 1_000],
  ])(
    "rejects invalid layout metrics (%s, %s, %s)",
    (containerWidth, targetHeight, gap) => {
      expect(
        buildJustifiedRows(
          [{ id: "a", width: 100, height: 100 }],
          containerWidth,
          targetHeight,
          gap,
        ),
      ).toEqual([]);
    },
  );

  it.each([
    { id: "zero-width", width: 0, height: 100 },
    { id: "negative-width", width: -1, height: 100 },
    { id: "nan-width", width: Number.NaN, height: 100 },
    { id: "infinite-width", width: Number.POSITIVE_INFINITY, height: 100 },
    { id: "zero-height", width: 100, height: 0 },
    { id: "negative-height", width: 100, height: -1 },
    { id: "nan-height", width: 100, height: Number.NaN },
    { id: "infinite-height", width: 100, height: Number.POSITIVE_INFINITY },
  ])("rejects invalid item dimensions for $id", (item) => {
    expect(buildJustifiedRows([item], 1_000, 100, 8)).toEqual([]);
  });

  it.each([
    {
      name: "an aspect ratio that underflows to zero",
      item: {
        id: "ratio-underflow",
        width: Number.MIN_VALUE,
        height: Number.MAX_VALUE,
      },
      containerWidth: 100,
      targetHeight: 1,
    },
    {
      name: "an aspect ratio that overflows",
      item: {
        id: "ratio-overflow",
        width: Number.MAX_VALUE,
        height: Number.MIN_VALUE,
      },
      containerWidth: 100,
      targetHeight: 1,
    },
    {
      name: "a target width that underflows to zero",
      item: { id: "width-underflow", width: Number.MIN_VALUE, height: 1 },
      containerWidth: 100,
      targetHeight: Number.MIN_VALUE,
    },
    {
      name: "a completed row height that underflows to zero",
      item: { id: "height-underflow", width: Number.MAX_VALUE, height: 1 },
      containerWidth: Number.MIN_VALUE,
      targetHeight: Number.MIN_VALUE,
    },
  ])("throws RangeError for $name", ({ item, containerWidth, targetHeight }) => {
    expect(() =>
      buildJustifiedRows([item], containerWidth, targetHeight, 0),
    ).toThrowError(RangeError);
    expect(() =>
      buildJustifiedRows([item], containerWidth, targetHeight, 0),
    ).toThrowError(/numeric range/i);
  });

  it("keeps every row height finite and positive when gaps fill a narrow row", () => {
    const rows = buildJustifiedRows(
      Array.from({ length: 20 }, (_, index) => ({
        id: String(index),
        width: 1,
        height: 10_000,
      })),
      100,
      180,
      8,
    );

    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.height).toBeGreaterThan(0);
      expect(Number.isFinite(row.height)).toBe(true);
      expect(row.items.every((item) => Number.isFinite(item.width))).toBe(true);
    }
  });

  it("keeps completed rows finite when aspect-ratio sums would overflow", () => {
    const rows = buildJustifiedRows(
      [
        { id: "a", width: 1e308, height: 1 },
        { id: "b", width: 1e308, height: 1 },
      ],
      Number.MAX_VALUE,
      1,
      0,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBeGreaterThan(0);
    expect(Number.isFinite(rows[0].height)).toBe(true);
    expect(
      rows[0].items.reduce((sum, item) => sum + item.width, 0) /
        Number.MAX_VALUE,
    ).toBeCloseTo(1);
  });
});
