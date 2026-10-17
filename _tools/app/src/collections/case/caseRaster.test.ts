import { expect, it } from "vitest";
import { caseRaster } from "./caseRaster";

it("draws the 3D models at 2x on PC screens and at their own density on dense tablet screens", () => {
  // PC monitors at 100-150 %: twice the size, as the sharpness fix needed.
  expect(caseRaster(1)).toBe(2);
  expect(caseRaster(1.5)).toBe(2);
  // Galaxy Tab S11 (density 2.375): already sharp natively, so no extra bitmap to turn every frame.
  expect(caseRaster(2.375)).toBe(1);
  expect(caseRaster(2)).toBe(1.5);
  expect(caseRaster(Number.NaN)).toBe(2);
});
