import { describe, expect, it } from "vitest";
import { fitCollectionCase, fitFlatJacket } from "./fitCaseStage";

describe("work stage fitting", () => {
  it.each([
    { width: 684, height: 472 }, // 1024×640, info dock open
    { width: 1024, height: 472 }, // info dock closed
    { width: 1100, height: 732 },
    { width: 1580, height: 912 },
  ])("fits closed and opened geometry, including the spine and perspective, in $width×$height", box => {
    for (const ratio of [.5, .71, 1]) for (const open of [false, true]) {
      const fit = fitCollectionCase(box, ratio, open);
      expect((fit.height * ratio * (open ? 2 : 1) + 34 * fit.scale) * 1.25).toBeLessThanOrEqual(box.width - 112 + .001);
      expect(fit.height * 1.25).toBeLessThanOrEqual(box.height - 48 + .001);
    }
  });
  it("keeps the large case on a large stage, and scales all inside content together", () => {
    expect(fitCollectionCase({ width: 1580, height: 912 }, .71, true)).toEqual({ height: 520, scale: 1 });
    const small = { width: 684, height: 472 };
    expect(fitCollectionCase(small, .71, true).height).toBeLessThan(fitCollectionCase(small, .71, false).height);
  });
  it("fits the entire flat sheet and caption area on both axes", () => {
    for (const box of [{ width: 684, height: 472 }, { width: 500, height: 900 }, { width: 1600, height: 300 }]) {
      const fit = fitFlatJacket(box, .71);
      expect(fit.height * .71 * 2 + fit.spine).toBeLessThanOrEqual(box.width - 112 + .001);
      expect(fit.height).toBeLessThanOrEqual(box.height - 96 + .001);
    }
    expect(fitFlatJacket({ width: 1580, height: 912 }, .71)).toEqual({ height: 520, spine: 40 });
  });
});
