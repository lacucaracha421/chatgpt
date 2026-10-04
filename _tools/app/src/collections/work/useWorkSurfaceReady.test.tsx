import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useWorkSurfaceReady } from './useWorkSurfaceReady';

it('waits for every painted part and ignores callbacks from an abandoned presentation', () => {
  const onReady = vi.fn();
  const view = renderHook(({id}) => useWorkSurfaceReady(id, false, false, onReady), {initialProps: {id: 'old'}});
  const old = view.result.current;
  act(() => { old('object'); old('hero'); old('backdrop'); });
  expect(onReady).not.toHaveBeenCalled();
  view.rerender({id: 'new'});
  act(() => { old('strip'); view.result.current('object'); view.result.current('strip'); });
  expect(onReady).not.toHaveBeenCalled();
  act(() => { view.result.current('hero'); view.result.current('backdrop'); });
  expect(onReady).toHaveBeenCalledOnce();
});

it('reuses the ready case when only the surrounding artwork changes', () => {
  const onReady = vi.fn();
  const view = renderHook(({id, object}) => useWorkSurfaceReady(id, false, true, onReady, object), {initialProps: {id: 'first', object: 'same case'}});
  act(() => { view.result.current('object'); view.result.current('hero'); view.result.current('strip'); });
  onReady.mockClear();
  view.rerender({id: 'new hero', object: 'same case'});
  act(() => { view.result.current('hero'); view.result.current('strip'); });
  expect(onReady).toHaveBeenCalledOnce();
  onReady.mockClear();
  view.rerender({id: 'new case', object: 'different case'});
  act(() => { view.result.current('hero'); view.result.current('strip'); });
  expect(onReady).not.toHaveBeenCalled();
});
