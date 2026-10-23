import { describe, expect, it } from "vitest";
import { MANGA_RUN_GAP, packMangaShelves } from "./mangaShelfLayout";
import { MANGA_MM, MANGA_PX_PER_MM } from "./mangaDimensions";

describe("manga shelf packing", () => {
  it.each([false, true])("keeps work order, separates runs and continues long works (tablet=%s)", tablet => {
    const spine = MANGA_MM.spine * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"];
    const width = 5 * (spine + 1) - 1 + MANGA_RUN_GAP;
    const works = [{ id: "a", count: 2 }, { id: "b", count: 9 }, { id: "c", count: 1 }];
    const rows = packMangaShelves(works, work => work.count, width, 1, tablet);
    expect(rows.map(row => row.map(run => [run.work.id, run.start, run.count, run.continued]))).toEqual([
      [["a", 0, 2, false], ["b", 0, 3, false]],
      [["b", 3, 5, true]],
      [["b", 8, 1, true], ["c", 0, 1, false]],
    ]);
    for (const row of rows) expect(row.reduce((sum, run) => sum + run.width, 0) + (row.length - 1) * MANGA_RUN_GAP).toBeLessThanOrEqual(width);
  });

  it("starts a new shelf when the inter-work gap leaves no room for another book", () => {
    const spine = MANGA_MM.spine * MANGA_PX_PER_MM.pc;
    const rows = packMangaShelves(["a", "b"], () => 1, spine * 2 + MANGA_RUN_GAP - 1, 1);
    expect(rows.map(row => row.map(run => run.work))).toEqual([["a"], ["b"]]);
  });
});
