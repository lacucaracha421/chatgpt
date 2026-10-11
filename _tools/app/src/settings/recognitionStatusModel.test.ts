import { expect, it } from "vitest";
import type { CharacterTarget } from "../characters/api";
import { READY_EXAMPLES, READY_REVIEWED, type S36Readiness } from "../characters/S36Publication";
// The same file the library's Rust test checks `allowed_wrong` and `readiness_status` against.
import rule from "../characters/learningRule.fixture.json";
import { accuracyRows, recognitionSeries } from "./recognitionStatusModel";

const target = (id: string, name: string, extra: Partial<CharacterTarget> = {}) => ({ id, displayName: name, seriesClassificationId: "zzz", enabled: true, manualOnly: false, role: "character", ...extra }) as CharacterTarget;
const readiness = (targetId: string, reviewed: number, wrong: number, allowed: number, examples: number, status: S36Readiness["status"]): S36Readiness => ({ targetId, reviewed, wrong, allowed, examples, status });
const enabled = { scoringEnabled: true };

it("shares the rule's numbers with the library: same thresholds, and every fixture case reads the same on the screen", () => {
  expect([rule.readyReviewed, rule.readyExamples]).toEqual([READY_REVIEWED, READY_EXAMPLES]);
  const cases = rule.cases.map((c, index) => ({ c, id: `t${index}` }));
  const targets = cases.map(({ id }) => target(id, id));
  const rows = new Map(cases.map(({ c, id }) => [id, readiness(id, c.judged, c.wrong, c.allowed, c.examples, c.status as S36Readiness["status"])]));
  const [series] = recognitionSeries(targets, rows, enabled, () => "시리즈");
  const byId = new Map(series!.rows.map(row => [row.targetId, row]));
  for (const { c, id } of cases) {
    const row = byId.get(id)!;
    expect([row.judged, row.examples, row.wrong, row.allowed]).toEqual([c.judged, c.examples, c.wrong, c.allowed]);
    expect(row.recognition).toBe(c.status === "learning" ? "학습 인식" : "기본 인식");
    expect(row.collecting).toBe(c.status === "collecting");
    // 5% of the judgments rounded down, at least one: the figure shown beside the wrong count.
    expect(c.allowed).toBe(Math.max(1, Math.floor(c.judged * 0.05)));
    // The line a character must reach to be placed by 학습 인식.
    const passes = c.judged >= rule.readyReviewed && c.examples >= rule.readyExamples && c.wrong <= c.allowed;
    expect(c.status === "learning").toBe(passes);
  }
});

it("lists each character with the recognition in use and its numbers", () => {
  const targets = [target("sna", "수나"), target("nam", "남궁우"), target("sisia", "시시아"), target("manual", "수동이", { enabled: false }), target("x", "기타", { role: "extras" })];
  const rows = new Map([readiness("sna", 74, 0, 3, 126, "learning"), readiness("nam", 44, 2, 2, 97, "learning"), readiness("sisia", 36, 3, 1, 62, "hold")].map(row => [row.targetId, row]));
  const [series] = recognitionSeries(targets, rows, enabled, id => id === "zzz" ? "젠레스" : undefined);
  expect(series!.seriesName).toBe("젠레스");
  expect(series!.rows.map(row => [row.name, row.recognition, row.judged, row.examples, row.wrong, row.allowed])).toEqual([
    ["수나", "학습 인식", 74, 126, 0, 3],
    ["남궁우", "학습 인식", 44, 97, 2, 2],
    ["시시아", "기본 인식", 36, 62, 3, 1],
    ["수동이", "수동", 0, 0, 0, 1],
  ]);
  expect(series!.rows.map(row => row.collecting)).toEqual([false, false, false, true]);
  expect(series!.learning).toBe(2);
});

it("shows 기본 인식 for everyone while the 학습 인식 preparation is off, since nothing is placed by it then", () => {
  const rows = new Map([readiness("a", 74, 0, 3, 126, "learning")].map(row => [row.targetId, row]));
  const [series] = recognitionSeries([target("a", "에이")], rows, { scoringEnabled: false }, () => undefined);
  expect(series!.rows[0]!.recognition).toBe("기본 인식");
  expect(series!.learning).toBe(0);
});

it("uses 기본 인식 where nothing has been judged yet", () => {
  const [series] = recognitionSeries([target("a", "에이")], new Map(), enabled, () => undefined);
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

it("keeps the automatic judgments apart from the people's: the totals follow the shared rule, the split is shown", () => {
  const cases = rule.automaticCases.map((c, index) => ({ c, id: `a${index}` }));
  const rows = new Map(cases.map(({ c, id }) => [id, { targetId: id, reviewed: c.judged, reviewedAuto: c.auto, wrong: c.wrong, wrongAuto: c.wrongAuto, allowed: c.allowed, examples: c.examples, status: c.status as S36Readiness["status"] }]));
  const [series] = recognitionSeries(cases.map(({ id }) => target(id, id)), rows, enabled, () => "시리즈");
  const byId = new Map(series!.rows.map(row => [row.targetId, row]));
  for (const { c, id } of cases) {
    const row = byId.get(id)!;
    expect([row.judged, row.judgedAuto, row.wrong, row.wrongAuto, row.examples]).toEqual([c.manual + c.auto, c.auto, c.wrongManual + c.wrongAuto, c.wrongAuto, c.examples]);
    expect(row.judged).toBe(c.judged);
    expect(row.wrong).toBe(c.wrong);
    expect(c.allowed).toBe(Math.max(1, Math.floor(c.judged * 0.05)));
    expect(row.recognition).toBe(c.status === "learning" ? "학습 인식" : "기본 인식");
    // Examples are the people's acceptances alone, so the automatic judgments never lift them.
    expect(c.status === "learning").toBe(c.judged >= rule.readyReviewed && c.examples >= rule.readyExamples && c.wrong <= c.allowed);
  }
});

it("treats a library that does not report the automatic split as all by people", () => {
  const rows = new Map([readiness("a", 30, 0, 1, 50, "learning")].map(row => [row.targetId, row]));
  const [series] = recognitionSeries([target("a", "에이")], rows, enabled, () => undefined);
  expect([series!.rows[0]!.judgedAuto, series!.rows[0]!.wrongAuto]).toEqual([0, 0]);
});
