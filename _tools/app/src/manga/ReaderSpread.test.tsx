import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReaderSpread } from "./ReaderSpread";

afterEach(() => { cleanup(); document.querySelector('[data-reader-test-style]')?.remove(); vi.restoreAllMocks(); });

it("keeps the painted spread above the same decoded pending image through two paint frames", async () => {
  const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: string): string }>("node:fs");
  const css = readFileSync("src/styles/global.css", "utf8");
  const style = document.createElement('style');
  style.dataset.readerTestStyle = '';
  style.textContent = css.slice(css.indexOf('.manga-viewer__buffers {'), css.indexOf('.manga-viewer__spread--double'));
  document.head.append(style);
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  const frame = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); });
  let finishDecode!: () => void;
  const { container, rerender } = render(<ReaderSpread identity="1"><img src="page-1" alt="one" /></ReaderSpread>);
  const old = container.querySelector('img')!;
  rerender(<ReaderSpread identity="2"><img src="page-2" alt="two" /></ReaderSpread>);
  const pending = container.querySelector<HTMLImageElement>('[data-reader-buffer="pending"] img')!;
  expect(old.closest('[data-reader-buffer]')).toHaveAttribute('data-reader-buffer', 'active');
  expect(pending.closest('[data-reader-buffer]')).toHaveAttribute('inert');
  Object.defineProperties(pending, {
    complete: { value: true }, naturalWidth: { value: 100 },
    decode: { value: vi.fn(() => new Promise<void>(resolve => { finishDecode = resolve; })) },
  });
  fireEvent.load(pending);
  frame();
  expect(old.closest('[data-reader-buffer]')).toHaveAttribute('data-reader-buffer', 'active');
  await act(async () => finishDecode());
  frame();
  expect(container.querySelector('[data-reader-buffer="active"] img')).toBe(pending);
  expect(old.closest('[data-reader-buffer]')).toHaveAttribute('data-reader-buffer', 'retiring');
  expect(old.closest('[data-reader-buffer]')).toHaveAttribute('aria-hidden', 'true');
  const retiring = old.closest('[data-reader-buffer]')!;
  const active = pending.closest('[data-reader-buffer]')!;
  expect(Number(getComputedStyle(retiring).zIndex)).toBeGreaterThan(Number(getComputedStyle(active).zIndex));
  expect(getComputedStyle(retiring).pointerEvents).toBe('none');
  frame();
  expect(document.contains(old)).toBe(true);
  frame();
  expect(document.contains(old)).toBe(false);
});

it("abandons an older pending decode when a newer page is requested", async () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  const { container, rerender } = render(<ReaderSpread identity="1"><img src="page-1" /></ReaderSpread>);
  rerender(<ReaderSpread identity="2"><img src="page-2" /></ReaderSpread>);
  const oldPending = container.querySelector<HTMLImageElement>('[data-reader-buffer="pending"] img')!;
  let finish!: () => void;
  Object.defineProperties(oldPending, { complete: { value: true }, naturalWidth: { value: 100 }, decode: { value: () => new Promise<void>(resolve => { finish = resolve; }) } });
  fireEvent.load(oldPending);
  rerender(<ReaderSpread identity="3"><img src="page-3" /></ReaderSpread>);
  await act(async () => finish());
  expect(container.querySelector('[data-reader-buffer="active"] img')).toHaveAttribute('src', 'page-1');
  expect(container.querySelector('[data-reader-buffer="pending"] img')).toHaveAttribute('src', 'page-3');
});

it("waits for both pages of a spread and accepts a committed error fallback", async () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  let callback: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(frame => { callback = frame; return 1; });
  const { container, rerender } = render(<ReaderSpread identity="1"><img src="page-1" /></ReaderSpread>);
  const fallback = vi.fn();
  rerender(<ReaderSpread identity="2-3"><img src="page-2" /><img src="page-3" onError={fallback} /></ReaderSpread>);
  const images = container.querySelectorAll<HTMLImageElement>('[data-reader-buffer="pending"] img');
  Object.defineProperties(images[0], { complete: { value: true }, naturalWidth: { value: 100 }, decode: { value: () => Promise.resolve() } });
  fireEvent.load(images[0]);
  await act(async () => {});
  expect(callback).toBeUndefined();
  Object.defineProperties(images[1], { complete: { value: true }, naturalWidth: { value: 100 }, decode: { value: () => Promise.reject(new Error('decode')) } });
  await act(async () => fireEvent.load(images[1]));
  expect(fallback).toHaveBeenCalledOnce();
  expect(callback).toBeUndefined();
  rerender(<ReaderSpread identity="2-3"><img src="page-2" /><span>3페이지를 불러오지 못했습니다</span></ReaderSpread>);
  await act(async () => {});
  act(() => callback!(0));
  expect(container.querySelector('[data-reader-buffer="active"]')).toHaveTextContent('3페이지를 불러오지 못했습니다');
});
