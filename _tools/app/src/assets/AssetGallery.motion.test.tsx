import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AssetGallery } from './AssetGallery';
import type { AssetSummary } from '../library/types';
import { AreaVisible, MotionScope } from '../shared/motion/AreaSwitch';
import { buildJustifiedGalleryRows } from './galleryRows';

const measure = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-virtual', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  const observed = new WeakSet();
  return {...actual, useVirtualizer: (...args: Parameters<typeof actual.useVirtualizer>) => {
    const virtualizer = actual.useVirtualizer(...args);
    if (!observed.has(virtualizer)) {
      observed.add(virtualizer);
      const original = virtualizer.measure;
      virtualizer.measure = () => { measure(); original(); };
    }
    return virtualizer;
  }};
});

vi.mock('./galleryRows', async importOriginal => {
  const actual = await importOriginal<typeof import('./galleryRows')>();
  return {...actual, buildJustifiedGalleryRows: vi.fn(actual.buildJustifiedGalleryRows)};
});

const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({cancel: vi.fn(), onfinish: null as (() => void) | null}));
const asset = (i: number): AssetSummary => ({id: `motion-${i}`, title: null, originalName: `motion-${i}.png`, byteSize: 1, width: 200, height: 200, collectedAt: '2026-10-02T00:00:00Z', favorite: false, sourceUrl: null, sourcePublishedAt: null, creatorName: null, creatorHandle: null, creatorUrl: null, importSource: null, importBatchId: null, originalModifiedAt: null, media: {kind: 'image'}});
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: {configurable: true, get: () => 840}, clientWidth: {configurable: true, get: () => 840},
    offsetHeight: {configurable: true, get: () => 600}, clientHeight: {configurable: true, get: () => 600},
    animate: {configurable: true, value: animate},
  });
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(200);
  vi.stubGlobal('CSS', {supports: () => false});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    if (this instanceof HTMLImageElement) return this.closest('[data-gallery-cell]')!.getBoundingClientRect();
    const cell = this.matches('[data-gallery-cell]');
    const scroller = this.closest('.asset-gallery__scroll');
    const x = cell ? parseFloat(this.style.left) : 0;
    const y = cell ? parseFloat(this.style.top) - (scroller?.scrollTop ?? 0) : 0;
    const width = cell ? parseFloat(this.style.width) : 840;
    const height = cell ? parseFloat(this.style.height) : this.classList.contains('asset-gallery__intro') ? 80 : 600;
    return {x, y, top: y, left: x, right: x + width, bottom: y + height, width, height, toJSON() {}};
  });
});
afterEach(() => {cleanup(); delete (HTMLElement.prototype as Partial<HTMLElement>).animate; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); animate.mockClear();});
const tick = async (ms = 32) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const scope = (folder: string, extra = {}) => JSON.stringify({classificationId: folder, sort: 'newest', mediaKind: null, ...extra});

it('measures the final gallery width once and ignores equal ResizeObserver deliveries during motion', async () => {
  const observers = new Map<Element, ResizeObserverCallback[]>();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { observers.set(element, [...observers.get(element) ?? [], this.callback]); }
    unobserve() {}
    disconnect() {}
  });
  const items = Array.from({length: 40}, (_, i) => asset(i));
  const view = render(<AssetGallery items={items} groupDates={false} />);
  const host = view.container.querySelector<HTMLElement>('.asset-gallery__scroll')!;
  vi.mocked(buildJustifiedGalleryRows).mockClear();
  measure.mockClear();
  const resize = () => act(() => {
    for (const callback of observers.get(host) ?? []) callback([{target: host, contentRect: {width: 640, height: 600}, borderBoxSize: [{inlineSize: 640, blockSize: 600}]} as unknown as ResizeObserverEntry], {} as ResizeObserver);
  });
  resize();
  expect(buildJustifiedGalleryRows).toHaveBeenCalledOnce();
  expect(measure).toHaveBeenCalledOnce();
  expect(vi.mocked(buildJustifiedGalleryRows).mock.calls[0][1]).toBe(640);
  for (let frame = 0; frame < 15; frame++) { await tick(16); resize(); }
  expect(buildJustifiedGalleryRows).toHaveBeenCalledOnce();
  expect(measure).toHaveBeenCalledOnce();
});

it.each([
  [['parent'], ['parent', 'child']],
  [['parent', 'child'], ['parent']],
  [['parent', 'child'], ['sibling']],
] as const)('swaps folder %j → %j in one step with no animation (user 2026-10-05)', async (previous, next) => {
  const tree = (path: readonly string[], id: number) => <AssetGallery layout="masonry" items={[asset(id)]} scopeKey={scope(path.join('/'))}/>;
  const view = render(tree(previous, 0)); animate.mockClear();
  view.rerender(tree(next, 1));
  expect(view.container.querySelector('.asset-gallery__scroll')).toHaveAttribute('data-folder-move', 'pending');
  await tick();
  expect(view.container.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
  expect(view.container.querySelector('.asset-gallery__scroll')).not.toHaveAttribute('data-folder-move');
  expect(animate).not.toHaveBeenCalled();
});

it('does not copy undecoded images or video into the snapshot', () => {
  const tree = (folder: string, offset: number) => <AssetGallery layout="masonry" items={[asset(offset), asset(offset + 1)]} scopeKey={scope(folder)}/>;
  const view = render(tree('old', 0));
  const images = view.container.querySelectorAll('img');
  Object.defineProperty(images[1], 'complete', {value: false});
  view.rerender(tree('new', 2));
  const snapshot = view.container.querySelector('.asset-gallery__folder-snapshot')!;
  expect(snapshot.children).toHaveLength(1);
  expect(snapshot.querySelector('img')).toHaveAttribute('alt', 'motion-0.png');
  expect(snapshot.querySelector('video, canvas, button')).toBeNull();
});

it('keeps the old folder until the decode cap, then swaps in one step without animation', async () => {
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {configurable: true, value: () => new Promise(() => {})});
  try {
    const tree = (folder: string, id: number) => <AssetGallery layout="masonry" items={[asset(id)]} scopeKey={scope(folder)}/>;
    const view = render(tree('old', 0)); animate.mockClear();
    view.rerender(tree('new', 1)); await tick(16 + 249);
    expect(view.container.querySelector('.asset-gallery__folder-snapshot')).not.toBeNull();
    expect(view.container.querySelector('.asset-gallery__scroll')).toHaveAttribute('data-folder-move', 'pending');
    await tick(17);
    expect(view.container.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
    expect(view.container.querySelector('.asset-gallery__scroll')).not.toHaveAttribute('data-folder-move');
    await tick(500);
    expect(animate).not.toHaveBeenCalled();
  } finally { delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode; }
});

it.each(['masonry', 'justified'] as const)('animates the first %s batch on every visit, skipping paging, sorting, filtering and refresh', layout => {
  const tree = (items: AssetSummary[], scopeKey: string, mounted = true, visible = true) => <MotionScope><AreaVisible.Provider value={visible}>{mounted && <AssetGallery layout={layout} items={items} scopeKey={scopeKey}/>}</AreaVisible.Provider></MotionScope>;
  const view = render(tree([], scope('initial'))); expect(animate).not.toHaveBeenCalled();
  const items = Array.from({length: 6}, (_, i) => asset(i));
  view.rerender(tree(items, scope('initial'))); const first = animate.mock.calls.length;
  expect(first).toBeGreaterThan(0);
  view.rerender(tree([...items, asset(6)], scope('initial')));
  view.rerender(tree([...items].reverse(), scope('initial', {sort: 'oldest'})));
  view.rerender(tree(items.slice(0, 2), scope('initial', {mediaKind: 'images', autoTags: ['test']})));
  view.rerender(tree([...items], scope('initial')));
  expect(animate).toHaveBeenCalledTimes(first);
  view.rerender(tree([], 'away', false)); view.rerender(tree(items, 'revisit'));
  expect(animate).toHaveBeenCalledTimes(first * 2);
  view.rerender(tree(items, 'revisit', true, false));
  expect(animate).toHaveBeenCalledTimes(first * 2);
  view.rerender(tree(items, 'revisit'));
  expect(animate).toHaveBeenCalledTimes(first * 3);
});
it('keeps the initial gallery still with reduced motion', () => {
  vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  render(<MotionScope><AssetGallery layout="masonry" items={[asset(0)]}/></MotionScope>);
  expect(animate).not.toHaveBeenCalled();
});

it.each(['masonry', 'justified'] as const)('holds one %s layer of visible decoded images, excluding the intro and overscan, then swaps without animation', async layout => {
  const tree = (folder: string, offset: number) => <AssetGallery layout={layout} groupDates={false} intro={<button>folder shelf</button>} items={Array.from({length: 60}, (_, i) => asset(i + offset))} scopeKey={scope(folder)}/>;
  const view = render(tree('old', 0));
  animate.mockClear();
  view.rerender(tree('next', 100));
  const snapshot = view.container.querySelector('.asset-gallery__folder-snapshot')!;
  expect(snapshot).not.toBeNull();
  expect(snapshot).toHaveAttribute('inert'); expect(snapshot).toHaveAttribute('aria-hidden', 'true');
  expect(snapshot.querySelector('img')).toHaveAttribute('alt', 'motion-0.png');
  expect(snapshot.querySelector('[data-asset-id], [data-gallery-cell], [role], [tabindex], [id]')).toBeNull();
  expect(snapshot.textContent).not.toContain('folder shelf');
  expect(snapshot.querySelectorAll('img').length).toBeGreaterThan(0);
  expect(snapshot.querySelectorAll('img').length).toBeLessThan(60);
  await tick();
  expect(snapshot.isConnected).toBe(false);
  expect(view.container.querySelector('.asset-gallery__scroll')).not.toHaveAttribute('data-folder-move');
  expect(view.container.querySelector<HTMLElement>('.asset-gallery__virtual-space')!.style.willChange).toBe('');
  fireEvent.scroll(view.container.querySelector('.asset-gallery__scroll')!, {target: {scrollTop: 1200}});
  await tick(); expect(animate).not.toHaveBeenCalled();
});

it('swaps a reduced-motion folder move in one step too', async () => {
  vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  const tree = (folder: string, id: number) => <AssetGallery layout="masonry" groupDates={false} items={[asset(id)]} scopeKey={scope(folder)}/>;
  const view = render(tree('old', 0)); view.rerender(tree('new', 1));
  expect(view.container.querySelector('.asset-gallery__folder-snapshot')).not.toBeNull();
  await tick();
  expect(view.container.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
  expect(animate).not.toHaveBeenCalled();
});

it.each(['scroll', 'wheel', 'pointerdown', 'keydown', 'touchstart'])('shows the new folder at once on %s while it is still waiting', async event => {
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {configurable: true, value: () => new Promise(() => {})});
  try {
    const tree = (folder: string, id: number) => <AssetGallery layout="masonry" items={[asset(id)]} scopeKey={scope(folder)}/>;
    const view = render(tree('old', 0)); animate.mockClear(); view.rerender(tree('new', 1)); await tick();
    const host = view.container.querySelector<HTMLElement>('.asset-gallery__scroll')!;
    expect(host.querySelector('.asset-gallery__folder-snapshot')).not.toBeNull();
    if (event === 'scroll') host.scrollTop = 100;
    fireEvent(host, new Event(event, {bubbles: true}));
    expect(host.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
    expect(host.dataset.folderMove).toBeUndefined();
    expect(animate).not.toHaveBeenCalled();
  } finally { delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode; }
});

it('keeps old decoded tiles while new media decodes and cancels a superseded folder before it can swap', async () => {
  let decode!: () => void;
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {configurable: true, value: vi.fn(() => new Promise<void>(resolve => {decode = resolve;}))});
  try {
    const tree = (folder: string, id: number, privacyMode = false) => <AssetGallery layout="masonry" items={[asset(id)]} scopeKey={scope(folder)} privacyMode={privacyMode}/>;
    const view = render(tree('old', 0)); animate.mockClear(); view.rerender(tree('new', 1)); await tick();
    expect(view.container.querySelector('.asset-gallery__scroll')).toHaveAttribute('data-folder-move', 'pending');
    expect(view.container.querySelector('.asset-gallery__folder-snapshot img')).toHaveAttribute('alt', 'motion-0.png');
    const staleDecode = decode;
    view.rerender(tree('third', 2)); await tick();
    await act(async () => staleDecode());
    expect(view.container.querySelector('.asset-gallery__scroll')).toHaveAttribute('data-folder-move', 'pending');
    await act(async () => decode());
    expect(view.container.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
    expect(view.container.querySelector('.asset-gallery__scroll')).not.toHaveAttribute('data-folder-move');
    expect(animate).not.toHaveBeenCalled();
    view.rerender(tree('third', 2, true));
    expect(view.container.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  } finally { delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode; }
});

it('holds first-screen tiles still loading at the cap and reveals them together, not one by one', async () => {
  const decodes = new Map<HTMLImageElement, (() => void)[]>();
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {configurable: true, value: vi.fn(function(this: HTMLImageElement) {
    return new Promise<void>(resolve => decodes.set(this, [...(decodes.get(this) ?? []), resolve]));
  })});
  try {
    const tree = (folder: string, offset: number) => <AssetGallery layout="masonry" groupDates={false} items={[0, 1, 2].map(i => asset(i + offset))} scopeKey={scope(folder)}/>;
    const view = render(tree('old', 0)); animate.mockClear();
    view.rerender(tree('new', 10));
    const tiles = () => [...view.container.querySelectorAll<HTMLImageElement>('[data-gallery-cell] img')].filter(image => image.alt.startsWith('motion-1'));
    const held = () => tiles().filter(image => image.hasAttribute('data-reveal-hold')).length;
    await tick(16 + 250 + 17);
    // The swap itself does not wait past the cap, and it starts no animation.
    expect(view.container.querySelector('.asset-gallery__folder-snapshot')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    expect(tiles()).toHaveLength(3);
    expect(held()).toBe(3);
    const settle = (image: HTMLImageElement) => decodes.get(image)?.forEach(resolve => resolve());
    await act(async () => { settle(tiles()[0]); settle(tiles()[1]); });
    await tick(16);
    expect(held()).toBe(3);
    await act(async () => settle(tiles()[2]));
    await tick(16);
    expect(held()).toBe(0);
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  } finally { delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode; }
});
