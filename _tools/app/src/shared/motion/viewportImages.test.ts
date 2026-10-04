import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IMAGE_READY_CAP_MS, viewportImageDecoded, waitForViewportImages } from './viewportImages';

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
