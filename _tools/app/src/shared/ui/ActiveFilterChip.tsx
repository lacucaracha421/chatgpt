import type { MouseEvent } from "react";
import { FunnelIcon, XMarkIcon } from "@heroicons/react/24/outline";

export function ActiveFilterChip({ label, onClear, groupLabel = "보기 필터" }: {
  label: string;
  onClear(event: MouseEvent<HTMLButtonElement>): void;
  groupLabel?: string;
}) {
  return <span className="ui-active-filter" role="group" aria-label={groupLabel}>
    <FunnelIcon aria-hidden="true" /><span className="ui-active-filter__label">{label}</span>
    <button type="button" className="ui-active-filter__clear" aria-label="필터 초기화" onClick={onClear}><XMarkIcon aria-hidden="true" /></button>
  </span>;
}
