export const MANGA_SPINE_INK = "#45423e";
// One sample of the first owned cover, shared by list/detail and retained between visits.
const colors = new Map<string, string>();
export function mangaSpineColor(key: string): string { return colors.get(key) ?? MANGA_SPINE_INK; }

/** The cover's most vivid hue as a print ink dark enough for paper; neutral ink when the cover is grey or unreadable. */
export function sampleMangaSpineColor(key: string, image: HTMLImageElement): string {
  const cached = colors.get(key);
  if (cached) return cached;
  const ink = vividInk(image) ?? MANGA_SPINE_INK;
  colors.set(key, ink);
  return ink;
}

function vividInk(image: HTMLImageElement): string | null {
  if (!image.naturalWidth || !image.naturalHeight) return null;
  let data: Uint8ClampedArray;
  try {
    const canvas = document.createElement("canvas"); canvas.width = 24; canvas.height = 24;
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return null;
    context.drawImage(image, 0, 0, 24, 24);
    data = context.getImageData(0, 0, 24, 24).data;
  } catch { return null; }
  // Weight each pixel by how colourful it is; the heaviest of 12 hue bins names the series colour.
  const bins = Array.from({ length: 12 }, () => ({ weight: 0, hue: 0, saturation: 0 }));
  for (let index = 0; index < data.length; index += 4) {
    const [hue, saturation, lightness] = hsl(data[index], data[index + 1], data[index + 2]);
    const weight = saturation * (1 - Math.abs(2 * lightness - 1));
    if (weight < .12) continue;
    const bin = bins[Math.floor(hue * 12) % 12];
    bin.weight += weight; bin.hue += hue * weight; bin.saturation += saturation * weight;
  }
  const best = bins.reduce((top, bin) => bin.weight > top.weight ? bin : top);
  if (best.weight < 2) return null;
  const hue = best.hue / best.weight;
  const saturation = Math.min(.82, Math.max(.5, best.saturation / best.weight));
  return rgbHex(hue, saturation, .38);
}

function hsl(red: number, green: number, blue: number): [number, number, number] {
  const r = red / 255, g = green / 255, b = blue / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue / 6, saturation, lightness];
}

function rgbHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (offset: number) => {
    const k = (offset + hue * 12) % 12;
    return lightness - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${[channel(0), channel(8), channel(4)].map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join("")}`;
}
