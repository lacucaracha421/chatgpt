import { ddayLabel } from "../displayDate";
import { Badge } from "./Badge";

type DDayProps = {
  /** Whole local calendar days until the date; negative or missing renders nothing. */
  days: number | null | undefined;
  /** `badge` on shelves and rows, `text` beside a date heading (release calendar). */
  as?: "badge" | "text";
  className?: string;
};

/**
 * Days left until a release, the same everywhere (DESIGN.md §12 Dates):
 * `오늘` on the day, `D-6` before it, nothing once it has passed — the date says it.
 */
export function DDay({ days, as = "badge", className }: DDayProps) {
  const label = ddayLabel(days);
  if (label === null) return null;
  const classes = ["ui-dday", className].filter(Boolean).join(" ");
  if (as === "text") return <span className={classes}>{label}</span>;
  return <Badge variant={days === 0 ? "accent" : "plain"} className={classes}>{label}</Badge>;
}
