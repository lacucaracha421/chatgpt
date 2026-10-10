import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {useCallback, useRef, useState} from 'react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {Gallery} from './Gallery';
import {rowHeight} from './model';
import {readFileSync} from 'node:fs';
import type {Asset} from './types';

// Keep the real range/offset machinery. Only enlarge the reported scroll extent,
// reproducing a viewport that can fling past the last materialized row without a TOC.
const measurement = vi.hoisted(() => ({total: 60_000, loadedSize: 0, width: 632}));
vi.mock('@tanstack/react-virtual', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  const proxies = new WeakMap<object, ReturnType<typeof actual.useVirtualizer>>();
  return {...actual, useVirtualizer: (options: Parameters<typeof actual.useVirtualizer>[0]) => {
    const instance = actual.useVirtualizer(options);
    if (proxies.has(instance)) return proxies.get(instance)!;
    const proxy = new Proxy(instance, {get(target, key) {
      if (key === 'getTotalSize') return () => {
        measurement.loadedSize = target.getTotalSize();
        return Math.max(measurement.total, measurement.loadedSize);
      };
      return Reflect.get(target, key);
    }});
    proxies.set(instance, proxy);
    return proxy;
  }};
});
vi.mock('./media', () => ({prefetchThumbnails: vi.fn(), loadThumbnail: vi.fn(async (asset: Asset) => asset), invalidateTicket: vi.fn(), mediaTicket: vi.fn()}));
vi.mock('./originalTicketWarm', () => ({warmOriginalTickets: vi.fn()}));

const observers: {callback: ResizeObserverCallback; target?: Element}[] = [];
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const requests = vi.fn();
let respond: (() => void) | undefined;
let loaded = 0;
const assets = (start: number, count: number): Asset[] => Array.from({length: count}, (_, i) => ({
  id: `asset-${start + i}`, kind: 'image', width: 600, height: 600,
  collected_at: '2026-10-10', preview: `https://test.invalid/${start + i}.webp`,
}));

function PagedHost({intro = false, appendCount = 60, density = 1, hasMore = true}: {intro?: boolean; appendCount?: number; density?: number; hasMore?: boolean}) {
  const [items, setItems] = useState(() => assets(0, 60));
  const pending = useRef(false);
  loaded = items.length;
  const more = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    requests(items.length);
    respond = () => {pending.current = false; setItems(previous => [...previous, ...assets(previous.length, appendCount)]);};
  }, [items.length, appendCount]);
  return <Gallery items={items} identity="all-assets" density={density} hasMore={hasMore} restoreScroll={0}
    intro={intro ? <div>All assets controls</div> : undefined}
    onScroll={() => {}} onOpen={() => {}} onReady={() => {}} onNearEnd={more} paused={false}/>;
}

beforeEach(() => {
  observers.length = 0; requests.mockClear(); respond = undefined; measurement.total = 60_000; measurement.width = 632;
  vi.stubGlobal('ResizeObserver', class {
    entry: {callback: ResizeObserverCallback; target?: Element};
    constructor(callback: ResizeObserverCallback) {this.entry = {callback}; observers.push(this.entry);}
    observe(target: Element) {this.entry.target = target;} unobserve() {} disconnect() {}
  });
  for (const [name, size] of [['offsetHeight', 1000], ['offsetWidth', 632], ['clientHeight', 1000], ['clientWidth', 632]] as const) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
    Object.defineProperty(HTMLElement.prototype, name, {configurable: true, get: () => name.endsWith('Width') ? measurement.width : size});
  }
  descriptors.set('scrollHeight', Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight'));
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {configurable: true, get() {
    const element = this as HTMLElement;
    return parseFloat(element.querySelector<HTMLElement>('.gallery-canvas')?.style.height ?? '0')
      + (element.querySelector('.gallery-intro')?.getBoundingClientRect().height ?? 0);
  }});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return {x: 0, y: 0, top: 0, left: 0, right: 632, width: 632,
      bottom: this.classList.contains('gallery-intro') ? 320 : 1000,
      height: this.classList.contains('gallery-intro') ? 320 : 1000, toJSON() {}};
  });
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
  descriptors.clear();
});
function mount(props: {intro?: boolean; appendCount?: number; density?: number; hasMore?: boolean} = {}) {
  render(<PagedHost {...props}/>);
  measure();
  return screen.getByLabelText('자산 목록');
}
function measure() {
  act(() => {for (const observer of observers) if (observer.target) observer.callback([
    {target: observer.target, borderBoxSize: [{inlineSize: 632, blockSize: 1000}]} as unknown as ResizeObserverEntry,
  ], {} as ResizeObserver);});
}
function coverage(scroll: HTMLElement, realOnly = false) {
  const introHeight = scroll.querySelector('.gallery-intro')?.getBoundingClientRect().height ?? 0;
  if (!realOnly) {
    const canvas = scroll.querySelector<HTMLElement>('.gallery-canvas')!;
    expect(canvas.style.getPropertyValue('--gallery-placeholder-pitch')).not.toBe('');
    const end = scroll.querySelector<HTMLElement>('.gallery-complete-tail');
    const height = end ? parseFloat(end.style.top) : parseFloat(canvas.style.height);
    return Math.max(0, Math.min(introHeight + height, scroll.scrollTop + scroll.clientHeight) - Math.max(introHeight, scroll.scrollTop));
  }
  const bands = [...scroll.querySelectorAll<HTMLElement>('.gallery-row')].flatMap(row => {
    if (realOnly && !row.closest('[data-gallery-row]')) return [];
    if (!row.querySelector('.tile-picture')) return [];
    const unit = row.parentElement!;
    const top = introHeight + parseFloat(unit.style.transform.slice('translateY('.length)) + parseFloat(row.style.top || '0');
    const bottom = top + parseFloat(row.style.height);
    return top < scroll.scrollTop + scroll.clientHeight && bottom > scroll.scrollTop
      ? [{top: Math.max(top, scroll.scrollTop), bottom: Math.min(bottom, scroll.scrollTop + scroll.clientHeight)}] : [];
  }).sort((a, b) => a.top - b.top);
  let end = scroll.scrollTop, painted = 0;
  for (const band of bands) {painted += Math.max(0, band.bottom - Math.max(end, band.top)); end = Math.max(end, band.bottom);}
  return painted;
}

it('requests the next page as soon as the viewport passes loaded rows, far from the reported end', () => {
  const scroll = mount();
  scroll.scrollTop = 10_000; fireEvent.scroll(scroll);
  expect(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight).toBeGreaterThan(40_000);
  expect(requests).toHaveBeenCalledWith(60);
});

it.each([false, true])('keeps the CSS canvas across each fling and stopped viewport, then fills in place (intro=%s)', async intro => {
  const scroll = mount({intro});
  vi.useFakeTimers();
  for (let fling = 1; fling <= 20; fling++) {
    scroll.scrollTop = 10_000 + fling * 1800; fireEvent.scroll(scroll);
    expect(coverage(scroll)).toBeGreaterThan(scroll.clientHeight * .9);
    await act(async () => {await vi.advanceTimersByTimeAsync(400);});
    expect(coverage(scroll)).toBeGreaterThan(scroll.clientHeight * .9);
  }
  expect(loaded).toBe(60); expect(requests).toHaveBeenCalledTimes(1);
  const top = scroll.scrollTop;
  await act(async () => {await vi.advanceTimersByTimeAsync(5000);});
  expect(coverage(scroll)).toBeGreaterThan(scroll.clientHeight * .9);
  // No further scroll events: each arriving page must continue the cursor walk until
  // real rows reach this viewport, keeping the same pixel position throughout.
  measurement.total = 0; // Later measurements must not clamp an already reached viewport.
  for (let page = 0; page < 20 && coverage(scroll, true) < 900; page++) {
    expect(respond).toBeDefined();
    act(() => {const reply = respond!; respond = undefined; reply();});
    expect(scroll.scrollTop).toBe(top);
    expect(scroll.scrollHeight).toBeGreaterThanOrEqual(top + scroll.clientHeight);
    expect(coverage(scroll)).toBeGreaterThan(scroll.clientHeight * .9);
  }
  expect(loaded).toBeGreaterThan(600);
  expect(coverage(scroll, true)).toBeGreaterThan(900);
  expect(scroll.querySelector('[data-gallery-placeholder-row]')).toBeNull();
});

it('preserves the partially unloaded viewport when a small page arrives with a corrected total', () => {
  const scroll = mount({appendCount: 3});
  scroll.scrollTop = measurement.loadedSize - 100; fireEvent.scroll(scroll);
  const top = scroll.scrollTop;
  expect(coverage(scroll)).toBeGreaterThan(900);
  measurement.total = 0;
  act(() => {const reply = respond!; respond = undefined; reply();});
  expect(scroll.scrollTop).toBe(top);
  expect(scroll.scrollHeight).toBeGreaterThanOrEqual(top + scroll.clientHeight);
  expect(coverage(scroll)).toBeGreaterThan(900);
});

// jsdom can inspect geometry and opaque CSS coverage, but cannot verify painting.
it.each([0, .5, 1, 1.5, 2].flatMap(density => [320, 800, 1280].map(width => ({density, width}))))('sizes the static pattern at density=$density and width=$width', ({density, width}) => {
  measurement.width = width;
  const scroll = mount({density});
  const canvas = scroll.querySelector<HTMLElement>('.gallery-canvas')!;
  const available = width - 32, target = rowHeight(density, available);
  const columns = Math.max(1, Math.round((available + 10) / (target * .75 + 10)));
  expect(canvas.style.getPropertyValue('--gallery-placeholder-height')).toBe(`${target}px`);
  expect(canvas.style.getPropertyValue('--gallery-placeholder-pitch')).toBe(`${target + 10}px`);
  const tileWidth = parseFloat(canvas.style.getPropertyValue('--gallery-placeholder-width'));
  expect(tileWidth * columns + 10 * (columns - 1)).toBeCloseTo(available);
  expect(parseFloat(canvas.style.getPropertyValue('--gallery-placeholder-column-pitch'))).toBeCloseTo(tileWidth + 10);
  expect(scroll.querySelector('[data-gallery-placeholder-row]')).toBeNull();
});

it('covers mounted full row pitches, headings and intro with opaque background, and masks the completed tail', () => {
  const style = document.createElement('style');
  // Resolve just the color tokens for jsdom; use the actual gallery rules from mobile.css.
  style.textContent = readFileSync('mobile-client/mobile.css', 'utf8')
    .split('\n').filter(line => /^\.gallery-(canvas|intro|complete-tail|justified-unit)\b/.test(line)).join('\n')
    .replaceAll('var(--color-bg)', '#161718').replaceAll('var(--color-surface)', '#222324');
  document.head.append(style);
  try {
    const view = render(<PagedHost intro/>); measure();
    const scroll = screen.getByLabelText('자산 목록');
    const canvas = scroll.querySelector<HTMLElement>('.gallery-canvas')!;
    expect(getComputedStyle(canvas).backgroundImage).toContain('repeating-linear-gradient');
    expect(getComputedStyle(scroll.querySelector('.gallery-intro')!).backgroundColor).toBe('rgb(22, 23, 24)');
    const units = [...scroll.querySelectorAll<HTMLElement>('[data-gallery-row]')];
    expect(units.length).toBeGreaterThan(0);
    expect(units.some(unit => unit.querySelector('.gallery-date-heading'))).toBe(true);
    for (const unit of units) {
      expect(getComputedStyle(unit).backgroundColor).toBe('rgb(22, 23, 24)');
      const row = unit.querySelector<HTMLElement>('.gallery-row')!;
      expect(parseFloat(unit.style.height)).toBe(parseFloat(row.style.top) + parseFloat(row.style.height) + 10);
    }
    scroll.scrollTop = 40_000; fireEvent.scroll(scroll);
    const extent = canvas.style.height;
    expect(scroll.querySelector('.gallery-complete-tail')).toBeNull();
    view.rerender(<PagedHost intro hasMore={false}/>);
    const tail = scroll.querySelector<HTMLElement>('.gallery-complete-tail')!;
    expect(tail).not.toBeNull();
    expect(getComputedStyle(tail).backgroundColor).toBe('rgb(22, 23, 24)');
    expect(parseFloat(tail.style.top)).toBe(measurement.loadedSize);
    expect(parseFloat(tail.style.top) + parseFloat(tail.style.height)).toBe(parseFloat(extent));
    expect(canvas.style.height).toBe(extent);
    expect(scroll.scrollTop).toBe(40_000);
  } finally {style.remove();}
});
