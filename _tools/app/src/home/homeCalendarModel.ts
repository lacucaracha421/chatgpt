import type { AssetDateBucket } from "../library/types";
import type { Note } from "../notes/store";
import { LEDGER } from "../notes/ledger/model";
import { displayCount } from "../shared/displayDate";
import { chargesInMonth, ledgerEntries, monthCharges, monthNotesOf } from "../notes/ledger/summary";

/**
 * PC Home release calendar: a two-week grid that starts on this week's Monday. Pure shaping of the
 * rows Home already reads (the released-since-last-visit rows and the upcoming rows); nothing is read here.
 */
export type CalendarEntry = { date: string | null; fresh?: boolean };
export type CalendarPayment = { key: string; date: string; label: string; noteId: string };

export type CalendarDay<T> = {
  /** `YYYY-MM-DD` */
  date: string;
  /** Day of the month. */
  day: number;
  /** Position in the grid, 0 = this week's Monday. */
  index: number;
  tense: "past" | "today" | "future";
  /** Whole days from today; negative before it. */
  daysFromToday: number;
  entries: T[];
  payments: CalendarPayment[];
  paymentOverflow: number;
  savedCount: number;
};

export type ReleaseCalendarModel<T> = {
  days: CalendarDay<T>[];
  /** NEW releases the grid cannot place: older than this week's Monday, or without a date. */
  earlier: T[];
  /** Releases after the last grid day; `from` is the first day past the grid. */
  later: { from: string; entries: T[] } | null;
};

const DAY = 86_400_000;
const utc = (date: string) => { const [year, month, day] = date.split("-").map(Number); return Date.UTC(year!, month! - 1, day!); };
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

export const addDays = (date: string, count: number) => iso(utc(date) + count * DAY);
/** The Monday on or before `date`. */
export const mondayOf = (date: string) => addDays(date, -((new Date(utc(date)).getUTCDay() + 6) % 7));

export function releaseCalendarModel<T extends CalendarEntry>(entries: T[], today: string, weeks = 2,
  activity: { payments?: CalendarPayment[]; saved?: AssetDateBucket[] } = {}): ReleaseCalendarModel<T> {
  const start = mondayOf(today);
  const end = addDays(start, weeks * 7 - 1);
  const byDate = new Map<string, T[]>();
  const earlier: T[] = [];
  const later: T[] = [];
  for (const entry of entries) {
    if (!entry.date) { if (entry.fresh) earlier.push(entry); continue; }
    if (entry.date < start) { if (entry.fresh) earlier.push(entry); continue; }
    if (entry.date > end) { later.push(entry); continue; }
    byDate.set(entry.date, [...(byDate.get(entry.date) ?? []), entry]);
  }
  const days = Array.from({ length: weeks * 7 }, (_, index): CalendarDay<T> => {
    const date = addDays(start, index);
    const daysFromToday = Math.round((utc(date) - utc(today)) / DAY);
    // NEW first; a stable sort keeps the source order otherwise.
    const dayEntries = [...(byDate.get(date) ?? [])].sort((a, b) => Number(Boolean(b.fresh)) - Number(Boolean(a.fresh)));
    const payments = (activity.payments ?? []).filter(payment => payment.date === date);
    const savedCount = date <= today ? (activity.saved ?? []).find(bucket => bucket.date === date)?.count ?? 0 : 0;
    return { date, day: Number(date.slice(8)), index, tense: daysFromToday < 0 ? "past" : daysFromToday === 0 ? "today" : "future", daysFromToday, entries: dayEntries,
      payments, paymentOverflow: Math.max(0, payments.length - 2), savedCount };
  });
  return { days, earlier, later: later.length ? { from: addDays(end, 1), entries: later } : null };
}

export type PaymentEvent = { key: string; date: string; noteId: string; name: string; amount: number; kind: "charge" | "trialEnd" };
const monthsBetween = (start: string, end: string) => {
  const months: string[] = [];
  for (let month = start.slice(0, 7); month <= end.slice(0, 7); month = addDays(`${month}-28`, 4).slice(0, 7)) months.push(month);
  return months;
};

/** Unconfirmed charges and trial ends dated in `start`..`end`: the ledger schedule, price history and confirmation rules shared by Home attention and the ledger. */
export function paymentEvents(notes: Note[], start: string, end: string): PaymentEvent[] {
  const months = monthsBetween(start, end);
  // Planned purchases currently have a target month only, never an exact day.
  return notes.filter(note => note.type === LEDGER && !note.deleted && !note.archived && !note.concealed && !note.redacted)
    .flatMap(note => {
      const entries = ledgerEntries(monthNotesOf(notes, note.id));
      return months.flatMap(month => {
        const pending = monthCharges(note.recurring ?? [], entries, month).filter(charge => !charge.confirmedBy);
        return chargesInMonth(note, month)
          .filter(event => event.kind !== "cancellationEnd" && event.date >= start && event.date <= end
            && pending.some(charge => charge.recurring.id === event.recurring.id && charge.date === event.date)
            // Trial end and the first charge share a single line, as in attentionRows.
            && !(event.kind === "charge" && event.recurring.trial && event.date === event.recurring.start))
          .map((event): PaymentEvent => ({ key: `${note.id}:${event.recurring.id}:${event.date}`, date: event.date, noteId: note.id,
            name: event.recurring.name, amount: event.amount, kind: event.kind === "trialEnd" ? "trialEnd" : "charge" }));
      });
    }).sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

/** The two-week strip's payment lines (the tablet's week strip). */
export function calendarPayments(notes: Note[], today: string): CalendarPayment[] {
  const start = mondayOf(today);
  return paymentEvents(notes, start, addDays(start, 13)).map(event => ({ key: event.key, date: event.date, noteId: event.noteId,
    label: `${event.name} ${event.kind === "trialEnd" ? "무료 끝남" : displayCount(event.amount, "원")}` }));
}
