import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { reducedMotion } from './curves';
import './areaMotion.css';

export const AreaVisible = createContext(true);
/** Portals outside the stage must follow the same paint boundary as the content. */
export const AreaPainted = createContext(true);
export const AreaRequested = createContext(true);
export const READY_CAP_MS = 1000;
const AppearanceMemory = createContext<Set<string> | null>(null);

/** A library/connection lifetime, rather than a component mount or query lifetime. */
export function MotionScope({children}: {children: ReactNode}) {
  const memory = useRef(new Set<string>());
  return <AppearanceMemory.Provider value={memory.current}>{children}</AppearanceMemory.Provider>;
}
export function useAppearanceMemory() { return useContext(AppearanceMemory); }

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
  /** Reserve the destination content width while the outgoing shell still owns its sidebar. */
  incomingWidthDelta?: number;
};

/** Preserve the actual old React/DOM tree until the incoming view commits its content. */
export function AreaSwitch({activeKey, views, retained = [], ready = viewReady, waitForReady = false, onShown, incomingWidthDelta = 0}: Props) {
  const [shown, setShown] = useState(activeKey);
  const nodes = useRef(new Map<string, ReactNode>());
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const shownRef = useRef(shown); shownRef.current = shown;
  const readyRef = useRef(ready); readyRef.current = ready;
  const onShownRef = useRef(onShown); onShownRef.current = onShown;
  const visited = useRef(new Set([activeKey]));
  const checkRef = useRef<(() => void) | null>(null);
  // Freeze the outgoing props. It must keep its old content, active styling and scroll DOM.
  for (const [key, node] of Object.entries(views)) {
    if (key !== shown || activeKey === shown) nodes.current.set(key, node);
  }
  const keys = new Set([shown, activeKey, ...retained.filter(key => nodes.current.has(key))]);

  useLayoutEffect(() => {
    if (activeKey === shownRef.current) return;
    const incoming = hosts.current.get(activeKey);
    if (!incoming) return;
    let finished = false, forced = false, frame = 0;
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const commit = () => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      window.clearTimeout(cap);
      window.cancelAnimationFrame(frame);
      setShown(activeKey);
      visited.current.add(activeKey);
      onShownRef.current?.(activeKey);
      for (const key of nodes.current.keys()) if (key !== activeKey && !retained.includes(key)) nodes.current.delete(key);
    };
    const start = () => {
      frame = 0;
      if (finished || (!forced && !readyRef.current(incoming, activeKey))) return;
      commit();
    };
    const check = () => {
      if (finished) return;
      if (!forced && !readyRef.current(incoming, activeKey)) { window.cancelAnimationFrame(frame); frame = 0; return; }
      // Effects, shared observer setup and layout from the content commit get a rendering
      // opportunity before the atomic swap. Reduced motion and the readiness cap stay immediate.
      if (forced || (retained.includes(activeKey) && visited.current.has(activeKey)) || reducedMotion() || typeof incoming.animate !== 'function') { window.cancelAnimationFrame(frame); start(); return; }
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(start);
      });
    };
    // A pending start survives further mutations (images settling, classes); start() re-checks readiness.
    const observer = new MutationObserver(check);
    observer.observe(incoming, {subtree: true, childList: true, attributes: true});
    checkRef.current = check;
    // Never leave an inert old view up; Collections waits longer for committed artwork, but never forever.
    const cap = window.setTimeout(() => { forced = true; check(); }, waitForReady ? READY_CAP_MS * 5 : READY_CAP_MS);
    check();
    const reduce = () => { if (query?.matches) check(); };
    query?.addEventListener?.('change', reduce);
    return () => {
      finished = true; checkRef.current = null; observer.disconnect(); window.clearTimeout(cap);
      window.cancelAnimationFrame(frame);
      query?.removeEventListener?.('change', reduce);
    };
  }, [activeKey]); // The readiness observer follows asynchronous child commits, not parent renders.

  // Explicit readiness may change without a DOM mutation (e.g. an empty first page).
  useLayoutEffect(() => { checkRef.current?.(); });

  return <div className="motion-stage" data-motion-active={activeKey} data-motion-shown={shown}>
    {[...keys].map(key => {
      const incoming = key === activeKey;
      const visible = key === shown;
      const interactive = incoming && visible;
      // Opacity hides the whole pending subtree even if a descendant overrides visibility.
      // Keep its layout measurable; remove opacity at rest so fixed overlays stack against the app.
      return <div key={key} ref={element => { if (element) hosts.current.set(key, element); else hosts.current.delete(key); }}
        className="motion-stage__view" data-motion-view={key} inert={!interactive || undefined} aria-hidden={!interactive || undefined}
        style={{display: key !== shown && !incoming ? 'none' : undefined, visibility: visible ? undefined : 'hidden', opacity: visible ? undefined : 0,
          width: incoming && !visible && incomingWidthDelta ? `calc(100% ${incomingWidthDelta < 0 ? '-' : '+'} ${Math.abs(incomingWidthDelta)}px)` : undefined}}>
        <AreaPainted.Provider value={visible}><AreaRequested.Provider value={incoming}>
          <AreaVisible.Provider value={visible && incoming}>{nodes.current.get(key)}</AreaVisible.Provider>
        </AreaRequested.Provider></AreaPainted.Provider>
      </div>;
    })}
  </div>;
}
