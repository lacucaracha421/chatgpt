import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_TONE, readNotePixels, toneAround, type NotePixels } from "./imageTextNoteTone";

afterEach(() => vi.restoreAllMocks());
function solid(rgb: number[], width = 64, height = 64): NotePixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return { data, width, height };
}
const box = { x: 20, y: 20, w: 20, h: 20 };
function luminance(rgb: readonly number[]) {
  const linear = rgb.map(v => v / 255 <= .04045 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
it("matches white, dark and coloured surroundings while ignoring the OCR interior and sparse outliers", () => {
  for (const rgb of [[255, 255, 255], [20, 22, 24], [220, 210, 170]]) {
    const pixels = solid(rgb);
    for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) pixels.data.set([255, 0, 0, 255], (y * 64 + x) * 4);
    pixels.data.set([0, 0, 0, 255], (16 * 64 + 16) * 4);
    const tone = toneAround(pixels, box);
    expect(tone.bg).toEqual(rgb);
    expect(tone.fg).toEqual(rgb[0] === 20 ? [251, 250, 247] : [28, 29, 31]);
  }
});
it("keeps WCAG contrast at least 4.5 across greys and saturated colours", () => {
  const colours = Array.from({ length: 256 }, (_, v) => [v, v, v]);
  colours.push([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]);
  for (const rgb of colours) {
    const { bg, fg } = toneAround(solid(rgb), box);
    expect((Math.max(luminance(bg), luminance(fg)) + .05) / (Math.min(luminance(bg), luminance(fg)) + .05)).toBeGreaterThanOrEqual(4.5);
  }
});
it("clips rings at image edges and falls back when there are no usable samples", () => {
  const pixels = solid([255, 255, 255]);
  expect(toneAround(pixels, { x: 0, y: 0, w: 20, h: 20 }).bg).toEqual([255, 255, 255]);
  expect(toneAround(pixels, { x: 0, y: 0, w: 64, h: 64 })).toBe(DEFAULT_TONE);
  expect(toneAround(null, box)).toBe(DEFAULT_TONE);
  expect(toneAround(pixels, { ...box, x: NaN })).toBe(DEFAULT_TONE);
  expect(toneAround({ ...pixels, data: new Uint8ClampedArray(0) }, box)).toBe(DEFAULT_TONE);
});
it("produces opaque paper tones from transparent pixels", () => {
  const pixels = solid([0, 0, 0]);
  pixels.data.fill(0);
  expect(toneAround(pixels, box).bg).toEqual([255, 255, 255]);
});
function decodedImage() {
  const image = document.createElement("img");
  image.src = "http://lakomics.localhost/asset/a";
  Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 2000 }, naturalHeight: { value: 1000 } });
  return image;
}
it("downscales and reads the displayed element only once even when notes remount", () => {
  const image = decodedImage(), pixels = solid([255, 255, 255], 256, 128);
  const context = { drawImage: vi.fn(), getImageData: vi.fn().mockReturnValue(pixels) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  expect(readNotePixels(image)).toBe(pixels);
  expect(readNotePixels(image)).toBe(pixels);
  expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(image, 0, 0, 256, 128);
  expect(context.getImageData).toHaveBeenCalledExactlyOnceWith(0, 0, 256, 128);
});
it("returns and caches the fallback on canvas errors, without reading undecoded images", () => {
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  expect(readNotePixels(document.createElement("img"))).toBeNull();
  expect(getContext).not.toHaveBeenCalled();
  const context = { drawImage: vi.fn(), getImageData: vi.fn(() => { throw new DOMException("tainted", "SecurityError"); }) };
  getContext.mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const image = decodedImage();
  expect(readNotePixels(image)).toBeNull();
  expect(readNotePixels(image)).toBeNull();
  expect(context.getImageData).toHaveBeenCalledOnce();
  getContext.mockReturnValue(null);
  expect(readNotePixels(decodedImage())).toBeNull();
});
