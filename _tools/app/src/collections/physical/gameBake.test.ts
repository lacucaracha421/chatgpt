import { afterEach, expect, it, vi } from "vitest";
vi.mock("./snapshotStore", () => ({ createSnapshotStore: () => null }));
vi.mock("./loadCoverImage", () => ({ loadCoverImage: vi.fn() }));
import { acquireCover, clearCollectibleCache } from "./collectibleRuntime";
import { loadCoverImage } from "./loadCoverImage";

afterEach(() => { clearCollectibleCache(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("reuses software game/output surfaces and releases backing stores after each PNG", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("CanvasRenderingContext2D", class {});
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:game"), revokeObjectURL: vi.fn() });
  const surfaces = new Map<HTMLCanvasElement, CanvasRenderingContext2DSettings | undefined>();
  const context = {
    setTransform: vi.fn(), beginPath: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
    fill: vi.fn(), stroke: vi.fn(), save: vi.fn(), restore: vi.fn(), clip: vi.fn(), transform: vi.fn(), drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function(this: HTMLCanvasElement, _id, options) {
    if (!surfaces.has(this)) surfaces.set(this, options);
    return context as unknown as CanvasRenderingContext2D;
  });
  const rasters: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function(this: HTMLCanvasElement, callback) {
    rasters.push([this.width, this.height]); callback(new Blob(["png"], { type: "image/png" }));
  });
  const images = [1, 2].map(() => ({ src:"/thumb", naturalWidth:270, naturalHeight:360 } as HTMLImageElement));
  vi.mocked(loadCoverImage).mockResolvedValueOnce(images[0]).mockResolvedValueOnce(images[1]);
  const notify = vi.fn(), stops: Array<() => void> = [];
  for (let i = 0; i < 2; i++) {
    stops.push(acquireCover({ kind:"game", src:`/thumb/${i}`, scope:"fixture", revision:"1", pixels:256 }, notify));
    await vi.runAllTimersAsync();
    expect([...surfaces.keys()].every(canvas => canvas.width <= 2 && canvas.height <= 2)).toBe(true);
  }
  expect(notify).toHaveBeenCalledTimes(2);
  expect(rasters).toEqual([[256, 362], [256, 362]]);
  // Two shared surfaces, plus one temporary artwork texture per case.
  expect(surfaces.size).toBe(4);
  expect([...surfaces.values()].every(options => options?.willReadFrequently === true)).toBe(true);
  expect(images.map(image => image.src)).toEqual(["", ""]);
  stops.forEach(stop => stop());
});
