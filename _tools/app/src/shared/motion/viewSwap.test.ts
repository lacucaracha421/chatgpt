import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cancelSegmentSwap, startViewSwap, swapSegment, viewTransitionRunning } from './viewSwap';

type Pending = { update: () => void; skip: ReturnType<typeof vi.fn>; finish(): void };
let pending: Pending[];
const owner = {};
const descriptor = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
function mockApi() {
  pending = [];
  Object.defineProperty(document, 'startViewTransition', {configurable: true, value: (update: () => void) => {
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const entry: Pending = {update, skip: vi.fn(), finish: () => finish()};
    pending.push(entry);
    return {ready: Promise.resolve(), finished, updateCallbackDone: Promise.resolve(), skipTransition: entry.skip} as unknown as ViewTransition;
  }});
}
beforeEach(() => { vi.stubGlobal('matchMedia', () => ({matches: false, addEventListener() {}, removeEventListener() {}})); });
afterEach(() => {
  document.body.replaceChildren();
  if (descriptor) Object.defineProperty(document, 'startViewTransition', descriptor); else Reflect.deleteProperty(document, 'startViewTransition');
  document.documentElement.removeAttribute('data-view-swap');
  document.documentElement.removeAttribute('data-area-view-transition');
  vi.unstubAllGlobals();
});

it('commits inside the snapshot callback and names only the target while it runs', async () => {
  mockApi();
  const target = document.createElement('div'), bar = document.createElement('div');target.append(bar);document.body.append(target);
  const commit = vi.fn();
  const swap = swapSegment(owner, {forward: false, target, still: bar, commit})!;
  // The old content stays painted: nothing commits before the browser has its old snapshot.
  expect(commit).not.toHaveBeenCalled();
  expect(document.documentElement.getAttribute('data-view-swap')).toBe('back');
  expect(target).toHaveAttribute('data-view-swap-target');
  expect(bar).toHaveAttribute('data-view-swap-still');
  expect(viewTransitionRunning()).toBe(true);
  pending[0].update();
  expect(commit).toHaveBeenCalledOnce();
  pending[0].finish(); await swap.finished;
  expect(document.documentElement).not.toHaveAttribute('data-view-swap');
  expect(target).not.toHaveAttribute('data-view-swap-target');
  expect(bar).not.toHaveAttribute('data-view-swap-still');
  expect(viewTransitionRunning()).toBe(false);
});

it('skips a running switch for a newer one and never applies the stale commit', async () => {
  mockApi();
  const first = vi.fn(), second = vi.fn(), target = document.createElement('div');document.body.append(target);
  swapSegment(owner, {forward: true, target, commit: first});
  swapSegment(owner, {forward: false, target, commit: second});
  expect(pending[0].skip).toHaveBeenCalledOnce();
  // Skipping still runs the old callback: its commit is dropped.
  pending[0].update(); pending[1].update();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  expect(document.documentElement.getAttribute('data-view-swap')).toBe('back');
  cancelSegmentSwap(owner);
  expect(pending[1].skip).toHaveBeenCalledOnce();
  expect(document.documentElement).not.toHaveAttribute('data-view-swap');
});

it('commits at once while another view transition owns the document', () => {
  mockApi();
  document.documentElement.setAttribute('data-area-view-transition', '');
  const commit = vi.fn(), target = document.createElement('div');document.body.append(target);
  expect(swapSegment(owner, {forward: true, target, commit})).toBeNull();
  expect(commit).toHaveBeenCalledOnce();
  expect(pending).toHaveLength(0);
});

it('lets an owner restart its own transition (the series shelf) without yielding to itself', () => {
  mockApi();
  const swap = startViewSwap({attribute: 'data-series-view-transition', value: 'forward', commit() {}})!;
  expect(viewTransitionRunning(swap)).toBe(false);
  expect(viewTransitionRunning()).toBe(true);
  swap.cancel();
  expect(document.documentElement).not.toHaveAttribute('data-series-view-transition');
});

it('without the API commits at once and slides the target by transform only (no blank or dim frame)', () => {
  Reflect.deleteProperty(document, 'startViewTransition');
  const target = document.createElement('div');document.body.append(target);
  const animate = vi.fn(); Object.defineProperty(target, 'animate', {value: animate});
  const commit = vi.fn();
  expect(startViewSwap({commit})).toBeNull();
  expect(swapSegment(owner, {forward: true, target, commit})).toBeNull();
  expect(commit).toHaveBeenCalledOnce();
  expect(animate.mock.calls[0][0]).toEqual([{transform: 'translateX(16px)'}, {transform: 'none'}]);
  expect(JSON.stringify(animate.mock.calls[0][0])).not.toContain('opacity');
  target.remove();
});
