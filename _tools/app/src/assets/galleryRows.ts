import type { AssetSummary } from "../library/types";
import { buildJustifiedRows, type JustifiedRow } from "./justifiedRows";
import { collectedDate, headingWeekday } from "./masonryLayout";

export type JustifiedDateHeading = {
  label: string;
  weekday: string;
  count: number;
  left: number;
  width: number;
};

export type JustifiedGalleryRow = JustifiedRow<AssetSummary> & {
  dateHeadings?: JustifiedDateHeading[];
};

type DateGroup = {
  items: AssetSummary[];
};

type PackedSegment = {
  group: DateGroup;
  width: number;
  items: AssetSummary[];
};

const INTER_SEGMENT_GAP_MULTIPLIER = 4;

export function buildJustifiedGalleryRows(
  items: AssetSummary[],
  width: number,
  targetHeight: number,
  gap: number,
  groupDates: boolean,
  _fullDateHeadings: boolean,
): JustifiedGalleryRow[] {
  if (!groupDates) return buildJustifiedRows(items, width, targetHeight, gap);

  const groups: DateGroup[] = [];
  for (const asset of items) {
    const current = groups[groups.length - 1];
    if (!current || collectedDate(current.items[0].collectedAt).key !== collectedDate(asset.collectedAt).key) groups.push({ items: [asset] });
    else current.items.push(asset);
  }

  const rows: JustifiedGalleryRow[] = [];
  let packedSegments: PackedSegment[] = [];
  let packedWidth = 0;
  const flushPacked = () => {
    if (packedSegments.length === 0) return;
    let left = 0;
    rows.push({
      height: targetHeight,
      items: packedSegments.flatMap((segment) => segment.items),
      dateHeadings: packedSegments.map((segment) => {
        const heading = makeDateHeading(segment.group, left, segment.width);
        left += segment.width + gap * INTER_SEGMENT_GAP_MULTIPLIER;
        return heading;
      }),
    });
    packedSegments = [];
    packedWidth = 0;
  };

  for (const group of groups) {
    const groupRows = buildJustifiedRows(group.items, width, targetHeight, gap);
    if (groupRows.length === 0) {
      flushPacked();
      continue;
    }
    const naturalWidth = widthAtTarget(group.items, targetHeight, gap);
    const isSmall = groupRows.length === 1 && naturalWidth <= width;
    if (isSmall) {
      const segmentItems = group.items.map((asset) => ({
        ...asset,
        width: (asset.width / asset.height) * targetHeight,
      }));
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
      dateHeadings: [makeDateHeading(group, 0, width)],
    } : row));
  }
  flushPacked();
  return rows;
}

function widthAtTarget(items: AssetSummary[], targetHeight: number, gap: number) {
  return items.reduce((width, item) => width + (item.width / item.height) * targetHeight, 0) + gap * (items.length - 1);
}

function makeDateHeading(group: DateGroup, left: number, width: number): JustifiedDateHeading {
  const asset = group.items[0];
  return {
    label: collectedDate(asset.collectedAt).label,
    weekday: headingWeekday(asset.collectedAt),
    count: group.items.length,
    left,
    width,
  };
}
