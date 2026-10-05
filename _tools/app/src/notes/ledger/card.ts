import { displayDate } from "../../shared/displayDate";
import { localToday } from "./cycle";
import { monthNotesOf, monthSummary } from "./summary";
import { signedWon, won } from "./model";
import type { Note } from "../store";

const monthNumber = (month: string) => Number(month.slice(5, 7));

/** Board card of a ledger: this month's headline figure, spend ratio and next charge. */
export function ledgerCard(ledger: Note, notes: Note[], today = localToday()) {
  const month = today.slice(0, 7);
  const summary = monthSummary(ledger, monthNotesOf(notes, ledger.id), month, today);
  const next = [...summary.upcomingCharges].sort((a, b) => a.date.localeCompare(b.date))[0];
  return {
    label: summary.available !== null ? `${monthNumber(month)}월 쓸 수 있는 돈` : `${monthNumber(month)}월 쓴 돈`,
    amount: summary.available !== null ? signedWon(summary.available) : won(summary.spent),
    over: summary.available !== null && summary.available < 0,
    spentRatio: summary.income > 0 ? Math.min(1, summary.spent / summary.income) : null,
    next: next ? `다음 결제 ${displayDate(next.date, new Date(`${today}T12:00:00`))} · ${next.recurring.name}` : null,
  };
}
