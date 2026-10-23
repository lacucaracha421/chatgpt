import { MANGA_MM, MANGA_PX_PER_MM } from "./mangaDimensions";

export const MANGA_RUN_GAP = 12;
export const MANGA_SHELF_GUTTER = 24;
export type MangaShelfRun<W> = { work: W; start: number; count: number; width: number; continued: boolean };

/** Reserve nominal B6 thickness, including the one-pixel seam. Scans never change row membership. */
export function packMangaShelves<W>(works: readonly W[], count: (work: W) => number, available: number, scale: number, tablet = false): MangaShelfRun<W>[][] {
  const spine = MANGA_MM.spine * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"] * scale;
  const width = Math.max(spine, available);
  const rows: MangaShelfRun<W>[][] = [];
  let row: MangaShelfRun<W>[] = [], used = 0;
  for (const work of works) {
    const total = Math.max(1, count(work));
    let start = 0;
    while (start < total) {
      const gap = row.length ? MANGA_RUN_GAP : 0;
      const fits = Math.floor((width - used - gap + 1 + 1e-6) / (spine + 1));
      if (!fits) { rows.push(row); row = []; used = 0; continue; }
      const take = Math.min(total - start, fits);
      const reserved = take * (spine + 1) - 1;
      row.push({ work, start, count: take, width: reserved, continued: start > 0 });
      used += gap + reserved;
      start += take;
      if (start < total) { rows.push(row); row = []; used = 0; }
    }
  }
  if (row.length) rows.push(row);
  return rows;
}
