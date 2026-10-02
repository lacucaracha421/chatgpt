import { useCallback, useLayoutEffect, useRef } from "react";

// Tile event handlers keep their identity while calling the latest committed gallery action.
// Preserve absence too: optional actions control affordances and click routing.
export function useGalleryEvent<Args extends unknown[]>(handler: (...args: Args) => void): (...args: Args) => void;
export function useGalleryEvent<Args extends unknown[]>(handler: ((...args: Args) => void) | undefined): ((...args: Args) => void) | undefined;
export function useGalleryEvent<Args extends unknown[]>(handler: ((...args: Args) => void) | undefined) {
  const latest = useRef(handler);
  useLayoutEffect(() => { latest.current = handler; });
  const stable = useCallback((...args: Args) => latest.current?.(...args), []);
  return handler ? stable : undefined;
}
