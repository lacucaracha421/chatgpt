import { expect, it } from "vitest";
import { displayGenres } from "./displayGenres";

it.each([
  ["Action & Adventure", "액션 & 모험"],
  ["Sci-Fi & Fantasy", "SF & 판타지"],
  ["War & Politics", "전쟁 & 정치"],
  ["Kids", "키즈"], ["News", "뉴스"], ["Reality", "리얼리티"],
  ["Soap", "연속극"], ["Talk", "토크"],
])("translates the exact TV genre %s", (value, expected) => {
  expect(displayGenres(value)).toBe(expected);
});

it("preserves other genres, separators, and partial or case-mismatched names", () => {
  expect(displayGenres("Action & Adventure · 애니메이션, Talk")).toBe("액션 & 모험 · 애니메이션, 토크");
  expect(displayGenres("Action, Kids & Family · talk · Newsroom")).toBe("Action, Kids & Family · talk · Newsroom");
  expect(displayGenres(null)).toBe("");
});
