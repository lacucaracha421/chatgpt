/**
 * Charge dates of recurring items (design §4.3). Date math runs only here; native code
 * never computes charges.
 *
 * - Charges fall on start + k·every·unit (k >= 0), strictly before `until`.
 * - Monthly and yearly charges on the 29th–31st clamp to the month's last day, always
 *   recomputed from `start`, so the day never drifts (31 Jan → 28 Feb → 31 Mar).
 * - Weekly charges fall on start + 7·k·every days.
 */
import { daysInMonth, isDate, type Recurring } from "./model";

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = 86_400_000;
/** Days since 1970-01-01 of a `YYYY-MM-DD` string. */
export const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY;
export function fromDayNumber(day: number): string {
  const d = new Date(day * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export const addDays = (date: string, days: number) => fromDayNumber(dayNumber(date) + days);
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const fromMonthIndex = (index: number) => `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
export const addMonths = (month: string, count: number) => fromMonthIndex(monthIndex(month) + count);
export const monthStart = (month: string) => `${month}-01`;
export const monthEnd = (month: string) => `${month}-${pad(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))))}`;
/** Today as a local calendar date. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

type Cycle = Pick<Recurring, "every" | "unit" | "start" | "until">;
/** Pulled payloads are not validated here: a malformed cycle has no charges (never loops). */
export const validCycle = (r: Cycle) =>
  Number.isInteger(r.every) && r.every >= 1 && r.every <= 120 && ["week", "month", "year"].includes(r.unit) && isDate(r.start) && (r.until === null || isDate(r.until));
/** Hard bound on generated charges per call (weekly over ~20 years). */
const MAX_STEPS = 1100;

/** The k-th charge (k >= 0), before applying `until`. */
function chargeAt(r: Cycle, k: number): string {
  if (r.unit === "week") return addDays(r.start, 7 * r.every * k);
  const index = monthIndex(r.start) + k * r.every * (r.unit === "year" ? 12 : 1);
  const year = Math.floor(index / 12), month = (index % 12) + 1;
  return `${year}-${pad(month)}-${pad(Math.min(Number(r.start.slice(8, 10)), daysInMonth(year, month)))}`;
}
/** First k whose charge can fall on or after `from`. */
function firstIndex(r: Cycle, from: string): number {
  if (from <= r.start) return 0;
  const step = r.unit === "week" ? 7 * r.every : r.every * (r.unit === "year" ? 12 : 1);
  const distance = r.unit === "week" ? dayNumber(from) - dayNumber(r.start) : monthIndex(from) - monthIndex(r.start);
  return Math.max(0, Math.floor(distance / step));
}

/** Charges dated within [from, to] (inclusive), oldest first. */
export function chargesBetween(r: Cycle, from: string, to: string): string[] {
  const dates: string[] = [];
  if (!validCycle(r)) return dates;
  for (let k = firstIndex(r, from), steps = 0; steps < MAX_STEPS; k++, steps++) {
    const date = chargeAt(r, k);
    if (date > to || (r.until !== null && date >= r.until)) break;
    if (date >= from) dates.push(date);
  }
  return dates;
}
export const chargesInMonth = (r: Cycle, month: string) => chargesBetween(r, monthStart(month), monthEnd(month));

/** The next `count` charges on or after `from`. */
export function nextCharges(r: Cycle, from: string, count = 1): string[] {
  const dates: string[] = [];
  if (!validCycle(r)) return dates;
  for (let k = firstIndex(r, from), steps = 0; dates.length < count && steps < MAX_STEPS; k++, steps++) {
    const date = chargeAt(r, k);
    if (r.until !== null && date >= r.until) break;
    if (date >= from) dates.push(date);
  }
  return dates;
}

/** Monthly equivalent, rounded to the won. */
export function monthlyEquivalent(r: Pick<Recurring, "amount" | "every" | "unit">): number {
  if (!Number.isInteger(r.every) || r.every < 1 || !["week", "month", "year"].includes(r.unit) || !Number.isFinite(r.amount)) return 0;
  if (r.unit === "week") return Math.round((r.amount * 52) / (12 * r.every));
  return Math.round(r.amount / (r.every * (r.unit === "year" ? 12 : 1)));
}
/** Cancelled or ended: no charge today or later. */
export const isEnded = (r: Pick<Recurring, "until">, today: string) => r.until !== null && r.until <= today;
export const inTrial = (r: Pick<Recurring, "trial" | "start">, today: string) => r.trial && today < r.start;

/** Charging today: started (the first paid charge is not in the future; covers trials) and not ended. */
export const isActive = (r: Recurring, today: string) => validCycle(r) && r.start <= today && !isEnded(r, today);
/** 월 환산 합계 (items active today), the 1년 total and the active count. */
export function recurringTotals(list: Recurring[], today: string): { monthly: number; yearly: number; active: number } {
  const active = list.filter((r) => isActive(r, today));
  const monthly = active.reduce((sum, r) => sum + monthlyEquivalent(r), 0);
  return { monthly, yearly: monthly * 12, active: active.length };
}

const WEEKDAYS = "일월화수목금토";
/** 매월 27일 / 매년 3월 14일 / 3개월마다 · 12일 / 매주 월요일 / 2주마다 월요일. */
export function cycleLabel(r: Pick<Recurring, "every" | "unit" | "start">): string {
  const day = Number(r.start.slice(8, 10)), month = Number(r.start.slice(5, 7));
  if (r.unit === "week") return `${r.every === 1 ? "매주" : `${r.every}주마다`} ${WEEKDAYS[new Date(dayNumber(r.start) * DAY).getUTCDay()]}요일`;
  if (r.unit === "year") return r.every === 1 ? `매년 ${month}월 ${day}일` : `${r.every}년마다 · ${month}월 ${day}일`;
  return r.every === 1 ? `매월 ${day}일` : `${r.every}개월마다 · ${day}일`;
}
