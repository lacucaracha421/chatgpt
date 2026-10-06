import { createElement, type ComponentProps, type ComponentType } from 'react';

/** Cache the component too: an already fulfilled import Promise still suspends React.lazy. */
export function preloadableTab<T extends ComponentType<any>>(load: () => Promise<{default: T}>) {
  let component: T | undefined;
  let pending: Promise<void> | undefined;
  let failed = false;
  let failure: unknown;
  const preload = () => pending ??= load().then(module => {
    component = module.default;
  }, error => {
    failed = true;
    failure = error;
    throw error;
  });
  const View = (props: ComponentProps<T>) => {
    if (failed) throw failure;
    if (!component) throw preload();
    return createElement(component, props);
  };
  return {View, preload};
}

/** One code-only import per idle opportunity; no components mount or data requests run. */
export function preloadTabsWhenIdle(loaders: readonly (() => Promise<unknown>)[], ready: () => boolean) {
  let cancelled = false, index = 0, waits = 0;
  // Never poll forever: after ~10 s without a settled Home, preload on idle anyway.
  const settled = () => waits >= 100 || ready();
  let idle: number | undefined, timer: number | undefined;
  const schedule = () => {
    if (cancelled || index === loaders.length) return;
    if (!settled()) {
      waits++;
      timer = window.setTimeout(schedule, 100);
    } else if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(run);
    } else {
      timer = window.setTimeout(run, 100);
    }
  };
  const run = () => {
    idle = timer = undefined;
    if (cancelled) return;
    if (!settled()) { schedule(); return; }
    // A failed speculative import must not become an unhandled rejection.
    void loaders[index++]().catch(() => {}).then(schedule);
  };
  schedule();
  return () => {
    cancelled = true;
    if (idle !== undefined) window.cancelIdleCallback(idle);
    window.clearTimeout(timer);
  };
}
