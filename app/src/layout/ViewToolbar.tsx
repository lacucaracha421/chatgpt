import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { WindowControls } from "./WindowControls";
import { ChromeContribution, type ViewChromeSpec } from "./WorkspaceChrome";
import { useWorkspaceChrome } from "./WorkspaceChromeContext";
import { ChromeQueryBadge } from "./ChromeSearch";

type ViewToolbarProps = {
  title: string;
  titleAccessory?: ReactNode;
  ariaLabel?: string;
  children?: ReactNode;
  actions?: ReactNode;
  chrome?: ViewChromeSpec;
};

export function ViewToolbar({ title, titleAccessory, ariaLabel, children, actions, chrome }: ViewToolbarProps) {
  const workspace = useWorkspaceChrome();
  const place = (header: ReactNode) => workspace?.targets.header ? createPortal(header, workspace.targets.header) : header;
  if (workspace && chrome) {
    return <>
      <ChromeContribution title={title} spec={chrome} />
      {place(<header className="view-toolbar view-toolbar--context" role="toolbar" aria-label={ariaLabel} data-tauri-drag-region="deep">
        <span className="chrome-location-mark" aria-hidden="true" />
        <h2 title={title}>{title}</h2>
        {titleAccessory}
        <ChromeQueryBadge search={chrome.search} />
        <div className="chrome-context-status">{chrome.status}</div>
      </header>)}
    </>;
  }
  return place(
    <header className="view-toolbar" role="toolbar" aria-label={ariaLabel} data-tauri-drag-region="deep">
      <h2>{title}</h2>
      {titleAccessory}
      {children && <div className="view-toolbar__content">{children}</div>}
      <div className="view-toolbar__actions">
        {actions && <div className="view-toolbar__view-actions">{actions}</div>}
        {!workspace && <WindowControls />}
      </div>
    </header>
  );
}
