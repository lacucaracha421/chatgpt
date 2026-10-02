import { useLayoutEffect, type RefObject } from "react";
import { beginNativePhase, nativePerfEnabled } from "../shared/nativePerf";

const frontSelector = ".cs-front img, .collection-card__cover img:not(.physical-cover__shell)";
const assigned = new WeakMap<HTMLImageElement, { src: string; at: number }>();

/** Callback ref: timestamp the committed src without reading style/layout or requesting an image. */
export function collectionCoverSourceRef(image: HTMLImageElement | null) {
  if (!image || !nativePerfEnabled()) return;
  const src = image.getAttribute("src");
  if (src && assigned.get(image)?.src !== src) assigned.set(image, { src, at: performance.now() });
}

/** Kit-only observation. Loading/decode never waits for a cover to become visible. */
export function useCollectionCoverPerf(rootRef: RefObject<HTMLElement | null>, scope: string, items: unknown) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const phase = beginNativePhase("collections.list-to-first-cover");
    if (!phase) return;
    phase.mark("list-committed");
    let cancelled = false, finished = false, sourceSeen = false, responseSeen = false;
    let frame: number | undefined;
    let cancelPaint: (() => void) | undefined;
    const decoding = new WeakMap<HTMLImageElement, { src: string }>();
    const ready = new Map<HTMLImageElement, string>();
    const checkVisible = () => {
      frame = undefined;
      if (cancelled || finished || !ready.size) return;
      const bounds = root.getBoundingClientRect();
      for (const [image, src] of ready) {
        if (!root.contains(image) || image.getAttribute("src") !== src) { ready.delete(image); continue; }
        if (getComputedStyle(image).visibility === "hidden") continue;
        const rect = image.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= Math.max(bounds.top, 0)
          || rect.top >= Math.min(bounds.bottom, innerHeight) || rect.right <= Math.max(bounds.left, 0)
          || rect.left >= Math.min(bounds.right, innerWidth)) continue;
        finished = true;
        phase.mark("visible-ready");
        // This check is already at the first frame boundary; the next offers paint.
        const paint = requestAnimationFrame(() => {
          if (root.contains(image) && image.getAttribute("src") === src) phase.mark("visible");
          else { finished = false; scan(); }
        });
        cancelPaint = () => cancelAnimationFrame(paint);
        break;
      }
    };
    const scheduleVisible = () => {
      if (!cancelled && !finished && ready.size && frame === undefined) frame = requestAnimationFrame(checkVisible);
    };
    const seeSource = (image: HTMLImageElement) => {
      const src = image.getAttribute("src");
      if (!src || sourceSeen) return;
      sourceSeen = true;
      const commit = assigned.get(image);
      // Callback refs give commit-time timestamps for shelf/flat covers. Other surfaces are
      // explicitly reported as observed, never passed off as exact assignment timestamps.
      if (commit?.src === src) performance.measure("w4:collections.first-cover.src-assigned", { start: commit.at, end: commit.at });
      phase.mark("src-observed");
    };
    const loaded = (image: HTMLImageElement) => {
      seeSource(image);
      const src = image.getAttribute("src");
      if (decoding.get(image)?.src !== src) { decoding.delete(image); ready.delete(image); }
      if (!src || !image.complete || !image.naturalWidth || decoding.has(image)) return;
      const request = { src };
      decoding.set(image, request);
      phase.mark("loaded");
      // Custom-scheme Resource Timing is unavailable in some WebKit versions. These are
      // resource timestamps, not a second fetch; never put URLs or media IDs in mark names.
      const resources = performance.getEntriesByName(image.currentSrc || image.src, "resource");
      const resource = resources[resources.length - 1] as PerformanceResourceTiming | undefined;
      if (resource && resource.responseEnd > 0 && !responseSeen) {
        responseSeen = true;
        phase.mark("response-observed");
        performance.measure("w4:collections.first-cover.request-start", { start: resource.startTime, end: resource.startTime });
        performance.measure("w4:collections.first-cover.response-end", { start: resource.responseEnd, end: resource.responseEnd });
        if (resource.responseStart > 0) performance.measure("w4:collections.first-cover.response-start", { start: resource.responseStart, end: resource.responseStart });
        performance.measure("w4:collections.first-cover.resource", { start: resource.startTime, end: resource.responseEnd });
        performance.measure("w4:collections.first-cover.resource-to-loaded", { start: resource.responseEnd, end: performance.now() });
      }
      void Promise.resolve().then(() => image.decode?.()).then(() => {
        if (cancelled || finished || decoding.get(image) !== request || !root.contains(image) || image.getAttribute("src") !== src) return;
        ready.set(image, src);
        phase.mark("decoded");
        scheduleVisible();
      }, () => { /* Failed covers cannot complete the visible measurement. */ });
    };
    const scan = () => {
      if (cancelled || finished) return;
      root.querySelectorAll<HTMLImageElement>(frontSelector).forEach(loaded);
      scheduleVisible();
    };
    const onLoad = (event: Event) => {
      const image = event.target;
      if (!finished && image instanceof HTMLImageElement && image.matches(frontSelector)) loaded(image);
    };
    root.addEventListener("load", onLoad, true);
    root.addEventListener("scroll", scheduleVisible, { passive: true });
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "src", "class", "aria-hidden"] });
    scan();
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      cancelPaint?.(); observer.disconnect();
      root.removeEventListener("load", onLoad, true); root.removeEventListener("scroll", scheduleVisible);
      phase.cancel();
    };
  }, [rootRef, scope, items]);
}
