import { describe, expect, it } from "vitest";
import { NO_VIEWER_ZONES, sameViewerZones, viewerZonesAt, viewerZonesShown } from "./viewerZones";

const rect = { left: 0, top: 0, right: 1200, bottom: 800 };

describe("viewer pointer zones", () => {
  it("shows nothing for a pointer around the centre", () => {
    expect(viewerZonesAt(600, 400, rect)).toEqual(NO_VIEWER_ZONES);
    expect(viewerZonesAt(300, 300, rect)).toEqual(NO_VIEWER_ZONES);
  });

  it("maps each edge to its own overlay", () => {
    expect(viewerZonesAt(600, 20, rect)).toEqual({ ...NO_VIEWER_ZONES, top: true });
    expect(viewerZonesAt(600, 700, rect)).toEqual({ ...NO_VIEWER_ZONES, bottom: true });
    expect(viewerZonesAt(30, 400, rect)).toEqual({ ...NO_VIEWER_ZONES, left: true });
    expect(viewerZonesAt(1170, 400, rect)).toEqual({ ...NO_VIEWER_ZONES, right: true });
  });

  it("combines zones in the corners", () => {
    expect(viewerZonesAt(10, 10, rect)).toEqual({ ...NO_VIEWER_ZONES, top: true, left: true });
    expect(viewerZonesAt(1190, 790, rect)).toEqual({ ...NO_VIEWER_ZONES, bottom: true, right: true });
  });

  it("uses the larger of a fraction and the minimum size", () => {
    // 800 px tall: top 15% = 120 px; a short stage falls back to 96 px.
    expect(viewerZonesAt(600, 119, rect).top).toBe(true);
    expect(viewerZonesAt(600, 121, rect).top).toBe(false);
    expect(viewerZonesAt(600, 95, { ...rect, bottom: 400 }).top).toBe(true);
    expect(viewerZonesAt(600, 97, { ...rect, bottom: 400 }).top).toBe(false);
    // 1200 px wide: sides 12% = 144 px; a narrow stage falls back to 96 px.
    expect(viewerZonesAt(143, 400, rect).left).toBe(true);
    expect(viewerZonesAt(145, 400, rect).left).toBe(false);
    expect(viewerZonesAt(95, 400, { ...rect, right: 600 }).left).toBe(true);
    expect(viewerZonesAt(97, 400, { ...rect, right: 600 }).left).toBe(false);
    // The strip keeps the band it already grew in: 210 px.
    expect(viewerZonesAt(600, 800 - 209, rect).bottom).toBe(true);
    expect(viewerZonesAt(600, 800 - 211, rect).bottom).toBe(false);
  });

  it("treats a pointer outside the stage, or an unmeasured stage, as in no zone", () => {
    expect(viewerZonesAt(1300, 400, rect)).toEqual(NO_VIEWER_ZONES);
    expect(viewerZonesAt(600, -5, rect)).toEqual(NO_VIEWER_ZONES);
    expect(viewerZonesAt(10, 10, { left: 0, top: 0, right: 0, bottom: 0 })).toEqual(NO_VIEWER_ZONES);
  });

  it("keeps a held overlay shown outside its zone", () => {
    expect(viewerZonesShown(NO_VIEWER_ZONES, { top: true })).toEqual({ ...NO_VIEWER_ZONES, top: true });
    expect(viewerZonesShown({ ...NO_VIEWER_ZONES, left: true }, { bottom: true })).toEqual({ ...NO_VIEWER_ZONES, left: true, bottom: true });
    expect(sameViewerZones(viewerZonesShown(NO_VIEWER_ZONES, {}), NO_VIEWER_ZONES)).toBe(true);
  });
});
