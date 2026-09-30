import type { ReactNode } from "react";
import { ArrowPathIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { ViewToolbar } from "../layout/ViewToolbar";
import type { ViewChromeSpec } from "../layout/WorkspaceChrome";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { displayDateTime } from "../shared/displayDate";

export type MangaSource = "all" | "bookmarked" | "local";

export function MangaSourceControl({ value, onChange, localCount, bookmarkCount }: {
  value: MangaSource; onChange: (source: MangaSource) => void; localCount?: number; bookmarkCount?: number;
}) {
  return <SegmentedControl label="망가 출처" value={value} onChange={onChange} options={[
    { value: "all", label: "카탈로그" }, { value: "bookmarked", label: "북마크", count: bookmarkCount }, { value: "local", label: "로컬", count: localCount },
  ]} />;
}

export function MangaChoiceMenu<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  return <Menu label={label} triggerClassName="manga-toolbar__quiet-menu" trigger={<><span>{label}</span><b>{options.find(option => option.value === value)?.label}</b><ChevronDownIcon aria-hidden="true" /></>}
    items={options.map(option => ({ id: option.value, label: option.label, group: label, selected: value === option.value, onSelect: () => onChange(option.value) }))} />;
}

export function MangaToolbar({ source, onSourceChange, localCount, bookmarkCount, countLabel, controls, refreshedAt, refreshing, onRefresh, actions, chrome, ariaLabel = "망가 도구" }: {
  source: MangaSource; onSourceChange: (source: MangaSource) => void; localCount?: number; bookmarkCount?: number;
  countLabel?: string; controls?: ReactNode; refreshedAt?: string | null; refreshing?: boolean; onRefresh?: () => void;
  actions?: ReactNode; chrome?: ViewChromeSpec; ariaLabel?: string;
}) {
  return <ViewToolbar title="망가" ariaLabel={ariaLabel} titleAccessory={<>
    {countLabel && <span className="manga-toolbar__count">{countLabel}</span>}
    <div className="manga-toolbar__controls"><MangaSourceControl value={source} onChange={onSourceChange} localCount={localCount} bookmarkCount={bookmarkCount} />{controls}</div>
    <div className="manga-toolbar__refresh">
      {refreshedAt && <time dateTime={refreshedAt}>갱신 {displayDateTime(refreshedAt, new Date(), { withTime: true })}</time>}
      {onRefresh && <Button variant="quiet" size="icon" aria-label="새로고침" disabled={refreshing} onClick={onRefresh}><ArrowPathIcon aria-hidden="true" /></Button>}
      {actions}
    </div>
  </>} chrome={chrome} />;
}
