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
