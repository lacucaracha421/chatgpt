import { useEffect } from "react";
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
      try {
        const result = await gateway.runDueCloudCaptureSync();
        if (active) onResult(result);
      } catch {
        // Network/configuration failures are retried by the next scheduled poll.
      } finally {
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
