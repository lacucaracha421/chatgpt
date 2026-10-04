import { afterEach, expect, it, vi } from "vitest";
import { drawGameCase } from "./drawGameCase";

afterEach(() => vi.restoreAllMocks());
it("keeps the approved 2x raster and 70 triangles on a software texture surface", () => {
  const context = () => ({
    setTransform: vi.fn(), beginPath: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
    fill: vi.fn(), stroke: vi.fn(), save: vi.fn(), restore: vi.fn(), clip: vi.fn(), transform: vi.fn(), drawImage: vi.fn(),
  });
  const output = context(), texture = context();
  const calls: Array<{ canvas: HTMLCanvasElement; options?: CanvasRenderingContext2DSettings }> = [];
  const canvas = document.createElement("canvas");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function(this: HTMLCanvasElement, _id, options) {
    calls.push({ canvas: this, options });
    return (this === canvas ? output : texture) as unknown as CanvasRenderingContext2D;
  });
  const image = { naturalWidth: 270, naturalHeight: 360 } as HTMLImageElement;
  expect(drawGameCase(canvas, image, 256 / (window.devicePixelRatio || 1))).toBe(true);
  expect(canvas.width).toBe(512);
  expect(canvas.height).toBe(Math.ceil(260 * 512 / 184));
  expect(output.drawImage).toHaveBeenCalledTimes(70);
  expect(texture.drawImage).toHaveBeenCalledTimes(1);
  expect(calls.find(call => call.canvas !== canvas)?.options).toEqual({ willReadFrequently: true });
  const temporary = calls.find(call => call.canvas !== canvas)!.canvas;
  expect([temporary.width, temporary.height]).toEqual([0, 0]);
});
