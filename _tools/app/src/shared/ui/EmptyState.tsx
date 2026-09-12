import type { PropsWithChildren } from "react";

type EmptyStateProps = PropsWithChildren<{
  title: string;
}>;

export function EmptyState({ children, title }: EmptyStateProps) {
  return (
    <section className="ui-empty-state">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
