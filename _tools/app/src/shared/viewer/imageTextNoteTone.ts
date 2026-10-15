import type { NoteBox } from "./imageTextNoteLayout";

type RGB = readonly [number, number, number];
export type NoteTone = { bg: RGB; fg: RGB };
export type NotePixels = { data: Uint8ClampedArray; width: number; height: number };
// Null tones use the existing theme's ivory colours.
export const DEFAULT_TONE: NoteTone = { bg: [251, 250, 247], fg: [31, 33, 35] };
const luminance = (rgb: RGB) => {
  const linear = rgb.map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
};
const contrast = (a: RGB, b: RGB) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t)) as [number, number, number];

/** Collector toneAround port: box and pixels use the same, downscaled pixel space. */
export function toneAround(pixels: NotePixels | null, box: NoteBox): NoteTone {
  if (!pixels || pixels.width <= 0 || pixels.height <= 0 || pixels.data.length < pixels.width * pixels.height * 4 ||
    ![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) return DEFAULT_TONE;
  const { data, width, height } = pixels, edge = Math.max(width, height);
  const m = Math.max(2, Math.round(edge * .005)), t = Math.max(3, Math.round(edge * .008));
  const x0 = Math.max(0, Math.round(box.x - m - t)), y0 = Math.max(0, Math.round(box.y - m - t));
  const x1 = Math.min(width, Math.round(box.x + box.w + m + t)), y1 = Math.min(height, Math.round(box.y + box.h + m + t));
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    if (x > box.x - m && x < box.x + box.w + m && y > box.y - m && y < box.y + box.h + m) continue;
    const i = (y * width + x) * 4;
    // Composite transparent pixels onto white so hidden RGB cannot tint opaque notes.
    const alpha = data[i + 3] / 255;
    rs.push(Math.round(data[i] * alpha + 255 * (1 - alpha)));
    gs.push(Math.round(data[i + 1] * alpha + 255 * (1 - alpha)));
    bs.push(Math.round(data[i + 2] * alpha + 255 * (1 - alpha)));
  }
  if (!rs.length) return DEFAULT_TONE;
  const median = (list: number[]) => { list.sort((a, b) => a - b); return list[list.length >> 1]; };
  let bg: RGB = [median(rs), median(gs), median(bs)];
  const light = luminance(bg) > .36;
  const fg: RGB = light ? [28, 29, 31] : [251, 250, 247];
  for (let k = 0; contrast(bg, fg) < (light ? 7 : 4.8) && k < 20; k++) bg = mix(bg, light ? [255, 255, 255] : [0, 0, 0], light ? .15 : .1);
  return { bg, fg };
}

const pixelCache = new WeakMap<HTMLImageElement, { src: string; pixels: NotePixels | null }>();

/** Read the already decoded displayed element once; never fetch or decode a second image. */
export function readNotePixels(image: HTMLImageElement | null): NotePixels | null {
  if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return null;
  const src = image.currentSrc || image.src;
  const cached = pixelCache.get(image);
  if (cached?.src === src) return cached.pixels;
  let pixels: NotePixels | null = null;
  try {
    const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = image.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context) {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    }
  } catch { /* Tainted or unsupported canvases retain the theme's ivory notes. */ }
  pixelCache.set(image, { src, pixels });
  return pixels;
}
