import { ddayLabel, displayDate } from '../shared/displayDate';
import { checklistMarkdown } from '../notes/model';
import { memoItems, memoMode, parseMemo } from '../notes/memo/memoModel';
import { LEDGER, won } from '../notes/ledger/model';
import { nextCharge } from '../notes/ledger/cycle';
import { ledgerEntries, monthNotesOf, monthSummary, reminders } from '../notes/ledger/summary';
import type { Note } from '../notes/store';
import { daysAfter } from './homeModel';

export type AttentionRow = { key: string; label: string; secondary?: string; value?: string; days?: number; noteId?: string; problem?: boolean; disabled?: boolean };
export type ReviewCount = { key: string; label: string; count: number | null; unit?: string };
export type ConnectionProblem = { key: string; label: string; value: string; tone: string };
const reviewOrder = ['unsorted', 'similar', 'pending', 'tagger', 'character', 'duplicates', 'av-link'];

/** Shared PC/tablet display rules. Concealed and unavailable note bodies never become previews. */
export function attentionRows(notes: Note[], reviews: ReviewCount[], connections: ConnectionProblem[], today: string): AttentionRow[] {
  const visible = notes.filter(n => !n.deleted && !n.archived && !n.concealed && n.type !== 'secret');
  const ledgers = visible.filter(n => n.type === LEDGER);
  const subscribed = ledgers.filter(n => (n.recurring?.length ?? 0) > 0);
  const rows: AttentionRow[] = [];
  if (subscribed.length) {
    const total = subscribed.reduce((sum, n) => sum + monthSummary(n, monthNotesOf(notes, n.id), today.slice(0, 7), today).recurringThisMonth, 0);
    const charges = subscribed.flatMap(n => (n.recurring ?? []).flatMap(r => { const next = nextCharge(r, today); return next ? [{ ...next, name: r.name, noteId: n.id }] : []; })).sort((a, b) => a.date.localeCompare(b.date));
    const next = charges[0];
    rows.push({ key: 'subscriptions', label: `구독 이번 달 ${won(total)}`, secondary: next ? `다음 결제 ${ddayLabel(daysAfter(next.date, today)) ?? displayDate(next.date, new Date(`${today}T12:00:00`))} · ${next.name}` : '다음 결제 없음', value: `${subscribed.reduce((n, l) => n + (l.recurring?.length ?? 0), 0)}개`, noteId: next?.noteId ?? subscribed[0]!.id });
  }
  // Confirmed or skipped charges (month-note entries) are no longer reminders.
  const notices = ledgers.flatMap(n => reminders(n, today, ledgerEntries(monthNotesOf(notes, n.id)))
    // Trial end and its first charge share one reminder.
    .filter(e => e.kind !== 'charge' || !n.recurring?.find(r => r.id === e.recurring.id && r.trial && r.start === e.date))
    .map(e => ({ key: `reminder:${n.id}:${e.recurring.id}:${e.date}`, label: `${e.recurring.name} ${e.kind === 'trialEnd' ? '무료 끝남' : '결제'}`, secondary: `${displayDate(e.date, new Date(`${today}T12:00:00`))} · ${won(e.amount)}${e.kind === 'trialEnd' ? '부터 결제' : ''}`, days: daysAfter(e.date, today), noteId: n.id })));
  rows.push(...notices.sort((a, b) => a.days - b.days || a.key.localeCompare(b.key)));
  rows.push(...reviews.filter(r => r.count !== null && r.count > 0).sort((a, b) => reviewOrder.indexOf(a.key) - reviewOrder.indexOf(b.key)).map(r => ({ key: r.key, label: r.label, value: `${r.count!.toLocaleString()}${r.unit ?? ''}` })));
  rows.push(...visible.filter(n => n.pinned && n.type !== LEDGER).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).flatMap(n => {
    const body = n.type === 'checklist' ? checklistMarkdown(n.items ?? []) : n.body;
    if (memoMode(body) !== 'todo') return [];
    const remaining = memoItems(parseMemo(body)).filter(i => i.task && !i.done).length;
    return remaining ? [{ key: `note:${n.id}`, label: n.title.trim() || '제목 없음', secondary: `남은 항목 ${remaining}개`, value: `${remaining}`, noteId: n.id }] : [];
  }));
  rows.push(...connections.filter(c => c.tone === 'off' || c.tone === 'idle').map(c => ({ key: `connection:${c.key}`, label: c.label, secondary: c.value, problem: true })));
  return rows;
}

export type HomeArrival = { key: string; token: string; date: string | null; fresh: boolean };
export type HomeVisit = { lastVisit: string | null; pending: string[]; opened: string[] };
export const HOME_VISIT_KEY = 'lakomics.home.visit.v1:';
export function readHomeVisit(scope: string): HomeVisit {
  try {
    const saved = JSON.parse(localStorage.getItem(HOME_VISIT_KEY + scope) ?? 'null');
    return { lastVisit: typeof saved?.lastVisit === 'string' && Number.isFinite(Date.parse(saved.lastVisit)) ? saved.lastVisit : null,
      pending: Array.isArray(saved?.pending) ? saved.pending.filter((v: unknown) => typeof v === 'string') : [],
      opened: Array.isArray(saved?.opened) ? saved.opened.filter((v: unknown) => typeof v === 'string') : [] };
  } catch { return { lastVisit: null, pending: [], opened: [] }; }
}
export function writeHomeVisit(scope: string, visit: HomeVisit) {
  try { localStorage.setItem(HOME_VISIT_KEY + scope, JSON.stringify(visit)); } catch { /* Storage can be disabled on either client. */ }
}
function releasedAfter(date: string, visitedAt: string): boolean {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day).getTime() > Date.parse(visitedAt);
}
export function newHomeArrivals<T extends HomeArrival>(items: T[], visit: HomeVisit, today: string): T[] {
  return items.filter(item => !visit.opened.includes(item.token) && (visit.pending.includes(item.token) || item.fresh || Boolean(item.date && item.date <= today && visit.lastVisit && releasedAfter(item.date, visit.lastVisit))))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.key.localeCompare(b.key));
}
