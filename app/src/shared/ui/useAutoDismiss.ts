import { useEffect } from "react";

export function useAutoDismiss<T>(value: T | null, dismiss: (value: null) => void, ms = 5000) {
  useEffect(() => {
    if (value === null) return;
    const timer = window.setTimeout(() => dismiss(null), ms);
    return () => window.clearTimeout(timer);
  }, [dismiss, ms, value]);
}
