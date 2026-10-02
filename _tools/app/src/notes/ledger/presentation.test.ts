import { expect, it } from 'vitest';
import { parseQuickEntry, shiftDateMonths, subscriptionPills, monthlyEvents, budgetFigures } from './presentation';
import { monthSummary, reminders } from './summary';
import type { LedgerEntry, Recurring } from './model';
const rec: Recurring = { id: 'r', name: '구독', amount: 10000, every: 1, unit: 'month', start: '2026-10-02', trial: true, trialFrom: '2026-07-02', until: null, remindDays: 3, order: 'V', memo: '' };
it('parses a trailing won amount without accepting malformed groups, empty names or overflow', () => {
  expect(parseQuickEntry(' 점심 8000 ')).toEqual({ name: '점심', amount: 8000 });
  expect(parseQuickEntry('책 2권 ₩18,000원')).toEqual({ name: '책 2권', amount: 18000 });
  for (const bad of ['8000', '점심', '점심 -8000', '점심 8,00', '점심 1.5', '점심 0', '점심 1000000000000']) expect(parseQuickEntry(bad)).toBeNull();
});
it('clamps free-period dates and keeps lifecycle wording shared', () => {
  expect(shiftDateMonths('2026-01-31', 1)).toBe('2026-02-28');
  expect(subscriptionPills(rec, '2026-09-30')).toEqual(['매달', '처음 3달 무료', '무료 D-2']);
});
it('combines trial end and first charge with D-n only inside the reminder window', () => {
  expect(monthlyEvents({ recurring: [rec] }, '2026-10', '2026-09-30')).toMatchObject([{ kind: 'trialEnd', days: 2, amount: 10000 }]);
  expect(monthlyEvents({ recurring: [rec] }, '2026-10', '2026-09-28')[0]!.days).toBeNull();
});

it('counts a moved confirmation only in its entry month', () => {
  const ledger = { income: 100000, recurring: [rec] };
  const moved: LedgerEntry = { id: 'e', date: '2026-11-03', name: '구독', amount: 9000, createdAt: '2026-10-02T00:00:00Z', recurring: { id: 'r', date: '2026-10-02' } };
  const october = budgetFigures(ledger, monthSummary(ledger, [], '2026-10', '2026-11-10', [moved]), [moved]);
  const november = budgetFigures(ledger, monthSummary(ledger, [], '2026-11', '2026-11-10', [moved]), [moved]);
  expect(october).toEqual({ budget: 100000, fixed: 0, spent: 0, left: 100000 });
  expect(november).toEqual({ budget: 100000, fixed: 10000, spent: 9000, left: 81000 });
});
it.each([0, 9000])('excludes a resolved charge (%s won) from events and reminders across month boundaries', amount => {
  const ledger = { recurring: [rec] };
  const entries: LedgerEntry[] = [{ id: 'e', date: '2026-11-03', name: '구독', amount, createdAt: '2026-09-30T00:00:00Z', recurring: { id: 'r', date: '2026-10-02' } }];
  expect(monthlyEvents(ledger, '2026-10', '2026-09-30', entries)).toEqual([]);
  expect(reminders(ledger, '2026-09-30', entries)).toEqual([]);
  expect(monthlyEvents({ recurring: [{ ...rec, until: '2026-10-20' }] }, '2026-10', '2026-09-30', entries)).toMatchObject([{ kind: 'cancellationEnd' }]);
});
it('honors a confirmation after its schedule day changes', () => {
  const ledger = { recurring: [{ ...rec, start: '2026-10-03' }] };
  const entries: LedgerEntry[] = [{ id: 'e', date: '2026-10-02', name: '구독', amount: 0, createdAt: '2026-10-02T00:00:00Z', recurring: { id: 'r', date: '2026-10-02' } }];
  expect(monthlyEvents(ledger, '2026-10', '2026-10-02', entries)).toEqual([]);
  expect(reminders(ledger, '2026-10-02', entries)).toEqual([]);
});

it.each([0, 9000])('removes resolved charges (%s won) from the shared Home reminder calculation', amount => {
  const entries: LedgerEntry[] = [{ id: 'e', date: '2026-10-02', name: '구독', amount, createdAt: '2026-09-30T00:00:00Z', recurring: { id: 'r', date: '2026-10-02' } }];
  expect(reminders({ recurring: [rec] }, '2026-09-30', entries)).toEqual([]);
});
