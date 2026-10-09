import type { ReactNode } from "react";
import type { KakaoReview } from "../library/types";
import { missingKakaoLabel, missingKakaoVolumes } from "./kakaoReviewModel";

/** Shared identity and volume marks for the PC review list and tablet overlay. */
export function KakaoReviewIdentity({ name, subtitle, cover }: { name: string; subtitle: string; cover: ReactNode }) {
  return <>{cover}<span className="kakao-review__identity"><strong>{name}</strong><small>{subtitle}</small></span></>;
}
export function KakaoReviewVolumes({ review }: { review: KakaoReview }) {
  const missing = missingKakaoVolumes(review);
  const highest = Math.max(0, review.highestOwnedVolume, ...review.volumes);
  const known = new Set(review.volumes);
  return <><span className="kakao-review__volumes" aria-label={`${highest}권 중 ${review.volumes.length}권 연결`}>
    {Array.from({ length: highest }, (_, i) => <i key={i} className={known.has(i + 1) ? "" : "is-missing"} title={`${i + 1}권${known.has(i + 1) ? " 연결됨" : " 없음"}`} />)}
  </span><span className="kakao-review__missing">{missingKakaoLabel(missing)}</span></>;
}
