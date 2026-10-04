import { flushSync } from 'react-dom';
import { reducedMotion } from './curves';
import './viewSwap.css';

/**
 * One browser view transition for a content swap, shared by the desktop area switch, the series
 * shelf and every category/segment switch on both clients.
 *
 * The caller keeps the old content painted until the new one is ready (data committed, first
 * viewport images decoded within their cap), then hands over `commit`. With the View Transitions
 * API, `commit` runs inside the snapshot callback through `flushSync`, so the old snapshot is the
 * last painted frame and the new one is the committed content: nothing blank or half-built paints.
 * `<html>` carries `attribute` (its value names the direction) and each `target` carries
 * `targetAttribute` while the transition runs, so CSS scopes the `view-transition-name`s.
 */
export type ViewSwap = {
  readonly attribute: string;
  /** Skips the transition; a callback that has not run yet does not commit (stale-commit guard). */
  cancel(): void;
  readonly finished: Promise<void>;
};
type Options = {
  /** `<html>` attribute while the swap runs; its value is the direction ("forward"/"back") or "". */
  attribute?: string;
  value?: string;
  /** Elements captured as the moving content; each gets `targetAttribute` while the swap runs. */
  target?: HTMLElement | readonly (HTMLElement | null | undefined)[] | null;
  targetAttribute?: string;
  /** Elements inside the target that stay put (a section bar): each is captured on its own. */
  still?: HTMLElement | readonly (HTMLElement | null | undefined)[] | null;
  commit(): void;
};

export const VIEW_SWAP_ATTRIBUTE = 'data-view-swap';
export const VIEW_SWAP_TARGET = 'data-view-swap-target';
export const VIEW_SWAP_STILL = 'data-view-swap-still';
/** Attributes whose presence on `<html>` means a view transition owns the document. */
const owners = new Set(['data-area-view-transition', 'data-series-view-transition', VIEW_SWAP_ATTRIBUTE]);
const running = new Set<ViewSwap>();

const list = (value: Options['target']) => (Array.isArray(value) ? value : [value]).filter((element): element is HTMLElement => !!element);

/** Whether a view transition (other than `except`) currently owns the document. */
export function viewTransitionRunning(except?: ViewSwap | null) {
  const root = document.documentElement;
  for (const attribute of owners) if (attribute !== except?.attribute && root.hasAttribute(attribute)) return true;
  for (const swap of running) if (swap !== except) return true;
  return false;
}

export function viewTransitionsSupported() {
  return typeof document.startViewTransition === 'function';
}

/**
 * Starts the transition, or returns null when the API is missing: then the caller commits
 * without it. It does not check `viewTransitionRunning`; callers decide what yields.
 */
export function startViewSwap({attribute = VIEW_SWAP_ATTRIBUTE, value = '', target, targetAttribute = VIEW_SWAP_TARGET, still, commit}: Options): ViewSwap | null {
  if (!viewTransitionsSupported()) return null;
  owners.add(attribute);
  const root = document.documentElement;
  const targets = list(target), stills = list(still);
  let cancelled = false, cleared = false, browser: ViewTransition | undefined;
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  const clear = () => {
    if (cleared) return;
    cleared = true;
    running.delete(swap);
    for (const element of targets) element.removeAttribute(targetAttribute);
    for (const element of stills) element.removeAttribute(VIEW_SWAP_STILL);
    // A newer swap under the same attribute owns it now.
    if (![...running].some(other => other.attribute === attribute)) root.removeAttribute(attribute);
    done();
  };
  const swap: ViewSwap = {
    attribute,
    cancel() { cancelled = true; browser?.skipTransition(); clear(); },
    finished,
  };
  running.add(swap);
  for (const element of targets) element.setAttribute(targetAttribute, '');
  for (const element of stills) element.setAttribute(VIEW_SWAP_STILL, '');
  root.setAttribute(attribute, value);
  browser = document.startViewTransition(() => {
    // skipTransition still invokes the callback; a superseded request must not commit.
    if (cancelled) return;
    flushSync(commit);
  });
  void browser.ready.catch(() => {}); // Skipping rejects ready but still applies the update.
  void browser.finished.then(clear, clear);
  return swap;
}

const segmentSwaps = new WeakMap<object, ViewSwap>();

/**
 * A category/segment switch (게임/만화/영화, 카탈로그/북마크, 전체/이미지/영상, 로컬/온라인): the old
 * content fades out in 90 ms while the new one enters 16 px from the side of travel over 240 ms on
 * the gentle spring (reduced motion: a 120 ms fade). A newer switch on the same `owner` skips the
 * running one, whose commit is dropped. With no connected target, while another view transition
 * owns the document, or without the API, `commit` runs at once; without the API the target slides in by transform only
 * (never from a blank or dim frame).
 */
export function swapSegment(owner: object, {forward, target, still, commit}: {/** Undefined: no direction (a search or filter change) — the new content rises in. */forward?: boolean; target?: HTMLElement | readonly (HTMLElement | null | undefined)[] | null; still?: Options['still']; commit(): void}) {
  const previous = segmentSwaps.get(owner);
  previous?.cancel();
  // Nothing on screen to move (a hidden or not yet mounted list): the switch is just a commit.
  if (!list(target).some(element => element.isConnected)) { commit(); return null; }
  if (viewTransitionsSupported()) {
    if (viewTransitionRunning()) { commit(); return null; }
    const swap = startViewSwap({value: forward === undefined ? 'rise' : forward ? 'forward' : 'back', target, still, commit})!;
    segmentSwaps.set(owner, swap);
    void swap.finished.then(() => { if (segmentSwaps.get(owner) === swap) segmentSwaps.delete(owner); });
    return swap;
  }
  commit();
  if (reducedMotion()) return null;
  for (const element of list(target)) {
    if (typeof element.animate !== 'function' || !element.isConnected) continue;
    element.animate([{transform: forward === undefined ? 'translateY(8px)' : `translateX(${forward ? 16 : -16}px)`}, {transform: 'none'}],
      {duration: forward === undefined ? 200 : 240, easing: getComputedStyle(element).getPropertyValue('--spring-gentle').trim() || 'cubic-bezier(.2,0,0,1)'});
  }
  return null;
}

/** Drops a pending segment swap of `owner` (an unmount or a navigation away). */
export function cancelSegmentSwap(owner: object) {
  segmentSwaps.get(owner)?.cancel();
  segmentSwaps.delete(owner);
}

const searchSwap = {};
/**
 * A search or filter applied or cleared: the shown results (`[data-search-results]`, the visible
 * ones) stay painted until `commit` has produced the new ones, then the old fade out in 90 ms and
 * the new rise 8 px into place over 200 ms (reduced motion: a 120 ms fade). Without results on
 * screen, or while another view transition runs, `commit` applies at once.
 */
export function swapSearchResults(commit: () => void) {
  // Shown results only: not in a retained/hidden view, an inert pending view or a closed screen.
  const target = Array.from(document.querySelectorAll<HTMLElement>('[data-search-results]')).filter(element =>
    !element.closest('[inert], [aria-hidden="true"], [style*="display: none"], [style*="visibility: hidden"]') && getComputedStyle(element).display !== 'none');
  return swapSegment(searchSwap, {target, commit});
}
