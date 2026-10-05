import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IMAGE_READY_CAP_MS, REVEAL_HOLD_ATTRIBUTE, revealTogether, viewportImageDecoded, waitForViewportImages } from './viewportImages';

const rect = (top = 0, height = 100) => ({top, bottom: top + height, left: 0, right: 100, width: 100, height, x: 0, y: top, toJSON() {}});
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div'); document.body.append(host);
  host.getBoundingClientRect = () => rect(0, 500);
});
afterEach(() => { host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
function thumbnail(top = 0) {
  const image = document.createElement('img'); image.src = '/thumbnail'; image.loading = 'lazy';
  image.getBoundingClientRect = () => rect(top); host.append(image);
  return image;
}

it('starts hidden first-viewport images without an IntersectionObserver delivery and waits for decode', async () => {
  host.style.opacity = '0'; host.style.visibility = 'hidden'; host.inert = true;
  const image = thumbnail(), offscreen = thumbnail(600), ready = vi.fn();
  let decode!: () => void;
  image.decode = vi.fn(() => new Promise<void>(resolve => { decode = resolve; }));
  offscreen.decode = vi.fn();
  const cancel = waitForViewportImages(host, ready);
  expect(image.loading).toBe('eager'); expect(image.decode).toHaveBeenCalledOnce();
  expect(offscreen.loading).toBe('lazy'); expect(offscreen.decode).not.toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
  decode(); await Promise.resolve();
  expect(viewportImageDecoded(image)).toBe(true);
  expect(ready).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  cancel();
});

it('caps a stalled decode at 250ms and lets the image continue loading afterwards', async () => {
  const image = thumbnail(), ready = vi.fn(); let decode!: () => void;
  image.decode = () => new Promise<void>(resolve => { decode = resolve; });
  waitForViewportImages(host, ready);
  await vi.advanceTimersByTimeAsync(IMAGE_READY_CAP_MS - 1); expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(ready).toHaveBeenCalledOnce();
  expect(image.loading).toBe('eager');
  decode(); await Promise.resolve(); expect(ready).toHaveBeenCalledOnce();
});

it('accepts the remaining time of a combined data/image deadline without changing the default cap', async () => {
  const image = thumbnail(), ready = vi.fn(); image.decode = () => new Promise<void>(() => {});
  waitForViewportImages(host, ready, 75);
  await vi.advanceTimersByTimeAsync(74); expect(ready).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(ready).toHaveBeenCalledOnce();
  expect(image.loading).toBe('eager');
});

it('cancels a superseded wait without clearing the live source or letting its decode start motion', async () => {
  const image = thumbnail(), ready = vi.fn(); let decode!: () => void;
  image.decode = () => new Promise<void>(resolve => { decode = resolve; });
  const cancel = waitForViewportImages(host, ready); cancel();
  decode(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(1000);
  expect(ready).not.toHaveBeenCalled(); expect(image.getAttribute('src')).toBe('/thumbnail');
  expect(vi.getTimerCount()).toBe(0);
});

it('tracks a replaced source and new viewport tiles within the original deadline', async () => {
  const image = thumbnail(), ready = vi.fn(), finishes: (() => void)[] = [];
  image.decode = () => new Promise<void>(resolve => finishes.push(resolve));
  waitForViewportImages(host, ready);
  image.src = '/replacement';
  expect(viewportImageDecoded(image)).toBe(false);
  const second = thumbnail(); let finishSecond!: () => void;
  second.decode = () => new Promise<void>(resolve => { finishSecond = resolve; });
  await Promise.resolve();
  finishes[0](); await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
  expect(viewportImageDecoded(image)).toBe(false);
  finishes[1](); await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
  expect(viewportImageDecoded(image)).toBe(true);
  finishSecond(); await Promise.resolve(); expect(ready).toHaveBeenCalledOnce();
});

it('uses load/error without decode and excludes snapshot copies and speculative spare slots', async () => {
  const image = thumbnail(), failed = thumbnail(), ready = vi.fn();
  const snapshot = document.createElement('div'); snapshot.className = 'asset-gallery__folder-snapshot';
  host.append(snapshot); snapshot.append(thumbnail());
  const spare = thumbnail(); spare.dataset.stableImageLoading = 'true';
  waitForViewportImages(host, ready);
  expect(spare.loading).toBe('lazy');
  expect(snapshot.querySelector('img')!.loading).toBe('lazy');
  image.dispatchEvent(new Event('load')); expect(ready).not.toHaveBeenCalled();
  failed.dispatchEvent(new Event('error')); expect(ready).toHaveBeenCalledOnce();
});

it('treats a decode rejection as settled so one broken image cannot block the entrance', async () => {
  const image = thumbnail(), ready = vi.fn(); image.decode = () => Promise.reject(new Error('broken'));
  waitForViewportImages(host, ready); await Promise.resolve();
  expect(viewportImageDecoded(image)).toBe(false);
  expect(ready).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('hands the images still loading at the cap to onLate, then reports ready', async () => {
  const done = thumbnail(), late = thumbnail(100), offscreen = thumbnail(600), order: string[] = [];
  done.decode = () => Promise.resolve();
  late.decode = () => new Promise<void>(() => {});
  offscreen.decode = () => new Promise<void>(() => {});
  waitForViewportImages(host, () => order.push('ready'), IMAGE_READY_CAP_MS, images => order.push(`late:${images.length}:${images[0] === late}`));
  await vi.advanceTimersByTimeAsync(IMAGE_READY_CAP_MS);
  expect(order).toEqual(['late:1:true', 'ready']);
});

it('does not call onLate when every viewport image decoded in time', async () => {
  const image = thumbnail(), onLate = vi.fn(), ready = vi.fn();
  image.decode = () => Promise.resolve();
  waitForViewportImages(host, ready, IMAGE_READY_CAP_MS, onLate);
  await vi.advanceTimersByTimeAsync(IMAGE_READY_CAP_MS);
  expect(ready).toHaveBeenCalledOnce(); expect(onLate).not.toHaveBeenCalled();
});

it('reveals late images together in one frame once the last one settles', async () => {
  const images = [thumbnail(), thumbnail(100), thumbnail(200)];
  const decodes = images.map(image => {
    let settle!: (failed?: boolean) => void;
    image.decode = () => new Promise<void>((resolve, reject) => { settle = failed => failed ? reject(new Error('404')) : resolve(); });
    return () => settle;
  });
  revealTogether(images, 750);
  const held = () => images.filter(image => image.hasAttribute(REVEAL_HOLD_ATTRIBUTE)).length;
  expect(held()).toBe(3);
  decodes[0]()(); decodes[2]()(true); await vi.advanceTimersByTimeAsync(32);
  expect(held()).toBe(3);
  decodes[1]()(); await Promise.resolve(); await Promise.resolve();
  expect(held()).toBe(3); // the reveal waits for the next frame, then flips all at once
  await vi.advanceTimersByTimeAsync(16);
  expect(held()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('reveals stalled late images together at the fail-safe cap, or when released', async () => {
  const images = [thumbnail(), thumbnail(100)];
  images.forEach(image => { image.decode = () => new Promise<void>(() => {}); });
  revealTogether(images, 750);
  await vi.advanceTimersByTimeAsync(749);
  expect(images.every(image => image.hasAttribute(REVEAL_HOLD_ATTRIBUTE))).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(images.some(image => image.hasAttribute(REVEAL_HOLD_ATTRIBUTE))).toBe(false);
  const other = thumbnail(); other.decode = () => new Promise<void>(() => {});
  const release = revealTogether([other], 750);
  release();
  expect(other.hasAttribute(REVEAL_HOLD_ATTRIBUTE)).toBe(false); expect(vi.getTimerCount()).toBe(0);
});
