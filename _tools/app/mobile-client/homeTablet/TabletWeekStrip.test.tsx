import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TabletWeekStrip } from './TabletWeekStrip';
import { releaseCalendarModel } from '../../src/home/homeCalendarModel';

afterEach(cleanup);
it('shows release text, kind and countdown without its cover', () => {
  const model = releaseCalendarModel([{key: 'anime', name: '사이버펑크: 엣지러너 2', date: '2026-10-18', detail: '애니', cover: <img alt="표지" src="poster.jpg"/>, onOpen: vi.fn()}], '2026-10-17');
  render(<TabletWeekStrip model={model} at={new Date(2026, 9, 17, 12)} onOpenCalendar={vi.fn()} onOpenNote={vi.fn()}/>);
  const calendar = within(screen.getByRole('region', {name: '발매 캘린더'}));
  expect(calendar.getByText('사이버펑크: 엣지러너 2')).toBeTruthy();
  expect(calendar.getByText('애니')).toBeTruthy();
  expect(calendar.getByText('D-1')).toBeTruthy();
  expect(calendar.queryByRole('img')).toBeNull();
});
