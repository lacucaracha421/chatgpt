import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LoadingLine, TopBar } from './TopBar';

afterEach(() => { cleanup(); vi.useRealTimers(); });
it('uses the shared 600 ms delay and 400 ms minimum for the loading line', () => {
  vi.useFakeTimers();
  const view = render(<LoadingLine label="목록 불러오는 중"/>);
  act(() => vi.advanceTimersByTime(599));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('status', {name: '목록 불러오는 중'})).toBeTruthy();
  view.rerender(<LoadingLine label={false}/>);
  act(() => vi.advanceTimersByTime(399));
  expect(screen.getByRole('status', {name: '목록 불러오는 중'})).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole('status')).toBeNull();
});


it('formats numeric header counts with thousands separators', () => {
 render(<TopBar title="폴더" count={1020}/>);
 expect(screen.getByText('1,020')).toBeTruthy();
});
