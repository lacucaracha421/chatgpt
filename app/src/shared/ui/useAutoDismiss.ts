import { useEffect } from "react";

export const TOAST_PAUSE_EVENT = "lakomics:toast-pause";
export const TOAST_RESUME_EVENT = "lakomics:toast-resume";
const AUTO_DISMISS_MS = 5_000;

export function useAutoDismiss(value: string | null, dismiss: (value: null) => void) {
  useEffect(() => {
    if (value === null) return;

    let remaining = AUTO_DISMISS_MS;
    let startedAt = Date.now();
    let timer: number | null = null;
    let pauseCount = 0;

    const schedule = () => {
      startedAt = Date.now();
      timer = window.setTimeout(() => dismiss(null), remaining);
    };
    const pause = () => {
      pauseCount += 1;
      if (pauseCount !== 1 || timer === null) return;
      window.clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    };
    const resume = () => {
      if (pauseCount === 0) return;
      pauseCount -= 1;
      if (pauseCount !== 0) return;
      if (remaining <= 0) {
        dismiss(null);
        return;
      }
      schedule();
    };

    schedule();
    window.addEventListener(TOAST_PAUSE_EVENT, pause);
    window.addEventListener(TOAST_RESUME_EVENT, resume);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(TOAST_PAUSE_EVENT, pause);
      window.removeEventListener(TOAST_RESUME_EVENT, resume);
    };
  }, [dismiss, value]);
}
