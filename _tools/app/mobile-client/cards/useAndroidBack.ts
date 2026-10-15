import {useEffect, useRef} from 'react';

/**
 * Android Back for an overlay the app shell does not know about (the pack opening sits on top of
 * Home, opened from inside a Home section). While one is open it takes Back first and the shell's
 * own handler never sees the press, so Back closes the overlay instead of leaving Home or the app.
 *
 * The shell listens on `window` too; this listener is a capturing one, and at the target a
 * capturing listener runs before the shell's, so `stopImmediatePropagation` reaches it in time.
 * Overlays stack: the newest open one gets the press.
 */
const stack: {current: () => void}[] = [];
function onBack(event: Event) {
  const top = stack[stack.length - 1];
  if (!top) return;
  event.stopImmediatePropagation();
  top.current();
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
