import type { ReactNode } from "react";
import { Squares2X2Icon } from "@heroicons/react/24/outline";
import { Menu } from "./Menu";
import { SegmentedControl } from "./SegmentedControl";
import { PerRowControl } from "./PerRowControl";
import { ViewOptionsSection } from "./ViewOptionsSection";

/** 보기: `leading` sections (what is shown) come first, then 배치 with 한 줄에 N개, then `children`. */
export function ViewOptionsMenu<T extends string>({ layout, options, onLayoutChange, perRow, min, max, onPerRowChange, leading, children }: {
  layout: T; options: { value: T; label: string }[]; onLayoutChange(value: T): void;
  perRow: number; min: number; max: number; onPerRowChange(value: number): void; leading?: ReactNode; children?: ReactNode;
}) {
  return <Menu label="보기" align="end" triggerClassName="asset-toolbar__quiet-menu"
    trigger={<><Squares2X2Icon aria-hidden="true" /><span>보기</span></>} contentClassName="ui-view-options"
    content={<div className="ui-view-options__content" onKeyDown={event => event.stopPropagation()}>
      {leading}
      <ViewOptionsSection title="배치">
        <SegmentedControl label="배치" options={options} value={layout} onChange={onLayoutChange} fullWidth />
        <PerRowControl value={perRow} min={min} max={max} onChange={onPerRowChange} />
      </ViewOptionsSection>
      {children}
    </div>} />;
}
