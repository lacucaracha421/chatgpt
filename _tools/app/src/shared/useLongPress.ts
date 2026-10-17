import {useCallback,useEffect,useRef,type KeyboardEvent,type PointerEvent} from 'react';

/** One long press for the whole tablet (TABLET-STRUCT-001): hold this long, moving less than the slop. */
export const LONG_PRESS_MS = 450;
export const LONG_PRESS_MOVE_PX = 10;

/** A short tick when the hold fires. It needs the VIBRATE permission; without it, or on a device without a motor, nothing happens. */
function tick() {
  try { navigator.vibrate?.(10); } catch { /* No haptics here. */ }
}

/** Where the hold began: a host that wraps many targets resolves which one from this. */
export type LongPressStart = {target: EventTarget | null; x: number; y: number};

export type LongPressOptions = {
  onLongPress(start: LongPressStart): void;
  /** False turns the gesture off without unmounting the element (for example outside selection mode). */
  enabled?: boolean;
  /** A host that must keep one press alive at a time (several fingers) gets each press's `cancel`. */
  onStart?(cancel: () => void): void;
  onEnd?(cancel: () => void): void;
};

/**
 * Long press for any element: `bind` goes on it with `{...bind}`, and `click(handler)` wraps its click
 * handler so the click that follows the hold (or a drag past the slop) is swallowed once.
 * The system context menu is blocked while the gesture is on; Shift+F10 and the menu key run the same
 * action from the keyboard. Scrolling takes the touch away (pointercancel) and ends the press quietly.
 */
export function useLongPress({onLongPress, enabled = true, onStart, onEnd}: LongPressOptions) {
  const timer = useRef<number | null>(null), origin = useRef<LongPressStart | null>(null), swallow = useRef(false);
  const latest = useRef({onLongPress, onStart, onEnd});
  latest.current = {onLongPress, onStart, onEnd};
  const clear = useCallback(() => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    origin.current = null;
  }, []);
  /** Ends the press and swallows the click that may still follow. */
  const cancel = useCallback(() => { clear(); swallow.current = true; }, [clear]);
  useEffect(() => clear, [clear]);
  const bind = {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!enabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
      clear();
      origin.current = {target: event.target, x: event.clientX, y: event.clientY};
      swallow.current = false;
      latest.current.onStart?.(cancel);
      timer.current = window.setTimeout(() => {
        const start = origin.current;
        if (!start) return;
        origin.current = null; timer.current = null; swallow.current = true;
        tick();
        latest.current.onLongPress(start);
      }, LONG_PRESS_MS);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = origin.current;
      if (!start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVE_PX) { cancel(); latest.current.onEnd?.(cancel); }
    },
    onPointerUp() { clear(); latest.current.onEnd?.(cancel); },
    onPointerCancel() { cancel(); swallow.current = false; latest.current.onEnd?.(cancel); },
    onPointerLeave() { clear(); },
    onContextMenu(event: {preventDefault(): void}) { if (enabled) event.preventDefault(); },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (enabled && event.target === event.currentTarget && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
        event.preventDefault(); latest.current.onLongPress({target: event.target, x: 0, y: 0});
      }
    },
  };
  const click = <E,>(handler?: (event: E) => void) => (event: E) => {
    if (swallow.current) { swallow.current = false; return; }
    handler?.(event);
  };
  /** For a host that wraps children with their own click handlers: `onClickCapture={captureClick}` swallows the click that follows a hold before any of them sees it. */
  const captureClick = (event: {stopPropagation(): void; preventDefault(): void}) => {
    if (!swallow.current) return;
    swallow.current = false; event.stopPropagation(); event.preventDefault();
  };
  return {bind, click, captureClick, cancel};
}
