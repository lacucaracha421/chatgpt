import type { ReactNode } from "react";
import type { KakaoReview } from "../library/types";
import { expectedKakaoVolumes, missingKakaoLabel, missingKakaoVolumes } from "./kakaoReviewModel";

/** Shared identity and volume marks for the PC review list and tablet overlay. */
export function KakaoReviewIdentity({ name, subtitle, cover }: { name: string; subtitle: string; cover: ReactNode }) {
  return <>{cover}<span className="kakao-review__identity"><strong>{name}</strong><small>{subtitle}</small></span></>;
}
export function KakaoReviewVolumes({ review }: { review: KakaoReview }) {
  const missing = missingKakaoVolumes(review);
  const expected = expectedKakaoVolumes(review);
  const known = new Set(review.volumes);
  return <><span className="kakao-review__volumes" aria-label={`${expected.length}권 중 ${expected.length - missing.length}권 연결`}>
    {expected.map(n => <i key={n} className={known.has(n) ? "" : "is-missing"} title={`${n}권${known.has(n) ? " 연결됨" : " 없음"}`} />)}
  </span><span className="kakao-review__missing">{missingKakaoLabel(missing)}</span></>;
}
