import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from './Gallery';
import type { Asset } from './types';
import { AreaVisible, MotionScope } from '../src/shared/motion/AreaSwitch';

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
it('animates the first tablet batch on every visit, skipping refresh, sort/filter and paging', () => {
  const tree = (items: Asset[], identity: string, mounted = true, visible = true) => <MotionScope><AreaVisible.Provider value={visible}>{mounted && <Gallery {...props} items={items} identity={identity}/>}</AreaVisible.Provider></MotionScope>;
  const view = render(tree([], 'first')); expect(animate).not.toHaveBeenCalled();
  view.rerender(tree(assets, 'first')); const first = animate.mock.calls.length; expect(first).toBeGreaterThan(0);
  expect(animate.mock.calls[0][1]).toEqual(expect.objectContaining({duration: 560, delay: 0}));
  view.rerender(tree([...assets, {...assets[0], id: 'next'}], 'page'));
  view.rerender(tree([...assets].reverse(), 'sort'));
  view.rerender(tree(assets.slice(0, 2), 'filter')); view.rerender(tree([...assets], 'refresh'));
  expect(animate).toHaveBeenCalledTimes(first);
  view.rerender(tree([], 'away', false)); view.rerender(tree(assets, 'revisit'));
  expect(animate).toHaveBeenCalledTimes(first * 2);
  view.rerender(tree(assets, 'revisit', true, false));
  expect(animate).toHaveBeenCalledTimes(first * 2);
  view.rerender(tree(assets, 'revisit'));
  expect(animate).toHaveBeenCalledTimes(first * 3);
});
it('does not consume first appearance while stale or paused, and skips it under reduced motion', () => {
  const tree = (paused: boolean, stale: boolean) => <MotionScope><Gallery {...props} paused={paused} stale={stale} items={assets} identity="first"/></MotionScope>;
  const view = render(tree(true, false)); expect(animate).not.toHaveBeenCalled();
  view.rerender(tree(false, true)); expect(animate).not.toHaveBeenCalled();
  vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  view.rerender(tree(false, false)); expect(animate).not.toHaveBeenCalled();
});

describe('tiles that arrive after a refresh fade in (user 2026-10-13)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(200);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  const asset = (i: number): Asset => ({...assets[0], id: `motion-${i}`, preview: `blob:motion-${i}`});
  const first = Array.from({length: 6}, (_, i) => asset(i));
  const tree = (items: Asset[], scope = 'scope', extra: Partial<React.ComponentProps<typeof Gallery>> = {}, visible = true) =>
    <MotionScope><AreaVisible.Provider value={visible}><Gallery {...props} items={items} identity={`${scope}:${items.length}`} arrivalScope={scope} {...extra}/></AreaVisible.Provider></MotionScope>;
  const arriving = (view: ReturnType<typeof render>) => [...view.container.querySelectorAll<HTMLElement>('[data-arrival]')].map(tile => tile.querySelector('img')?.getAttribute('src'));
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('marks only the new ids of the same scope, then clears the marker', async () => {
    const view = render(tree(first)); await advance(32);
    expect(arriving(view)).toEqual([]);
    view.rerender(tree([asset(100), ...first]));
    expect(arriving(view)).toEqual(['blob:motion-100']);
    await advance(16);
    expect(view.container.querySelector('[data-arrival]')?.getAttribute('data-arrival')).toBe('in');
    await advance(300);
    expect(arriving(view)).toEqual([]);
    view.rerender(tree([asset(100), ...first]));
    expect(arriving(view)).toEqual([]);
  });

  it('keeps an arriving tile transparent until its thumbnail is ready', async () => {
    const view = render(tree(first)); await advance(32);
    const pending = new WeakSet<HTMLImageElement>();
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockImplementation(function(this: HTMLImageElement) { return !(this.getAttribute('src') === 'blob:motion-100' && !pending.has(this)); });
    view.rerender(tree([asset(100), ...first])); await advance(100);
    const tile = view.container.querySelector('[data-arrival]')!;
    expect(tile.getAttribute('data-arrival')).toBe('wait');
    const image = tile.querySelector('img')!; pending.add(image);
    await act(async () => { image.dispatchEvent(new Event('load')); await vi.advanceTimersByTimeAsync(16); });
    expect(tile.getAttribute('data-arrival')).toBe('in');
    await advance(300);
    expect(tile.hasAttribute('data-arrival')).toBe(false);
  });

  it.each([
    ['paging', (items: Asset[]) => tree([...items, asset(200)], 'scope', {hasMore: true}), {hasMore: true}],
    ['a filter or sort change', (items: Asset[]) => tree([asset(300), ...items], 'other'), {}],
    ['a list sharing nothing with the old one', () => tree([asset(301), asset(302)]), {}],
  ])('does not fade on %s', async (_name, next, before) => {
    const view = render(tree(first, 'scope', before)); await advance(32);
    view.rerender(next(first)); await advance(16);
    expect(arriving(view)).toEqual([]);
  });

  it('falls back to the identity when no arrival scope is given, so a new load never fades', async () => {
    const plain = (items: Asset[], identity: string) => <MotionScope><Gallery {...props} items={items} identity={identity}/></MotionScope>;
    const view = render(plain(first, 'a')); await advance(32);
    view.rerender(plain([asset(100), ...first], 'b')); await advance(16);
    expect(arriving(view)).toEqual([]);
    view.rerender(plain([asset(101), asset(100), ...first], 'b')); await advance(16);
    expect(arriving(view)).toEqual(['blob:motion-101']);
  });

  it('does not fade a revisit, a paused gallery or reduced motion', async () => {
    const view = render(tree(first)); await advance(32);
    view.rerender(tree([asset(100), ...first], 'scope', {}, false));
    view.rerender(tree([asset(101), asset(100), ...first]));
    expect(arriving(view)).toEqual([]);
    view.rerender(tree([asset(102), asset(101), asset(100), ...first], 'scope', {paused: true}));
    view.rerender(tree([asset(103), asset(102), asset(101), asset(100), ...first]));
    expect(arriving(view)).toEqual([]);
    vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
    view.rerender(tree([asset(104), asset(103), asset(102), asset(101), asset(100), ...first]));
    expect(arriving(view)).toEqual([]);
    expect(view.container.querySelector('img[src="blob:motion-104"]')).not.toBeNull();
  });
});
