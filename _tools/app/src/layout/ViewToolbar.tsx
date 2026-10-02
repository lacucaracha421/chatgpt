import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { WindowControls } from "./WindowControls";
import { ChromeContribution, type ViewChromeSpec } from "./WorkspaceChrome";
import { useWorkspaceChrome } from "./WorkspaceChromeContext";
import { ChromeQueryBadge } from "./ChromeSearch";

import type { SectionDrop } from "../shared/ui/useSectionDrop";

type ViewToolbarProps = {
  sectionDrop?: SectionDrop;
  title: string;
  titleContent?: ReactNode;
  leadingAction?: ReactNode;
  titleAccessory?: ReactNode;
  ariaLabel?: string;
  children?: ReactNode;
  actions?: ReactNode;
  chrome?: ViewChromeSpec;
};

export function ViewToolbar({ title, titleContent, leadingAction, titleAccessory, ariaLabel, children, actions, chrome, sectionDrop }: ViewToolbarProps) {
  const workspace = useWorkspaceChrome();
  const place = (header: ReactNode) => workspace?.targets.header ? createPortal(header, workspace.targets.header) : header;
  if (workspace && chrome) {
    return <>
      <ChromeContribution title={title} spec={chrome} />
      {sectionDrop?.overlay}
      {place(<header ref={sectionDrop?.barRef} className="view-toolbar view-toolbar--context" role="toolbar" aria-label={ariaLabel} data-tauri-drag-region="deep">
        {leadingAction}
        <h2 aria-description={title}>{sectionDrop ? sectionDrop.title(titleContent ?? title, sectionDrop.area ?? title) : titleContent ?? title}</h2>
        {titleAccessory}
        <ChromeQueryBadge search={chrome.search} />
        <div className="chrome-context-status">{chrome.status}</div>
        {!workspace.targets.actions && chrome.actions && <div className="view-toolbar__view-actions">{chrome.actions}</div>}
      </header>)}
    </>;
  }
  return <>{sectionDrop?.overlay}{place(
    <header ref={sectionDrop?.barRef} className="view-toolbar" role="toolbar" aria-label={ariaLabel} data-tauri-drag-region="deep">
      {leadingAction}
      <h2>{sectionDrop ? sectionDrop.title(titleContent ?? title, sectionDrop.area ?? title) : titleContent ?? title}</h2>
      {titleAccessory}
      {children && <div className="view-toolbar__content">{children}</div>}
      <div className="view-toolbar__actions">
        {actions && <div className="view-toolbar__view-actions">{actions}</div>}
        {!workspace && <WindowControls />}
      </div>
    </header>
  )}</>;
}
