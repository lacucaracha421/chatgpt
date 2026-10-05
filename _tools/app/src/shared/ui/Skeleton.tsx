type SkeletonProps = {
  className?: string;
  /** Announced while loading; `null` for one of several placeholders that a parent already announces. */
  label?: string | null;
};

/**
 * The one loading placeholder (DESIGN.md §12 States): a block in the content's shape that fades in
 * only after 300 ms and breathes slowly, so fast work shows nothing. No loading text beside it.
 */
export function Skeleton({ className, label = "Loading" }: SkeletonProps) {
  const classes = `ui-skeleton${className ? ` ${className}` : ""}`;
  if (label === null) return <span aria-hidden="true" className={classes} />;
  return <span aria-label={label} className={classes} role="status" />;
}
