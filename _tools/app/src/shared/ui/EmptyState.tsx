import type { ComponentType, PropsWithChildren, SVGProps } from "react";

type EmptyStateProps = PropsWithChildren<{
  title: string;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  className?: string;
}>;

export function EmptyState({ children, title, icon: Icon, className }: EmptyStateProps) {
  return (
    <section className={["ui-empty-state", className].filter(Boolean).join(" ")}>
      {Icon && <Icon className="ui-empty-state__icon" aria-hidden="true" />}
      <h2>{title}</h2>
      {children}
    </section>
  );
}
