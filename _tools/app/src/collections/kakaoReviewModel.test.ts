import {expect, it} from "vitest";
import type {KakaoReview} from "../library/types";
import {kakaoReviewSegment, missingKakaoVolumes, missingKakaoLabel, normalizeKakaoTitle} from "./kakaoReviewModel";
const review: KakaoReview = {collectionId: "a", query: "작품", querySource: "name", bound: true, volumes: [1,2,4], highestOwnedVolume: 6, ownedCount: 6, partialDismissed: false, groupFingerprints: [], minVolume: null, maxVolume: null, hideConnectionPrompt: false};
it("checks internal gaps and the owned tail from volume one", () => {
  expect(missingKakaoVolumes(review)).toEqual([3,5,6]);
  expect(missingKakaoLabel([3,5,6])).toBe("3, 5–6권 없음");
  expect(kakaoReviewSegment(review)).toBe("partial");
  expect(kakaoReviewSegment({...review, partialDismissed: true})).toBe("excluded");
  expect(kakaoReviewSegment({...review, volumes: [1,2,3,4,5,6]})).toBeNull();
});
it("keeps prompt hiding separate from bound partial dismissal", () => {
  expect(kakaoReviewSegment({...review, bound: false})).toBe("unlinked");
  expect(kakaoReviewSegment({...review, bound: false, hideConnectionPrompt: true})).toBe("excluded");
  expect(kakaoReviewSegment({...review, hideConnectionPrompt: true})).toBe("partial");
});
it("normalizes width, punctuation, case and spacing without accepting a different edition", () => {
  expect(normalizeKakaoTitle(" Ｄungeon · 밥!")).toBe(normalizeKakaoTitle("dungeon밥"));
  expect(normalizeKakaoTitle("던전밥 컬러판")).not.toBe(normalizeKakaoTitle("던전밥"));
});

it("counts missing volumes in the part numbering space", () => {
  expect(missingKakaoVolumes({...review, minVolume: 64, maxVolume: 80, restartNumbering: true, highestOwnedVolume: 17, volumes: Array.from({length: 16}, (_, i) => i + 1)})).toEqual([17]);
  expect(missingKakaoVolumes({...review, minVolume: 12, maxVolume: 14, restartNumbering: false, highestOwnedVolume: 14, volumes: [12, 14]})).toEqual([13]);
});
