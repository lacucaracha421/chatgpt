import type { KakaoReview } from "../library/types";

export type KakaoReviewSegment = "unlinked" | "partial" | "excluded";
export const QUERY_SOURCES = { name: "작품명", mangadex: "MangaDex 한국어 제목", none: "한국어 제목 없음" };
export const normalizeKakaoTitle = (title: string) => title.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export function missingKakaoVolumes(review: KakaoReview): number[] {
  const highest = Math.max(0, review.highestOwnedVolume, ...review.volumes);
  const known = new Set(review.volumes);
  return Array.from({ length: highest }, (_, i) => i + 1).filter(n => !known.has(n));
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
