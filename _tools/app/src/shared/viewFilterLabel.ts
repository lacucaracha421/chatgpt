import type { AssetAspectFilter, AssetMediaFilter } from "../library/types";

const KIND = { images: "이미지", videos: "영상" };
const RATIO = { square: "정사각형", landscape: "가로형", portrait: "세로형" };

export function viewFilterLabel(media: AssetMediaFilter, aspect: AssetAspectFilter): string | null {
  const kind = media === "all" ? null : KIND[media];
  const ratio = aspect === "all" ? null : RATIO[aspect];
  const label = [ratio, kind].filter(Boolean).join(" ");
  return label ? `${label}만` : null;
}

export function viewFilterEmptyTitle(media: AssetMediaFilter, aspect: AssetAspectFilter): string {
  const kind = media === "all" ? "항목" : KIND[media];
  const ratio = aspect === "all" ? null : RATIO[aspect];
  return `${[ratio, kind].filter(Boolean).join(" ")} 없음`;
}
