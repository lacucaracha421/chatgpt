/** Pixel memory plus encoded bytes; browser/GPU overhead is outside this estimate. */
export class SpineBitmapLRU<T extends { bytes: number }> {
  private entries = new Map<string, T>();
  private bytes = 0;
  constructor(private limit: number, private dispose: (value: T) => void) {}
  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value) { this.entries.delete(key); this.entries.set(key, value); }
    return value;
  }
  set(key: string, value: T): boolean {
    const old = this.entries.get(key);
    if (old) { this.entries.delete(key); this.bytes -= old.bytes; this.dispose(old); }
    if (value.bytes > this.limit) return false;
    while (this.bytes + value.bytes > this.limit) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      const evicted = this.entries.get(first)!;
      this.entries.delete(first); this.bytes -= evicted.bytes; this.dispose(evicted);
    }
    this.entries.set(key, value); this.bytes += value.bytes;
    return true;
  }
}

export type SpineBitmapSpec = {
  id: string; art: string | null; scan: string | null; ink: string;
  title: string; author: string | null; publisher: string | null; number: number;
  width: number; height: number; print: number; scale: number; dpr: number; zoom: number;
  privacy: boolean; opacity: number; focus: number | null; numberMix: number;
  titleFont: number; labelFont: number; authorFont: number; publisherFont: number;
  font: string;
};

export function spineBitmapKey(spec: SpineBitmapSpec): string {
  // Include every printed input, including ownership and edits, not only volume identity.
  return JSON.stringify([1, spec.id, spec.art, spec.scan, spec.ink, spec.width, spec.height,
    spec.scale, spec.dpr, spec.privacy, spec.title, spec.author, spec.publisher, spec.number,
    spec.opacity, spec.focus, spec.numberMix, spec.print, spec.zoom, spec.titleFont,
    spec.labelFont, spec.authorFont, spec.publisherFont, spec.font]);
}
