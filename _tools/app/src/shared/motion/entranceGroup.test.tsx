import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useFirstAppearance } from './useFirstAppearance';

// The artists index and its thumbnail grid: two parts of one screen that enter as one.
type Played = { part: string; at: number };
let played: Played[] = [];
const animate = vi.fn(function (this: HTMLElement, _frames: Keyframe[], _options?: KeyframeAnimationOptions) {
  const part = this.closest('[data-part]')!.getAttribute('data-part')!;
  return { cancel: vi.fn(), pause: vi.fn(), play: vi.fn(() => { played.push({ part, at: Date.now() }); }) };
});
let decode: Record<string, () => void> = {};
const box = { left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
beforeEach(() => {
  vi.useFakeTimers(); played = []; decode = {};
  vi.stubGlobal('CSS', { supports: () => false });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box);
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value(this: HTMLImageElement) { return new Promise<void>(resolve => { decode[this.getAttribute('src')!] = resolve; }); } });
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); animate.mockClear();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
});

function Part({ name, count, group = 'artists' }: { name: string; count: number; group?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useFirstAppearance(host, count, true, name, '.row', undefined, group);
  return <div ref={host} data-part={name}>{Array.from({ length: count }, (_, index) => <div key={index} className="row"><img src={`/${name}-${index}.png`} alt="" /></div>)}</div>;
}
const frames = async (ms: number) => { for (let left = ms; left > 0; left -= 16) await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(16, left)); }); };

it('holds both parts unseen until every part\'s first images decode, then starts them in the same frame', async () => {
  render(<><Part name="index" count={3} /><Part name="grid" count={2} /></>);
  // Held on the first frame: unseen (visibility, never an opacity fade) and offset.
  expect(animate.mock.calls[0][0]).toEqual([{ visibility: 'hidden', transform: 'translateY(8px) scale(.98)' }, { visibility: 'visible', transform: 'none' }]);
  expect(animate.mock.results.every(result => result.value.pause.mock.calls.length === 1)).toBe(true);
  for (const src of ['/index-0.png', '/index-1.png', '/index-2.png']) decode[src]();
  await frames(48);
  expect(played).toHaveLength(0); // The grid's thumbnails are not ready yet.
  for (const src of ['/grid-0.png', '/grid-1.png']) decode[src]();
  await frames(48);
  expect(played.map(entry => entry.part)).toEqual(['index', 'index', 'index', 'grid', 'grid']);
  expect(new Set(played.map(entry => entry.at)).size).toBe(1);
  // Matching timing: one duration, one easing family and a capped stagger for both parts.
  const options = animate.mock.calls.map(call => call[1] as KeyframeAnimationOptions);
  expect(new Set(options.map(option => option.duration))).toEqual(new Set([560]));
  expect(options.map(option => option.delay)).toEqual([0, 24, 48, 0, 24]);
});

it('starts at the image cap when a thumbnail never decodes', async () => {
  render(<><Part name="index" count={1} /><Part name="grid" count={1} /></>);
  await frames(240);
  expect(played).toHaveLength(0);
  await frames(32);
  expect(played.map(entry => entry.part)).toEqual(['index', 'grid']);
});

it('does not hold or move under reduced motion', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  render(<><Part name="index" count={2} /><Part name="grid" count={2} /></>);
  await frames(300);
  expect(animate).not.toHaveBeenCalled();
});
