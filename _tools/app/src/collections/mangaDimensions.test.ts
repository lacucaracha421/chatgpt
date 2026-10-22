import { describe, expect, it } from "vitest";
import { mangaPixels, MANGA_MM, MANGA_PX_PER_MM } from "./mangaDimensions";

describe("manga dimensions", () => {
  it.each(["pc", "tablet"] as const)("uses trim millimetres and the %s scale", client => {
    const scale = MANGA_PX_PER_MM[client];
    const size = mangaPixels("volume", scale, 1.35);
    expect(size.height).toBeCloseTo(182 * scale * 1.35);
    expect(size.width).toBeCloseTo(128 * scale * 1.35);
    expect(size.spine / (scale * 1.35)).toBeGreaterThanOrEqual(13);
    expect(size.spine / (scale * 1.35)).toBeLessThanOrEqual(15);
  });
  it("retains deterministic thickness when a volume moves or the scale changes", () => {
    const ids = Array.from({ length: 50 }, (_, index) => `volume-${index}`);
    const before = new Map(ids.map(id => [id, mangaPixels(id, 1).spine]));
    for (const id of ids.reverse()) expect(mangaPixels(id, 1.25).spine).toBeCloseTo(before.get(id)! * 1.25);
    expect(new Set(before.values()).size).toBe(3);
  });
  it("accepts a known trim without changing the scale rule", () => {
    expect(mangaPixels("volume", 1.1, 1, { ...MANGA_MM, height: 210, width: 148 }).height).toBeCloseTo(231);
  });
});
