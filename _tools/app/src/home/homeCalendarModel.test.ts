import { describe, expect, it } from "vitest";
import { addDays, calendarPayments, mondayOf, releaseCalendarModel } from "./homeCalendarModel";
import type { Note } from "../notes/store";
import type { Recurring } from "../notes/ledger/model";

const entry = (name: string, date: string | null, fresh = false) => ({ name, date, fresh });

describe("release calendar model", () => {
  it("starts on this week's Monday, whatever day today is", () => {
    // 2026-09-21 is a Monday.
    expect(mondayOf("2026-09-21")).toBe("2026-09-21");
    expect(mondayOf("2026-09-26")).toBe("2026-09-21");
    expect(mondayOf("2026-09-27")).toBe("2026-09-21");
    expect(mondayOf("2026-09-28")).toBe("2026-09-28");
    expect(addDays("2026-09-28", 5)).toBe("2026-10-03");
    const sunday = releaseCalendarModel([], "2026-09-27");
    expect(sunday.days[0]!.date).toBe("2026-09-21");
    expect(sunday.days[6]!.tense).toBe("today");
  });

  it("makes fourteen days that carry the weekday column, the past, today and D-days", () => {
    const { days } = releaseCalendarModel([], "2026-09-26");
    expect(days).toHaveLength(14);
    expect(days[0]).toMatchObject({ date: "2026-09-21", index: 0, tense: "past", daysFromToday: -5 });
    expect(days[5]).toMatchObject({ date: "2026-09-26", tense: "today", daysFromToday: 0 });
    expect(days[6]).toMatchObject({ date: "2026-09-27", tense: "future", daysFromToday: 1 });
    expect(days[13]).toMatchObject({ date: "2026-10-04", daysFromToday: 8, index: 13 });
    // Across the month boundary the day of the month restarts.
    expect(days[9]!.day).toBe(30);
    expect(days[10]!.day).toBe(1);
    expect(days.map(day => day.index % 7)).toEqual([0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6]);
  });

  it("puts each release in its day, NEW first, and keeps the source order otherwise", () => {
    const rows = [entry("a", "2026-09-26"), entry("b", "2026-09-26", true), entry("c", "2026-09-26"), entry("d", "2026-09-22", true)];
    const { days } = releaseCalendarModel(rows, "2026-09-26");
    expect(days[5]!.entries.map(row => row.name)).toEqual(["b", "a", "c"]);
    expect(days[1]!.entries.map(row => row.name)).toEqual(["d"]);
  });

  it("holds NEW releases the grid cannot place, and counts the ones after it", () => {
    const rows = [
      entry("old new", "2026-09-10", true), entry("old seen", "2026-09-10"), entry("no date new", null, true), entry("no date", null),
      entry("edge", "2026-10-04"), entry("after 1", "2026-10-05"), entry("after 2", "2026-11-20"),
    ];
    const model = releaseCalendarModel(rows, "2026-09-26");
    expect(model.earlier.map(row => row.name)).toEqual(["old new", "no date new"]);
    expect(model.days[13]!.entries.map(row => row.name)).toEqual(["edge"]);
    expect(model.later?.from).toBe("2026-10-05");
    expect(model.later?.entries.map(row => row.name)).toEqual(["after 1", "after 2"]);
    expect(releaseCalendarModel([entry("edge", "2026-10-04")], "2026-09-26").later).toBeNull();
  });
});

const recurring = (extra: Partial<Recurring> = {}): Recurring => ({ id: "netflix", name: "넷플릭스", amount: 13500, every: 1, unit: "month", start: "2026-01-26", until: null, trial: false, order: "a", memo: "", ...extra });
const ledger = (extra: Partial<Note> = {}): Note => ({ id: "ledger", title: "가계부", body: "", type: "ledger", deleted: false, pinned: true, pending: false, conflict: false, localRevision: 1, createdAt: "", updatedAt: "", recurring: [recurring()], ...extra });

describe("calendar activity", () => {
  it("places monthly charges and trial ends on their exact dates, once per trial", () => {
    const payments = calendarPayments([ledger({ recurring: [recurring(), recurring({ id: "trial", name: "체험", start: "2026-09-28", trial: true })] })], "2026-09-26");
    expect(payments).toEqual([
      { key: "ledger:netflix:2026-09-26", date: "2026-09-26", noteId: "ledger", label: "넷플릭스 13,500원" },
      { key: "ledger:trial:2026-09-28", date: "2026-09-28", noteId: "ledger", label: "체험 무료 끝남" },
    ]);
    const model = releaseCalendarModel([], "2026-09-26", 2, { payments });
    expect(model.days[5]!.payments).toEqual([payments[0]]);
    expect(model.days[7]!.payments).toEqual([payments[1]]);
  });

  it("reuses month-end clamping, price history and completed/skipped charge rules", () => {
    const schedule = ledger({ recurring: [recurring({ start: "2026-01-31", priceHistory: [{ until: "2026-10-01", amount: 12000 }] })] });
    expect(calendarPayments([schedule], "2026-09-30")[0]).toMatchObject({ date: "2026-09-30", label: "넷플릭스 12,000원" });
    const month = ledger({ id: "month", type: "ledger-month", ledger: "ledger", month: "2026-09", archived: true,
      recurring: [], entries: [{ id: "paid", name: "결제", date: "2026-09-30", amount: 0, createdAt: "", recurring: { id: "netflix", date: "2026-09-30" } }] });
    expect(calendarPayments([schedule, month], "2026-09-30")).toEqual([]);
  });

  it("hides locked, concealed, archived and deleted ledgers even if their bodies remain present", () => {
    const hidden = [ledger({ redacted: true }), ledger({ concealed: true }), ledger({ archived: true }), ledger({ deleted: true }), ledger({ type: "secret" })];
    expect(calendarPayments(hidden, "2026-09-26")).toEqual([]);
  });

  it("does not invent a day for month-only planned purchases", () => {
    const planned = { id: "shoes", name: "러닝화", amount: 89000, month: "2026-09", dropped: false, order: "a", memo: "" };
    expect(calendarPayments([ledger({ recurring: [], planned: [planned] })], "2026-09-26")).toEqual([]);
  });

  it("keeps all payments reachable and counts only the lines after the first two as overflow", () => {
    const payments = calendarPayments([ledger({ recurring: Array.from({ length: 5 }, (_, index) => recurring({ id: String(index) })) })], "2026-09-26");
    const model = releaseCalendarModel([], "2026-09-26", 2, { payments });
    expect(model.days[5]!.payments).toHaveLength(5);
    expect(model.days[5]!.paymentOverflow).toBe(3);
    expect(model.days[4]!.paymentOverflow).toBe(0);
  });

  it("maps saved counts only to this week's elapsed local days, including today", () => {
    const saved = [ { date: "2026-09-20", count: 9 }, { date: "2026-09-21", count: 12 }, { date: "2026-09-26", count: 3 }, { date: "2026-09-27", count: 20 } ];
    const model = releaseCalendarModel([], "2026-09-26", 2, { saved });
    expect(model.days.map(day => day.savedCount)).toEqual([12, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
