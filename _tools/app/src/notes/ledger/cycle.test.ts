import { describe, expect, it } from "vitest";
import { chargesBetween, chargesInMonth, cycleLabel, inTrial, isEnded, monthlyEquivalent, nextCharges, recurringTotals } from "./cycle";
import type { Recurring } from "./model";

const r = (change: Partial<Recurring>): Recurring => ({ id: "r", name: "구독", amount: 10000, every: 1, unit: "month", start: "2026-01-31", trial: false, until: null, memo: "", order: "V", ...change });

describe("charge dates", () => {
  it("clamps the 29th-31st to the month's end without drifting, including leap years", () => {
    const monthly = r({ start: "2026-01-31" });
    expect(chargesBetween(monthly, "2026-01-01", "2026-04-30")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(chargesInMonth(r({ start: "2027-12-31" }), "2028-02")).toEqual(["2028-02-29"]);
    expect(chargesInMonth(r({ start: "2024-02-29", unit: "year" }), "2025-02")).toEqual(["2025-02-28"]);
    expect(chargesInMonth(r({ start: "2024-02-29", unit: "year" }), "2028-02")).toEqual(["2028-02-29"]);
  });

  it("repeats every N months from the start", () => {
    const quarterly = r({ start: "2026-03-12", every: 3 });
    expect(chargesInMonth(quarterly, "2026-09")).toEqual(["2026-09-12"]);
    expect(chargesInMonth(quarterly, "2026-10")).toEqual([]);
    expect(chargesInMonth(quarterly, "2026-02")).toEqual([]);
    expect(nextCharges(quarterly, "2026-09-13", 2)).toEqual(["2026-12-12", "2027-03-12"]);
  });

  it("counts weekly charges across a month boundary", () => {
    const weekly = r({ unit: "week", start: "2026-09-21" });
    expect(chargesInMonth(weekly, "2026-09")).toEqual(["2026-09-21", "2026-09-28"]);
    expect(chargesInMonth(weekly, "2026-10")).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(chargesInMonth(r({ unit: "week", every: 2, start: "2026-09-21" }), "2026-10")).toEqual(["2026-10-05", "2026-10-19"]);
  });

  it("stops strictly before until (a charge on the until day is excluded)", () => {
    const cancelled = r({ unit: "year", start: "2025-11-02", until: "2026-11-02" });
    expect(chargesInMonth(cancelled, "2025-11")).toEqual(["2025-11-02"]);
    expect(chargesInMonth(cancelled, "2026-11")).toEqual([]);
    expect(nextCharges(cancelled, "2026-01-01", 3)).toEqual([]);
    expect(isEnded(cancelled, "2026-11-01")).toBe(false);
    expect(isEnded(cancelled, "2026-11-02")).toBe(true);
  });

  it("has no charge before the start; a trial ends when the first paid charge starts", () => {
    const trial = r({ trial: true, start: "2026-10-01", amount: 9900 });
    expect(chargesInMonth(trial, "2026-09")).toEqual([]);
    expect(chargesInMonth(trial, "2026-10")).toEqual(["2026-10-01"]);
    expect(inTrial(trial, "2026-09-25")).toBe(true);
    expect(inTrial(trial, "2026-10-01")).toBe(false);
  });

  it("places a yearly charge only in its month", () => {
    const yearly = r({ unit: "year", start: "2026-03-14", amount: 24000 });
    expect(chargesInMonth(yearly, "2026-09")).toEqual([]);
    expect(chargesInMonth(yearly, "2027-03")).toEqual(["2027-03-14"]);
    expect(nextCharges(yearly, "2026-09-25")).toEqual(["2027-03-14"]);
  });
});

describe("malformed cycles", () => {
  it("have no charges instead of looping", () => {
    for (const bad of [r({ every: 0 }), r({ every: -1 }), r({ every: 1.5 }), r({ unit: "day" as Recurring["unit"] }), r({ start: "x" })]) {
      expect(chargesInMonth(bad, "2026-09")).toEqual([]);
      expect(nextCharges(bad, "2026-09-01", 3)).toEqual([]);
      expect(monthlyEquivalent(bad)).toBe(bad.start === "x" ? 10000 : 0);
    }
    expect(nextCharges(r({ unit: "week" }), "2026-01-01", 5000).length).toBeLessThanOrEqual(1100);
  });
});

describe("totals and labels", () => {
  it("rounds the monthly equivalent to the won", () => {
    expect(monthlyEquivalent(r({ amount: 19900, unit: "year" }))).toBe(1658);
    expect(monthlyEquivalent(r({ amount: 29700, every: 3 }))).toBe(9900);
    expect(monthlyEquivalent(r({ amount: 10000, unit: "week" }))).toBe(43333);
    expect(monthlyEquivalent(r({ amount: 10001, every: 2 }))).toBe(5001);
  });

  it("totals only charges active today (no trials, nothing ended)", () => {
    const list = [
      r({ id: "a", amount: 17000 }),
      r({ id: "b", amount: 24000, unit: "year" }),
      r({ id: "c", amount: 9900, trial: true, start: "2026-10-01" }),
      r({ id: "d", amount: 5000, until: "2026-09-01" }),
      r({ id: "e", amount: 8000, start: "2026-11-01" }),
    ];
    expect(recurringTotals(list, "2026-09-25")).toEqual({ monthly: 19000, yearly: 228000, active: 2 });
  });

  it("describes each cycle", () => {
    expect(cycleLabel(r({ start: "2026-01-27" }))).toBe("매월 27일");
    expect(cycleLabel(r({ start: "2026-03-14", unit: "year" }))).toBe("매년 3월 14일");
    expect(cycleLabel(r({ start: "2026-03-12", every: 3 }))).toBe("3개월마다 · 12일");
    expect(cycleLabel(r({ start: "2026-09-21", unit: "week" }))).toBe("매주 월요일");
    expect(cycleLabel(r({ start: "2026-09-21", unit: "week", every: 2 }))).toBe("2주마다 월요일");
  });
});
