import type { ReactNode } from "react";
import { WindowControls } from "./WindowControls";

type ViewToolbarProps = {
  title: string;
  ariaLabel?: string;
  children?: ReactNode;
  actions?: ReactNode;
};

export function ViewToolbar({ title, ariaLabel, children, actions }: ViewToolbarProps) {
  return (
    <header className="view-toolbar" role="toolbar" aria-label={ariaLabel} data-tauri-drag-region>
      <h2 data-tauri-drag-region>{title}</h2>
      {children && <div className="view-toolbar__content" data-tauri-drag-region>{children}</div>}
      <div className="view-toolbar__actions">
        {actions && <div className="view-toolbar__view-actions">{actions}</div>}
        <WindowControls />
      </div>
    </header>
  );
}
