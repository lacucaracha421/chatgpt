import {act, cleanup, renderHook} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {usePublicationCheck} from './usePublicationCheck';

const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', () => mocks);
const signal = (live: boolean, revision = 1) => window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live, signals: {collections: revision}}}));
beforeEach(() => {vi.useFakeTimers(); mocks.api.mockReset(); signal(false);});
afterEach(() => {cleanup(); signal(false); vi.useRealTimers();});

it('does not queue a second startup status read for the baseline, but follows later changes', async () => {
  const pending: {signal: AbortSignal; finish(value: unknown): void}[] = [];
  mocks.api.mockImplementation((_path: string, signal: AbortSignal) => new Promise(finish => pending.push({signal, finish})));
  const receive = vi.fn();
  renderHook(() => usePublicationCheck(true, '/v1/collections/status', undefined, receive));
  await act(async () => {signal(true, 1); pending[0].finish({revision: 'r1'});});
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(pending[0].signal.aborted).toBe(false);
  await act(async () => {signal(true, 2);});
  expect(mocks.api).toHaveBeenCalledTimes(2);
  await act(async () => {signal(true, 3); pending[1].finish({revision: 'r2'});});
  expect(mocks.api).toHaveBeenCalledTimes(3);
  await act(async () => {pending[2].finish({revision: 'r3'});});
  expect(receive.mock.calls.map(([reply]) => reply.revision)).toEqual(['r1', 'r2', 'r3']);
});
