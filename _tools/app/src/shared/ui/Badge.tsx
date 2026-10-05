import type { ComponentType, HTMLAttributes, ReactNode, SVGProps } from "react";
import { displayCount } from "../displayDate";

/**
 * plain · accent (NEW) · danger · count (a number on a tab, row or menu) ·
 * scrim (over media: video length, `+15`, page counts) · corner (a count pinned to an icon's corner).
 */
type BadgeVariant = "plain" | "accent" | "danger" | "count" | "scrim" | "corner";
type BadgeIcon = ComponentType<SVGProps<SVGSVGElement>>;

type BadgeBaseProps = Omit<HTMLAttributes<HTMLSpanElement>, "aria-label" | "children" | "className" | "role"> & {
  className?: string;
  variant?: BadgeVariant;
};

type BadgeProps =
  | (BadgeBaseProps & { icon: BadgeIcon; children?: never; "aria-label": string })
  | (BadgeBaseProps & { icon?: BadgeIcon; children: ReactNode; "aria-label"?: string; role?: HTMLAttributes<HTMLSpanElement>["role"] });

export function Badge({ children, className, icon: Icon, variant = "plain", ...props }: BadgeProps) {
  const iconOnly = children === undefined || children === null;
  const role = "role" in props ? props.role : undefined;
  const classes = ["ui-badge", `ui-badge--${variant}`, iconOnly ? "ui-badge--icon" : "", className].filter(Boolean).join(" ");

  return (
    <span {...props} className={classes} role={iconOnly ? "img" : role}>
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

type CountBadgeProps = Omit<BadgeBaseProps, "variant"> & {
  value: number;
  /** Above this the badge reads `99+`; omit to show every count. */
  max?: number;
  unit?: string;
  variant?: "count" | "corner" | "scrim" | "accent";
  "aria-label"?: string;
};

/** A number badge: tabular figures, thousands separators, optional `99+` cap. */
export function CountBadge({ value, max, unit, variant = "count", ...props }: CountBadgeProps) {
  const text = max !== undefined && value > max ? `${displayCount(max)}+` : displayCount(value, unit);
  return <Badge {...props} variant={variant}>{text}</Badge>;
}
