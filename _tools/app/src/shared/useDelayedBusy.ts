import { useLayoutEffect, useMemo, useState } from "react";
import { createDelayedBusy, type BusyTiming } from "./delayedBusy";

export function useDelayedBusy(busy: boolean, { delay = 600, minVisible = 400 }: BusyTiming = {}): boolean {
  const [visible, setVisible] = useState(false);
  const timing = useMemo(() => createDelayedBusy(setVisible, { delay, minVisible }), [delay, minVisible]);
  useLayoutEffect(() => {
    setVisible(false);
    return () => timing.dispose();
  }, [timing]);
  useLayoutEffect(() => { timing.setBusy(busy); }, [busy, timing]);
  return visible;
}
