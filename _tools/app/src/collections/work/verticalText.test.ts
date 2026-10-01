import { describe, expect, it } from "vitest";
import { fitSpineTitle, spineTitleSplits, verticalSpineRuns, verticalSpineText, SPINE_TITLE_SCALE } from "./verticalText";

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
  it("stands one- or two-digit numbers upright but keeps longer numbers and Latin-attached digits sideways", () => {
    expect(verticalSpineRuns("제12권 3부 2024년 WATCH2")).toEqual([
      { text: "제", upright: false }, { text: "12", upright: true }, { text: "권 ", upright: false }, { text: "3", upright: true },
      { text: "부 2024년 WATCH2", upright: false },
    ]);
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
