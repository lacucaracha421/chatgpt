import { MANGA_MM, MANGA_PX_PER_MM } from "./mangaDimensions";

export const MANGA_RUN_GAP = 12;
export const MANGA_SHELF_GUTTER = 24;
export const MANGA_LABEL_WIDTH = 104;
export type MangaShelfRun<W> = { work: W; start: number; count: number; width: number; continued: boolean };

/** Reserve nominal B6 thickness, including the one-pixel seam. Scans never change row membership. */
export function packMangaShelves<W>(works: readonly W[], count: (work: W) => number, available: number, scale: number, tablet = false): MangaShelfRun<W>[][] {
  const spine = MANGA_MM.spine * MANGA_PX_PER_MM[tablet ? "tablet" : "pc"] * scale;
  const width = Math.max(spine, available);
  const labelWidth = Math.min(width, MANGA_LABEL_WIDTH * scale);
  const footprint = (volumes: number) => Math.max(labelWidth, volumes * (spine + 1) - 1);
  const capacity = Math.max(1, Math.floor((width + 1 + 1e-6) / (spine + 1)));
  const rows: MangaShelfRun<W>[][] = [];
  let row: MangaShelfRun<W>[] = [], used = 0;
  for (const work of works) {
    const total = Math.max(1, count(work));
    let start = 0;
    while (start < total) {
      const gap = row.length ? MANGA_RUN_GAP : 0;
      const room = width - used - gap;
      const fits = Math.max(0, Math.floor((room + 1 + 1e-6) / (spine + 1)));
      const remaining = total - start;
      let take = Math.min(remaining, fits);
      // Do not start a run with one or two books at the edge. Leave at least
      // three for the continuation too; move a whole fitting run instead.
      if (take < remaining && capacity >= 3) {
        if (remaining <= capacity && (take < 3 || remaining - take < 3)) take = 0;
        else if (remaining >= 6) {
          take = Math.min(take, remaining - 3);
          if (take < 3) take = 0;
        }
      } else if (take < remaining && row.length) take = 0;
      if (!take || footprint(take) > room + 1e-6) {
        rows.push(row); row = []; used = 0; continue;
      }
      const reserved = footprint(take);
      row.push({ work, start, count: take, width: reserved, continued: start > 0 });
      used += gap + reserved;
      start += take;
      if (start < total) { rows.push(row); row = []; used = 0; }
    }
  }
  if (row.length) rows.push(row);
  return rows;
}
