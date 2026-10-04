import { createContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { contentCross, EASE_STANDARD, reducedMotion } from './curves';
import { waitForViewportImages } from './viewportImages';
import { startViewSwap, viewTransitionsSupported, type ViewSwap } from './viewSwap';
import './areaMotion.css';
import './viewTransitions.css';

export const AreaVisible = createContext(true);
/** Portals outside the stage must follow the same paint boundary as the content. */
export const AreaPainted = createContext(true);
export const AreaRequested = createContext(true);
/** The area entrance includes its first batch; tiles must not start a second entrance. */
export const AreaEntering = createContext(false);
export const READY_CAP_MS = 1000;
/** Set on <html> while a desktop area swap owns the document's view transition. */
const AREA_VIEW_TRANSITION = 'data-area-view-transition';

/** Keep existing app wrappers compatible; entrance state now belongs to each visit. */
export function MotionScope({children}: {children: ReactNode}) {
  return children;
}

/** Ignore hidden retained subviews and privacy masks when looking for an initial load. */
export function viewReady(host: HTMLElement) {
  const visible = (element: Element) => !element.closest('[style*="display: none"]');
  return !Array.from(host.querySelectorAll('.library-content__deferred, .asset-browser__skeleton, .manga-card--skeleton, .notes-loading, [aria-busy="true"]:not(button), .ui-skeleton:not(.privacy-mask)'))
    .some(visible);
}

type Props = {
  activeKey: string;
  views: Record<string, ReactNode>;
  /** These surfaces already stay mounted in their owning app. */
  retained?: readonly string[];
  ready?: (host: HTMLElement, key: string) => boolean;
  /** Collection entry keeps the old shelf longer while the actual artwork commits. */
  waitForReady?: boolean;
  onShown?: (key: string) => void;
  /** Prepare the destination at its final width while the painted shell stays put. */
  incomingWidthDelta?: number;
  /** Keep the index entrance on the same image-ready frame. */
  onSettlingChange?: (settling: boolean) => void;
  /** The tablet's bottom tabs swap instantly (user 2026-10-04); readiness still holds the old view. */
  crossFade?: boolean;
  /** Desktop area swaps use browser snapshots when supported. */
  viewTransitions?: boolean;
  /**
   * A shared element of the outgoing and incoming view (a shelf item and its work-screen object):
   * when both are on screen, the browser snapshot morphs that one object between them while the
   * rest of the page swaps. Returns the element in `host` for view `key`, or null.
   */
  hero?: (key: string, host: HTMLElement) => HTMLElement | null;
};

/** Marks the one element captured as the shared object (`work-hero` in viewTransitions.css). */
export const VIEW_HERO_ATTRIBUTE = 'data-view-hero';
/** Only an element with a box inside the viewport is named; a hidden or scrolled-away one is not. */
function onScreen(element: HTMLElement | null): element is HTMLElement {
  const rect = element?.getBoundingClientRect();
  return !!rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

/** Preserve the actual old React/DOM tree until the incoming view commits its content. */
export function AreaSwitch({activeKey, views, retained = [], ready = viewReady, waitForReady = false, onShown, incomingWidthDelta = 0, onSettlingChange, crossFade = true, viewTransitions = false, hero}: Props) {
  const heroRef = useRef(hero); heroRef.current = hero;
  const [shown, setShown] = useState(activeKey);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const nodes = useRef(new Map<string, ReactNode>());
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const frozen = useRef<CSSProperties | null>(null);
  const shownRef = useRef(shown); shownRef.current = shown;
  const readyRef = useRef(ready); readyRef.current = ready;
  const onShownRef = useRef(onShown); onShownRef.current = onShown;
  const onSettlingRef = useRef(onSettlingChange); onSettlingRef.current = onSettlingChange;
  const visited = useRef(new Set([activeKey]));
  const checkRef = useRef<(() => void) | null>(null);
  const entrance = useRef<string | null>(null);
  const transition = useRef<{key: string; swap?: ViewSwap | null} | null>(null);
  /** The committed entrance; `started` turns true once its first frame may paint. */
  const running = useRef<{finish: (reveal?: boolean) => void; started: boolean; outgoing: string | null} | null>(null);
  // Freeze the outgoing props. It must keep its old content, active styling and scroll DOM.
  for (const [key, node] of Object.entries(views)) {
    if ((key !== shown || activeKey === shown) && key !== outgoing) nodes.current.set(key, node);
  }
  const keys = new Set([...(outgoing ? [outgoing] : []), shown, activeKey, ...retained.filter(key => nodes.current.has(key))]);
  for (const key of nodes.current.keys()) if (!keys.has(key)) nodes.current.delete(key);

  useLayoutEffect(() => {
    transition.current?.swap?.cancel();
    transition.current = null;
    document.documentElement.removeAttribute(AREA_VIEW_TRANSITION);
    const interrupted = running.current;
    interrupted?.finish(false);
    if (interrupted && !interrupted.started && interrupted.outgoing) {
      // Its images were still decoding behind the old view: that switch never painted.
      // Return to the painted view instead of flashing the abandoned one.
      shownRef.current = interrupted.outgoing;
      setShown(interrupted.outgoing);
    }
    if (activeKey === shownRef.current) return;
    const incoming = hosts.current.get(activeKey);
    if (!incoming) return;
    let finished = false, forced = false, frame = 0, cancelled = false;
    let stopImages: (() => void) | undefined;
    const browserTransition = crossFade && viewTransitions && viewTransitionsSupported();
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const commit = () => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      window.clearTimeout(cap);
      window.cancelAnimationFrame(frame);
      stopImages?.();
      if (browserTransition) {
        const entry: {key: string; swap?: ViewSwap | null} = {key: activeKey};
        transition.current = entry;
        // The shared object is named on the outgoing view for the old snapshot and on the incoming
        // view for the new one, never both at once; only when both are on screen, never under
        // reduced motion (then the page only cross-fades).
        const from = shownRef.current, outgoingHost = hosts.current.get(from), findHero = heroRef.current;
        let oldHero = findHero && outgoingHost && !reducedMotion() ? findHero(from, outgoingHost) : null;
        let newHero = oldHero ? findHero!(activeKey, incoming) : null;
        if (!onScreen(oldHero) || !onScreen(newHero) || oldHero === newHero) oldHero = newHero = null;
        oldHero?.setAttribute(VIEW_HERO_ATTRIBUTE, '');
        entry.swap = startViewSwap({attribute: AREA_VIEW_TRANSITION, value: oldHero ? 'hero' : '', commit: () => {
          // Abandoned requests must not commit (skipping still invokes the callback).
          if (cancelled) return;
          oldHero?.removeAttribute(VIEW_HERO_ATTRIBUTE);
          setShown(activeKey);
          visited.current.add(activeKey);
          onShownRef.current?.(activeKey);
          newHero?.setAttribute(VIEW_HERO_ATTRIBUTE, '');
        }});
        if (!entry.swap) oldHero?.removeAttribute(VIEW_HERO_ATTRIBUTE);
        void entry.swap?.finished.then(() => {
          oldHero?.removeAttribute(VIEW_HERO_ATTRIBUTE); newHero?.removeAttribute(VIEW_HERO_ATTRIBUTE);
          if (transition.current === entry) transition.current = null;
        });
        return;
      }
      const animate = crossFade && !forced && typeof incoming.animate === 'function';
      const previous = animate ? hosts.current.get(shownRef.current) : undefined;
      const rect = previous?.getBoundingClientRect();
      // Capture before any shell update; viewport coordinates survive the index moving the stage.
      frozen.current = rect ? {position: 'fixed', inset: 'auto', left: rect.left, top: rect.top,
        width: rect.width, height: rect.height, boxSizing: 'border-box', contain: 'layout paint size'} : null;
      entrance.current = animate ? activeKey : null;
      setSettling(animate);
      onSettlingRef.current?.(animate);
      setOutgoing(animate ? shownRef.current : null);
      setShown(activeKey);
      visited.current.add(activeKey);
      if (!animate) onShownRef.current?.(activeKey);
    };
    const start = () => {
      frame = 0;
      if (finished || (!forced && !readyRef.current(incoming, activeKey))) return;
      if (browserTransition && !forced) {
        // Decode at the destination width while the old content and shell still paint.
        if (!stopImages) {
          window.clearTimeout(cap); // Image decoding has its own 250ms cap after readiness.
          stopImages = waitForViewportImages(incoming, () => {
            stopImages = undefined;
            if (readyRef.current(incoming, activeKey)) commit();
            else {
              cap = window.setTimeout(() => { forced = true; check(); }, waitForReady ? READY_CAP_MS * 5 : READY_CAP_MS);
              check();
            }
          });
        }
        return;
      }
      commit();
    };
    const check = () => {
      if (finished) return;
      if (!forced && !readyRef.current(incoming, activeKey)) { window.cancelAnimationFrame(frame); frame = 0; return; }
      // Effects, shared observer setup and layout from the content commit get a rendering
      // opportunity before the atomic swap. The fallback's reduced-motion shortcut stays immediate.
      if (forced || (!browserTransition && ((retained.includes(activeKey) && visited.current.has(activeKey)) || reducedMotion() || typeof incoming.animate !== 'function'))) { window.cancelAnimationFrame(frame); start(); return; }
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(start);
      });
    };
    // A pending start survives further mutations (images settling, classes); start() re-checks readiness.
    const observer = new MutationObserver(check);
    observer.observe(incoming, {subtree: true, childList: true, attributes: true});
    checkRef.current = check;
    // Never leave an inert old view up; Collections waits longer for committed artwork, but never forever.
    let cap = window.setTimeout(() => { forced = true; check(); }, waitForReady ? READY_CAP_MS * 5 : READY_CAP_MS);
    check();
    const reduce = () => { if (query?.matches) check(); };
    query?.addEventListener?.('change', reduce);
    return () => {
      cancelled = true; finished = true; checkRef.current = null; observer.disconnect(); window.clearTimeout(cap);
      stopImages?.();
      window.cancelAnimationFrame(frame);
      query?.removeEventListener?.('change', reduce);
    };
  }, [activeKey]); // The readiness observer follows asynchronous child commits, not parent renders.

  useLayoutEffect(() => () => {
    transition.current?.swap?.cancel();
    transition.current = null;
    document.documentElement.removeAttribute(AREA_VIEW_TRANSITION);
  }, []);

  // Explicit readiness may change without a DOM mutation (e.g. an empty first page).
  useLayoutEffect(() => { checkRef.current?.(); });

  useLayoutEffect(() => {
    if (entrance.current !== shown) return;
    entrance.current = null;
    const incoming = hosts.current.get(shown);
    if (!incoming || typeof incoming.animate !== 'function') return;
    const previous = outgoing ? hosts.current.get(outgoing) : undefined;
    let frame = 0, timer = 0, animation: Animation | undefined, exit: Animation | undefined;
    let stopImages: (() => void) | undefined;
    const finish = (reveal = true) => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      stopImages?.();
      if (animation) { animation.onfinish = null; animation.cancel(); }
      exit?.cancel();
      incoming.style.willChange = '';
      if (previous) previous.style.willChange = '';
      frozen.current = null;
      if (reveal && !entry.started) onShownRef.current?.(shown);
      setSettling(false);
      onSettlingRef.current?.(false);
      setOutgoing(null);
      if (running.current === entry) running.current = null;
    };
    const entry = {finish, started: false, outgoing};
    running.current = entry;
    const start = () => {
      entry.started = true;
      const reduced = reducedMotion(), duration = reduced ? contentCross.reduced : 150;
      const easing = getComputedStyle(incoming).getPropertyValue("--ease-out").trim() || EASE_STANDARD;
      incoming.style.willChange = 'opacity';
      // Both views share the same opacity clock; the old view covers the first frame.
      animation = incoming.animate(
        [{opacity: 0}, {opacity: 1}],
        {duration, easing},
      );
      if (previous) {
        previous.style.willChange = 'opacity';
        exit = previous.animate([{opacity: 1}, {opacity: 0}],
          {duration, easing, fill: 'forwards'});
      }
      setSettling(false);
      onSettlingRef.current?.(false);
      onShownRef.current?.(shown);
      window.clearTimeout(timer);
      timer = window.setTimeout(finish, duration);
      animation.onfinish = () => finish();
    };
    frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(() => {
      // Final-width layout and visible-only thumbnail effects have committed before sampling.
      stopImages = waitForViewportImages(incoming, start);
    }); });
    // A suspended rendering loop must not strand the old inert surface.
    timer = window.setTimeout(finish, READY_CAP_MS);
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const cancel = () => { if (query?.matches) finish(); };
    query?.addEventListener?.('change', cancel);
    return () => {
      window.clearTimeout(timer); window.cancelAnimationFrame(frame);
      stopImages?.();
      if (animation) { animation.onfinish = null; animation.cancel(); }
      exit?.cancel();
      incoming.style.willChange = '';
      if (previous) previous.style.willChange = '';
      if (running.current === entry) running.current = null;
      query?.removeEventListener?.('change', cancel);
    };
  }, [shown]);

  return <div className="motion-stage" data-motion-active={activeKey} data-motion-shown={shown}>
    {[...keys].map(key => {
      const incoming = key === activeKey;
      const visible = key === shown;
      const painted = visible || key === outgoing;
      const interactive = incoming && visible && !settling;
      const preparing = incoming && (!visible || settling);
      // Opacity hides the whole pending subtree even if a descendant overrides visibility.
      // Keep its layout measurable; remove opacity at rest so fixed overlays stack against the app.
      return <div key={key} ref={element => { if (element) hosts.current.set(key, element); else hosts.current.delete(key); }}
        className="motion-stage__view" data-motion-view={key} inert={!interactive || undefined} aria-hidden={!interactive || undefined}
        style={{...(key === outgoing ? frozen.current : null),
          left: key === outgoing ? frozen.current?.left : preparing && incomingWidthDelta ? -incomingWidthDelta : undefined,
          width: key === outgoing ? frozen.current?.width : preparing && incomingWidthDelta ? `calc(100% + ${incomingWidthDelta}px)` : undefined,
          display: !painted && !incoming ? 'none' : undefined, visibility: painted ? undefined : 'hidden', opacity: !painted || (visible && settling) ? 0 : undefined,
          zIndex: outgoing ? visible ? 1 : 0 : undefined}}>
        <AreaPainted.Provider value={visible && !settling || key === outgoing && settling}><AreaRequested.Provider value={incoming}>
          <AreaEntering.Provider value={visible && (outgoing !== null || transition.current?.key === key)}><AreaVisible.Provider value={visible && incoming}>{nodes.current.get(key)}</AreaVisible.Provider></AreaEntering.Provider>
        </AreaRequested.Provider></AreaPainted.Provider>
      </div>;
    })}
  </div>;
}
