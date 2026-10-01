import type { ReactNode } from "react";
import { SegmentedControl, type SegmentedOption } from "./SegmentedControl";

/**
 * Where the host puts the bar (DESIGN.md §12, docs/prototypes/section-bar-20261001):
 * - `pinned`: a non-scrolling row directly under the top bar; the list scrolls beneath it (PC).
 * - `inline`: the first row inside a scrolling list, so it scrolls away with the list (tablet).
 * - `shade`: the same bar dropped over the list from the top bar (tablet); the host positions it and
 *   decides when it is open.
 * The bar itself only lays out its sections and trailing controls; placement styling is the host's.
 */
export type SectionBarPlacement = "pinned" | "inline" | "shade";

export type SectionBarProps<T extends string> = {
  /** Accessible name of the section switch (the radiogroup). */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** View controls at the bar's right end (sort, filters, 보기). */
  trailing?: ReactNode;
  placement?: SectionBarPlacement;
  className?: string;
};

/** One thin bar holding a tab's sections, shared by the PC and the tablet. */
export function SectionBar<T extends string>({ label, options, value, onChange, trailing, placement = "pinned", className }: SectionBarProps<T>) {
  return <div className={["ui-section-bar", `ui-section-bar--${placement}`, className].filter(Boolean).join(" ")}>
    <SegmentedControl label={label} options={options} value={value} onChange={onChange} />
    {trailing && <div className="ui-section-bar__trailing">{trailing}</div>}
  </div>;
}
