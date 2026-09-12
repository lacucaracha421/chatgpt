import { useEffect, useRef } from "react";
import type { LibraryGateway } from "../library/types";

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
  const inFlight = useRef<{
    gateway: LibraryGateway;
    libraryRoot: string;
    promise: ReturnType<LibraryGateway["runDueCloudCaptureSync"]>;
  } | null>(null);

  useEffect(() => {
    let active = true;
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
          request = { gateway, libraryRoot, promise: gateway.runDueCloudCaptureSync() };
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
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, [gateway, libraryRoot, onResult]);
}
