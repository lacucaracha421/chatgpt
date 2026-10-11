import { expect, it } from "vitest";
import type { CharacterTarget } from "../characters/api";
import type { S36Readiness } from "../characters/S36Publication";
import { accuracyRows, allowedWrong, recognitionSeries } from "./recognitionStatusModel";

const target = (id: string, name: string, extra: Partial<CharacterTarget> = {}) => ({ id, displayName: name, seriesClassificationId: "zzz", enabled: true, manualOnly: false, role: "character", ...extra }) as CharacterTarget;
const readiness = (targetId: string, reviewed: number, wrong: number, examples: number): S36Readiness => ({ targetId, reviewed, wrong, examples, status: "collecting" });

it("allows 5% of the judgments as wrong, at least one", () => {
  expect([0, 1, 29, 30, 39, 40, 59, 60, 74, 100, 250].map(allowedWrong)).toEqual([1, 1, 1, 1, 1, 2, 2, 3, 3, 5, 12]);
});

it("lists each character with the recognition in use and its numbers", () => {
  const targets = [target("sna", "수나"), target("nam", "남궁우"), target("sisia", "시시아"), target("manual", "수동이", { enabled: false }), target("x", "기타", { role: "extras" })];
  const rows = new Map([readiness("sna", 74, 0, 126), readiness("nam", 44, 2, 97), readiness("sisia", 36, 3, 42)].map(row => [row.targetId, row]));
  const [series] = recognitionSeries(targets, rows, { series: ["zzz"], excludedTargets: ["sisia"], scoringEnabled: true }, id => id === "zzz" ? "젠레스" : undefined);
  expect(series!.seriesName).toBe("젠레스");
  expect(series!.rows.map(row => [row.name, row.recognition, row.judged, row.examples, row.wrong, row.allowed])).toEqual([
    ["수나", "학습 인식", 74, 126, 0, 3],
    ["남궁우", "학습 인식", 44, 97, 2, 2],
    ["시시아", "기본 인식", 36, 42, 3, 1],
    ["수동이", "수동", 0, 0, 0, 1],
  ]);
  expect(series!.rows.map(row => row.collecting)).toEqual([false, false, true, true]);
  expect(series!.learning).toBe(2);
});

it("uses 기본 인식 where the series is not switched", () => {
  const [series] = recognitionSeries([target("a", "에이")], new Map(), { series: [], excludedTargets: [], scoringEnabled: true }, () => undefined);
  expect(series!.rows[0]!.recognition).toBe("기본 인식");
  expect(series!.seriesName).toBe("시리즈 없음");
});

it("builds the accuracy table from the judged counts", () => {
  const counts = (accepted: number, rejected: number) => ({ pending: 0, accepted, rejected });
  const summary = { automatic: counts(290, 12), recommended: counts(59, 23), doubtful: counts(0, 0) } as never;
  const doubtful = { automatic: counts(0, 0), recommended: counts(0, 0), doubtful: counts(69, 2) } as never;
  expect(accuracyRows(summary, doubtful)).toEqual([
    { label: "자동 후보", judged: 302, accepted: 290, percent: 96 },
    { label: "추천 후보", judged: 82, accepted: 59, percent: 72 },
    { label: "학습 인식이 넣은 것 다시 봄", judged: 71, accepted: 69, percent: 97 },
  ]);
  expect(accuracyRows(null, null).map(row => row.percent)).toEqual([null, null, null]);
});
