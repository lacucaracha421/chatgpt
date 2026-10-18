import { describe, expect, it } from "vitest";
import type { CollectionSummary, ReleaseBoardEntry, ReleaseWishlistItem } from "../library/types";
import type { LedgerEntry } from "../notes/ledger/model";
import type { Note } from "../notes/store";
import type { PaymentEvent } from "./homeCalendarModel";
import { gridDates, homeLedger, ledgerLists, monthDays, monthSavedQueries, monthTitle, monthTotals, movedSelection, pastReleaseRows, savedHeat } from "./homeMonthModel";

const entry = (id: string, date: string, amount: number, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ id, date, amount, name: id, createdAt: `${date}T00:00:00Z`, ...extra });

describe("month grid", () => {
  it("always shows six Sunday-first weeks around the month", () => {
    const dates = gridDates("2026-09");
    expect(dates).toHaveLength(42);
    expect(dates[0]).toBe("2026-08-30");
    expect(dates[41]).toBe("2026-10-10");
    // February 2027 starts on a Monday and still gets six rows.
    expect(gridDates("2027-02")[0]).toBe("2027-01-31");
    expect(gridDates("2027-02")).toHaveLength(42);
  });

  it("titles another year with the year", () => {
    expect(monthTitle("2026-10", "2026-10-17")).toBe("10월");
    expect(monthTitle("2027-01", "2026-10-17")).toBe("2027년 1월");
  });

  it("collects each day's markers; saved counts only for elapsed days and income never counts as spending", () => {
    const payments: PaymentEvent[] = [{ key: "k", date: "2026-10-21", noteId: "n", name: "클로드", amount: 159000, kind: "charge" }];
    const days = monthDays("2026-10", "2026-10-17", {
      releases: [{ date: "2026-10-20", fresh: false }, { date: "2026-10-15", fresh: true }, { date: "2026-10-15", fresh: false }],
      saved: [{ date: "2026-10-16", count: 25 }, { date: "2026-10-18", count: 9 }],
      payments, memos: new Map([["2026-10-03", "옷 정리"]]),
      entries: [entry("a", "2026-10-15", 8000), entry("b", "2026-10-15", 12000), entry("c", "2026-10-15", 5000, { in: true })],
    });
    const by = (date: string) => days.find(day => day.date === date)!;
    expect(by("2026-10-15")).toMatchObject({ spent: 20000, inMonth: true, tense: "past" });
    expect(by("2026-10-15").releases[0]!.fresh).toBe(true);
    expect(by("2026-10-16").savedCount).toBe(25);
    expect(by("2026-10-18").savedCount).toBe(0);
    expect(by("2026-10-21").payments).toHaveLength(1);
    expect(by("2026-10-03").hasMemo).toBe(true);
    expect(by("2026-10-17")).toMatchObject({ tense: "today", currentWeek: true });
    expect(by("2026-10-18").currentWeek).toBe(true);
    expect(by("2026-10-19").currentWeek).toBe(false);
    expect(by("2026-09-30").inMonth).toBe(false);
  });

  it("totals the month's spending and its unconfirmed charges", () => {
    const payments: PaymentEvent[] = [
      { key: "a", date: "2026-10-21", noteId: "n", name: "A", amount: 1000, kind: "charge" },
      { key: "b", date: "2026-10-22", noteId: "n", name: "B", amount: 500, kind: "trialEnd" },
      { key: "c", date: "2026-11-01", noteId: "n", name: "C", amount: 700, kind: "charge" },
    ];
    expect(monthTotals("2026-10", [entry("x", "2026-10-02", 300), entry("y", "2026-09-30", 900), entry("z", "2026-10-03", 50, { in: true })], payments)).toEqual({ spent: 300, planned: 1000 });
  });

  it("reads the six weeks in reads the native side accepts (at most 31 days each), with local-midnight ranges", () => {
    // The native test also covers a 25-hour day; these expectations use the host's local zone.
    const queries = monthSavedQueries("2026-09");
    const days = queries.flatMap(query => query.localDays!);
    expect(queries.every(query => query.imagesOnly && query.localDays!.length <= 31)).toBe(true);
    expect(days).toHaveLength(42);
    expect(queries[0]!.startUtc).toBe(new Date(2026, 7, 30).toISOString());
    expect(queries[queries.length - 1]!.endUtc).toBe(new Date(2026, 9, 11).toISOString());
    days.forEach((range, index) => {
      expect(range.startUtc).toBe(new Date(2026, 7, 30 + index).toISOString());
      expect(range.endUtc).toBe(new Date(2026, 7, 31 + index).toISOString());
    });
  });
});

describe("keyboard moves", () => {
  it("steps by a day or a week, pages months keeping the day number, and Home returns to today", () => {
    expect(movedSelection("2026-10-17", "ArrowLeft", "2026-10-05")).toBe("2026-10-16");
    expect(movedSelection("2026-10-17", "ArrowDown", "2026-10-05")).toBe("2026-10-24");
    expect(movedSelection("2026-10-31", "PageDown", "2026-10-05")).toBe("2026-11-30");
    expect(movedSelection("2026-03-31", "PageUp", "2026-10-05")).toBe("2026-02-28");
    expect(movedSelection("2026-10-17", "Home", "2026-10-05")).toBe("2026-10-05");
    expect(movedSelection("2026-10-17", "a", "2026-10-05")).toBeNull();
  });
});

describe("past releases", () => {
  const work = (extra: Partial<CollectionSummary>) => ({ id: "w", name: "작품", type: "manga", releaseDate: null, ...extra }) as CollectionSummary;
  const board = (volumes: { volumeNumber: number; date: string | null; status: string }[]) => new Map([["w", { releaseWatch: { enabled: true }, releaseSchedule: { kakao: { volumes, editionIndex: 0 } }, ownedVolumes: [] } as unknown as ReleaseBoardEntry]]);
  const wish = (id: string, date: string, extra: Partial<ReleaseWishlistItem> = {}) => ({ id, kind: "game", title: id, date, precision: "exact", muted: false, ...extra }) as ReleaseWishlistItem;

  it("keeps released Korean volumes, exact wishlist dates and dated works on their day, before today only", () => {
    const rows = pastReleaseRows([work({}), work({ id: "g", name: "게임", type: "game", releaseDate: "2026-10-02" })],
      board([{ volumeNumber: 3, date: "2026-10-01", status: "released" }, { volumeNumber: 4, date: "2026-10-20", status: "upcoming" }]), new Map(),
      [wish("a", "2026-10-03"), wish("today", "2026-10-17"), wish("muted", "2026-10-04", { muted: true }), wish("old", "2026-08-01")], "2026-10-17", "2026-09-28", "2026-11-08");
    expect(rows.map(row => `${row.date} ${row.name} ${row.detail}`.trim()).sort()).toEqual(["2026-10-01 작품 3권", "2026-10-02 게임", "2026-10-03 a"]);
  });
});

describe("ledger choice", () => {
  const ledger = (id: string, createdAt: string, extra: Partial<Note> = {}) => ({ id, type: "ledger", title: id, body: "", pinned: false, deleted: false, createdAt, updatedAt: createdAt, localRevision: 1, pending: false, conflict: false, ...extra }) as Note;
  it("prefers the oldest ledger with subscriptions, else the oldest, and skips deleted or hidden ones", () => {
    const plain = ledger("plain", "2026-01-01T00:00:00Z"), subscribed = ledger("subs", "2026-02-01T00:00:00Z", { recurring: [{ id: "r" } as never] });
    expect(homeLedger([plain, subscribed])?.id).toBe("subs");
    expect(homeLedger([plain, ledger("late", "2026-03-01T00:00:00Z")])?.id).toBe("plain");
    expect(homeLedger([ledger("gone", "2026-01-01T00:00:00Z", { deleted: true }), ledger("secret", "2026-01-02T00:00:00Z", { concealed: true })])).toBeNull();
  });
});

describe("saved-image heat", () => {
  it("steps by rank among the shown non-zero days, so a quiet month still uses the range", () => {
    const heat = savedHeat([0, 0, 2, 4, 6, 8, 12, 30, 0, 100]);
    expect(heat(0)).toBe(0);
    expect(heat(2)).toBe(1);
    expect(heat(100)).toBe(7);
    expect([2, 4, 6, 8, 12, 30, 100].map(heat)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("gives equal counts one step and a lone day the lightest", () => {
    expect(savedHeat([5, 5, 5])(5)).toBe(1);
    expect(savedHeat([0, 7, 0])(7)).toBe(1);
    expect(savedHeat([0, 0])(0)).toBe(0);
  });
});

describe("day panel lists", () => {
  const recurring = (id: string, start: string, until: string | null = null) => ({ id, name: id, amount: 1000, every: 1, unit: "month" as const, start, until, trial: false, memo: "", order: id });
  const plan = (id: string, dropped = false) => ({ id, name: id, amount: 500, month: null, memo: "", dropped, order: id });

  it("lists running subscriptions by soonest charge and the plans not yet bought or dropped", () => {
    const lists = ledgerLists({ recurring: [recurring("b", "2026-01-25"), recurring("a", "2026-01-20"), recurring("old", "2025-01-01", "2026-03-01")], planned: [plan("p1"), plan("p2"), plan("p3", true)] },
      [entry("x", "2026-10-01", 500, { planned: "p2" })], "2026-10-17");
    expect(lists.subscriptions.map(row => row.item.id)).toEqual(["a", "b"]);
    expect(lists.wishes.map(item => item.id)).toEqual(["p1"]);
  });
});
