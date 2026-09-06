import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";

/** Keep detail state in its owner while placing controls in the workspace index. */
export function CollectionSidebarSection({ children, actions = false }: { children: ReactNode; actions?: boolean }) {
  const chrome = useWorkspaceChrome();
  if (!chrome) return children;
  return chrome.targets.details ? createPortal(
    <div className={`collection-detail-sidebar__section${actions ? " collection-detail-sidebar__section--actions" : ""}`}>{children}</div>,
    chrome.targets.details,
  ) : null;
}
