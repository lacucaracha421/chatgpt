import type { ReactNode } from "react";
import { Squares2X2Icon } from "@heroicons/react/24/outline";
import { Menu } from "./Menu";
import { SegmentedControl } from "./SegmentedControl";
import { PerRowControl } from "./PerRowControl";

export function ViewOptionsMenu<T extends string>({ layout, options, onLayoutChange, perRow, min, max, onPerRowChange, children }: {
  layout: T; options: { value: T; label: string }[]; onLayoutChange(value: T): void;
  perRow: number; min: number; max: number; onPerRowChange(value: number): void; children?: ReactNode;
}) {
  return <Menu label="보기" align="end" triggerClassName="asset-toolbar__quiet-menu"
    trigger={<><Squares2X2Icon aria-hidden="true" /><span>보기</span></>} contentClassName="ui-view-options"
    content={<div className="ui-view-options__content" onKeyDown={event => event.stopPropagation()}>
      <section className="ui-view-options__section"><span className="ui-view-options__label">배치</span>
        <SegmentedControl label="배치" options={options} value={layout} onChange={onLayoutChange} fullWidth />
      </section>
      <PerRowControl value={perRow} min={min} max={max} onChange={onPerRowChange} />
      {children}
    </div>} />;
}
