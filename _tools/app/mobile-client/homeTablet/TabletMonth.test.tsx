import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { monthDays, type MonthRelease } from '../../src/home/homeMonthModel';
import { TabletMonth } from './TabletMonth';

afterEach(cleanup);

it('shares the Sunday grid and holidays, selects on tap, opens on double tap and pages on swipe', () => {
  const onSelect = vi.fn(), onOpenDay = vi.fn(), onMonth = vi.fn();
  const days = monthDays<MonthRelease>('2026-10', '2026-10-18', {releases: [], saved: [], payments: [], entries: [], memos: new Map()});
  const {container} = render(<TabletMonth month="2026-10" today="2026-10-18" at={new Date('2026-10-18T12:00:00Z')}
    selected="2026-10-18" days={days} totals={null} hideAmounts={false} earlier={[]}
    onSelect={onSelect} onOpenDay={onOpenDay} onMonth={onMonth} onToday={vi.fn()} onOpenCalendar={vi.fn()} />);
  expect(screen.getAllByRole('columnheader').map(day => day.textContent)).toEqual(['일', '월', '화', '수', '목', '금', '토']);
  expect(screen.getAllByRole('gridcell')).toHaveLength(42);
  expect(screen.getAllByRole('gridcell')[0]?.getAttribute('aria-label')).toContain('9월 27일 일요일');
  const holiday = screen.getByRole('gridcell', {name: /10월 5일.*대체공휴일/});
  fireEvent.click(holiday);
  expect(onSelect).toHaveBeenLastCalledWith('2026-10-05');
  expect(onOpenDay).not.toHaveBeenCalled();
  fireEvent.click(holiday);
  expect(onOpenDay).toHaveBeenCalledWith('2026-10-05');
  const strip = container.firstElementChild!;
  fireEvent.touchStart(strip, {touches: [{clientX: 300, clientY: 100}]});
  fireEvent.touchEnd(strip, {changedTouches: [{clientX: 200, clientY: 110}]});
  expect(onMonth).toHaveBeenCalledWith('2026-11');
});
