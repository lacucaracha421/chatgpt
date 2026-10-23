import { describe, expect, it } from "vitest";
import { MANGA_LABEL_WIDTH, MANGA_RUN_GAP, packMangaShelves } from "./mangaShelfLayout";
import { MANGA_MM, MANGA_PX_PER_MM } from "./mangaDimensions";

describe("manga shelf packing", () => {
  it.each([false, true])("keeps work and volume order across continuations (tablet=%s)", tablet => {
    const works = [{ id: "a", count: 2 }, { id: "b", count: 57 }, { id: "c", count: 1 }];
    const rows = packMangaShelves(works, work => work.count, 800, 1, tablet);
    const flattened = rows.flatMap(row => row.flatMap(run => Array.from({ length: run.count }, (_, index) => `${run.work.id}:${run.start + index}`)));
    expect(flattened).toEqual(works.flatMap(work => Array.from({ length: work.count }, (_, index) => `${work.id}:${index}`)));
    for (const row of rows) {
      expect(row.length).toBeGreaterThan(0);
      expect(row.reduce((sum, run) => sum + run.width, 0) + (row.length - 1) * MANGA_RUN_GAP).toBeLessThanOrEqual(800);
      for (const run of row) expect(run.continued).toBe(run.start > 0);
    }
  });

  it.each([false, true])("reserves readable labels for short runs at every size (tablet=%s)", tablet => {
    for (const scale of [.8, 1, 1.35]) {
      const works = [1, 2, 3].map(count => ({ count }));
      const rows = packMangaShelves(works, work => work.count, 800, scale, tablet);
      for (const run of rows.flat()) expect(run.width).toBeGreaterThanOrEqual(MANGA_LABEL_WIDTH * scale);
      expect(rows).toHaveLength(1);
    }
  });

  it.each([false, true])("moves a fitting work when a split would leave a tiny continuation (tablet=%s)", tablet => {
    const spine = MANGA_MM.spine * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"];
    const width = 17 * (spine + 1) - 1 + MANGA_RUN_GAP;
    const works = [{ id: "a", count: 10 }, { id: "b", count: 8 }];
    const rows = packMangaShelves(works, work => work.count, width, 1, tablet);
    expect(rows.map(row => row.map(run => [run.work.id, run.count]))).toEqual([[["a", 10]], [["b", 8]]]);
  });

  it.each([false, true])("does not start a run with a tiny fragment at the shelf edge (tablet=%s)", tablet => {
    const spine = MANGA_MM.spine * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"];
    const width = 12 * (spine + 1) - 1 + MANGA_RUN_GAP;
    const rows = packMangaShelves([10, 8], count => count, width, 1, tablet);
    expect(rows.map(row => row.map(run => run.count))).toEqual([[10], [8]]);
  });

  it.each([false, true])("splits only substantial parts and balances a long work's last fragment (tablet=%s)", tablet => {
    const spine = MANGA_MM.spine * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"];
    const width = 17 * (spine + 1) - 1 + MANGA_RUN_GAP;
    const rows = packMangaShelves([10, 12, 37], count => count, width, 1, tablet);
    expect(rows[0].map(run => run.count)).toEqual([10, 7]);
    for (const run of rows.flat()) expect(run.count).toBeGreaterThanOrEqual(3);
  });

  it.each([false, true])("leaves at least three books on the final continuation (tablet=%s)", tablet => {
    const spine = MANGA_MM.spine * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"];
    const capacity = 17;
    const width = capacity * (spine + 1) - 1;
    const rows = packMangaShelves([capacity * 2 + 1], count => count, width, 1, tablet);
    expect(rows.map(row => row[0].count)).toEqual([capacity, capacity - 2, 3]);
  });

  it("keeps labels within a shelf narrower than their preferred footprint", () => {
    const rows = packMangaShelves([1, 1], count => count, 80, 1);
    expect(rows.map(row => row.map(run => run.width))).toEqual([[80], [80]]);
  });
});
