import { useEffect } from "react";

export function useAutoDismiss(value: string | null, dismiss: (value: null) => void) {
  useEffect(() => {
    if (value === null) return;
    const timer = window.setTimeout(() => dismiss(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [dismiss, value]);
}
