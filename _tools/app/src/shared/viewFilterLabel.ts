import type { AssetAspectFilter, AssetMediaFilter } from "../library/types";

import { DURATION_LABELS as DURATION, type AssetDurationFilter as DurationFilter } from "./assetDurationFilter";

const KIND = { images: "이미지", videos: "영상" };
const RATIO = { square: "정사각형", landscape: "가로형", portrait: "세로형" };

export function viewFilterLabel(media: AssetMediaFilter, aspect: AssetAspectFilter, duration: DurationFilter = 'all'): string | null {
  const kind = media === "all" ? null : KIND[media];
  const ratio = aspect === "all" ? null : RATIO[aspect];
  const length = duration === 'all' ? null : DURATION[duration];
  const label = [length, ratio, kind].filter(Boolean).join(" ");
  return label ? `${label}만` : null;
}

export function viewFilterEmptyTitle(media: AssetMediaFilter, aspect: AssetAspectFilter, duration: DurationFilter = 'all'): string {
  const kind = media === "all" ? "항목" : KIND[media];
  const ratio = aspect === "all" ? null : RATIO[aspect];
  const length = duration === 'all' ? null : DURATION[duration];
  return `${[length, ratio, kind].filter(Boolean).join(" ")} 없음`;
}
