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
});
