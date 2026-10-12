import type { AssetAspectFilter, AssetMediaFilter } from "../library/types";

const KIND = { images: "이미지", videos: "영상" };
type DurationFilter = 'all' | 'under_30s' | '30s_1m' | '1m_5m' | 'over_5m';
const DURATION = { under_30s: '30초 미만', '30s_1m': '30초–1분', '1m_5m': '1–5분', over_5m: '5분 이상' };
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
