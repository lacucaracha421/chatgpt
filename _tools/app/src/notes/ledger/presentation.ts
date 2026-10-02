import { addDays, addMonths, dayNumber, inTrial, isEnded, nextCharge } from './cycle';
import { daysInMonth, isDate, validAmount, type Recurring, type LedgerEntry } from './model';
import { chargesInMonth, monthCharges, reminders, type LedgerLike, type MonthSummary } from './summary';

/** Fixed charges are counted once, separately from manual spending. Wishlist is a preview. */
export function budgetFigures(ledger: LedgerLike, summary: MonthSummary, all: LedgerEntry[]) {
  const charges = monthCharges(ledger.recurring ?? [], all, summary.month);
  const confirmed = new Set(charges.flatMap(c => c.confirmedBy ? [c.confirmedBy.id] : []));
  const fixed = charges.reduce((sum, c) => sum + c.amount, 0);
  const spent = summary.entries.filter(e => !e.in && !confirmed.has(e.id)).reduce((sum, e) => sum + e.amount, 0);
  return { budget: summary.incomeSet ? summary.income : null, fixed, spent, left: summary.incomeSet ? summary.income - fixed - spent : null };
}
export function shiftDateMonths(date: string, count: number) {
  const month = addMonths(date, count);
  const day = Math.min(Number(date.slice(8)), daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5))));
  return `${month}-${String(day).padStart(2, '0')}`;
}
export function trialMonths(r: Pick<Recurring, 'start' | 'trialFrom'>): number | null {
  if (!r.trialFrom) return null;
  return Math.max(1, (Number(r.start.slice(0, 4)) - Number(r.trialFrom.slice(0, 4))) * 12 + Number(r.start.slice(5, 7)) - Number(r.trialFrom.slice(5, 7)));
}
export function subscriptionPills(r: Recurring, today: string) {
  const cycle = r.unit === 'year' && r.every === 1 ? '1년 갱신' : r.unit === 'month' ? r.every === 1 ? '매달' : `${r.every}달마다` : `${r.every}${r.unit === 'week' ? '주' : '년'}마다`;
  const pills = [cycle];
  if (r.trial) pills.push(trialMonths(r) ? `처음 ${trialMonths(r)}달 무료` : '첫 결제까지 무료');
  if (r.until) pills.push(isEnded(r, today) ? '종료됨' : '해지 예약');
  if (inTrial(r, today) && !isEnded(r, today)) pills.push(`무료 D-${dayNumber(r.start) - dayNumber(today)}`);
  return pills;
}
export function monthlyEvents(ledger: LedgerLike, month: string, today: string) {
  const notices = reminders(ledger, today);
  const events = chargesInMonth(ledger, month);
  return events
    .filter(e => month !== today.slice(0, 7) || e.date >= today)
    // A trial end is the first paid charge; keep one dated item with both meanings.
    .filter(e => e.kind !== 'charge' || !events.some(t => t.kind === 'trialEnd' && t.recurring.id === e.recurring.id && t.date === e.date))
    .map(e => ({ ...e, days: e.date >= today && (notices.some(n => n.recurring.id === e.recurring.id && n.date === e.date) || (e.kind === 'cancellationEnd' && e.recurring.remindDays != null && today >= addDays(e.date, -e.recurring.remindDays))) ? dayNumber(e.date) - dayNumber(today) : null }));
}
export function cancellationDate(r: Recurring, today: string) {
  return nextCharge({ ...r, until: null }, today)?.date ?? today;
}
/** A trailing positive integer amount; commas must form valid thousands groups. */
export function parseQuickEntry(text: string): { name: string; amount: number } | null {
  const match = text.trim().match(/^(.+?)\s+₩?(\d+|\d{1,3}(?:,\d{3})+)원?$/);
  if (!match) return null;
  const name = match[1]!.trim(), amount = Number(match[2]!.replace(/,/g, ''));
  return name && Array.from(name).length <= 100 && validAmount(amount) && amount > 0 ? { name, amount } : null;
}
export function priceChange(r: Recurring, amount: number, date: string) {
  if (!isDate(date)) return null;
  const history = r.priceHistory ?? [];
  if (history.length >= 24 || (history.length && date <= history[history.length - 1]!.until)) return null;
  return { amount, priceHistory: [...history, { until: date, amount: r.amount }] };
}
