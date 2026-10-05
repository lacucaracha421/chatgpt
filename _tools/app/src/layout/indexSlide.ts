import { reducedMotion } from "../shared/motion/curves";
import { cancelSegmentSwap, swapSegment } from "../shared/motion/viewSwap";

/** The sidebar width transition of a user show/hide in chrome.css (`.workspace-index-slot[data-toggling]`). */
export const INDEX_SLIDE_MS = 220;
/** Fallback when the slot's `transitionend` never arrives (an interrupted or skipped transition). */
const SETTLE_FALLBACK_MS = INDEX_SLIDE_MS + 40;
/** On `<html>` while the one relayout after a slide runs its content swap (chrome.css sizes the old frame). */
export const INDEX_SLIDE_ATTRIBUTE = "data-index-slide";
/** The content beside the sidebar (App.tsx); the titlebar above it keeps reflowing. */
const CONTENT_SELECTOR = ".library-content";

type Frozen = {
  content: HTMLElement;
  scroller: HTMLElement | null;
  /** Inline values restored on release. */
  width: string;
  overflowX: string;
  frozenWidth: number;
  slot: HTMLElement | null;
  timer: number | undefined;
  onEnd: ((event: TransitionEvent) => void) | null;
};

/**
 * A user show/hide of the 망가 sidebar (user, 2026-10-05). While the sidebar width slides, the content
 * beside it keeps its layout at the old width, so it moves as one piece with the sidebar edge in the
 * same frames as the width transition (no per-frame reflow, no column change, hit-testing stays
 * true). When the slide ends it lays out once for the new width inside the shared content swap
 * (`swapSegment`, no direction: the old frame fades out, the new one rises in). Reduced motion snaps.
 */
export function createIndexSlide() {
  const owner = {};
  let frozen: Frozen | null = null;
  const stopWaiting = () => {
    if (!frozen) return;
    window.clearTimeout(frozen.timer);
    if (frozen.onEnd) frozen.slot?.removeEventListener("transitionend", frozen.onEnd);
    frozen.timer = undefined;
    frozen.onEnd = null;
  };
  const release = () => {
    if (!frozen) return;
    stopWaiting();
    const { content, scroller, width, overflowX } = frozen;
    frozen = null;
    content.style.width = width;
    if (scroller) scroller.style.overflowX = overflowX;
  };
  const settle = () => {
    if (!frozen) return;
    stopWaiting();
    const { content, frozenWidth } = frozen;
    const next = content.parentElement?.getBoundingClientRect().width;
    // Back where it started (shown and hidden again mid-slide): nothing to lay out anew.
    if (next === undefined || Math.abs(next - frozenWidth) < 0.5) { release(); return; }
    const root = document.documentElement;
    root.setAttribute(INDEX_SLIDE_ATTRIBUTE, "");
    const swap = swapSegment(owner, { target: content, commit: release });
    if (!swap) { root.removeAttribute(INDEX_SLIDE_ATTRIBUTE); return; }
    void swap.finished.then(() => { if (!frozen) root.removeAttribute(INDEX_SLIDE_ATTRIBUTE); });
  };
  return {
    /** Call right after the toggle commits, while the slot's width transition is at its start. */
    start(navigation: HTMLElement | null, slot: HTMLElement | null) {
      if (reducedMotion()) return;
      // A swap from an earlier slide has not committed yet: the content is still frozen at its old layout.
      cancelSegmentSwap(owner);
      document.documentElement.removeAttribute(INDEX_SLIDE_ATTRIBUTE);
      if (!frozen) {
        const content = navigation?.parentElement?.querySelector<HTMLElement>(CONTENT_SELECTOR);
        if (!content) return;
        const frozenWidth = content.getBoundingClientRect().width;
        if (!(frozenWidth > 0)) return;
        // The frozen content may be wider than the shell while the sidebar opens; clip it instead of scrolling.
        const scroller = content.closest<HTMLElement>(".app-shell__content");
        frozen = { content, scroller, width: content.style.width, overflowX: scroller?.style.overflowX ?? "", frozenWidth, slot, timer: undefined, onEnd: null };
        content.style.width = `${frozenWidth}px`;
        if (scroller) scroller.style.overflowX = "hidden";
      }
      stopWaiting();
      const onEnd = (event: TransitionEvent) => { if (event.target === slot && event.propertyName === "width") settle(); };
      frozen.slot = slot;
      frozen.onEnd = onEnd;
      slot?.addEventListener("transitionend", onEnd);
      frozen.timer = window.setTimeout(settle, SETTLE_FALLBACK_MS);
    },
    /** An area switch or unmount: the content takes its width at once, without the swap. */
    stop() {
      cancelSegmentSwap(owner);
      release();
      document.documentElement.removeAttribute(INDEX_SLIDE_ATTRIBUTE);
    },
  };
}
