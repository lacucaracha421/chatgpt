import type { CSSProperties } from "react";

/** B6 defaults until the client has per-volume trim/thickness data. */
export const MANGA_MM = { height: 182, width: 128, spine: 14 };
export const MANGA_PX_PER_MM = { pc: 1.1, tablet: 1.25 };
export function mangaVolumeHash(id: string): number {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}
/** Thickness varies by at most one millimetre, independent of position or ownership. */
export function mangaPixels(id: string, pxPerMm: number, scale = 1, mm = MANGA_MM) {
  const unit = pxPerMm * scale;
  return { height: mm.height * unit, width: mm.width * unit, spine: (mm.spine + mangaVolumeHash(id) % 3 - 1) * unit };
}
/** Inherited by loading rows as well as their books, so the reserved height never changes on load. */
export function mangaShelfStyle(tablet: boolean): CSSProperties {
  return { "--manga-height": `${MANGA_MM.height * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"]}px` } as CSSProperties;
}
