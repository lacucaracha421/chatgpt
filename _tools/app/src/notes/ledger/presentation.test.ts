import { expect, it } from 'vitest';
import { parseQuickEntry, shiftDateMonths, subscriptionPills, monthlyEvents } from './presentation';
import type { Recurring } from './model';
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
