import type { ReactNode } from "react";
import { Squares2X2Icon } from "@heroicons/react/24/outline";
import { SidebarOpenIcon } from "../shared/ui/SidebarIcons";
import { ViewToolbar } from "../layout/ViewToolbar";
import type { ViewChromeSpec } from "../layout/WorkspaceChrome";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { SectionBar } from "../shared/ui/SectionBar";
import { SectionDropMount, useSectionDrop } from "../shared/ui/useSectionDrop";
import { displayDateTime } from "../shared/displayDate";

export type MangaSource = "all" | "bookmarked" | "local";
const sourceOptions = [
  { value: "all" as const, label: "카탈로그" }, { value: "bookmarked" as const, label: "북마크" }, { value: "local" as const, label: "로컬" },
];

/** The source switch as the section bar under the top bar; the 보기 menu sits at its right end. */
export function MangaSourceControl({ value, onChange, trailing }: {
  value: MangaSource; onChange: (source: MangaSource) => void; localCount?: number; bookmarkCount?: number; trailing?: ReactNode;
}) {
  return <SectionBar label="망가 출처" className="manga-section-bar" value={value} onChange={onChange} trailing={trailing} options={sourceOptions} />;
}

/** One choice of the 망가 보기 menu (언어, 정렬): a labelled radio group. */
export type MangaViewChoice = { label: string; value: string; options: readonly { value: string; label: string }[]; onChange(value: string): void };

/** 보기 for 망가, the same trigger as the Asset and Collections 보기: each choice is a labelled group of options. */
export function MangaViewMenu({ choices }: { choices: MangaViewChoice[] }) {
  return <Menu label="보기" align="end" triggerClassName="asset-toolbar__quiet-menu" groupLabels
    trigger={<><Squares2X2Icon aria-hidden="true" /><span>보기</span></>}
    items={choices.flatMap(choice => choice.options.map(option => ({ id: `${choice.label}:${option.value}`, label: option.label, group: choice.label,
      selected: choice.value === option.value, onSelect: () => choice.onChange(option.value) })))} />;
}

export function MangaToolbar({ source, onSourceChange, countLabel, filterToken, controls, refreshedAt, actions, chrome, ariaLabel = "망가 도구" }: {
  source: MangaSource; onSourceChange: (source: MangaSource) => void; localCount?: number; bookmarkCount?: number;
  countLabel?: string; filterToken?: ReactNode; controls?: ReactNode; refreshedAt?: string | null;
  actions?: ReactNode; chrome?: ViewChromeSpec; ariaLabel?: string;
}) {
  const workspace = useWorkspaceChrome();
  const sectionDrop = useSectionDrop({ label: "망가 출처", className: "manga-section-bar", value: source, onChange: onSourceChange, trailing: controls, options: sourceOptions });
  return <>
    <ViewToolbar sectionDrop={sectionDrop} title="망가" ariaLabel={ariaLabel}
      leadingAction={workspace?.indexHidden.manga && <Button type="button" size="icon" variant="ghost" aria-label="사이드바 보이기" onClick={() => workspace.setIndexHidden("manga", false)}><SidebarOpenIcon aria-hidden="true" /></Button>}
      titleAccessory={<>
      {filterToken}
      {countLabel && <span className="manga-toolbar__count">{countLabel}</span>}
      <div className="manga-toolbar__refresh">
        {refreshedAt && <time dateTime={refreshedAt}>갱신 {displayDateTime(refreshedAt, new Date(), { withTime: true })}</time>}
        {actions}
      </div>
    </>} chrome={chrome} />
    <SectionDropMount host=".manga-browser" target=".manga-browser__content">{sectionDrop.inline}</SectionDropMount>
  </>;
}
