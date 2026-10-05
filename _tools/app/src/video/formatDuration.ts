import { displayDuration } from "../shared/displayDate";

/** The same quiet duration label on desktop and tablet asset tiles; `—` when unknown. */
export function formatDuration(durationMs: number | null | undefined) {
  return displayDuration(durationMs) || "—";
}
