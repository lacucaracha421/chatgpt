import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { Dialog } from "../shared/ui/Dialog";
import { IconButton } from "../shared/ui/IconButton";
import { TextInput, type TextInputProps } from "../shared/ui/TextInput";

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
 * A view's own query editor (the online catalog with tag suggestions, Somi). In 망가, Ctrl+Q opens it
 * directly; the rail 찾기 palette (and Ctrl+Q elsewhere) opens it through the chrome search handle.
 * The input leads: what belongs to it (suggestions) sits under it in the flow, only that list scrolls,
 * and the actions stay in view.
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

type FieldProps = Omit<TextInputProps, "icon" | "type" | "value"> & {
  value: string;
  /** Empties the field; the input keeps focus. */
  onClear: () => void;
};

/** The search editor's one input: magnifier, text and a quiet clear button while there is text. */
export function SearchSurfaceField({ value, onClear, ...props }: FieldProps) {
  return <div className="chrome-search-editor__field">
    <TextInput {...props} icon={MagnifyingGlassIcon} type="text" value={value} autoComplete="off" spellCheck={false} enterKeyHint="search" />
    {value && <IconButton className="chrome-search-editor__clear" label="검색어 지우기" icon={XMarkIcon}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => { const input = event.currentTarget.parentElement?.querySelector("input"); onClear(); input?.focus(); }} />}
  </div>;
}
