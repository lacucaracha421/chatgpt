import { useWorkloadProfile } from "./workloadProfile";
import {useEffect} from 'react';
import type {LibraryGateway} from '../library/types';

export const CLASSIFICATION_AUTHORITY_CHANGED_EVENT =
  'lakomics-classification-authority-changed';
const CLASSIFICATION_SYNC_INTERVAL_MS = 5_000;

/**
 * Classification authority loop: flush first, then receive.
 *
 * The order is deliberate and matches the Album loop rather than the bookmark one.
 * Classification edits are structural — `create X -> rename X -> move X` are ordered
 * and dependent — so a received page must never replace a local edit the server has not
 * accepted or explicitly rejected. A rename that exists only locally *is* the user's
 * current intent. So a pass sends queued intents first, and only a pass that leaves the
 * queue empty receives. The native side enforces the same rule for its own callers; this
 * loop simply avoids asking for a receive it already knows would be deferred.
 *
 * A stopped pass means the queue is blocked on a structural conflict that needs a user
 * decision, and receive has nothing safe to do over it, so the pass reports and waits.
 *
 * A pass announces itself only when it actually changed local visible state — an adopted
 * or re-based baseline, replayed change rows, or assignments that were projected once
 * their Asset appeared — because a poll that converged nothing must not churn the UI.
 */
export function useClassificationAuthoritySync(gateway: LibraryGateway, libraryRoot: string) {
  const { restricted } = useWorkloadProfile();
  useEffect(() => {
    if (!gateway.reconcileClassificationAuthority || !gateway.flushClassificationOutbox) return;
    let active = true;
    let running = false;
    let lastRun = -Infinity;
    const run = async () => {
      // Single-flight: a slow pass must not stack behind the interval or the
      // foreground events that can all fire together.
      if (!active || running || (restricted && Date.now() - lastRun < 60_000)) return;
      lastRun = Date.now();
      running = true;
      try {
        const flushed = await gateway.flushClassificationOutbox!();
        // A blocked queue means a structural conflict is waiting for the user. Sending
        // past it could deliver a command that depends on the unresolved one, and
        // receiving over it would hide it. Report and try again next tick.
        if (flushed.stopped) return;
        const received = await gateway.reconcileClassificationAuthority!();
        const changed =
          received.appliedChanges > 0 ||
          received.adoptedBaseline ||
          received.rematerializedAssignments > 0;
        if (changed) window.dispatchEvent(new Event(CLASSIFICATION_AUTHORITY_CHANGED_EVENT));
      } catch {
        // A failure is quiet by design: the durable cursor, revision caches and outbox
        // survive, and the next tick or foreground event retries from the same state.
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), restricted ? 60_000 : CLASSIFICATION_SYNC_INTERVAL_MS);
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
