import type { ComponentType, PropsWithChildren, ReactNode, SVGProps } from "react";

type EmptyStateProps = PropsWithChildren<{
  title: string;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** One quiet line under the title; it may differ per screen ("검색어나 필터를 바꿔 보세요"). */
  hint?: ReactNode;
  /** The one next step, when there is a real one (DESIGN.md §12 States). */
  action?: ReactNode;
  /** One faint line inside a list, picker, palette or section instead of a centred block. */
  inline?: boolean;
  role?: "status" | "alert";
  className?: string;
}>;

/**
 * Empty list, no result or failed load (DESIGN.md §12 States): a faint icon, one line,
 * an optional hint and one action. No search results always read "검색 결과 없음".
 */
export function EmptyState({ children, title, icon: Icon, hint, action, inline = false, role, className }: EmptyStateProps) {
  if (inline) {
    return <p className={["ui-empty-state--inline", className].filter(Boolean).join(" ")} role={role}>{title}</p>;
  }
  return (
    <section className={["ui-empty-state", className].filter(Boolean).join(" ")} role={role}>
      {Icon && <Icon className="ui-empty-state__icon" aria-hidden="true" />}
      <h2>{title}</h2>
      {hint !== undefined && hint !== null && hint !== false && <p className="ui-empty-state__hint">{hint}</p>}
      {children}
      {action}
    </section>
  );
}
