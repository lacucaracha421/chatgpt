import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LoadingLine } from './TopBar';

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
