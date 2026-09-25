import { expect, it } from "vitest";
import { koreanGenreName, koreanGenres, koreanGenreText } from "./genreNames";

it.each([
  ["Action", "액션"], ["Romance", "로맨스"], ["Comedy", "코미디"], ["Isekai", "이세계"],
  ["Slice of Life", "일상"], ["School Life", "학원"], ["Boys' Love", "BL"], ["Girls' Love", "백합"],
  ["Reincarnation", "환생"], ["Time Travel", "타임리프"], ["Villainess", "악역 영애"], ["Wuxia", "무협"],
  ["Psychological", "심리"], ["Tragedy", "비극"], ["Web Comic", "웹코믹"], ["Long Strip", "세로 스크롤"],
  ["Full Color", "풀컬러"], ["Oneshot", "단편"], ["4-Koma", "4컷"], ["Award Winning", "수상작"],
  ["Official Colored", "공식 컬러"], ["Adaptation", "원작 있음"], ["Anthology", "앤솔러지"], ["Doujinshi", "동인지"],
  ["Sci-Fi", "SF"], ["Post-Apocalyptic", "포스트 아포칼립스"], ["Sexual Violence", "성폭력"],
])("names the MangaDex tag %s in Korean", (tag, korean) => {
  expect(koreanGenreName(tag)).toBe(korean);
});

it("matches regardless of case, curly apostrophes and spacing", () => {
  expect(koreanGenreName("slice of life")).toBe("일상");
  expect(koreanGenreName("  SCHOOL   LIFE ")).toBe("학원");
  expect(koreanGenreName("Boys’ Love")).toBe("BL");
});

it("passes unknown and already-Korean names through unchanged", () => {
  expect(koreanGenreName("Cyberpunk Noir")).toBe("Cyberpunk Noir");
  expect(koreanGenreName("판타지")).toBe("판타지");
});

it("splits a stored list, translates it and drops duplicates after mapping", () => {
  expect(koreanGenres("Action, Romance, Isekai")).toEqual(["액션", "로맨스", "이세계"]);
  expect(koreanGenres("Fantasy · 판타지, fantasy,  , Wuxia")).toEqual(["판타지", "무협"]);
  expect(koreanGenres("Girls' Love, Shoujo Ai")).toEqual(["백합"]);
  expect(koreanGenres(null)).toEqual([]);
  expect(koreanGenres("")).toEqual([]);
  expect(koreanGenreText("Comedy, Drama, Unknown Tag")).toBe("코미디, 드라마, Unknown Tag");
});
