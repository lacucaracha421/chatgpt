import { useEffect, useSyncExternalStore } from "react";
import type { AssetSummary } from "../library/types";

const STORAGE_KEY = "lakomics.assets.perRow.v1";
let transientCount: number | null = null;
const listeners = new Set<() => void>();
export function migrateGalleryCount(pixels: number): number {
  return Math.max(3, Math.min(12, Math.floor(1200 / ((Number.isFinite(pixels) && pixels > 0 ? pixels : 180) + 2))));
}
function readCount(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value = Number(raw);
    return raw !== null && Number.isInteger(value) && value >= 3 && value <= 12 ? value : null;
  } catch { return transientCount; }
}
export function useGalleryCount(legacyPixels = 180): [number, (value: number) => void] {
  const fallback = migrateGalleryCount(legacyPixels);
  const count = useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => readCount() ?? fallback, () => fallback);
  const save = (value: number) => {
    transientCount = Math.max(3, Math.min(12, Math.round(value)));
    try { localStorage.setItem(STORAGE_KEY, String(transientCount)); } catch { /* Browsing also works without persistent storage. */ }
    listeners.forEach(listener => listener());
  };
  useEffect(() => { if (readCount() === null) save(fallback); }, [fallback]);
  return [count, save];
}
/** A representative aspect ratio converts the count to a justified row's target height. */
export function galleryRowHeight(items: AssetSummary[], width: number, gap: number, count: number): number {
  const sample = items.slice(0, 120);
  const meanRatio = sample.length ? sample.reduce((sum, item) => sum + (item.width > 0 && item.height > 0 ? Math.max(.25, Math.min(4, item.width / item.height)) : 1), 0) / sample.length : 1;
  return Math.max(1, (width - gap * (count - 1)) / count / meanRatio);
}
