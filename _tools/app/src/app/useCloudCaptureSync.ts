import { useEffect, useRef } from "react";
import type { IngestOutcome, LibraryGateway } from "../library/types";

const ACTIVE_POLL_INTERVAL_MS = 15_000;
const BACKGROUND_POLL_INTERVAL_MS = 60_000;

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
    let timerId: number | undefined;
    let windowFocused = document.hasFocus();

    const pollIntervalMs = () =>
      document.visibilityState === "hidden" || !windowFocused
        ? BACKGROUND_POLL_INTERVAL_MS
        : ACTIVE_POLL_INTERVAL_MS;

    const clearTimer = () => {
      if (timerId === undefined) return;
      window.clearTimeout(timerId);
      timerId = undefined;
    };

    const run = async () => {
      if (!active || running) return;
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
        if (active) onResult(result);
      } catch {
        // Network/configuration failures are retried by the next scheduled poll.
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
      scheduleNext();
    };

    const triggerNow = () => {
      clearTimer();
      void runAndReschedule();
    };

    const handleVisibilityChange = () => {
      if (!active) return;
      if (document.visibilityState === "hidden" || !windowFocused) {
        scheduleNext();
        return;
      }
      triggerNow();
    };

    const handleFocus = () => {
      windowFocused = true;
      if (document.visibilityState !== "hidden") triggerNow();
    };

    const handleBlur = () => {
      windowFocused = false;
      scheduleNext();
    };

    triggerNow();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      active = false;
      currentSubscriber.active = false;
      clearTimer();
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
