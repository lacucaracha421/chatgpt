/**
 * Month figures of a ledger (design §4.3): readers union the month notes of one ledger,
 * dedupe entries by id, derive unconfirmed charges and compute
 * 쓸 수 있는 돈 = 수입 − 쓴 돈 − 예정.
 */
import { chargesInMonth, dayNumber, monthEnd, monthStart, addDays } from "./cycle";
import { byEntryOrder, incomeDateIn, LEDGER_MONTH, type LedgerEntry, type Planned, type Recurring } from "./model";

/** What a reader needs from a month note (a decrypted `ledger-month` Note fits). */
export type MonthNoteLike = { id: string; type?: string; ledger?: string; month?: string; income?: number | null; entries?: LedgerEntry[]; deleted: boolean; updatedAt: string };
export type LedgerLike = { income?: number | null; incomeDay?: number | null; recurring?: Recurring[]; planned?: Planned[] };

/** The month notes of one ledger, newest first; keep-both copies of one month are all kept. */
export function monthNotesOf<T extends MonthNoteLike>(notes: T[], ledgerId: string): T[] {
  return notes.filter((n) => n.type === LEDGER_MONTH && n.ledger === ledgerId && !n.deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Every entry of the ledger, deduped by id (a moved entry briefly lives in two month notes,
 * and keep-both copies repeat entries); the copy whose note month matches its date wins.
 */
export function ledgerEntries(monthNotes: MonthNoteLike[]): LedgerEntry[] {
  const chosen = new Map<string, { entry: LedgerEntry; matches: boolean }>();
  for (const note of monthNotes)
    for (const entry of note.entries ?? []) {
      const matches = entry.date.slice(0, 7) === note.month;
      const current = chosen.get(entry.id);
      if (!current || (matches && !current.matches)) chosen.set(entry.id, { entry, matches });
    }
  return [...chosen.values()].map((c) => c.entry).sort(byEntryOrder);
}

/** This month's income override if any month note of `month` sets one, else the ledger's. */
export function baseIncome(ledger: LedgerLike, monthNotes: MonthNoteLike[], month: string): number | null {
  for (const note of monthNotes) if (note.month === month && note.income != null) return note.income;
  return ledger.income ?? null;
}

/** Plans referenced by any entry in any month; done state is never stored. */
export function donePlans(entries: LedgerEntry[]): Map<string, LedgerEntry> {
  const done = new Map<string, LedgerEntry>();
  for (const entry of entries) if (entry.planned && !done.has(entry.planned)) done.set(entry.planned, entry);
  return done;
}

export type Charge = { recurring: Recurring; date: string; amount: number; confirmedBy: LedgerEntry | null };

/**
 * Charges dated in `month`; an entry carrying {id, date} replaces (or with 0 skips) its charge.
 * A confirmation whose date no longer is a charge (the schedule was edited) takes that
 * item's first unconfirmed charge of the month, so the money is never counted twice.
 */
export function monthCharges(recurring: Recurring[], entries: LedgerEntry[], month: string): Charge[] {
  const confirmations = new Map<string, LedgerEntry[]>();
  for (const entry of entries)
    if (entry.recurring && entry.recurring.date.startsWith(month)) confirmations.set(entry.recurring.id, [...(confirmations.get(entry.recurring.id) ?? []), entry]);
  const charges: Charge[] = [];
  for (const r of recurring) {
    const own = chargesInMonth(r, month).map((date): Charge => ({ recurring: r, date, amount: r.amount, confirmedBy: null }));
    const pending = [...(confirmations.get(r.id) ?? [])];
    for (const charge of own) {
      const at = pending.findIndex((e) => e.recurring!.date === charge.date);
      if (at >= 0) charge.confirmedBy = pending.splice(at, 1)[0]!;
    }
    for (const charge of own) if (!charge.confirmedBy && pending.length) charge.confirmedBy = pending.shift()!;
    for (const charge of own) if (charge.confirmedBy) charge.amount = charge.confirmedBy.amount;
    charges.push(...own);
  }
  return charges.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export type MonthSummary = {
  month: string;
  phase: "past" | "current" | "future";
  /** Base income (month override ?? ledger) plus 들어온 돈 entries. */ income: number;
  /** False when neither the month nor the ledger sets an income: show 쓴 돈 as the headline. */ incomeSet: boolean;
  /** The day income arrives this month (the ledger's 들어오는 날, clamped to the month's end); null when not set. */ incomeDate: string | null;
  /** An income is set and its date is after the cut-off day (still to come; shown in 다가오는 결제). */ incomeUpcoming: boolean;
  /** Non-`in` entries plus unconfirmed charges dated on or before the cut-off day. */ spent: number;
  /** Unconfirmed charges after the cut-off day plus this month's open plans. */ scheduled: number;
  scheduledCharges: number;
  scheduledPlans: number;
  /** 쓸 수 있는 돈 = income − spent − scheduled; null without an income. */ available: number | null;
  /** Current month only: remaining days including today, and available ÷ those days (floored). */ remainingDays: number | null;
  perDay: number | null;
  /** 고정·구독 이번 달: every charge dated in the month (confirmed amounts replace derived ones). */ recurringThisMonth: number;
  /** Entries dated in the month, newest first. */ entries: LedgerEntry[];
  /** Unconfirmed charges up to the cut-off: shown muted in 기록 (derived, not stored). */ pastCharges: Charge[];
  /** Unconfirmed charges after the cut-off (다가오는 결제). */ upcomingCharges: Charge[];
  /** Plans for this month that are not dropped, with the entry that bought them. */ plans: { plan: Planned; doneBy: LedgerEntry | null }[];
  /** 확인할 기록 N건: entries in the month still forked by an edit collision. */ reviewCount: number;
};

/**
 * Figures for `month` on `today`. The cut-off day T is today for the current month, the
 * month's end for past months, and the day before its start for future months (so every
 * charge of a future month is scheduled). Past months are final: open plans no longer
 * count as scheduled.
 */
export function monthSummary(ledger: LedgerLike, monthNotes: MonthNoteLike[], month: string, today: string, allEntries = ledgerEntries(monthNotes)): MonthSummary {
  const current = today.slice(0, 7);
  const phase = month < current ? "past" : month > current ? "future" : "current";
  const cutoff = phase === "past" ? monthEnd(month) : phase === "future" ? addDays(monthStart(month), -1) : today;
  const entries = allEntries.filter((e) => e.date.startsWith(month));
  const charges = monthCharges(ledger.recurring ?? [], allEntries, month);
  const open = charges.filter((c) => !c.confirmedBy);
  const pastCharges = open.filter((c) => c.date <= cutoff);
  const upcomingCharges = open.filter((c) => c.date > cutoff);
  const done = donePlans(allEntries);
  const plans = (ledger.planned ?? []).filter((p) => p.month === month && !p.dropped).map((plan) => ({ plan, doneBy: done.get(plan.id) ?? null }));
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const base = baseIncome(ledger, monthNotes, month);
  const income = (base ?? 0) + sum(entries.filter((e) => e.in).map((e) => e.amount));
  const spent = sum(entries.filter((e) => !e.in).map((e) => e.amount)) + sum(pastCharges.map((c) => c.amount));
  const scheduledCharges = sum(upcomingCharges.map((c) => c.amount));
  const scheduledPlans = phase === "past" ? 0 : sum(plans.filter((p) => !p.doneBy).map((p) => p.plan.amount));
  const scheduled = scheduledCharges + scheduledPlans;
  const available = base === null ? null : income - spent - scheduled;
  const incomeDate = incomeDateIn(month, ledger.incomeDay);
  const remainingDays = phase === "current" ? dayNumber(monthEnd(month)) - dayNumber(today) + 1 : null;
  return {
    month, phase, income, incomeSet: base !== null, incomeDate, incomeUpcoming: base !== null && incomeDate !== null && incomeDate > cutoff, spent, scheduled, scheduledCharges, scheduledPlans, available,
    remainingDays, perDay: available !== null && remainingDays ? Math.floor(available / remainingDays) : null,
    recurringThisMonth: sum(charges.map((c) => c.amount)), entries, pastCharges, upcomingCharges, plans,
    reviewCount: entries.filter((e) => e.forkOf).length,
  };
}
