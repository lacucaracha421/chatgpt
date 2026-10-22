import { ChevronRightIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { SectionLabel } from "../../shared/ui/SectionLabel";
import { NO_PERFORMER } from "./performerGroups";
import "./performerGroupHeading.css";

/**
 * The heading over one performer's works when the AV list is grouped by performer (PC and tablet): portrait,
 * name with the Japanese name under it, the work count, then the section rule. The whole heading opens the
 * performer page. Each client passes its own portrait (the PC reads the library, the tablet the published copy).
 */
export function PerformerGroupHeading({ portrait, name, count, onOpen }: {
  portrait: ReactNode; name: { primary: string; secondary: string }; count: number; onOpen(): void;
}) {
  return <button type="button" className="performer-group-heading" aria-label={`${name.primary} ${count.toLocaleString()}편`} onClick={onOpen}>
    {portrait}
    <span className="performer-group-heading__name"><b>{name.primary}</b>{name.secondary && <small lang="ja">{name.secondary}</small>}</span>
    <span className="performer-group-heading__count">{count.toLocaleString()}편</span>
    <span className="performer-group-heading__rule" aria-hidden="true" />
    <ChevronRightIcon className="performer-group-heading__chevron" aria-hidden="true" />
  </button>;
}

/** The last group's label (works with no performer), counted in 편 like the performer headings. */
export function NoPerformerHeading({ count }: { count: number }) {
  return <SectionLabel title={NO_PERFORMER} count={count} unit="편" />;
}
