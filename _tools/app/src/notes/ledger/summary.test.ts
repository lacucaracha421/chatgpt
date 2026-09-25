import { describe, expect, it } from "vitest";
import type { LedgerEntry, Planned, Recurring } from "./model";
import { ledgerEntries, monthNotesOf, monthSummary, type MonthNoteLike } from "./summary";

const rec = (id: string, name: string, amount: number, start: string, change: Partial<Recurring> = {}): Recurring =>
  ({ id, name, amount, every: 1, unit: "month", start, trial: false, until: null, memo: "", order: id, ...change });
const plan = (id: string, name: string, amount: number, month: string | null, change: Partial<Planned> = {}): Planned =>
  ({ id, name, amount, month, memo: "", dropped: false, order: id, ...change });
const entry = (id: string, date: string, amount: number, name: string, change: Partial<LedgerEntry> = {}): LedgerEntry =>
  ({ id, date, amount, name, createdAt: `${date}T12:00:00Z`, ...change });
const monthNote = (month: string, entries: LedgerEntry[], change: Partial<MonthNoteLike> = {}): MonthNoteLike =>
  ({ id: `m-${month}`, type: "ledger-month", ledger: "L", month, income: null, entries, deleted: false, updatedAt: "2026-09-25T00:00:00Z", ...change });

// The mockup (docs/prototypes/budget-notes-20260925): 2,300,000 − 1,612,500 − 124,890 = 562,610 on 2026-09-25.
const recurring = [
  rec("rent", "월세", 800000, "2026-01-01"),
  rec("insurance", "보험", 98400, "2026-01-05"),
  rec("phone", "통신", 55000, "2026-01-10"),
  rec("netflix", "넷플릭스", 17000, "2026-01-03"),
  rec("millie", "밀리의 서재", 29700, "2026-03-12", { every: 3 }),
  rec("coupang", "쿠팡 와우", 7890, "2026-01-27"),
  rec("gpt", "ChatGPT Plus", 28000, "2026-01-29"),
  rec("google", "Google One", 24000, "2026-03-14", { unit: "year" }),
  rec("nintendo", "닌텐도 온라인", 19900, "2025-11-02", { unit: "year", until: "2026-11-02" }),
  rec("disney", "디즈니+", 9900, "2026-10-01", { trial: true }),
];
const planned = [
  plan("shoes", "러닝화", 89000, "2026-09"),
  plan("umbrella", "접이식 우산", 25000, "2026-09"),
  plan("tent", "텐트", 300000, "2026-09", { dropped: true }),
  plan("arm", "모니터암", 45000, null),
];
const ledger = { income: 2300000, recurring, planned };
const september = [
  entry("e1", "2026-09-25", 9500, "점심 김치찌개"),
  entry("e2", "2026-09-25", 3200, "편의점"),
  entry("e3", "2026-09-24", 31800, "저녁 장보기"),
  entry("e4", "2026-09-19", 22000, "접이식 우산", { planned: "umbrella" }),
  entry("e5", "2026-09-12", 420000, "여행 숙소"),
  entry("e6", "2026-09-06", 125900, "마트"),
];

describe("month summary", () => {
  it("reproduces the mockup numbers", () => {
    const s = monthSummary(ledger, [monthNote("2026-09", september)], "2026-09", "2026-09-25");
    expect(s.phase).toBe("current");
    expect(s.income).toBe(2300000);
    expect(s.spent).toBe(1612500);
    expect(s.scheduledCharges).toBe(35890);
    expect(s.scheduledPlans).toBe(89000);
    expect(s.scheduled).toBe(124890);
    expect(s.available).toBe(562610);
    expect(s.remainingDays).toBe(6);
    expect(s.perDay).toBe(93768);
    expect(s.recurringThisMonth).toBe(1035990);
    expect(s.upcomingCharges.map((c) => c.recurring.name)).toEqual(["쿠팡 와우", "ChatGPT Plus"]);
    expect(s.pastCharges.map((c) => c.date)).toEqual(["2026-09-01", "2026-09-03", "2026-09-05", "2026-09-10", "2026-09-12"]);
    expect(s.plans.map((p) => [p.plan.id, p.doneBy?.id ?? null])).toEqual([["shoes", null], ["umbrella", "e4"]]);
    expect(s.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    expect(s.reviewCount).toBe(0);
  });

  it("replaces a confirmed charge with its entry and skips one confirmed with 0", () => {
    const entries = [
      ...september,
      entry("c1", "2026-09-01", 810000, "월세", { recurring: { id: "rent", date: "2026-09-01" } }),
      entry("c2", "2026-09-25", 0, "ChatGPT Plus", { recurring: { id: "gpt", date: "2026-09-29" } }),
    ];
    const s = monthSummary(ledger, [monthNote("2026-09", entries)], "2026-09", "2026-09-25");
    expect(s.spent).toBe(1612500 + 10000);
    expect(s.scheduledCharges).toBe(7890);
    expect(s.recurringThisMonth).toBe(1035990 + 10000 - 28000);
    expect(s.pastCharges.some((c) => c.recurring.id === "rent")).toBe(false);
  });

  it("pairs a confirmation of a moved charge date with that item's charge instead of counting both", () => {
    const moved = [...september, entry("c", "2026-09-28", 28000, "ChatGPT Plus", { recurring: { id: "gpt", date: "2026-09-28" } })];
    const s = monthSummary(ledger, [monthNote("2026-09", moved)], "2026-09", "2026-09-25");
    expect(s.spent).toBe(1612500 + 28000);
    expect(s.scheduledCharges).toBe(7890);
    expect(s.recurringThisMonth).toBe(1035990);
  });

  it("adds money-in entries and the month's own income", () => {
    const entries = [...september, entry("in", "2026-09-24", 18000, "택배 반품 환불", { in: true })];
    const s = monthSummary(ledger, [monthNote("2026-09", entries, { income: 2500000 })], "2026-09", "2026-09-25");
    expect(s.income).toBe(2518000);
    expect(s.spent).toBe(1612500);
    expect(s.available).toBe(2518000 - 1612500 - 124890);
  });

  it("shows spent as the headline without an income", () => {
    const s = monthSummary({ ...ledger, income: null }, [monthNote("2026-09", september)], "2026-09", "2026-09-25");
    expect(s.incomeSet).toBe(false);
    expect(s.available).toBeNull();
    expect(s.perDay).toBeNull();
    expect(s.spent).toBe(1612500);
  });

  it("finalizes past months and schedules everything in future months", () => {
    const august = monthSummary(ledger, [monthNote("2026-08", [entry("a", "2026-08-10", 5000, "책")])], "2026-08", "2026-09-25");
    expect(august.phase).toBe("past");
    // Aug: rent, insurance, phone, netflix, coupang, gpt; millie (3,6,9,12) is not due.
    expect(august.spent).toBe(5000 + 800000 + 98400 + 55000 + 17000 + 7890 + 28000);
    expect(august.scheduled).toBe(0);
    expect(august.remainingDays).toBeNull();
    const october = monthSummary({ ...ledger, planned: [plan("desk", "책상", 150000, "2026-10")] }, [], "2026-10", "2026-09-25");
    expect(october.phase).toBe("future");
    expect(october.spent).toBe(0);
    // Oct: rent, insurance, phone, netflix, coupang, gpt, disney (trial ends) = 1,016,190, plus the plan.
    expect(october.scheduledCharges).toBe(800000 + 98400 + 55000 + 17000 + 7890 + 28000 + 9900);
    expect(october.scheduled).toBe(october.scheduledCharges + 150000);
  });

  it("marks a plan done from an entry in another month and ignores dropped plans", () => {
    const notes = [monthNote("2026-09", september), monthNote("2026-10", [entry("buy", "2026-10-02", 87000, "러닝화", { planned: "shoes" })])];
    const s = monthSummary(ledger, notes, "2026-09", "2026-09-25");
    expect(s.scheduledPlans).toBe(0);
    expect(s.plans.find((p) => p.plan.id === "shoes")?.doneBy?.id).toBe("buy");
    expect(s.plans.some((p) => p.plan.id === "tent")).toBe(false);
  });

  it("counts forked entries (both copies) until one is kept", () => {
    const forked = [...september, entry("f", "2026-09-25", 9000, "점심 김치찌개", { forkOf: "e1" })];
    const s = monthSummary(ledger, [monthNote("2026-09", forked)], "2026-09", "2026-09-25");
    expect(s.reviewCount).toBe(1);
    expect(s.spent).toBe(1612500 + 9000);
  });
});

describe("reading month notes", () => {
  it("dedupes an entry found in two month notes, preferring the note of its date's month", () => {
    const moved = entry("m", "2026-10-01", 5000, "옮긴 기록");
    const stale = { ...moved, amount: 4000 };
    const notes = [monthNote("2026-09", [...september, stale]), monthNote("2026-10", [moved])];
    const entries = ledgerEntries(notes);
    expect(entries.filter((e) => e.id === "m")).toEqual([moved]);
    expect(entries).toHaveLength(september.length + 1);
    // Keep-both copies of one month count each entry once.
    const copies = [monthNote("2026-09", september), monthNote("2026-09", september, { id: "copy" })];
    expect(monthSummary(ledger, copies, "2026-09", "2026-09-25").spent).toBe(1612500);
  });

  it("selects only this ledger's live month notes", () => {
    const notes = [monthNote("2026-09", []), monthNote("2026-08", [], { ledger: "other" }), monthNote("2026-07", [], { deleted: true }), { ...monthNote("2026-06", []), type: "text" }];
    expect(monthNotesOf(notes, "L").map((n) => n.month)).toEqual(["2026-09"]);
  });
});
