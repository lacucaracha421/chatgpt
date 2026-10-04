import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { folderMoveEntrance } from "../assets/FolderWave";
import { waitForViewportImages } from "../shared/motion/viewportImages";
import { startViewSwap, viewTransitionRunning, viewTransitionsSupported, type ViewSwap } from "../shared/motion/viewSwap";

export const SERIES_SHELF_CAP_MS = 300;
/** Set on <html> while the shelf owns the document's view transition: "forward" | "back". */
export const SERIES_VIEW_TRANSITION_ATTRIBUTE = "data-series-view-transition";
const SHELF_ATTRIBUTE = "data-series-shelf-transition";
type BrowserSwap = { scope: string; swap?: ViewSwap | null };

/** Back = the new path is a strict prefix of the old one (group → its series); siblings move forward. */
const movesBack = (from: readonly string[] | undefined, to: readonly string[] | undefined) =>
  Boolean(from && to && to.length < from.length && to.every((part, index) => from[index] === part));

/** Keep both real trees mounted: the prepared image elements become the shown ones. */
export function SeriesShelf({ scope, path, privacyKey, ready, children }: { scope: string; path?: readonly string[]; privacyKey: string; ready: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(scope);
  const [exiting, setExiting] = useState<{ scope: string; children: ReactNode } | null>(null);
  const retained = useRef({ scope, path, privacyKey, children });
  const host = useRef<HTMLDivElement>(null), next = useRef<HTMLDivElement>(null);
  const deadline = useRef(0), previous = useRef(scope);
  const animations = useRef<(Animation | null)[]>([]);
  const swap = useRef<BrowserSwap | null>(null);
  /** The commit already moved through a browser snapshot (or must stay instant): no custom entrance. */
  const instant = useRef(false);
  const switching = shown !== scope && retained.current.privacyKey === privacyKey;
  if (!switching) retained.current = { scope, path, privacyKey, children };
  const publish = () => {
    const element = host.current;
    if (element && viewTransitionsSupported() && !clipped(element)) {
      if (viewTransitionRunning(swap.current?.swap)) {
        // One view transition per document: the area entrance already moves this content.
        instant.current = true;
        setShown(scope);
        return;
      }
      if (swap.current?.scope === scope) return; // Already requested; its callback commits.
      endSwap();
      const entry: BrowserSwap = { scope };
      swap.current = entry;
      // A superseded request is cancelled through the swap, which then never commits.
      entry.swap = startViewSwap({ attribute: SERIES_VIEW_TRANSITION_ATTRIBUTE, value: movesBack(retained.current.path, path) ? "back" : "forward",
        target: element, targetAttribute: SHELF_ATTRIBUTE, commit: () => { instant.current = true; setShown(entry.scope); } });
      void entry.swap?.finished.then(() => { if (swap.current === entry) swap.current = null; });
      return;
    }
    if (switching && typeof next.current?.animate === "function") setExiting(retained.current);
    setShown(scope);
  };
  const endSwap = () => {
    const entry = swap.current;
    if (!entry) return;
    swap.current = null;
    entry.swap?.cancel();
  };

  useLayoutEffect(() => {
    if (!switching && shown !== scope) { previous.current = scope; setShown(scope); }
  }, [scope, shown, switching]);

  useLayoutEffect(() => {
    // A new request interrupts the running shelf transition before anything else commits.
    endSwap();
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
    if (previous.current !== scope && !instant.current) {
      animations.current.forEach(animation => animation?.cancel());
      const entrance = next.current ? folderMoveEntrance(next.current) : null;
      animations.current = [entrance];
      // The old paint stays opaque until the actual entrance finishes, not a wall-clock timer.
      if (entrance) entrance.onfinish = () => setExiting(null);
    }
    instant.current = false;
    previous.current = scope;
  }, [shown, scope]);
  useLayoutEffect(() => () => {
    endSwap();
    animations.current.forEach(animation => { if (animation) { animation.onfinish = null; animation.cancel(); } });
  }, []);

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

/** A named snapshot paints above its scroller; a shelf scrolled under the toolbar keeps the in-place path. */
function clipped(element: HTMLElement) {
  const scroller = element.closest(".asset-gallery__scroll");
  return Boolean(scroller && element.getBoundingClientRect().top < scroller.getBoundingClientRect().top - 0.5);
}
