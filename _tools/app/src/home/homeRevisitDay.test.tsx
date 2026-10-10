import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { homeRevisitDay, useHomeRevisitDay } from './useHomeRevisitDay';
import { useHomeMedia } from './useHomeMedia';
import type { LibraryGateway } from '../library/types';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('refreshes PC selection at 23:59 → 00:00 KST and keeps the old set pending', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-09T14:59:00Z'));
  let finish!: (value: unknown) => void;
  const slate = vi.fn().mockResolvedValueOnce({bundles: [{kind: 'date', assetIds: ['before']}]})
    .mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const gateway = {getRevisitSlate: slate} as unknown as LibraryGateway;
  const view = renderHook(() => useHomeMedia(gateway, useHomeRevisitDay(), true, 0));
  await act(async () => {});
  expect(slate.mock.calls[0][0]).toBe('2026-10-09');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(slate.mock.calls[1][0]).toBe('2026-10-10');
  expect(view.result.current.data?.anniversary?.assetIds).toEqual(['before']);
  await act(async () => { finish({bundles: [{kind: 'date', assetIds: ['after']}]}); });
  expect(view.result.current.data?.anniversary?.assetIds).toEqual(['after']);
});

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
