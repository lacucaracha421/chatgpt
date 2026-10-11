import type { ButtonHTMLAttributes } from "react";

/** Scope and multi-select filters use one face cue and the client's control height. */
export function FilterChip({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className={`ui-filter-chip${className ? ` ${className}` : ""}`} />;
}
