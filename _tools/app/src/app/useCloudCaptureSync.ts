import { workloadPollDelay, getWorkloadProfile } from "./workloadProfile";
import { useEffect, useRef } from "react";
import type { IngestOutcome, LibraryGateway } from "../library/types";

const ACTIVE_POLL_INTERVAL_MS = 15_000;
const BACKGROUND_POLL_INTERVAL_MS = 60_000;
/** Safety poll while the native status watcher announces every capture. */
export const QUIET_FALLBACK_MS = 15 * 60_000;
const RESTRICTED_SPACING_MS = 60_000;

export function useCloudCaptureSync(
  gateway: LibraryGateway,
  libraryRoot: string,
  onResult: (
    result: Awaited<ReturnType<LibraryGateway["runDueCloudCaptureSync"]>>,
  ) => void,
) {
  // Effect replay cannot cancel a native poll that already consumed captures.
  // Its result must reach the current subscriber to wake video preparation.
  const subscriber = useRef<{
    gateway: LibraryGateway; libraryRoot: string; onResult: typeof onResult; active: boolean;
  } | null>(null);
  const inFlight = useRef<{
    gateway: LibraryGateway;
    libraryRoot: string;
    promise: ReturnType<LibraryGateway["runDueCloudCaptureSync"]>;
  } | null>(null);

  useEffect(() => {
    let active = true;
    const currentSubscriber = { gateway, libraryRoot, onResult, active: true };
    subscriber.current = currentSubscriber;
    let running = false;
    let lastRun = -Infinity;
    let timerId: number | undefined;
    let windowFocused = document.hasFocus();
    // The last poll said the inbox is empty and a live watcher will signal the next capture:
    // poll on `cloud://captures-pending` only, with a long safety interval.
    let quiet = false;
    let signalledWhileRunning = false;

    const pollIntervalMs = () =>
      quiet
        ? QUIET_FALLBACK_MS
        : document.visibilityState === "hidden" || !windowFocused
          ? BACKGROUND_POLL_INTERVAL_MS
          : workloadPollDelay(ACTIVE_POLL_INTERVAL_MS);
    const throttleRemaining = () =>
      getWorkloadProfile().restricted ? Math.max(0, lastRun + RESTRICTED_SPACING_MS - Date.now()) : 0;

    const clearTimer = () => {
      if (timerId === undefined) return;
      window.clearTimeout(timerId);
      timerId = undefined;
    };

    const run = async () => {
      if (!active || running || throttleRemaining() > 0) return;
      lastRun = Date.now();
      running = true;
      let request = inFlight.current;
      try {
        if (!request || request.gateway !== gateway || request.libraryRoot !== libraryRoot) {
          request = { gateway, libraryRoot, promise: gateway.runDueCloudCaptureSync(outcome => {
            const current = subscriber.current;
            if (current?.active && current.gateway === gateway && current.libraryRoot === libraryRoot) {
              current.onResult(committedCaptureResult(outcome));
            }
          }) };
          inFlight.current = request;
        }
        const result = await request.promise;
        quiet = result.signalsQuiet === true;
        if (active) onResult(result);
      } catch {
        // Network/configuration failures are retried by the next scheduled poll.
        quiet = false;
      } finally {
        if (inFlight.current === request) inFlight.current = null;
        running = false;
      }
    };

    const scheduleNext = () => {
      if (!active) return;
      clearTimer();
      timerId = window.setTimeout(() => {
        void runAndReschedule();
      }, pollIntervalMs());
    };

    const runAndReschedule = async () => {
      await run();
      if (signalledWhileRunning) {
        // The finished poll may have read the inbox before the signalled capture.
        signalledWhileRunning = false;
        handleSignal();
        return;
      }
      scheduleNext();
    };

    const triggerNow = () => {
      clearTimer();
      void runAndReschedule();
    };

    const handleSignal = () => {
      if (!active) return;
      if (running) {
        signalledWhileRunning = true;
        return;
      }
      const wait = throttleRemaining();
      if (wait === 0) {
        triggerNow();
        return;
      }
      clearTimer();
      timerId = window.setTimeout(() => {
        void runAndReschedule();
      }, wait);
    };

    // While quiet the watcher announces captures, so focus and visibility need no poll.
    const handleVisibilityChange = () => {
      if (!active || quiet) return;
      if (document.visibilityState === "hidden" || !windowFocused) {
        scheduleNext();
        return;
      }
      triggerNow();
    };

    const handleFocus = () => {
      windowFocused = true;
      if (!quiet && document.visibilityState !== "hidden") triggerNow();
    };

    const handleBlur = () => {
      windowFocused = false;
      if (!quiet) scheduleNext();
    };

    triggerNow();
    const unsubscribe = gateway.subscribeCloudCapturesPending?.(handleSignal);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      active = false;
      currentSubscriber.active = false;
      clearTimer();
      unsubscribe?.();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, [gateway, libraryRoot, onResult]);
}


/** UI invalidation: committed assets remain visible even when a remote ACK fails. */
function committedCaptureResult(outcome: IngestOutcome) {
  return {
    attempted: 0, acknowledged: 0, failed: 0,
    reviewPending: outcome.status === "review_pending" ? 1 : 0,
    added: outcome.status === "added" ? 1 : 0,
    videoAdded: outcome.status === "added" && outcome.asset.media.kind === "video" ? 1 : 0,
    classificationChanged: outcome.status === "exact_duplicate" && outcome.classificationChanged ? 1 : 0,
  };
}
