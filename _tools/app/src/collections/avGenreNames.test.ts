import { expect, it } from "vitest";
import { AV_GENRE_NAME_COUNT, avGenreMatches, avGenreName, displayAvGenres, hiddenAvGenreCount, isHiddenAvGenre } from "./avGenreNames";

it.each([
  ["単体作品", "단독 출연작"], ["中出し", "질내사정"], ["騎乗位", "기승위"], ["痴女", "치녀"], ["人妻・主婦", "유부녀·주부"],
  ["寝取り・寝取られ・NTR", "NTR"], ["3P・4P", "3P·4P"], ["フェラ", "펠라치오"], ["潮吹き", "분수"], ["野外・露出", "야외·노출"],
])("names the tag %s literally", (tag, korean) => {
  expect(avGenreName(tag)).toBe(korean);
});

it("keeps the Japanese original for a tag the table does not know", () => {
  expect(avGenreName("ギリモザ")).toBe("ギリモザ");
  expect(avGenreName("  未登録タグ ")).toBe("未登録タグ");
});

it("covers the common DMM genre list", () => {
  expect(AV_GENRE_NAME_COUNT).toBeGreaterThan(300);
});

it.each(["セール対象商品", "KMPグループ大感謝祭40％オフセール", "40%OFFセール", "サンプル動画", "ポイント還元", "期間限定", "ハイビジョン", "4K", "独占配信", "配信専用"])(
  "hides the sale, sample or distribution tag %s", tag => { expect(isHiddenAvGenre(tag)).toBe(true); });

it.each(["単体作品", "ハメ撮り", "中出し", "VR専用", "企画"])("does not hide the genre %s", tag => { expect(isHiddenAvGenre(tag)).toBe(false); });

it("lists the shown tags with Korean names, without hidden or repeated ones", () => {
  const tags = ["痴女", "セール対象商品", "ギリモザ", "痴女", "ハイビジョン", " "];
  expect(displayAvGenres(tags)).toEqual([{ original: "痴女", name: "치녀" }, { original: "ギリモザ", name: "ギリモザ" }]);
  expect(hiddenAvGenreCount(tags)).toBe(2);
  expect(displayAvGenres(null)).toEqual([]);
});

it("matches a search for either the Korean name or the stored original", () => {
  expect(avGenreMatches("痴女", "치녀")).toBe(true);
  expect(avGenreMatches("痴女", "痴")).toBe(true);
  expect(avGenreMatches("痴女", "분수")).toBe(false);
  expect(avGenreMatches("痴女", "")).toBe(true);
});
