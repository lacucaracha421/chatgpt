import { useEffect, useRef, useState } from "react";
import { ArrowPathIcon, ArrowsUpDownIcon, ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import "./transferMark.css";

/** What the 전송 tile's icon says: nothing going on, a send on its way, one waiting for the receiver, or the last send failed. */
export type TransferTone = "idle" | "moving" | "waiting" | "failed";

/** The tile's state from its sends, newest first: any send on its way spins; otherwise the newest send decides. */
export function transferTone<T>(lines: readonly T[], toneOf: (line: T) => TransferTone): { tone: TransferTone; line: T | null } {
  const moving = lines.find(line => toneOf(line) === "moving");
  if (moving !== undefined) return { tone: "moving", line: moving };
  const newest = lines[0];
  const tone = newest === undefined ? "idle" : toneOf(newest);
  return tone === "failed" || tone === "waiting" ? { tone, line: newest! } : { tone: "idle", line: null };
}

/**
 * The 전송 tile's icon on PC and tablet (user 2026-10-18): the recent-send list is gone, so the icon carries the
 * state. A send on its way turns it into a spinning arrow, only after 400 ms so a quick send shows nothing; a new
 * failure shakes the warning mark once and then it stays still with a short line under it; a send waiting for the
 * receiver shows a still clock. Reduced motion keeps the same icons without movement. `note` is one short line
 * under the icon (the failure, or on the tablet why nothing can be sent).
 */
export function TransferMark({ tone, note, settled = true }: { tone: TransferTone; note?: string; settled?: boolean }) {
  const spinning = useDelayedBusy(tone === "moving", { delay: 400 });
  // Only a failure that happens while Home is open shakes; one already there when the sends first arrive
  // (`settled`: the first state has been read) stays still.
  const previous = useRef<{ tone: TransferTone; settled: boolean }>({ tone, settled });
  const [alerts, setAlerts] = useState(0);
  useEffect(() => {
    if (settled && previous.current.settled && tone === "failed" && previous.current.tone !== "failed") setAlerts(count => count + 1);
    previous.current = { tone, settled };
  }, [tone, settled]);
  const shown: TransferTone = tone === "failed" ? "failed" : spinning ? "moving" : tone === "waiting" ? "waiting" : "idle";
  const Icon = shown === "failed" ? ExclamationTriangleIcon : shown === "moving" ? ArrowPathIcon : shown === "waiting" ? ClockIcon : ArrowsUpDownIcon;
  return <span key={alerts} className="transfer-mark" data-state={shown} data-alert={alerts > 0 && shown === "failed" ? "" : undefined}>
    <Icon aria-hidden="true" />
    {note && <small>{note}</small>}
  </span>;
}
