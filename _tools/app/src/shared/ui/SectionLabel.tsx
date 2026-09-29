import { ChevronRightIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";

type SectionLabelProps = {
  title: string;
  count?: number;
  actions?: ReactNode;
  onOpen?: () => void;
  as?: "div" | "h2" | "h3";
  id?: string;
  className?: string;
};

export function SectionLabel({ title, count, actions, onOpen, as = "div", id, className }: SectionLabelProps) {
  const Element = as;
  const classes = ["ui-section-label", className].filter(Boolean).join(" ");

  return (
    <Element id={id} className={classes}>
      <span className="ui-section-label__title">{title}</span>
      {count !== undefined && <span className="ui-section-label__count">{count.toLocaleString()}</span>}
      <span className="ui-section-label__rule" aria-hidden="true" />
      {actions !== undefined && <span className="ui-section-label__actions">{actions}</span>}
      {onOpen && (
        <button type="button" className="ui-section-label__open" aria-label={`${title} 전체`} onClick={onOpen}>
          <ChevronRightIcon aria-hidden="true" />
        </button>
      )}
    </Element>
  );
}
