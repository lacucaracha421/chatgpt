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
    let finished = false, started = false, forced = false, timer = 0;
    const animations: Animation[] = [];
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const commit = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      setShown(activeKey);
      setArriving(null);
      for (const key of nodes.current.keys()) if (key !== activeKey && !retained.includes(key)) nodes.current.delete(key);
    };
    const check = () => {
      if (started || (!forced && !readyRef.current(incoming, activeKey))) return;
      started = true; observer.disconnect();
      if (reducedMotion() || typeof incoming.animate !== 'function') { commit(); return; }
      setArriving(activeKey);
      animations.push(incoming.animate([{opacity: 0}, {opacity: 1}], {duration: 160, easing: EASE_STANDARD}));
      animations.push(incoming.animate([{transform: 'translateY(12px)'}, {transform: 'none'}], {duration: 380, easing: EASE_SHEET}));
      animations[0].onfinish = commit;
      // Some native webviews do not dispatch finish after backgrounding.
      timer = window.setTimeout(() => { animations[0]?.finish?.(); commit(); }, 160);
    };
    const observer = new MutationObserver(check);
    observer.observe(incoming, {subtree: true, childList: true, attributes: true});
    checkRef.current = check;
    // Never leave an inert old view up: a view that stays busy switches after this cap.
    const cap = window.setTimeout(() => { forced = true; check(); }, READY_CAP_MS);
    check();
    const reduce = () => { if (query?.matches && started) { animations.forEach(a => a.cancel()); commit(); } };
    query?.addEventListener?.('change', reduce);
    return () => {
      finished = true; checkRef.current = null; observer.disconnect(); window.clearTimeout(timer); window.clearTimeout(cap);
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
      return <div key={key} ref={element => { if (element) hosts.current.set(key, element); else hosts.current.delete(key); }}
        className="motion-stage__view" data-motion-view={key} inert={!interactive || undefined} aria-hidden={!interactive || undefined}
        style={{display: key !== shown && !incoming ? 'none' : undefined, visibility: visible ? undefined : 'hidden', zIndex: incoming ? 1 : 0}}>
        <AreaVisible.Provider value={visible && incoming}>{nodes.current.get(key)}</AreaVisible.Provider>
      </div>;
    })}
  </div>;
}
