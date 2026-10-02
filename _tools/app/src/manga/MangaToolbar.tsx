import type { ReactNode } from "react";
import { ArrowPathIcon, ChevronDownIcon, ViewColumnsIcon } from "@heroicons/react/24/outline";
import { ViewToolbar } from "../layout/ViewToolbar";
import type { ViewChromeSpec } from "../layout/WorkspaceChrome";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { SectionBar } from "../shared/ui/SectionBar";
import { SectionDropMount, useSectionDrop } from "../shared/ui/useSectionDrop";
import { displayDateTime } from "../shared/displayDate";

export type MangaSource = "all" | "bookmarked" | "local";
const sourceOptions = (localCount?: number, bookmarkCount?: number) => [
  { value: "all" as const, label: "카탈로그" }, { value: "bookmarked" as const, label: "북마크", count: bookmarkCount }, { value: "local" as const, label: "로컬", count: localCount },
];

/** The source switch as the section bar under the top bar; sort and language menus sit at its right end. */
export function MangaSourceControl({ value, onChange, localCount, bookmarkCount, trailing }: {
  value: MangaSource; onChange: (source: MangaSource) => void; localCount?: number; bookmarkCount?: number; trailing?: ReactNode;
}) {
  return <SectionBar label="망가 출처" className="manga-section-bar" value={value} onChange={onChange} trailing={trailing} options={sourceOptions(localCount, bookmarkCount)} />;
}

export function MangaChoiceMenu<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  return <Menu label={label} triggerClassName="manga-toolbar__quiet-menu" trigger={<><span>{label}</span><b>{options.find(option => option.value === value)?.label}</b><ChevronDownIcon aria-hidden="true" /></>}
    items={options.map(option => ({ id: option.value, label: option.label, group: label, selected: value === option.value, onSelect: () => onChange(option.value) }))} />;
}

export function MangaToolbar({ source, onSourceChange, localCount, bookmarkCount, countLabel, filterToken, controls, refreshedAt, refreshing, onRefresh, actions, chrome, ariaLabel = "망가 도구" }: {
  source: MangaSource; onSourceChange: (source: MangaSource) => void; localCount?: number; bookmarkCount?: number;
  countLabel?: string; filterToken?: ReactNode; controls?: ReactNode; refreshedAt?: string | null; refreshing?: boolean; onRefresh?: () => void;
  actions?: ReactNode; chrome?: ViewChromeSpec; ariaLabel?: string;
}) {
  const workspace = useWorkspaceChrome();
  const sectionDrop = useSectionDrop({ label: "망가 출처", className: "manga-section-bar", value: source, onChange: onSourceChange, trailing: controls, options: sourceOptions(localCount, bookmarkCount) });
  return <>
    <ViewToolbar sectionDrop={sectionDrop} title="망가" ariaLabel={ariaLabel}
      leadingAction={workspace?.indexHidden.manga && <Button type="button" size="icon" variant="ghost" aria-label="사이드바 보이기" onClick={() => workspace.setIndexHidden("manga", false)}><ViewColumnsIcon aria-hidden="true" /></Button>}
      titleAccessory={<>
      {filterToken}
      {countLabel && <span className="manga-toolbar__count">{countLabel}</span>}
      <div className="manga-toolbar__refresh">
        {refreshedAt && <time dateTime={refreshedAt}>갱신 {displayDateTime(refreshedAt, new Date(), { withTime: true })}</time>}
        {onRefresh && <Button variant="quiet" size="icon" aria-label="새로고침" disabled={refreshing} onClick={onRefresh}><ArrowPathIcon aria-hidden="true" /></Button>}
        {actions}
      </div>
    </>} chrome={chrome} />
    <SectionDropMount host=".manga-browser" target=".manga-browser__content">{sectionDrop.inline}</SectionDropMount>
  </>;
}
