import type { ComponentType, HTMLAttributes, ReactNode, SVGProps } from "react";

type BadgeVariant = "plain" | "accent" | "danger" | "count";
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
