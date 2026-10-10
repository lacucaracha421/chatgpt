import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useHomeRevisit } from './homeDashboard';
import { resetHomeSourceCache } from './homeCache';
import { api } from './transport';

vi.mock('./transport', async importOriginal => ({...await importOriginal<typeof import('./transport')>(), api: vi.fn()}));
afterEach(() => { cleanup(); resetHomeSourceCache(); localStorage.clear(); vi.useRealTimers(); vi.clearAllMocks(); });

it('refreshes tablet selection at KST midnight without losing the previous set', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-09T14:59:00Z'));
  resetHomeSourceCache(); localStorage.clear();
  const reply = (id: string) => ({bundles: [{kind: 'date', title: '1년 전 오늘', items: [{id, kind: 'image', collected_at: '2025-10-09T15:00:00Z'}]}]});
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockResolvedValueOnce(reply('before')).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  const view = renderHook(() => useHomeRevisit(true, 'fixture'));
  await act(async () => {});
  expect(vi.mocked(api).mock.calls[0][0]).toContain('day=2026-10-09');
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toContain('day=2026-10-10');
  expect(view.result.current?.[0].items[0].id).toBe('before');
  await act(async () => {finish(reply('after'));});
  expect(view.result.current?.[0].items[0].id).toBe('after');
});
