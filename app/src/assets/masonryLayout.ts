import type { AssetSummary } from "../library/types";

export type GalleryLayout = "masonry" | "justified";
export type MasonryTile = { asset: AssetSummary; index: number; left: number; top: number; width: number; imageHeight: number; height: number };
export const CAPTION_HEIGHT = 26;
const DATE_HEADING_HEIGHT = 44;
const fullDateFormat = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium", hour12: false });

// Date headings and captions deliberately share the same local timestamp.
export function collectedDate(value: string | null | undefined) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return { key: "unknown", label: "수집일 미상", time: "—", full: "수집 시각 없음" };
  const key = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
  return { key, label: key, time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`, full: fullDateFormat.format(date) };
}

export function buildMasonryLayout(items: AssetSummary[], width: number, targetWidth: number, gap: number, captions: boolean, groupDates: boolean) {
  const tiles: MasonryTile[] = [];
  const headings: Array<{ key: string; label: string; top: number }> = [];
  if (width <= 0 || targetWidth <= 0) return { tiles, headings, height: 0 };
  const columns = Math.max(1, Math.floor((width + gap) / (targetWidth + gap)));
  const tileWidth = (width - gap * (columns - 1)) / columns;
  let bottoms = Array<number>(columns).fill(0);
  let previousDate: string | null = null;
  items.forEach((asset, index) => {
    const date = collectedDate(asset.collectedAt);
    if (groupDates && date.key !== previousDate) {
      const top = Math.max(...bottoms);
      headings.push({ key: asset.id, label: date.label, top });
      bottoms = bottoms.map(() => top + DATE_HEADING_HEIGHT);
      previousDate = date.key;
    }
    const column = bottoms.indexOf(Math.min(...bottoms));
    const imageHeight = tileWidth * (asset.width > 0 && asset.height > 0 ? asset.height / asset.width : 1);
    const height = imageHeight + (captions ? CAPTION_HEIGHT : 0);
    tiles.push({ asset, index, left: column * (tileWidth + gap), top: bottoms[column], width: tileWidth, imageHeight, height });
    bottoms[column] += height + gap;
  });
  return { tiles, headings, height: Math.max(...bottoms) };
}

export function masonryMove(tiles: MasonryTile[], currentId: string, direction: 1 | -1) {
  const current = tiles.find((tile) => tile.asset.id === currentId);
  if (!current) return 0;
  let best = current;
  let distance = Infinity;
  for (const tile of tiles) {
    const dy = (tile.top - current.top) * direction;
    if (dy <= 1) continue;
    const score = Math.abs(tile.left - current.left) * 4 + dy;
    if (score < distance) { best = tile; distance = score; }
  }
  return best.index - current.index;
}
