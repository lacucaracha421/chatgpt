import { MagnifyingGlassIcon } from "../shared/ui/ArchiveIcons";
import type { ReactNode } from "react";
import { Dialog } from "../shared/ui/Dialog";

type Props = {
  label: string;
  scope: string;
  active: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
};

/**
 * A view's specialized query editor (e.g. the online catalog with tag suggestions).
 * Ctrl+F belongs to the 찾기 palette, which opens this editor through the chrome search handle.
 */
export function SearchSurface({ label, scope, active, open, onOpen, onClose, children }: Props) {
  return <>
    <button type="button" className="ui-button ui-button--icon ui-button--ghost chrome-search-trigger" aria-label={label} onClick={onOpen}>
      <MagnifyingGlassIcon aria-hidden="true" />
      {active && <span className="chrome-search-trigger__active" aria-hidden="true" />}
    </button>
    <Dialog open={open} title={`${scope}에서 검색`} onClose={onClose}>
      <div className="chrome-search-editor" data-chrome-search-open>{children}</div>
    </Dialog>
  </>;
}
