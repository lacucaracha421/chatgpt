import { displayDateTime } from "../shared/displayDate";

/** Today is time only, yesterday is named, and older edits use the shared dot date. */
export function noteDateLabel(value: string, now = new Date()): string {
  return displayDateTime(value, now);
}
