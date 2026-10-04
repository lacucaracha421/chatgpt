import { describe, expect, it } from "vitest";
import { fitSpineAuthor, spineAuthorColumns, fitSpineTitle, spineTitleSplits, verticalSpineRuns, verticalSpineText, SPINE_TITLE_SCALE } from "./verticalText";

describe("vertical spine text", () => {
  it("maps punctuation and brackets to vertical presentation forms", () => {
    expect(verticalSpineText("가, 나、다. 라。 마: 바; 사! 아? 자… 차...")).toBe("가︐ 나︑다︒ 라︒ 마︓ 바︔ 사︕ 아︖ 자︙ 차︙");
    expect(verticalSpineText("(가)[나]「다」『라』《마》〈바〉【사】")).toBe("︵가︶﹇나﹈﹁다﹂﹃라﹄︽마︾︿바﹀︻사︼");
    expect(verticalSpineText("가 - 나 ~ 다〜라 마ー")).toBe("가 ︱ 나 〜 다〜라 마︱");
    expect(verticalSpineText("정말!? 진짜!!")).toBe("정말⁉ 진짜‼");
  });
  it("pairs straight and curly quotes", () => {
    expect(verticalSpineText("'가' \"나\" ‘다’ “라”")).toBe("﹁가﹂ ﹃나﹄ ﹁다﹂ ﹃라﹄");
  });
  it("leaves marks inside Latin runs to the sideways run", () => {
    expect(verticalSpineText("JoJo's X-Men 1.5 Re:Zero")).toBe("JoJo's X-Men 1.5 Re:Zero");
  });
  it("combines short digit runs and makes longer runs upright, including Latin-attached digits", () => {
    expect(verticalSpineRuns("제12권 3부 2024년 WATCH2")).toEqual([
      { text: "제", orientation: "mixed" }, { text: "12", orientation: "combined" }, { text: "권 ", orientation: "mixed" }, { text: "3", orientation: "combined" },
      { text: "부 ", orientation: "mixed" }, { text: "2024", orientation: "upright" }, { text: "년 WATCH", orientation: "mixed" }, { text: "2", orientation: "combined" },
    ]);
  });
  it("splits names in reading order with at most two columns", () => {
    expect(spineAuthorColumns(" Shinohara  Kenta ")).toEqual(["Shinohara", "Kenta"]);
    expect(spineAuthorColumns("작가")).toEqual(["작가"]);
    expect(spineAuthorColumns("One Two Three Four")).toEqual(["One", "Two Three Four"]);
    expect(spineAuthorColumns("  ")).toEqual([]);
  });
  it("fits authors without dropping letters or going below 7px", () => {
    const fit = (author: string, available: number, base = 10) => fitSpineAuthor(author, { available, base, length: text => text.length * base });
    expect(fit("Kenta", 100)).toMatchObject({ fontSize: 10, inlineScale: 1 });
    expect(fit("Shinohara Kenta", 72)).toMatchObject({ fontSize: 8, inlineScale: 1 });
    const long = fit("First VeryLongAuthorName", 20);
    expect(long.columns).toEqual(["First", "VeryLongAuthorName"]);
    expect(long.fontSize).toBe(7);
    expect(18 * long.fontSize * long.inlineScale).toBeCloseTo(20);
    expect(fit("작가", 100, 4).fontSize).toBe(7);
    expect(fit("", 0)).toMatchObject({ columns: [], inlineScale: 1 });
  });
  it("offers the subtitle split first, then spaces, else the middle", () => {
    const splits = spineTitleSplits("드래곤 퀘스트 다이의 대모험 : 용사 아방과 옥염의 마왕");
    expect(splits[0]).toEqual({ parts: ["드래곤 퀘스트 다이의 대모험", "용사 아방과 옥염의 마왕"], natural: true });
    expect(splits.slice(1).every(split => !split.natural)).toBe(true);
    expect(spineTitleSplits("기동전사 - 건담")[0]).toEqual({ parts: ["기동전사", "건담"], natural: true });
    expect(spineTitleSplits("원피스원피스")).toEqual([{ parts: ["원피스", "원피스"], natural: false }]);
    expect(spineTitleSplits("가")).toEqual([]);
  });
  it("keeps, shrinks, splits, then clips", () => {
    const length = (text: string) => Array.from(text).length * 22;
    const fit = (title: string) => fitSpineTitle(title, { available: 290, width: 34, length });
    expect(fit("원피스")).toEqual({ scale: SPINE_TITLE_SCALE.base, columns: ["원피스"], clipped: false });
    const shrunk = fit("죠죠의 기묘한 모험 다이아");
    expect(shrunk.columns).toEqual(["죠죠의 기묘한 모험 다이아"]); expect(shrunk.scale).toBeLessThan(SPINE_TITLE_SCALE.base); expect(shrunk.scale).toBeGreaterThanOrEqual(SPINE_TITLE_SCALE.singleMin);
    const split = fit("죠죠의 기묘한 모험 다이아몬드는 부서지지 않는다");
    expect(split.columns).toHaveLength(2); expect(split.clipped).toBe(false);
    expect(split.columns.join(" ")).toBe("죠죠의 기묘한 모험 다이아몬드는 부서지지 않는다");
    const clipped = fit("가".repeat(80));
    expect(clipped.clipped).toBe(true); expect(clipped.scale).toBe(SPINE_TITLE_SCALE.twoMin);
    expect(clipped.columns.every(column => column.endsWith("︙"))).toBe(true);
    expect(fitSpineTitle("원피스", { available: 0, width: 0, length: () => 0 })).toEqual({ scale: SPINE_TITLE_SCALE.base, columns: ["원피스"], clipped: false });
  });
});
