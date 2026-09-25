import { describe, expect, it } from "vitest";
import payloads from "../../../../../tests/fixtures/notes-v2/payload-examples.json";
import vectors from "../../../../../tests/fixtures/notes-v2/ledger-vectors.json";
import { incomeDateIn, ledgerSizeProblem, forkedIds, isDate, isMonth, keepOnly, LEDGER, LEDGER_MONTH, ledgerFallback, ledgerLimitProblem, monthFallback, won, type LedgerEntry, type Planned, type Recurring } from "./model";

type Any = Record<string, any>;
const bigName = "가".repeat(100);
const rec = (i: number, change: Partial<Recurring> = {}): Recurring =>
  ({ id: `r${String(i).padStart(3, "0")}`, name: bigName, amount: 10000 + i, every: 1, unit: "month", start: "2026-01-15", trial: false, until: null, memo: "", order: `a${String(i).padStart(3, "0")}`, ...change });
const plan = (i: number): Planned => ({ id: `p${String(i).padStart(3, "0")}`, name: bigName, amount: 20000 + i, month: null, memo: "", dropped: false, order: `a${String(i).padStart(3, "0")}` });
const entry = (i: number, change: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ id: `e${String(i).padStart(3, "0")}`, date: `2026-09-${String(1 + (i % 30)).padStart(2, "0")}`, amount: 1000 + i, name: bigName, createdAt: "2026-09-01T00:00:00Z", ...change });
const lines = (body: string) => { const all = body.split("\n"); return { bytes: new TextEncoder().encode(body).length, lines: all.length, first: all[0], last: all[all.length - 1] }; };

describe("fallback body", () => {
  it("matches the shared payload examples built by every client", () => {
    const ledgers = (payloads.examples as Any[]).filter((e) => [LEDGER, LEDGER_MONTH].includes(e.payload.type));
    expect(ledgers.length).toBeGreaterThanOrEqual(3);
    for (const { name, payload } of ledgers) {
      const body = payload.type === LEDGER ? ledgerFallback(payload) : monthFallback(payload);
      expect(body, name).toBe(payload.body);
    }
  });

  it("is cut at 24 KiB with '… N건 더' exactly as the shared vectors say", () => {
    expect(lines(monthFallback({ month: "2026-09", income: null, entries: Array.from({ length: 500 }, (_, i) => entry(i)) }))).toEqual(vectors.truncation.month);
    expect(lines(ledgerFallback({ title: "가계부", income: 2300000, recurring: Array.from({ length: 200 }, (_, i) => rec(i)), planned: Array.from({ length: 300 }, (_, i) => plan(i)) }))).toEqual(vectors.truncation.ledger);
  });

  it("writes cycles, trials, endings, dropped plans and money in", () => {
    expect(ledgerFallback({ title: "", income: null, recurring: [rec(1, { name: "밀리\n서재", amount: 29700, every: 3, trial: true, until: "2027-01-01" })], planned: [{ ...plan(1), name: "텐트", month: "2026-10", dropped: true }] }))
      .toBe("# 가계부\n\n## 고정·구독\n- 밀리 서재 ₩29,700 · 3개월마다 · 2026-01-15부터 · 무료 체험 · 2027-01-01 만료\n\n## 사고 싶은 것\n- 텐트 ₩20,001 · 2026-10 · 안 사기로 함");
    expect(monthFallback({ month: "2026-10", income: 2500000, entries: [entry(0, { date: "2026-10-02", name: "", in: true, amount: 5000 })] }))
      .toBe("# 2026년 10월 기록 (1건)\n수입 ₩2,500,000\n- 10-02 +₩5,000");
  });
});

describe("limits", () => {
  const month = (entries: LedgerEntry[]) => ({ type: LEDGER_MONTH, ledger: "L", month: "2026-09", income: null, entries });
  it("accepts the maximum and refuses one more", () => {
    expect(ledgerLimitProblem({ type: LEDGER, income: 999_999_999_999, recurring: Array.from({ length: 200 }, (_, i) => rec(i)), planned: Array.from({ length: 300 }, (_, i) => plan(i)) })).toBeNull();
    expect(ledgerLimitProblem({ type: LEDGER, recurring: Array.from({ length: 201 }, (_, i) => rec(i)) })).toMatch("200개");
    expect(ledgerLimitProblem({ type: LEDGER, planned: Array.from({ length: 301 }, (_, i) => plan(i)) })).toMatch("300개");
    expect(ledgerLimitProblem(month(Array.from({ length: 300 }, (_, i) => entry(i))))).toBeNull();
    expect(ledgerLimitProblem(month(Array.from({ length: 301 }, (_, i) => entry(i))))).toMatch("300개");
  });
  it("checks amounts, names, cycles, dates and ids", () => {
    expect(ledgerLimitProblem({ income: 1e12 })).not.toBeNull();
    expect(ledgerLimitProblem(month([entry(1, { amount: 1.5 })]))).not.toBeNull();
    expect(ledgerLimitProblem(month([entry(1, { amount: -1 })]))).not.toBeNull();
    expect(ledgerLimitProblem(month([entry(1, { name: bigName + "가" })]))).not.toBeNull();
    expect(ledgerLimitProblem(month([entry(1, { date: "2026-02-30" })]))).not.toBeNull();
    expect(ledgerLimitProblem(month([entry(1), entry(1)]))).not.toBeNull();
    expect(ledgerLimitProblem(month([entry(1, { recurring: { id: "r", date: "x" } })]))).not.toBeNull();
    expect(ledgerLimitProblem({ ...month([]), month: "2026-13" })).not.toBeNull();
    expect(ledgerLimitProblem({ type: LEDGER, recurring: [rec(1, { every: 0 })] })).not.toBeNull();
    expect(ledgerLimitProblem({ type: LEDGER, recurring: [rec(1, { every: 121 })] })).not.toBeNull();
    expect(ledgerLimitProblem({ type: LEDGER, recurring: [rec(1, { unit: "day" as Recurring["unit"] })] })).not.toBeNull();
    expect(ledgerLimitProblem({ type: LEDGER, recurring: [rec(1, { memo: "m".repeat(501) })] })).not.toBeNull();
    expect(ledgerLimitProblem({ type: LEDGER, planned: [{ ...plan(1), month: "someday" }] })).not.toBeNull();
  });
  it("validates calendar strings", () => {
    expect(isDate("2028-02-29") && !isDate("2026-02-29") && !isDate("2026-9-01") && isMonth("2026-12") && !isMonth("2026-00")).toBe(true);
    expect(won(0)).toBe("₩0");
    expect(won(999_999_999_999)).toBe("₩999,999,999,999");
  });
});

describe("income day", () => {
  it("accepts 1–31 or null and refuses anything else", () => {
    for (const day of [1, 25, 31, null, undefined]) expect(ledgerLimitProblem({ type: LEDGER, income: 2300000, incomeDay: day }), String(day)).toBeNull();
    for (const day of [0, 32, 1.5, -1, "25" as unknown as number]) expect(ledgerLimitProblem({ type: LEDGER, incomeDay: day }), String(day)).toMatch("1~31일");
  });
  it("clamps a day past the month's end to its last day", () => {
    expect(incomeDateIn("2026-02", 31)).toBe("2026-02-28");
    expect(incomeDateIn("2028-02", 30)).toBe("2028-02-29");
    expect(incomeDateIn("2026-09", 25)).toBe("2026-09-25");
    expect(incomeDateIn("2026-09", 5)).toBe("2026-09-05");
    expect(incomeDateIn("2026-09", null)).toBeNull();
    expect(incomeDateIn("2026-09", 0)).toBeNull();
  });
  it("shows the day in the fallback next to the income", () => {
    expect(ledgerFallback({ title: "가계부", income: 2300000, incomeDay: 25, recurring: [], planned: [] })).toBe("# 가계부\n월 수입 ₩2,300,000 · 매달 25일");
    expect(ledgerFallback({ title: "가계부", income: null, incomeDay: 25, recurring: [], planned: [] })).toBe("# 가계부");
  });
});

describe("forks", () => {
  const list = [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 3, forkOf: "a" }];
  it("keeps the chosen version and drops the other", () => {
    expect([...forkedIds(list)].sort()).toEqual(["a", "c"]);
    expect(keepOnly(list, "c")).toEqual([{ id: "b", v: 2 }, { id: "c", v: 3 }]);
    expect(keepOnly(list, "a")).toEqual([{ id: "a", v: 1 }, { id: "b", v: 2 }]);
  });
});

it("shows ledger notes read-only in the generic editors until the ledger screens exist", async () => {
  const { genericView } = await import("./model");
  expect(genericView({ type: "ledger", readOnly: false })).toEqual({ type: "ledger", readOnly: true });
  expect(genericView<{ type: string; readOnly?: boolean }>({ type: "ledger-month" })?.readOnly).toBe(true);
  expect(genericView({ type: "checklist", readOnly: false })?.readOnly).toBe(false);
  expect(genericView(null)).toBeNull();
});

it("checks the 256 KiB payload size before saving", () => {
  const uuid = (i: number) => `${String(i).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const worst = (count: number) => Array.from({ length: count }, (_, i) => entry(i, { id: uuid(i), amount: 999_999_999_999, createdAt: "2026-09-25T12:34:56.789Z", in: true, recurring: { id: uuid(i + 1000), date: "2026-09-25" }, planned: uuid(i + 2000), forkOf: uuid(i + 3000) }));
  const month = (entries: LedgerEntry[]) => ({ type: LEDGER_MONTH, title: "가계부 2026년 9월", ledger: uuid(9), month: "2026-09", income: 2_300_000, entries });
  expect(ledgerSizeProblem(month(worst(300)))).toBeNull();
  expect(ledgerSizeProblem(month(worst(500)))).toMatch("너무 많습니다");
});
