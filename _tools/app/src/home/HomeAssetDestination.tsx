import { useContext, useEffect, useState, type ReactNode } from 'react';
import { AreaPainted, AreaRequested } from '../shared/motion/AreaSwitch';
import { DialogPortalContainer } from '../shared/ui/Dialog';
import { ViewerExit } from '../shared/viewer/useViewerMotion';

/**
 * An image opened from Home goes straight to its viewer and back. The viewer renders inside the
 * Assets area instead of over the page, so it stays hidden while the area prepares and the one area
 * switch reveals it (Home -> viewer, no gallery first). Closing it (`onExit`) switches back to Home
 * while the viewer is still up, so the gallery behind it never shows on the way back either.
 */
export function HomeAssetDestination({ active, onExit, children }: { active: boolean; onExit?: () => void; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const painted = useContext(AreaPainted);
  const requested = useContext(AreaRequested);
  const shown = painted && requested;
  useEffect(() => {
    // The viewer opened while the area was still inert, so focus could not enter it; arrow keys need it.
    if (active && shown && host && !host.contains(document.activeElement)) host.querySelector<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
  }, [active, shown, host]);
  return <DialogPortalContainer.Provider value={active ? host : null}><ViewerExit.Provider value={onExit ?? null}>
    {children}
    <div ref={setHost} className="home-asset-destination" />
  </ViewerExit.Provider></DialogPortalContainer.Provider>;
}
