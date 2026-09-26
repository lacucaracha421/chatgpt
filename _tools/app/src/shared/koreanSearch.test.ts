import { describe, expect, it } from "vitest";
import { createKoreanMatcher, matchesKoreanSearch, normalizeSearchText } from "./koreanSearch";

describe("koreanSearch", () => {
  it("matches everything for an empty or blank query", () => {
    expect(matchesKoreanSearch("서리", "")).toBe(true);
    expect(matchesKoreanSearch("서리", "   ")).toBe(true);
    expect(matchesKoreanSearch(null, "")).toBe(true);
  });

  it("matches by 초성", () => {
    expect(matchesKoreanSearch("서리", "ㅅㄹ")).toBe(true);
    expect(matchesKoreanSearch("은하 서리", "ㅅㄹ")).toBe(true);
    expect(matchesKoreanSearch("까닭", "ㄲㄷ")).toBe(true);
    expect(matchesKoreanSearch("서리", "ㄹㅅ")).toBe(false);
    expect(matchesKoreanSearch("사과", "ㅅㄹ")).toBe(false);
  });

  it("matches a syllable still being composed", () => {
    expect(matchesKoreanSearch("가락", "갈")).toBe(true);
    expect(matchesKoreanSearch("달걀", "닭")).toBe(true);
    expect(matchesKoreanSearch("사과", "삭")).toBe(true);
    expect(matchesKoreanSearch("과일", "고")).toBe(true);
    expect(matchesKoreanSearch("서리", "서ㄹ")).toBe(true);
    expect(matchesKoreanSearch("가락", "갈비")).toBe(false);
    // A jamo run may not start inside a syllable: 안 ends in ㄴ, it is not 나.
    expect(matchesKoreanSearch("안아", "나")).toBe(false);
  });

  it("mixes Hangul and Latin, ignoring case and spaces", () => {
    expect(matchesKoreanSearch("Blue Archive 서리", "bluearchive")).toBe(true);
    expect(matchesKoreanSearch("Blue Archive 서리", "ARCHIVE ㅅㄹ")).toBe(true);
    expect(matchesKoreanSearch("NIKKE 2B", "nikkeㅅ")).toBe(false);
    expect(matchesKoreanSearch("NIKKE 서리", "nikkeㅅㄹ")).toBe(true);
    expect(matchesKoreanSearch("서 리", "서리")).toBe(true);
    expect(matchesKoreanSearch("서리", "서 리")).toBe(true);
    expect(normalizeSearchText(" A b\tC ")).toBe("abc");
  });

  it("normalizes decomposed Hangul (NFD file names)", () => {
    expect(matchesKoreanSearch("서리".normalize("NFD"), "ㅅㄹ")).toBe(true);
    expect(matchesKoreanSearch("서리", "서리".normalize("NFD"))).toBe(true);
  });

  it("requires every word in some field", () => {
    const matcher = createKoreanMatcher("서리 kim");
    expect(matcher(["서리", "Kim"])).toBe(true);
    expect(matcher(["서리", "Lee"])).toBe(false);
    expect(matcher([null, undefined, "서리 kim"])).toBe(true);
  });

  it("filters 5k items quickly", () => {
    const syllables = "가나다라마바사아자차카타파하서리은하별";
    const items = Array.from({ length: 5000 }, (_, index) =>
      `${syllables[index % syllables.length]}${syllables[(index * 7) % syllables.length]}${syllables[(index * 13) % syllables.length]} Item ${index}`);
    const typing = ["ㅅ", "ㅅㄹ", "서", "설", "서리", "item 42", "갈"];
    const started = performance.now();
    for (const query of typing) {
      const matcher = createKoreanMatcher(query);
      items.filter((item) => matcher(item));
    }
    const elapsed = performance.now() - started;
    expect(items.filter(createKoreanMatcher("ㅅㄹ")).length).toBeGreaterThan(0);
    // Cold cache included; generous bound so slow CI hosts stay green.
    expect(elapsed).toBeLessThan(1500);
  });
});
