import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { waitForViewportImages } from "../shared/motion/viewportImages";

export const SERIES_SHELF_CAP_MS = 300;

/**
 * Keep both real trees mounted: the prepared image elements become the shown ones. The old shelf
 * stays until the next one's data and viewport images are ready (capped), then the next one
 * replaces it in one step, without animation (user 2026-10-05).
 */
export function SeriesShelf({ scope, privacyKey, ready, hidden = false, children }: { scope: string; privacyKey: string; ready: boolean; hidden?: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(scope);
  const retained = useRef({ scope, privacyKey, children });
  const next = useRef<HTMLDivElement>(null);
  const deadline = useRef(0);
  const switching = shown !== scope && retained.current.privacyKey === privacyKey;
  if (!switching) retained.current = { scope, privacyKey, children };

  useLayoutEffect(() => {
    if (!switching && shown !== scope) setShown(scope);
  }, [scope, shown, switching]);

  useLayoutEffect(() => {
    if (shown === scope) return;
    deadline.current = performance.now() + SERIES_SHELF_CAP_MS;
    // Bound image waiting, never publish incomplete folder/suggestion data.
  }, [scope, shown]);

  useLayoutEffect(() => {
    if (!switching || !ready || !next.current) return;
    return waitForViewportImages(next.current, () => setShown(scope), Math.max(0, deadline.current - performance.now()));
  }, [scope, switching, ready]);

  return <div className="series-browser__overview series-shelf" style={hidden ? { display: 'none' } : undefined}>
    {switching && <div key={shown} inert>{retained.current.children}</div>}
    <div key={scope} ref={next} data-motion-view="series-shelf" aria-hidden={switching || undefined} inert={switching || undefined}
      style={switching ? { position: "absolute", top: 0, left: 0, width: "100%", opacity: 0, pointerEvents: "none" } : undefined}>
      {children}
    </div>
  </div>;
}
