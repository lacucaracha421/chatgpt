import { nativeWorkload, useWorkloadProfile } from "./workloadProfile";
import { relayNativeAuthorityEvent } from "./nativeAuthorityEvents";
import {useEffect} from 'react';
import type {LibraryGateway} from '../library/types';

export const ALBUM_AUTHORITY_CHANGED_EVENT = 'lakomics-album-authority-changed';
const ALBUM_SYNC_INTERVAL_MS = 5_000;

/**
 * Album authority loop: flush first, then receive.
 *
 * The order is deliberate and differs from the bookmark loop. Album edits are
 * structural, so a received page must never replace a local edit the server has not
 * accepted or explicitly rejected — a rename that exists only locally is the user's
 * current intent. So a pass sends queued intents first, and only a pass that leaves
 * the queue empty receives. The native side reports that state as
 * `deferredToOutbox`, and this loop simply tries again on the next tick.
 */
export function useAlbumAuthoritySync(gateway: LibraryGateway, libraryRoot: string) {
  const { restricted } = useWorkloadProfile();
  useEffect(() => {
    if (nativeWorkload()) {
      return relayNativeAuthorityEvent("library://album-authority-changed", ALBUM_AUTHORITY_CHANGED_EVENT);
    }
    if (!gateway.reconcileAlbumAuthority || !gateway.flushAlbumOutbox) return;
    let active = true;
    let running = false;
    let lastRun = -Infinity;
    const run = async () => {
      if (!active || running || (restricted && Date.now() - lastRun < 60_000)) return;
      lastRun = Date.now();
      running = true;
      try {
        const flushed = await gateway.flushAlbumOutbox!();
        // A blocked queue means a structural conflict is waiting for the user, and the
        // receive half has nothing safe to do over it. Reporting it is enough here;
        // the conflict surface is a later batch.
        if (flushed.stopped) return;
        const received = await gateway.reconcileAlbumAuthority!();
        // Announce only when visible Album replica state actually changed. A pass that
        // merely rematerialized a withheld relation has already written `asset_albums`,
        // so React's cached gallery is stale even though no change row was applied.
        const changed =
          received.appliedChanges > 0 ||
          received.adoptedBaseline ||
          received.rematerializedMemberships > 0;
        if (changed) window.dispatchEvent(new Event(ALBUM_AUTHORITY_CHANGED_EVENT));
      } catch {
        // Durable cursors/outbox survive; retry on the next tick or foreground event.
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), restricted ? 60_000 : ALBUM_SYNC_INTERVAL_MS);
    window.addEventListener('online', run);
    window.addEventListener('focus', run);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', run);
      window.removeEventListener('focus', run);
    };
  }, [gateway, libraryRoot, restricted]);
}
