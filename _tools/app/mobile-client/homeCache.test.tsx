import {act, cleanup, renderHook} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {resetHomeSourceCache, useCachedHomeSourceRead} from './homeCache';

const signal = (live: boolean, revision = 1) => window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live, signals: {collections: revision}}}));
beforeEach(() => {vi.useFakeTimers(); resetHomeSourceCache(); signal(false);});
afterEach(() => {cleanup(); signal(false); vi.useRealTimers();});
const options = (read: (signal: AbortSignal) => Promise<string>) => ({enabled: true, scope: 'fixture', source: 'shelf', signalKey: 'collections', initial: '', read});

it('keeps startup reads through the first live baseline, then cancels on a later change', async () => {
  const pending: {signal: AbortSignal; finish(value: string): void}[] = [];
  const read = vi.fn((signal: AbortSignal) => new Promise<string>(finish => pending.push({signal, finish})));
  const view = renderHook(() => useCachedHomeSourceRead(options(read)));
  await act(async () => {signal(true, 1);});
  expect(read).toHaveBeenCalledTimes(1);
  expect(pending[0].signal.aborted).toBe(false);
  await act(async () => {signal(true, 1);});
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {signal(true, 2);});
  expect(read).toHaveBeenCalledTimes(2);
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => {pending[1].finish('new'); pending[0].finish('old');});
  expect(view.result.current.value).toBe('new');
});

it('does not reread an already completed startup source when the baseline arrives', async () => {
  const read = vi.fn().mockResolvedValue('kept');
  const view = renderHook(() => useCachedHomeSourceRead(options(read)));
  await act(async () => {});
  await act(async () => {signal(true, 1);});
  expect(read).toHaveBeenCalledTimes(1);
  expect(view.result.current.ready).toBe(true);
});

it('does no minute refresh while signals are live, then uses the ten-minute safety read', async () => {
  signal(true);
  const read = vi.fn().mockResolvedValue('kept');
  const view = renderHook(() => useCachedHomeSourceRead(options(read)));
  await act(async () => {});
  await act(async () => {await vi.advanceTimersByTimeAsync(9 * 60_000);});
  expect(read).toHaveBeenCalledTimes(1);
  expect(view.result.current.value).toBe('kept');
  await act(async () => {await vi.advanceTimersByTimeAsync(60_000);});
  expect(read).toHaveBeenCalledTimes(2);
});

it('refreshes immediately on a real change and keeps content while the reply is pending', async () => {
  signal(true);
  let finish!: (value: string) => void;
  const read = vi.fn().mockResolvedValueOnce('old').mockImplementation(() => new Promise<string>(resolve => {finish = resolve;}));
  const view = renderHook(() => useCachedHomeSourceRead(options(read)));
  await act(async () => {});
  await act(async () => {signal(true, 2);});
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.result.current.value).toBe('old');
  await act(async () => {finish('new');});
  expect(view.result.current.value).toBe('new');
});

it('falls back promptly after signal loss and retains the legacy timer without support', async () => {
  signal(true);
  const read = vi.fn().mockResolvedValue('kept');
  renderHook(() => useCachedHomeSourceRead(options(read)));
  await act(async () => {await vi.advanceTimersByTimeAsync(2 * 60_000);});
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {signal(false);});
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {await vi.advanceTimersByTimeAsync(60_000);});
  expect(read).toHaveBeenCalledTimes(3);
});

it('cancels an obsolete in-flight read when another signal arrives', async () => {
  signal(true);
  const pending: {signal: AbortSignal; finish(value: string): void}[] = [];
  const read = vi.fn((signal: AbortSignal) => new Promise<string>(finish => pending.push({signal, finish})));
  const view = renderHook(() => useCachedHomeSourceRead(options(read)));
  await act(async () => {signal(true, 2);});
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => {pending[1].finish('new'); pending[0].finish('obsolete');});
  expect(view.result.current.value).toBe('new');
});

it('uses the safety interval for Home sources without a dedicated publication signal', async () => {
  signal(true);
  const read = vi.fn().mockResolvedValue('count');
  renderHook(() => useCachedHomeSourceRead({...options(read), signalKey: undefined}));
  await act(async () => {await vi.advanceTimersByTimeAsync(9 * 60_000);});
  expect(read).toHaveBeenCalledTimes(1);
});

it('retains a day source until ready while clearing content on a connection scope change', async () => {
  let finish!: (value: string) => void;
  const read = vi.fn().mockResolvedValueOnce('old').mockImplementation(() => new Promise<string>(resolve => {finish = resolve;}));
  const view = renderHook(({scope, source}) => useCachedHomeSourceRead({
    ...options(read), scope, source, keepOnSourceChange: true,
  }), {initialProps: {scope: 'library-a', source: 'day-one'}});
  await act(async () => {});
  view.rerender({scope: 'library-a', source: 'day-two'});
  expect(view.result.current.value).toBe('old');
  expect(view.result.current.ready).toBe(false);
  await act(async () => {finish('new');});
  expect(view.result.current.value).toBe('new');
  view.rerender({scope: 'library-b', source: 'day-two'});
  expect(view.result.current.value).toBe('');
});
