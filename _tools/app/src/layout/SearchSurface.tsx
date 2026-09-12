import { MagnifyingGlassIcon } from "../shared/ui/ArchiveIcons";
import { useEffect, type ReactNode } from "react";
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

/** One search entry point, including views with a specialized query editor. */
export function SearchSurface({ label, scope, active, open, onOpen, onClose, children }: Props) {
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", search);
    return () => window.removeEventListener("keydown", search);
  }, [onOpen]);
  return <>
    <button type="button" className="ui-button ui-button--icon ui-button--ghost chrome-search-trigger" aria-label={label} aria-description={`${label} (Ctrl+F)`} onClick={onOpen}>
      <MagnifyingGlassIcon aria-hidden="true" />
      {active && <span className="chrome-search-trigger__active" aria-hidden="true" />}
    </button>
    <Dialog open={open} title={`${scope}에서 검색`} onClose={onClose}>
      <div className="chrome-search-editor" data-chrome-search-open>{children}</div>
    </Dialog>
  </>;
}
