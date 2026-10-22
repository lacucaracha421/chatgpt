import {useEffect, useRef} from 'react';

/**
 * Android Back for an overlay the app shell does not know about (the pack opening sits on top of
 * Home, opened from inside a Home section; the folder drawer; action sheets). While one is open it
 * takes Back first and the shell's own handler never acts on the press, so Back closes only the
 * topmost overlay instead of also leaving Home, the folder or the app.
 *
 * Two listeners can see the press, and which one runs first depends on the WebView's ordering of
 * capturing and bubbling listeners at `window`. So neither order matters: the capturing listener
 * here and the shell's own handler both call `consumeOverlayBack`, the first caller closes the
 * top overlay and marks the event, and every later caller on the same event gets `true` back and
 * must do nothing. Overlays stack: the newest open one gets the press.
 */
const stack: {current: () => void}[] = [];
const consumed = new WeakSet<Event>();

/** True when this Back press belongs to an open overlay (closing the top one on first call). */
export function consumeOverlayBack(event?: Event): boolean {
  if (event && consumed.has(event)) return true;
  const top = stack[stack.length - 1];
  if (!top) return false;
  if (event) consumed.add(event);
  top.current();
  return true;
}

function onBack(event: Event) {
  if (consumeOverlayBack(event)) event.stopImmediatePropagation();
}

export function useAndroidBack(handler: () => void, enabled = true) {
  const entry = useRef({current: handler});
  entry.current.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const own = entry.current;
    if (!stack.length) window.addEventListener('lakomics-back', onBack, true);
    stack.push(own);
    return () => {
      const index = stack.indexOf(own);
      if (index >= 0) stack.splice(index, 1);
      if (!stack.length) window.removeEventListener('lakomics-back', onBack, true);
    };
  }, [enabled]);
}
