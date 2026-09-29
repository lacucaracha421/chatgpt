import type { AssetSummary } from "../library/types";
import { buildJustifiedRows } from "./justifiedRows";
import { collectedDate, headingWeekday } from "./masonryLayout";

export const GALLERY_DATE_HEADING_HEIGHT = 44;

export type JustifiedDateHeading = {
  label: string;
  weekday: string;
  count: number;
  left: number;
  width: number;
};

export type GalleryRow<T> = {
  height: number;
  items: T[];
};

export type JustifiedGalleryRow<T = AssetSummary> = GalleryRow<T> & {
  dateHeadings?: JustifiedDateHeading[];
};

export type GalleryRowAccessors<T, R> = {
  ratio(item: T): number;
  dateValue(item: T): string | null | undefined;
  /** Builds an item whose width is the supplied target-height width. */
  packItem(item: T, index: number, width: number, height: number): R;
  /** Each client keeps its own justified-row algorithm. */
  buildRows(items: T[], width: number, targetHeight: number, gap: number, startIndex: number): GalleryRow<R>[];
};

type DateGroup<T> = {
  items: T[];
  startIndex: number;
};

type PackedSegment<T, R> = {
  group: DateGroup<T>;
  width: number;
  items: R[];
};

const INTER_SEGMENT_GAP_MULTIPLIER = 4;

const assetSummaryAccessors: GalleryRowAccessors<AssetSummary, AssetSummary> = {
  ratio: (asset) => asset.width / asset.height,
  dateValue: (asset) => asset.collectedAt,
  packItem: (asset, _index, width) => ({ ...asset, width }),
  buildRows: (items, width, targetHeight, gap) => buildJustifiedRows(items, width, targetHeight, gap),
};

export function buildJustifiedGalleryRows<T = AssetSummary, R = T>(
  items: T[],
  width: number,
  targetHeight: number,
  gap: number,
  groupDates: boolean,
  _fullDateHeadings: boolean,
  accessors?: GalleryRowAccessors<T, R>,
): JustifiedGalleryRow<R>[] {
  const resolved = accessors ?? assetSummaryAccessors as unknown as GalleryRowAccessors<T, R>;
  if (!groupDates) return resolved.buildRows(items, width, targetHeight, gap, 0);

  const groups: Array<DateGroup<T>> = [];
  for (const [index, item] of items.entries()) {
    const current = groups[groups.length - 1];
    if (!current || dateKey(resolved.dateValue(current.items[0])) !== dateKey(resolved.dateValue(item))) {
      groups.push({ items: [item], startIndex: index });
    } else current.items.push(item);
  }

  const rows: JustifiedGalleryRow<R>[] = [];
  let packedSegments: Array<PackedSegment<T, R>> = [];
  let packedWidth = 0;
  const flushPacked = () => {
    if (packedSegments.length === 0) return;
    let left = 0;
    rows.push({
      height: targetHeight,
      items: packedSegments.flatMap((segment) => segment.items),
      dateHeadings: packedSegments.map((segment) => {
        const heading = makeDateHeading(segment.group, left, segment.width, resolved);
        left += segment.width + gap * INTER_SEGMENT_GAP_MULTIPLIER;
        return heading;
      }),
    });
    packedSegments = [];
    packedWidth = 0;
  };

  for (const group of groups) {
    const groupRows = resolved.buildRows(group.items, width, targetHeight, gap, group.startIndex);
    if (groupRows.length === 0) {
      flushPacked();
      continue;
    }
    const naturalWidth = widthAtTarget(group.items, targetHeight, gap, resolved.ratio);
    const isSmall = groupRows.length === 1 && naturalWidth <= width;
    if (isSmall) {
      const segmentItems = group.items.map((item, index) => resolved.packItem(
        item,
        group.startIndex + index,
        resolved.ratio(item) * targetHeight,
        targetHeight,
      ));
      const nextWidth = packedSegments.length === 0
        ? naturalWidth
        : packedWidth + gap * INTER_SEGMENT_GAP_MULTIPLIER + naturalWidth;
      if (packedSegments.length > 0 && nextWidth > width) flushPacked();
      packedSegments.push({ group, width: naturalWidth, items: segmentItems });
      packedWidth = packedSegments.reduce((sum, segment) => sum + segment.width, 0) + gap * INTER_SEGMENT_GAP_MULTIPLIER * (packedSegments.length - 1);
      continue;
    }

    flushPacked();
    rows.push(...groupRows.map((row, index) => index === 0 ? {
      ...row,
      dateHeadings: [makeDateHeading(group, 0, width, resolved)],
    } : row));
  }
  flushPacked();
  return rows;
}

function dateKey(value: string | null | undefined) {
  return collectedDate(value).key;
}

function widthAtTarget<T>(items: T[], targetHeight: number, gap: number, ratio: (item: T) => number) {
  return items.reduce((width, item) => width + ratio(item) * targetHeight, 0) + gap * (items.length - 1);
}

function makeDateHeading<T, R>(group: DateGroup<T>, left: number, width: number, accessors: GalleryRowAccessors<T, R>): JustifiedDateHeading {
  const value = accessors.dateValue(group.items[0]);
  return {
    label: collectedDate(value).label,
    weekday: headingWeekday(value),
    count: group.items.length,
    left,
    width,
  };
}
