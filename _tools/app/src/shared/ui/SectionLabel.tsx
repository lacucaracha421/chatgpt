import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { displayCount } from "../displayDate";

type SectionLabelProps = {
  title: string;
  /** A 16px glyph inside the label, before the title (rare; most labels have none). */
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  count?: number;
  /** Attached without a space, e.g. `8장` (DESIGN.md §12 Dates and numbers). */
  unit?: string;
  actions?: ReactNode;
  onOpen?: () => void;
  as?: "div" | "h2" | "h3";
  id?: string;
  className?: string;
  /** The complete label becomes the fold control; do not combine with actions/onOpen. `label` overrides its accessible name. */
  collapsible?: { open: boolean; onToggle: () => void; controls?: string; label?: string };
};

export function SectionLabel({ title, icon: Icon, count, unit, actions, onOpen, as = "div", id, className, collapsible }: SectionLabelProps) {
  const Element = as;
  const classes = ["ui-section-label", className].filter(Boolean).join(" ");

  if (collapsible) return <button type="button" id={id} className={`${classes} ui-section-label--collapsible`} aria-expanded={collapsible.open} aria-controls={collapsible.controls} aria-label={collapsible.label} onClick={collapsible.onToggle}>
    <span className="ui-section-label__title">{Icon && <Icon aria-hidden="true" />}{title}</span>
    {count !== undefined && <>{" "}<span className="ui-section-label__count">{displayCount(count, unit)}</span></>}
    <span className="ui-section-label__rule" aria-hidden="true" />
    <ChevronDownIcon className="ui-section-label__chevron" aria-hidden="true" />
  </button>;

  return (
    <Element id={id} className={classes}>
      <span className="ui-section-label__title">{Icon && <Icon aria-hidden="true" />}{title}</span>
      {count !== undefined && <>{" "}<span className="ui-section-label__count">{displayCount(count, unit)}</span></>}
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
