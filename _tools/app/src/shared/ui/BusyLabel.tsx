import { useRef, type ReactNode } from "react";
import { useDelayedBusy } from "../useDelayedBusy";

/** Keep mounted across both busy edges, including while showing the normal button label. */
export function BusyLabel({ busy, children, idle = null }: { busy: boolean; children: ReactNode; idle?: ReactNode }) {
  const visible = useDelayedBusy(busy);
  const lastLabel = useRef(children);
  const lastIdle = useRef(idle);
  if (busy) lastLabel.current = children;
  else lastIdle.current = idle;
  return <>{visible ? lastLabel.current : busy ? lastIdle.current : idle}</>;
}
