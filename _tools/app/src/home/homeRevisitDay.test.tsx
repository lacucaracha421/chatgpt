import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { homeRevisitDay, useHomeRevisitDay } from './useHomeRevisitDay';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('uses fixed KST and checks the day when a sleeping app resumes', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-09T14:59:00Z'));
  const view = renderHook(() => useHomeRevisitDay());
  expect(homeRevisitDay(new Date('2026-10-09T23:00:00-07:00'))).toBe('2026-10-10');
  vi.setSystemTime(new Date('2026-10-11T01:00:00Z'));
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(view.result.current).toBe('2026-10-11');
  expect(vi.getTimerCount()).toBe(1);
});
