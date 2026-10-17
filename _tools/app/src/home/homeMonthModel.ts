import type { ReactNode } from "react";
import type { AssetDateBucket, AssetDateBucketQuery, CollectionSummary, ReleaseBoardEntry, ReleaseInboxItem, ReleaseWishlistItem } from "../library/types";
import { koreanReleases } from "../collections/releaseCaption";
import { addDays, mondayOf, type PaymentEvent } from "./homeCalendarModel";
import type { ReleaseKind } from "./homeModel";
import { nextCharge, isEnded } from "../notes/ledger/cycle";
import { LEDGER, sortRecurring, type LedgerEntry, type Planned, type Recurring } from "../notes/ledger/model";
import { donePlans, type LedgerLike } from "../notes/ledger/summary";
import type { Note } from "../notes/store";

/**
 * PC Home month calendar (HOME-CAL-001): pure shaping of the rows Home already reads. The grid is
 * always six Monday-first weeks (42 days), so paging never changes its height.
 */
export const MONTH_GRID_DAYS = 42;
const DAY = 86_400_000;
const utc = (date: string) => { const [year, month, day] = date.split("-").map(Number); return Date.UTC(year!, month! - 1, day!); };

export type MonthRelease = { key: string; kind: ReleaseKind; date: string; name: string; detail: string; fresh: boolean; token?: string; cover?: ReactNode; onOpen(): void };

export type MonthDay<T> = {
  /** `YYYY-MM-DD` */
  date: string;
  day: number;
  /** False for the neighbouring months' days shown to fill the six weeks. */
  inMonth: boolean;
  tense: "past" | "today" | "future";
  daysFromToday: number;
  /** The seven days of today's week share a quiet face. */
  currentWeek: boolean;
  releases: T[];
  savedCount: number;
  payments: PaymentEvent[];
  /** Money out on this day (entries, not income). */
  spent: number;
  hasMemo: boolean;
};

export const monthOf = (date: string) => date.slice(0, 7);
export const monthStart = (month: string) => `${month}-01`;
export function shiftMonth(month: string, count: number): string {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + count, 1));
  return date.toISOString().slice(0, 7);
}
/** `10월`, or `2027년 1월` for another year (DESIGN §12 Dates). */
export function monthTitle(month: string, today: string): string {
  const monthNumber = Number(month.slice(5, 7));
  return month.slice(0, 4) === today.slice(0, 4) ? `${monthNumber}월` : `${Number(month.slice(0, 4))}년 ${monthNumber}월`;
}
/** The 42 dates of the grid that shows `month`. */
export const gridDates = (month: string): string[] => {
  const start = mondayOf(monthStart(month));
  return Array.from({ length: MONTH_GRID_DAYS }, (_, index) => addDays(start, index));
};

export type MonthActivity<T extends { date: string | null; fresh?: boolean }> = {
  releases: T[];
  saved: AssetDateBucket[];
  payments: PaymentEvent[];
  entries: LedgerEntry[];
  memos: Map<string, string>;
};

export function monthDays<T extends { date: string | null; fresh?: boolean }>(month: string, today: string, activity: MonthActivity<T>): MonthDay<T>[] {
  const releases = new Map<string, T[]>();
  for (const release of activity.releases) if (release.date) releases.set(release.date, [...(releases.get(release.date) ?? []), release]);
  const saved = new Map(activity.saved.map(bucket => [bucket.date, bucket.count]));
  const payments = new Map<string, PaymentEvent[]>();
  for (const payment of activity.payments) payments.set(payment.date, [...(payments.get(payment.date) ?? []), payment]);
  const spent = new Map<string, number>();
  for (const entry of activity.entries) if (!entry.in) spent.set(entry.date, (spent.get(entry.date) ?? 0) + entry.amount);
  const thisWeek = mondayOf(today);
  return gridDates(month).map((date): MonthDay<T> => {
    const daysFromToday = Math.round((utc(date) - utc(today)) / DAY);
    return {
      date, day: Number(date.slice(8)), inMonth: monthOf(date) === month,
      tense: daysFromToday < 0 ? "past" : daysFromToday === 0 ? "today" : "future", daysFromToday,
      currentWeek: mondayOf(date) === thisWeek,
      // NEW first; a stable sort keeps the source order otherwise.
      releases: [...(releases.get(date) ?? [])].sort((a, b) => Number(Boolean(b.fresh)) - Number(Boolean(a.fresh))),
      savedCount: date <= today ? saved.get(date) ?? 0 : 0,
      payments: payments.get(date) ?? [],
      spent: spent.get(date) ?? 0,
      hasMemo: activity.memos.has(date),
    };
  });
}

/** The month's figures: money out, and the unconfirmed charges still to come. */
export function monthTotals(month: string, entries: LedgerEntry[], payments: PaymentEvent[]) {
  return {
    spent: entries.filter(entry => !entry.in && entry.date.startsWith(month)).reduce((sum, entry) => sum + entry.amount, 0),
    planned: payments.filter(payment => payment.kind === "charge" && payment.date.startsWith(month)).reduce((sum, payment) => sum + payment.amount, 0),
  };
}

/** One bounded library read for the whole grid; local Date construction preserves 23/25-hour days at DST changes. */
/** The native count read takes at most 31 local days, so the six-week grid is read in three-week halves. */
const SAVED_DAYS_PER_READ = 21;

export function monthSavedQueries(month: string): AssetDateBucketQuery[] {
  const midnight = (date: string) => {
    const [year, monthNumber, day] = date.split("-").map(Number);
    return new Date(year!, monthNumber! - 1, day!);
  };
  const days = gridDates(month).map(date => ({ localDate: date, startUtc: midnight(date).toISOString(), endUtc: midnight(addDays(date, 1)).toISOString() }));
  const offsetMinutes = -midnight(monthStart(month)).getTimezoneOffset();
  const queries: AssetDateBucketQuery[] = [];
  for (let index = 0; index < days.length; index += SAVED_DAYS_PER_READ) {
    const localDays = days.slice(index, index + SAVED_DAYS_PER_READ);
    queries.push({ startUtc: localDays[0]!.startUtc, endUtc: localDays[localDays.length - 1]!.endUtc, offsetMinutes, imagesOnly: true, localDays });
  }
  return queries;
}

/** The date a key moves the selection to, or null for other keys. */
export function movedSelection(date: string, key: string, today: string): string | null {
  switch (key) {
    case "ArrowLeft": return addDays(date, -1);
    case "ArrowRight": return addDays(date, 1);
    case "ArrowUp": return addDays(date, -7);
    case "ArrowDown": return addDays(date, 7);
    case "PageUp": return shiftDate(date, -1);
    case "PageDown": return shiftDate(date, 1);
    case "Home": return today;
    default: return null;
  }
}
/** The same day number one month away, or the other month's last day when it is shorter. */
function shiftDate(date: string, count: number): string {
  const month = shiftMonth(monthOf(date), count);
  const last = Number(addDays(monthStart(shiftMonth(month, 1)), -1).slice(8));
  return `${month}-${String(Math.min(Number(date.slice(8)), last)).padStart(2, "0")}`;
}

export type PastReleaseRow = { key: string; kind: ReleaseKind; date: string; name: string; detail: string; volume?: number; collectionId?: string; titleId?: string };

/**
 * Releases that already came out and are dated inside `start`..`end`: Korean volumes of watched manga
 * that are not owned yet, wishlist titles with an exact date and local works with a release date.
 * NEW ones come from the visit list; this shaping lets the older ones stay visible on their day.
 */
export function pastReleaseRows(collections: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>,
  wishlist: ReleaseWishlistItem[], today: string, start: string, end: string): PastReleaseRow[] {
  const last = end < today ? end : addDays(today, -1);
  const inRange = (date: string | null | undefined): date is string => Boolean(date) && /^\d{4}-\d{2}-\d{2}$/.test(date!) && date! >= start && date! <= last;
  const rows: PastReleaseRow[] = [];
  for (const release of koreanReleases(collections.filter(work => work.type === "manga"), board, inbox, today))
    for (const volume of release.volumes)
      if (volume.released && inRange(volume.date)) rows.push({ key: `manga:${release.work.id}:${volume.volumeNumber}`, kind: "manga", date: volume.date, name: release.work.name, detail: `${volume.volumeNumber}권`, volume: volume.volumeNumber, collectionId: release.work.id });
  for (const title of wishlist)
    if (!title.muted && title.precision === "exact" && inRange(title.date)) rows.push({ key: `title:${title.id}`, kind: title.kind, date: title.date!, name: title.title, detail: "", titleId: title.id });
  for (const collection of collections)
    if (collection.type !== "av" && collection.type !== "manga" && inRange(collection.releaseDate)
      && !rows.some(row => row.collectionId === collection.id || (row.name === collection.name && row.date === collection.releaseDate)))
      rows.push({ key: `work:${collection.id}`, kind: collection.type, date: collection.releaseDate!, name: collection.name, detail: "", collectionId: collection.id });
  return rows;
}

/**
 * The ledger Home reads and writes: the oldest one with subscriptions, else the oldest ledger.
 * (Several ledgers are possible in the notes; Home does not mix their entries.)
 */
export function homeLedger(notes: Note[]): Note | null {
  const ledgers = notes.filter(note => note.type === LEDGER && !note.deleted && !note.archived && !note.concealed && !note.redacted)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return ledgers.find(note => (note.recurring?.length ?? 0) > 0) ?? ledgers[0] ?? null;
}

export type SubscriptionRow = { item: Recurring; next: { date: string; amount: number } | null };

/**
 * The lists under the day panel's 가계부: every subscription still running (soonest charge first, those without one last)
 * and the things to buy (not dropped, not bought yet).
 */
export function ledgerLists(ledger: LedgerLike | null, entries: LedgerEntry[], today: string): { subscriptions: SubscriptionRow[]; wishes: Planned[] } {
  if (!ledger) return { subscriptions: [], wishes: [] };
  const subscriptions = sortRecurring(ledger.recurring ?? []).filter(item => !isEnded(item, today))
    .map(item => ({ item, next: nextCharge(item, today) }))
    .sort((a, b) => (a.next?.date ?? "9999").localeCompare(b.next?.date ?? "9999"));
  const done = donePlans(entries);
  const wishes = sortRecurring(ledger.planned ?? []).filter(plan => !plan.dropped && !done.has(plan.id));
  return { subscriptions, wishes };
}

/**
 * Heat step (0 = none, 1..4 = busier) of a day's saved-image count, by its rank among the non-zero counts of the shown days,
 * so a busy month and a quiet one both use the whole range. Equal counts share a step; a lone day is the lightest.
 */
/** Heat steps for days with saves (user 2026-10-17: eight). */
export const SAVED_HEAT_STEPS = 8;

export function savedHeat(counts: number[]): (count: number) => number {
  const sorted = counts.filter(count => count > 0).sort((a, b) => a - b);
  return count => {
    if (count <= 0 || sorted.length === 0) return 0;
    const below = sorted.filter(value => value < count).length;
    return 1 + Math.min(SAVED_HEAT_STEPS - 1, Math.floor(SAVED_HEAT_STEPS * below / sorted.length));
  };
}
