import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { folderMoveEntrance } from "../assets/FolderWave";
import { waitForViewportImages } from "../shared/motion/viewportImages";

export const SERIES_SHELF_CAP_MS = 300;

/** Keep both real trees mounted: the prepared image elements become the shown ones. */
export function SeriesShelf({ scope, privacyKey, ready, children }: { scope: string; privacyKey: string; ready: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(scope);
  const [exiting, setExiting] = useState<{ scope: string; children: ReactNode } | null>(null);
  const retained = useRef({ scope, privacyKey, children });
  const host = useRef<HTMLDivElement>(null), next = useRef<HTMLDivElement>(null);
  const deadline = useRef(0), previous = useRef(scope);
  const animations = useRef<(Animation | null)[]>([]);
  const switching = shown !== scope && retained.current.privacyKey === privacyKey;
  if (!switching) retained.current = { scope, privacyKey, children };
  const publish = () => {
    if (switching && typeof next.current?.animate === "function") setExiting(retained.current);
    setShown(scope);
  };

  useLayoutEffect(() => {
    if (!switching && shown !== scope) { previous.current = scope; setShown(scope); }
  }, [scope, shown, switching]);

  useLayoutEffect(() => {
    animations.current.forEach(animation => { if (animation) { animation.onfinish = null; animation.cancel(); } });
    setExiting(null);
  }, [scope, privacyKey]);

  useLayoutEffect(() => {
    if (shown === scope) return;
    deadline.current = performance.now() + SERIES_SHELF_CAP_MS;
    // Bound image waiting, never publish incomplete folder/suggestion data.
  }, [scope, shown]);

  useLayoutEffect(() => {
    if (!switching || !ready || !next.current) return;
    return waitForViewportImages(next.current, publish, Math.max(0, deadline.current - performance.now()));
  }, [scope, switching, ready]);

  useLayoutEffect(() => {
    if (shown !== scope) return;
    if (previous.current !== scope) {
      animations.current.forEach(animation => animation?.cancel());
      const entrance = next.current ? folderMoveEntrance(next.current) : null;
      animations.current = [entrance];
      // The old paint stays opaque until the actual entrance finishes, not a wall-clock timer.
      if (entrance) entrance.onfinish = () => setExiting(null);
    }
    previous.current = scope;
  }, [shown, scope]);
  useLayoutEffect(() => () => animations.current.forEach(animation => { if (animation) { animation.onfinish = null; animation.cancel(); } }), []);

  return <div ref={host} className="series-browser__overview series-shelf">
    {switching && <div key={shown} inert>{retained.current.children}</div>}
    {!switching && exiting && <div key={exiting.scope} data-shelf-exit aria-hidden="true" inert
      style={{ pointerEvents: "none" }}>{exiting.children}</div>}
    <div key={scope} ref={next} data-motion-view="series-shelf" aria-hidden={switching || undefined} inert={switching || undefined}
      style={switching ? { position: "absolute", top: 0, left: 0, width: "100%", opacity: 0, pointerEvents: "none" } : undefined}>
      {children}
    </div>
  </div>;
}
