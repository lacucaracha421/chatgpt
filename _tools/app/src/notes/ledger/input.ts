/**
 * Parsing for the PC ledger inputs (amount, day and month fields). Pure helpers so the
 * keyboard rules (a leading `+` means 들어온 돈, "25" means the 25th of the shown month)
 * stay testable without the screen.
 */
import { dayNumber } from "./cycle";
import { isDate, isMonth, validAmount } from "./model";

const pad = (n: number) => String(n).padStart(2, "0");
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Keeps an optional leading `+`, drops everything but digits (at most 12), and groups them. */
export function formatAmountInput(text: string, allowIn = true): string {
  const sign = allowIn && /^\s*\+/.test(text) ? "+" : "";
  const digits = text.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 12);
  return sign + group(digits);
}
/** "+18,000" → {amount: 18000, in: true}; null when empty or out of range. */
export function parseAmount(text: string): { amount: number; in: boolean } | null {
  const digits = text.replace(/\D/g, "");
  if (!digits) return null;
  const amount = Number(digits);
  return validAmount(amount) ? { amount, in: /^\s*\+/.test(text) } : null;
}
/** Plain grouped number for an input's initial value (no ₩). */
export const amountText = (amount: number | null | undefined) => (amount == null ? "" : group(String(amount)));

/**
 * A day typed in the entry row: "2026-09-25", "09-25", "9/25", "9.25" (year of the shown
 * month) or "25" (day of the shown month). Returns YYYY-MM-DD or null.
 */
export function parseDay(text: string, month: string): string | null {
  const t = text.trim();
  let year = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)), d: number;
  let match: RegExpMatchArray | null;
  if ((match = t.match(/^(\d{4})[-./ ](\d{1,2})[-./ ](\d{1,2})$/))) { year = Number(match[1]); m = Number(match[2]); d = Number(match[3]); }
  else if ((match = t.match(/^(\d{1,2})[-./ ](\d{1,2})$/))) { m = Number(match[1]); d = Number(match[2]); }
  else if ((match = t.match(/^(\d{1,2})$/))) d = Number(match[1]);
  else return null;
  const date = `${year}-${pad(m)}-${pad(d)}`;
  return isDate(date) ? date : null;
}
/** "" → null (언젠가); "2026-10", "2026.10" or "10" (this or next year, whichever is not past). */
export function parseMonth(text: string, currentMonth: string): string | null | undefined {
  const t = text.trim();
  if (!t) return null;
  let match: RegExpMatchArray | null;
  if ((match = t.match(/^(\d{4})[-./ ](\d{1,2})$/))) {
    const month = `${match[1]}-${pad(Number(match[2]))}`;
    return isMonth(month) ? month : undefined;
  }
  if ((match = t.match(/^(\d{1,2})월?$/))) {
    const m = Number(match[1]);
    if (m < 1 || m > 12) return undefined;
    const year = Number(currentMonth.slice(0, 4)) + (m < Number(currentMonth.slice(5, 7)) ? 1 : 0);
    return `${year}-${pad(m)}`;
  }
  return undefined;
}
/** "2026-09-25" → "9.25". */
export const dotDate = (date: string) => `${Number(date.slice(5, 7))}.${Number(date.slice(8, 10))}`;
const WEEKDAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
export const weekday = (date: string) => WEEKDAYS[new Date(dayNumber(date) * 86_400_000).getUTCDay()]!;
/** "오늘", "내일", "N일 후". */
export function daysUntil(date: string, today: string): string {
  const days = dayNumber(date) - dayNumber(today);
  return days === 0 ? "오늘" : days === 1 ? "내일" : `${days}일 후`;
}
