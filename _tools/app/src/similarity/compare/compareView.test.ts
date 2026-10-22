import { describe, expect, it } from "vitest";
import { COMPARE_MAX_SCALE, FIT, compareViewForKey, fitted, panBy, stepWipe, toggleActualSize, transformFor, wipeAt, zoomAt } from "./compareView";

const box = { width: 400, height: 400 };
const wide = { width: 2000, height: 1000 };
const shown = fitted(box, wide);

describe("synced compare view", () => {
  it("puts the same normalized point at the centre of differently sized images", () => {
    expect(shown).toEqual({ width: 400, height: 200 });
    expect(transformFor(FIT, box, wide)).toBe("translate(0px, 0px) scale(1)");
    const view = { scale: 4, x: 0.75, y: 0.25 };
    // A 2000×1000 image and its 1000×500 downscale are displayed the same size, so they line up.
    expect(transformFor(view, box, wide)).toBe(transformFor(view, box, { width: 1000, height: 500 }));
    expect(transformFor(view, box, wide)).toBe("translate(-400px, 200px) scale(4)");
  });

  it("keeps the image point under the wheel or pinch where it was", () => {
    const point = { x: 100, y: -50 };
    const under = (view: typeof FIT) => ({ x: view.x + point.x / (shown.width * view.scale), y: view.y + point.y / (shown.height * view.scale) });
    const zoomed = zoomAt(FIT, point, 2, shown);
    expect(zoomed.scale).toBe(2);
    expect(under(zoomed).x).toBeCloseTo(under(FIT).x);
    expect(under(zoomed).y).toBeCloseTo(under(FIT).y);
    expect(zoomAt(zoomed, point, 0.5, shown)).toBe(FIT);
    expect(zoomAt(zoomed, point, 100, shown).scale).toBe(COMPARE_MAX_SCALE);
  });

  it("pans only a zoomed view and never past the image edge", () => {
    expect(panBy(FIT, 50, 50, shown)).toBe(FIT);
    const view = { scale: 2, x: 0.5, y: 0.5 };
    expect(panBy(view, -80, 0, shown)).toEqual({ scale: 2, x: 0.6, y: 0.5 });
    expect(panBy(view, 10_000, -10_000, shown)).toEqual({ scale: 2, x: 0, y: 1 });
  });

  it("toggles 1:1 around the double-clicked point and back to the fit", () => {
    const actual = toggleActualSize(FIT, { x: 100, y: 0 }, 2000, shown);
    expect(actual).toEqual({ scale: 5, x: 0.75, y: 0.5 });
    expect(toggleActualSize(actual, { x: 0, y: 0 }, 2000, shown)).toBe(FIT);
    // A small image still zooms a visible step.
    expect(toggleActualSize(FIT, { x: 0, y: 0 }, 300, shown).scale).toBe(2);
  });

  it("zooms and pans from the keyboard and leaves other keys alone", () => {
    const zoomed = compareViewForKey(FIT, "+")!;
    expect(zoomed).toEqual({ scale: 1.5, x: 0.5, y: 0.5 });
    expect(compareViewForKey(zoomed, "ArrowRight")!.x).toBeGreaterThan(0.5);
    expect(compareViewForKey(zoomed, "0")).toBe(FIT);
    expect(compareViewForKey(FIT, "ArrowRight")).toBeNull();
    expect(compareViewForKey(FIT, "-")).toBeNull();
    expect(compareViewForKey(zoomed, "a")).toBeNull();
  });
});

describe("wipe divider", () => {
  it("follows the pointer inside the stage and clamps at its edges", () => {
    const rect = { left: 100, width: 400 };
    expect(wipeAt(200, rect)).toBe(25);
    expect(wipeAt(50, rect)).toBe(0);
    expect(wipeAt(900, rect)).toBe(100);
  });

  it("steps like a slider", () => {
    expect(stepWipe(50, "ArrowLeft")).toBe(45);
    expect(stepWipe(50, "ArrowRight", true)).toBe(51);
    expect(stepWipe(98, "ArrowRight")).toBe(100);
    expect(stepWipe(50, "Home")).toBe(0);
    expect(stepWipe(50, "End")).toBe(100);
    expect(stepWipe(50, "Enter")).toBeNull();
  });
});
