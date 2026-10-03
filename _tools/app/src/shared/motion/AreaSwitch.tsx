import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { EASE_SHEET, EASE_STANDARD, reducedMotion } from './curves';
import './areaMotion.css';

export const AreaVisible = createContext(true);
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
};

/** Preserve the actual old React/DOM tree until the incoming view commits its content. */
export function AreaSwitch({activeKey, views, retained = [], ready = viewReady}: Props) {
  const [shown, setShown] = useState(activeKey);
  const [arriving, setArriving] = useState<string | null>(null);
  const nodes = useRef(new Map<string, ReactNode>());
  const hosts = useRef(new Map<string, HTMLDivElement>());
  const shownRef = useRef(shown); shownRef.current = shown;
  const readyRef = useRef(ready); readyRef.current = ready;
  const checkRef = useRef<(() => void) | null>(null);
  // Freeze the outgoing props. It must keep its old content, active styling and scroll DOM.
  for (const [key, node] of Object.entries(views)) {
    if (key !== shown || activeKey === shown) nodes.current.set(key, node);
  }
  const keys = new Set([shown, activeKey, ...retained.filter(key => nodes.current.has(key))]);

  useLayoutEffect(() => {
    if (activeKey === shownRef.current) { setArriving(null); return; }
    const incoming = hosts.current.get(activeKey);
    if (!incoming) return;
    let finished = false, started = false, forced = false, timer = 0, frame = 0;
    const animations: Animation[] = [];
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const commit = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      setShown(activeKey);
      setArriving(null);
      for (const key of nodes.current.keys()) if (key !== activeKey && !retained.includes(key)) nodes.current.delete(key);
    };
    const start = () => {
      frame = 0;
      if (finished || started || (!forced && !readyRef.current(incoming, activeKey))) return;
      started = true; observer.disconnect();
      if (reducedMotion() || typeof incoming.animate !== 'function') { commit(); return; }
      setArriving(activeKey);
      animations.push(incoming.animate([{opacity: 0}, {opacity: 1}], {duration: 160, easing: EASE_STANDARD}));
      // Move the box (top/bottom), not a transform: a transformed view would become the containing
      // block of its fixed bars (the tablet scrubber), which then jump during the rise.
      animations.push(incoming.animate([{top: '12px', bottom: '-12px'}, {top: '0px', bottom: '0px'}], {duration: 380, easing: EASE_SHEET}));
      animations[0].onfinish = commit;
      // Some native webviews do not dispatch finish after backgrounding.
      timer = window.setTimeout(() => { animations[0]?.finish?.(); commit(); }, 160);
    };
    const check = () => {
      if (finished || started) return;
      if (!forced && !readyRef.current(incoming, activeKey)) { window.cancelAnimationFrame(frame); frame = 0; return; }
      // Effects, shared observer setup and layout from the content commit get a rendering
      // opportunity before the dissolve starts. Reduced motion and the readiness cap stay immediate.
      if (forced || reducedMotion() || typeof incoming.animate !== 'function') { window.cancelAnimationFrame(frame); start(); return; }
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(start);
      });
    };
    // A pending start survives further mutations (images settling, classes); start() re-checks readiness.
    const observer = new MutationObserver(check);
    observer.observe(incoming, {subtree: true, childList: true, attributes: true});
    checkRef.current = check;
    // Never leave an inert old view up: a view that stays busy switches after this cap.
    const cap = window.setTimeout(() => { forced = true; check(); }, READY_CAP_MS);
    check();
    const reduce = () => { if (query?.matches) { if (started) { animations.forEach(a => a.cancel()); commit(); } else check(); } };
    query?.addEventListener?.('change', reduce);
    return () => {
      finished = true; checkRef.current = null; observer.disconnect(); window.clearTimeout(timer); window.clearTimeout(cap);
      window.cancelAnimationFrame(frame);
      query?.removeEventListener?.('change', reduce);
      animations.forEach(a => a.cancel());
    };
  }, [activeKey]); // The readiness observer follows asynchronous child commits, not parent renders.

  // Explicit readiness may change without a DOM mutation (e.g. an empty first page).
  useLayoutEffect(() => { checkRef.current?.(); });

  return <div className="motion-stage" data-motion-active={activeKey} data-motion-shown={shown}>
    {[...keys].map(key => {
      const incoming = key === activeKey;
      const visible = key === shown || (incoming && arriving === key);
      const interactive = incoming && (activeKey === shown || arriving === key);
      // A stacking layer only while two views overlap: at rest, fixed overlays inside a view
      // (the collection work screen) must stack against the whole app, not inside this stage.
      return <div key={key} ref={element => { if (element) hosts.current.set(key, element); else hosts.current.delete(key); }}
        className="motion-stage__view" data-motion-view={key} inert={!interactive || undefined} aria-hidden={!interactive || undefined}
        style={{display: key !== shown && !incoming ? 'none' : undefined, visibility: visible ? undefined : 'hidden', zIndex: incoming && arriving === key ? 1 : undefined}}>
        <AreaVisible.Provider value={visible && incoming}>{nodes.current.get(key)}</AreaVisible.Provider>
      </div>;
    })}
  </div>;
}
