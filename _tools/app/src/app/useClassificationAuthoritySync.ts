import {useEffect} from 'react';
import type {LibraryGateway} from '../library/types';

export const CLASSIFICATION_AUTHORITY_CHANGED_EVENT =
  'lakomics-classification-authority-changed';
const CLASSIFICATION_SYNC_INTERVAL_MS = 5_000;

/**
 * Classification authority receive loop.
 *
 * This batch (2B) is **receive only**, so unlike the Album loop there is no
 * flush-first step: there is no Classification outbox yet, and inventing a flush call
 * here would imply a send path that does not exist. 2B.1 adds the queue and the send
 * half together.
 *
 * A pass announces itself only when it actually changed local visible state — an
 * adopted or re-based baseline, replayed change rows, or assignments that were
 * projected once their Asset appeared — because a poll that converged nothing must not
 * churn the UI.
 */
export function useClassificationAuthoritySync(gateway: LibraryGateway, libraryRoot: string) {
  useEffect(() => {
    if (!gateway.reconcileClassificationAuthority) return;
    let active = true;
    let running = false;
    const run = async () => {
      // Single-flight: a slow pass must not stack behind the interval or the
      // foreground events that can all fire together.
      if (!active || running) return;
      running = true;
      try {
        const received = await gateway.reconcileClassificationAuthority!();
        const changed =
          received.appliedChanges > 0 ||
          received.adoptedBaseline ||
          received.rematerializedAssignments > 0;
        if (changed) window.dispatchEvent(new Event(CLASSIFICATION_AUTHORITY_CHANGED_EVENT));
      } catch {
        // A failure is quiet by design: the durable cursor and revision caches survive,
        // and the next tick or foreground event retries from the same state.
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), CLASSIFICATION_SYNC_INTERVAL_MS);
    window.addEventListener('online', run);
    window.addEventListener('focus', run);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', run);
      window.removeEventListener('focus', run);
    };
  }, [gateway, libraryRoot]);
}
