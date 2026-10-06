import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense, useEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { preloadableTab, preloadTabsWhenIdle } from './preloadTabs';
import { AreaSwitch } from '../shared/motion/AreaSwitch';
import { waitForViewportImages } from '../shared/motion/viewportImages';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('rules out the image cap when there are no viewport images: readiness is synchronous', () => {
  vi.useFakeTimers();
  const ready = vi.fn();
  waitForViewportImages(document.createElement('div'), ready);
  expect(ready).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('reproduces the production Suspense retry throttle even with a warm import, and avoids it with the cached component', async () => {
  // act() flushes retries and hides this delay, so exercise the installed production renderer.
  const moduleUrl = pathToFileURL(resolve('src/app/preloadTabs.ts')).href;
  const script = `
    (async () => {
    const {JSDOM} = await import('jsdom');
    const dom = new JSDOM('<div id="root"></div>', {url: 'http://localhost'});
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    const React = await import('react');
    const {createRoot} = await import('react-dom/client');
    const {flushSync} = await import('react-dom');
    const {preloadableTab} = await import(${JSON.stringify(moduleUrl)});
    const root = createRoot(document.getElementById('root'));
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const results = [];
    for (const mode of ['cold', 'warm-lazy', 'warm-component']) {
      flushSync(() => root.render(React.createElement('div', null, 'Home')));
      await sleep(350);
      let committed;
      const Component = () => {
        React.useLayoutEffect(() => { committed = performance.now(); }, []);
        return React.createElement('b', null, 'Tab');
      };
      const load = () => new Promise(resolve => setTimeout(() => resolve({default: Component}), 5));
      let Tab;
      if (mode === 'warm-component') {
        const tab = preloadableTab(load); await tab.preload(); Tab = tab.View;
      } else {
        const promise = load(); if (mode === 'warm-lazy') await promise;
        Tab = React.lazy(() => promise);
      }
      const start = performance.now();
      flushSync(() => root.render(React.createElement(React.Suspense,
        {fallback: React.createElement('i', null, 'loading')}, React.createElement(Tab))));
      const synchronous = committed !== undefined;
      while (committed === undefined && performance.now() - start < 2000) await sleep(5);
      results.push({mode, synchronous, ms: Math.round(committed - start)});
    }
    root.unmount(); dom.window.close();
    const {parentPort} = await import('node:worker_threads');
    parentPort.postMessage(results);
    })();
  `;
  const worker = new Worker(script, {eval: true, env: {...process.env, NODE_ENV: 'production'}});
  const result = await new Promise<{mode: string; synchronous: boolean; ms: number}[]>((resolve, reject) => {
    worker.once('message', resolve); worker.once('error', reject);
  }).finally(() => worker.terminate());
  expect(result[0].ms).toBeGreaterThanOrEqual(250);
  expect(result[1].ms).toBeGreaterThanOrEqual(250);
  expect(result[2].synchronous).toBe(true);
}, 15000);

it('holds the old painted view until a cold tab resolves, then preserves state on rerender', async () => {
  let resolve!: (module: {default: typeof Content}) => void;
  const mounted = vi.fn();
  function Content() {
    const [count, setCount] = useState(0);
    useEffect(mounted, []);
    return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
  }
  const tab = preloadableTab(() => new Promise<{default: typeof Content}>(resolveModule => { resolve = resolveModule; }));
  const tree = (key: string) => <AreaSwitch activeKey={key} views={{[key]: key === 'home' ? <b>Home</b>
    : <Suspense fallback={<div className="library-content__deferred"/>}><tab.View/></Suspense>}}/>;
  const view = render(tree('home'));
  view.rerender(tree('notes'));
  expect(document.querySelector('[data-motion-view="home"]')).not.toHaveStyle({visibility: 'hidden'});
  expect(document.querySelector('[data-motion-view="notes"]')).toHaveStyle({visibility: 'hidden'});
  await act(async () => { resolve({default: Content}); });
  expect(document.querySelector('.motion-stage')).toHaveAttribute('data-motion-shown', 'notes');
  act(() => screen.getByRole('button').click());
  view.rerender(tree('notes'));
  expect(screen.getByRole('button')).toHaveTextContent('Count 1');
  expect(mounted).toHaveBeenCalledOnce();
});

it('preloads code once without mounting the tab or its data effects', async () => {
  const effect = vi.fn();
  const load = vi.fn(async () => ({default: () => { useEffect(effect, []); return <b>Ready</b>; }}));
  const tab = preloadableTab(load);
  await Promise.all([tab.preload(), tab.preload()]);
  expect(load).toHaveBeenCalledOnce();
  expect(effect).not.toHaveBeenCalled();
  render(<Suspense fallback={<b>Fallback</b>}><tab.View/></Suspense>);
  expect(screen.getByText('Ready')).toBeInTheDocument();
  expect(screen.queryByText('Fallback')).toBeNull();
});

it('surfaces a failed import on render', async () => {
  const error = new Error('chunk failed');
  const tab = preloadableTab(async () => { throw error; });
  await expect(tab.preload()).rejects.toBe(error);
  expect(() => tab.View({})).toThrow(error);
});

it('waits for Home readiness, uses separate idle opportunities, and cancels queued work', async () => {
  vi.useFakeTimers();
  let ready = false;
  const callbacks: IdleRequestCallback[] = [];
  const idle = vi.fn((callback: IdleRequestCallback) => { callbacks.push(callback); return callbacks.length; });
  const cancel = vi.fn();
  vi.stubGlobal('requestIdleCallback', idle); vi.stubGlobal('cancelIdleCallback', cancel);
  const loaders = [vi.fn(async () => {}), vi.fn(async () => {})];
  const stop = preloadTabsWhenIdle(loaders, () => ready);
  await vi.advanceTimersByTimeAsync(500);
  expect(idle).not.toHaveBeenCalled(); expect(loaders[0]).not.toHaveBeenCalled();
  ready = true; await vi.advanceTimersByTimeAsync(100);
  expect(idle).toHaveBeenCalledOnce(); expect(idle.mock.calls[0]).toHaveLength(1);
  callbacks[0]({didTimeout: false, timeRemaining: () => 50});
  await Promise.resolve(); await Promise.resolve();
  expect(loaders[0]).toHaveBeenCalledOnce(); expect(loaders[1]).not.toHaveBeenCalled();
  stop(); expect(cancel).toHaveBeenCalledWith(2);
  callbacks[1]({didTimeout: false, timeRemaining: () => 50});
  expect(loaders[1]).not.toHaveBeenCalled();
});

it('rechecks readiness at execution and continues after a failed speculative import with the timer fallback', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestIdleCallback', undefined);
  let ready = true;
  const loaders = [vi.fn(async () => { throw new Error('chunk failed'); }), vi.fn(async () => {})];
  const stop = preloadTabsWhenIdle(loaders, () => ready);
  ready = false; await vi.advanceTimersByTimeAsync(300);
  expect(loaders[0]).not.toHaveBeenCalled();
  ready = true; await vi.advanceTimersByTimeAsync(100);
  expect(loaders[0]).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(loaders[0]).toHaveBeenCalledOnce(); expect(loaders[1]).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(loaders[1]).toHaveBeenCalledOnce();
  stop(); expect(vi.getTimerCount()).toBe(0);
});
