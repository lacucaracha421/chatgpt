// Serialized into the WebView by WebDriver; no application hooks or IPC privileges.
export function installProbe() {
  window.__nativeCheckPerf?.dispose();
  let previous = null, frameId = null, active = null;
  const frames = [], longTasks = [], measures = [];
  const supported = globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask') ?? false;
  const appendTasks = entries => { for (const e of entries) longTasks.push({ startTime: e.startTime, duration: e.duration }); };
  const observer = supported ? new PerformanceObserver(list => appendTasks(list.getEntries())) : null;
  observer?.observe({ type: 'longtask', buffered: true });
  const frame = now => { if (previous !== null) frames.push(now - previous); previous = now; frameId = requestAnimationFrame(frame); };
  // Capture input before React, so app phases can be related to the real opening/navigation action.
  const actions = [];
  const input = event => {
    const target = event.target;
    if (event.type === 'dblclick' && target.closest?.('.asset-gallery__scroll [role="option"]')) actions.push({ name: 'viewer.open', at: performance.now() });
    if (event.type === 'keydown' && ['ArrowRight', 'ArrowLeft'].includes(event.key) && document.querySelector('.asset-viewer')) actions.push({ name: 'viewer.next', at: performance.now() });
    if (event.type === 'click' && target.closest?.('.workspace-rail button')?.textContent.trim() === '컬렉션') actions.push({ name: 'collections.open', at: performance.now() });
  };
  for (const type of ['dblclick', 'keydown', 'click']) document.addEventListener(type, input, true);
  window.__nativeCheckPerf = {
    start(name, motion) {
      frames.length = 0; measures.length = 0; actions.length = 0; previous = null;
      for (const entry of performance.getEntriesByType('measure')) if (entry.name.startsWith('w4:')) performance.clearMeasures(entry.name);
      active = { name, at: performance.now(), visibility: document.visibilityState };
      performance.mark(`${name}:start`);
      if (motion) frameId = requestAnimationFrame(frame);
    },
    mark(name) { performance.mark(name); },
    measure(name, from) { performance.mark(`${name}:end`); const entry = performance.measure(name, from, `${name}:end`); measures.push({ name, duration: entry.duration }); },
    stop() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      if (observer) appendTasks(observer.takeRecords());
      const end = performance.now();
      performance.mark(`${active.name}:end`);
      performance.measure(active.name, `${active.name}:start`, `${active.name}:end`);
      const appMeasures = performance.getEntriesByType('measure').filter(e => e.name.startsWith('w4:') && e.startTime >= active.at)
        .map(e => ({ name: e.name, startTime: e.startTime, duration: e.duration }));
      for (const entry of appMeasures) {
        const kind = entry.name === 'w4:viewer.request.visible' ? 'viewer.' : entry.name === 'w4:collections.list-to-first-cover.visible' ? 'collections.' : null;
        const action = kind && actions.findLast(a => a.name.startsWith(kind) && a.at <= entry.startTime);
        if (action) measures.push({ name: `w4:${action.name}-to-visible`, startTime: action.at, duration: entry.startTime + entry.duration - action.at });
      }
      return { durationMs: end - active.at, frames: [...frames], measures: [...measures, ...appMeasures],
        longTasksSupported: supported, longTasks: longTasks.filter(e => e.startTime >= active.at && e.startTime < end),
        heapBytes: performance.memory?.usedJSHeapSize ?? null, visibility: [active.visibility, document.visibilityState],
        navigation: performance.getEntriesByType('navigation').map(e => ({ domContentLoadedMs: e.domContentLoadedEventEnd, loadMs: e.loadEventEnd })) };
    },
    dispose() { for (const type of ['dblclick', 'keydown', 'click']) document.removeEventListener(type, input, true); observer?.disconnect(); if (frameId !== null) cancelAnimationFrame(frameId); }
  };
  return { userAgent: navigator.userAgent, timeOrigin: performance.timeOrigin, longTasksSupported: supported, heapSupported: !!performance.memory };
}

// A bounded local quiet window, visible decoded images and two animation frames. It is a
// repeatable operational definition of settled, not proof of native/background/network idle.
export function settleSurface(options, done) {
  const { selector, quietMs = 300, timeoutMs = 15000, requireImages = false, allowAlerts = false, ignoreBrokenSrc = null } = options;
  const start = performance.now();
  let changed = start, finished = false, observer = null, observed = null, deadline;
  const visible = el => {
    if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  };
  const finish = result => { if (finished) return; finished = true; clearTimeout(deadline); observer?.disconnect(); done(result); };
  const check = async () => {
    if (finished) return;
    if (performance.now() - start > timeoutMs) return finish({ error: `settle timeout: ${selector}` });
    const root = document.querySelector(selector);
    if (root && root !== observed) {
      observer?.disconnect(); observed = root; changed = performance.now();
      observer = new MutationObserver(() => { changed = performance.now(); });
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    if (root && visible(root)) {
      const images = [...root.querySelectorAll('img')].filter(visible);
      if (root.matches('img')) images.push(root);
      const busy = [root, ...root.querySelectorAll('[aria-busy="true"], [role="alert"], .ui-skeleton, .asset-gallery__loading')]
        .some(el => visible(el) && (el.getAttribute('aria-busy') === 'true' || (!allowAlerts && el.getAttribute('role') === 'alert') || el.classList.contains('ui-skeleton') || el.classList.contains('asset-gallery__loading')));
      if (!busy && (!requireImages || images.length > 0) && images.every(img => img.complete) && performance.now() - changed >= quietMs) {
        const expected = img => ignoreBrokenSrc && img.naturalWidth === 0 && img.src.includes(ignoreBrokenSrc);
        const broken = images.filter(img => img.naturalWidth === 0 && !expected(img)).length;
        if (broken) return finish({ error: `${broken} broken visible images: ${selector}` });
        try { await Promise.all(images.filter(img => !expected(img)).map(img => img.decode?.())); } catch { return finish({ error: `image decode failed: ${selector}` }); }
        const quietAt = changed;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (changed === quietAt) finish({ settledMs: performance.now() - start, images: images.length });
          else setTimeout(check, 25);
        }));
        return;
      }
    }
    setTimeout(check, 25);
  };
  // rAF is suspended in hidden windows. The independent deadline still resolves failures.
  deadline = setTimeout(() => finish({ error: `settle timeout: ${selector}` }), timeoutMs);
  check();
}

export function scrollSurface(options, done) {
  const el = document.querySelector(options.selector);
  if (!el || (options.pixels > 0 && el.scrollHeight <= el.clientHeight)) return done({ error: 'scroll surface missing or not scrollable' });
  const start = performance.now(), from = el.scrollTop, target = options.pixels;
  const frame = now => {
    const progress = Math.min(1, (now - start) / options.durationMs);
    el.scrollTop = from + target * progress;
    if (progress < 1) requestAnimationFrame(frame);
    else done({ from, to: el.scrollTop, scrollHeight: el.scrollHeight });
  };
  requestAnimationFrame(frame);
}
