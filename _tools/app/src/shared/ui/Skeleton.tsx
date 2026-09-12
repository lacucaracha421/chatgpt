type SkeletonProps = {
  className?: string;
  label?: string;
};

export function Skeleton({ className, label = "Loading" }: SkeletonProps) {
  return <span aria-label={label} className={`ui-skeleton${className ? ` ${className}` : ""}`} role="status" />;
}
