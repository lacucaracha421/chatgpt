import type { ReactNode } from "react";
import { SectionLabel } from "./SectionLabel";

/** One group of a 보기 surface (PC menu, tablet sheet): a section label, with an optional ⓘ or action at its end, over its controls. */
export function ViewOptionsSection({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="ui-view-options__section"><SectionLabel title={title} actions={actions} />{children}</section>;
}
