import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Gallery } from './Gallery';
import type { Asset } from './types';
import { MotionScope } from '../src/shared/motion/AreaSwitch';

const animate = vi.fn(() => ({cancel: vi.fn()}));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('CSS', {supports: () => false});
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {configurable: true, get: () => 600}, clientWidth: {configurable: true, get: () => 600},
    offsetHeight: {configurable: true, get: () => 600}, clientHeight: {configurable: true, get: () => 600},
    animate: {configurable: true, value: animate},
  });
});
afterEach(() => {cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; vi.unstubAllGlobals(); animate.mockClear();});
const assets: Asset[] = Array.from({length: 6}, (_, i) => ({id: `motion-${i}`, kind: 'image', preview: `blob:motion-${i}`, width: 200, height: 200}));
const props = {density: 1, restoreScroll: 0, onScroll: vi.fn(), onOpen: vi.fn(), onReady: vi.fn(), onNearEnd: vi.fn(), paused: false};
it('animates the first tablet batch once, skipping refresh, sort/filter, paging and remount revisits', () => {
  const tree = (items: Asset[], identity: string, mounted = true) => <MotionScope>{mounted && <Gallery {...props} items={items} identity={identity}/>}</MotionScope>;
  const view = render(tree([], 'first')); expect(animate).not.toHaveBeenCalled();
  view.rerender(tree(assets, 'first')); const first = animate.mock.calls.length; expect(first).toBeGreaterThan(0);
  expect(animate.mock.calls[0][1]).toEqual(expect.objectContaining({duration: 560, delay: 0}));
  view.rerender(tree([...assets, {...assets[0], id: 'next'}], 'page'));
  view.rerender(tree([...assets].reverse(), 'sort'));
  view.rerender(tree(assets.slice(0, 2), 'filter')); view.rerender(tree([...assets], 'refresh'));
  view.rerender(tree([], 'away', false)); view.rerender(tree(assets, 'revisit'));
  expect(animate).toHaveBeenCalledTimes(first);
});
it('does not consume first appearance while stale or paused, and skips it under reduced motion', () => {
  const tree = (paused: boolean, stale: boolean) => <MotionScope><Gallery {...props} paused={paused} stale={stale} items={assets} identity="first"/></MotionScope>;
  const view = render(tree(true, false)); expect(animate).not.toHaveBeenCalled();
  view.rerender(tree(false, true)); expect(animate).not.toHaveBeenCalled();
  vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  view.rerender(tree(false, false)); expect(animate).not.toHaveBeenCalled();
});
