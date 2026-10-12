import { expect, it } from "vitest";
import type { AssetAspectFilter, AssetMediaFilter } from "../library/types";
import { viewFilterEmptyTitle, viewFilterLabel } from "./viewFilterLabel";

const cases: [AssetMediaFilter, AssetAspectFilter, string | null, string][] = [
  ["all", "all", null, "항목 없음"],
  ["images", "all", "이미지만", "이미지 없음"],
  ["videos", "all", "영상만", "영상 없음"],
  ["all", "square", "정사각형만", "정사각형 항목 없음"],
  ["images", "square", "정사각형 이미지만", "정사각형 이미지 없음"],
  ["videos", "square", "정사각형 영상만", "정사각형 영상 없음"],
  ["all", "landscape", "가로형만", "가로형 항목 없음"],
  ["images", "landscape", "가로형 이미지만", "가로형 이미지 없음"],
  ["videos", "landscape", "가로형 영상만", "가로형 영상 없음"],
  ["all", "portrait", "세로형만", "세로형 항목 없음"],
  ["images", "portrait", "세로형 이미지만", "세로형 이미지 없음"],
  ["videos", "portrait", "세로형 영상만", "세로형 영상 없음"],
];

it.each(cases)("names %s / %s in the chip and empty state", (media, aspect, label, title) => {
  expect(viewFilterLabel(media, aspect)).toBe(label);
  expect(viewFilterEmptyTitle(media, aspect)).toBe(title);
});


it.each([
  ['under_30s', '30초 미만'], ['30s_1m', '30초–1분'], ['1m_5m', '1–5분'], ['over_5m', '5분 이상'],
] as const)('names the tablet duration %s without changing PC labels', (duration, label) => {
  expect(viewFilterLabel('all', 'all', duration)).toBe(`${label}만`);
  expect(viewFilterEmptyTitle('all', 'all', duration)).toBe(`${label} 항목 없음`);
  expect(viewFilterLabel('videos', 'portrait', duration)).toBe(`${label} 세로형 영상만`);
  expect(viewFilterEmptyTitle('videos', 'portrait', duration)).toBe(`${label} 세로형 영상 없음`);
  expect(viewFilterLabel('videos', 'portrait', 'all')).toBe(viewFilterLabel('videos', 'portrait'));
});
