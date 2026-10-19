import type { KakaoReview } from "../library/types";

export type KakaoReviewSegment = "unlinked" | "partial" | "excluded";
export const QUERY_SOURCES = { original: "일본어 원제", name: "작품명", mangadex: "MangaDex 한국어 제목", none: "한국어 제목 없음" };
export const normalizeKakaoTitle = (title: string) => title.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export function expectedKakaoVolumes(review: KakaoReview): number[] {
  const low = review.restartNumbering ? 1 : Math.max(1, review.minVolume ?? 1);
  const observed = Math.max(0, review.highestOwnedVolume, ...review.volumes);
  const highest = review.restartNumbering
    ? review.maxVolume === null ? review.highestOwnedVolume : review.maxVolume - (review.minVolume ?? 1) + 1
    : Math.min(observed, review.maxVolume ?? observed);
  return Array.from({ length: Math.max(0, highest - low + 1) }, (_, i) => i + low);
}
export function missingKakaoVolumes(review: KakaoReview): number[] {
  const known = new Set(review.volumes);
  return expectedKakaoVolumes(review).filter(n => !known.has(n));
}
export function kakaoReviewSegment(review: KakaoReview): KakaoReviewSegment | null {
  if (!review.bound) return review.hideConnectionPrompt ? "excluded" : "unlinked";
  if (missingKakaoVolumes(review).length === 0) return null;
  return review.partialDismissed ? "excluded" : "partial";
}
export function missingKakaoLabel(numbers: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    const start = numbers[i]; let end = start;
    while (numbers[i + 1] === end + 1) end = numbers[++i];
    ranges.push(start === end ? `${start}` : `${start}–${end}`);
  }
  return `${ranges.join(", ")}권 없음`;
}
