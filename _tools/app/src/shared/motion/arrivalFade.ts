import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { reducedMotion } from './curves';
import './arrivalFade.css';

/** Opacity-only fade length; keep equal to arrival-fade in arrivalFade.css. */
export const ARRIVAL_FADE_MS = 200;
/** A new tile that cannot show its thumbnail by now fades in anyway (the image then arrives on its own late fade). */
const ARRIVAL_WAIT_CAP_MS = 800;
/** An arrival is claimed by the tile that mounts for it; a tile mounting later (scrolled into view) is not an arrival. */
const ARRIVAL_CLAIM_MS = 600;

const NO_SCOPE = Symbol('no-scope');

type Observed = {
  scope: unknown;
  seen: Set<string>;
  baseline: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
  items: readonly unknown[] | null;
  fresh: Map<string, number>;
};

export type ArrivalTracker = {
  /** True once for an id that newly arrived (and not through paging); `claim` ends it. */
  isFresh(id: string): boolean;
  claim(id: string): void;
};

export type ArrivalOptions = {
  /** False while the grid is hidden, paused, sparse or has no stable scope: the baseline is dropped. */
  enabled: boolean;
  hasNext: boolean;
  hasPrevious: boolean;
};

const reset = (state: Observed) => {
  state.seen = new Set(); state.baseline = false; state.items = null; state.fresh.clear();
};

/**
 * Decides which items of a grid are new arrivals: ids not present in the previous render of the
 * same scope. A scope change (place, filter, sort) or a hidden area restarts the baseline without
 * arrivals, as does the grid's first batch (useFirstAppearance owns that), a list sharing no id
 * with the previous one, and ids that joined as a page: after the old items while the previous
 * render had a next page, or before them while it had a previous page.
 * Pure bookkeeping per render (idempotent, so StrictMode replays are harmless); "already shown" is
 * tracked per scope here, not per mounted tile, so a virtualized tile scrolled out and back never
 * animates again.
 */
export function useArrivals<T>(scope: unknown, items: readonly T[], idOf: (item: T) => string, options: ArrivalOptions): ArrivalTracker {
  const holder = useRef<{state: Observed; tracker: ArrivalTracker} | null>(null);
  if (!holder.current) {
    const state: Observed = {scope: NO_SCOPE, seen: new Set(), baseline: false, hasNext: false, hasPrevious: false, items: null, fresh: new Map()};
    holder.current = {state, tracker: {
      isFresh: id => (state.fresh.get(id) ?? 0) > Date.now(),
      claim: id => { state.fresh.delete(id); },
    }};
  }
  const {state} = holder.current;
  if (!options.enabled || reducedMotion()) {
    reset(state); state.scope = NO_SCOPE;
  } else if (state.scope !== scope) {
    reset(state); state.scope = scope;
    state.baseline = items.length > 0; state.items = items;
    state.seen = new Set(items.map(idOf));
  } else if (state.items !== items) {
    state.items = items;
    if (!state.baseline) {
      state.baseline = items.length > 0;
      state.seen = new Set(items.map(idOf));
    } else {
      const ids = items.map(idOf);
      const added: number[] = [];
      let first = -1, last = -1;
      ids.forEach((id, index) => {
        if (state.seen.has(id)) { if (first < 0) first = index; last = index; } else added.push(index);
      });
      if (first < 0 && ids.length) {
        state.seen = new Set(ids); // Nothing carried over: a different list, not a refresh of this one.
        state.fresh.clear();
      } else {
        const expires = Date.now() + ARRIVAL_CLAIM_MS;
        for (const index of added) {
          const paged = index > last ? state.hasNext : index < first ? state.hasPrevious : false;
          if (!paged) state.fresh.set(ids[index], expires);
          state.seen.add(ids[index]);
        }
      }
    }
  }
  state.hasNext = options.hasNext; state.hasPrevious = options.hasPrevious;
  return holder.current.tracker;
}

/**
 * Per tile: `wait` (transparent) from the tile's first render until its thumbnail is loaded and
 * decoded, then `in` (the 200 ms fade), then nothing. Whether the tile is an arrival is decided
 * once, on mount (`thumbnailPending`: the tile has no image element yet but will), so later renders and remounts never replay it. Reduced motion: no phase at all.
 */
export function useArrivalFade(tracker: ArrivalTracker | undefined, id: string, root: RefObject<HTMLElement | null>, thumbnailPending = false) {
  const [phase, setPhase] = useState<'wait' | 'in' | undefined>(() => tracker?.isFresh(id) && !reducedMotion() ? 'wait' : undefined);
  useLayoutEffect(() => { tracker?.claim(id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (phase !== 'wait') return;
    let live = true;
    const timers: number[] = [];
    const cleanups: (() => void)[] = [];
    const go = () => { if (live) setPhase('in'); };
    timers.push(window.setTimeout(go, ARRIVAL_WAIT_CAP_MS));
    if (thumbnailPending) return () => { live = false; timers.forEach(window.clearTimeout); }; // The image element does not exist yet; its arrival re-runs this effect.
    const images = Array.from(root.current?.querySelectorAll('img') ?? []).filter(image => !image.dataset.stableImageLoading);
    let remaining = images.length;
    const settled = () => { if (--remaining <= 0) go(); };
    for (const image of images) {
      const decoded = () => { if (typeof image.decode === 'function') void image.decode().then(settled, settled); else settled(); };
      if (image.complete && image.naturalWidth > 0) decoded();
      else {
        image.addEventListener('load', decoded, {once: true});
        image.addEventListener('error', settled, {once: true});
        cleanups.push(() => { image.removeEventListener('load', decoded); image.removeEventListener('error', settled); });
      }
    }
    if (!images.length) go();
    return () => { live = false; timers.forEach(window.clearTimeout); cleanups.forEach(run => run()); };
  }, [phase, root, thumbnailPending]);
  useEffect(() => {
    if (phase !== 'in') return;
    const timer = window.setTimeout(() => setPhase(undefined), ARRIVAL_FADE_MS + 60);
    return () => window.clearTimeout(timer);
  }, [phase]);
  return phase;
}
