import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { MagnifyingGlassIcon } from "../shared/ui/ArchiveIcons";
import { modalDialogOpen } from "./modalDialog";
import type { ChromeSearchInfo } from "./WorkspaceChromeContext";
import { matchesEntry, NAVIGATION_GROUP_LABELS, type NavigationEntry, type NavigationEntryGroup } from "./navigationEntries";

const GROUP_ORDER: NavigationEntryGroup[] = ["search", "place", "queue", "go", "action", "settings"];

export type PaletteSearch = { info: ChromeSearchInfo; apply: (query: string) => void; open: (draft: string) => void };

/** Rows for the current view's own search. None when the view has no search (pc-design-reference §5). */
function searchEntries(search: PaletteSearch | null | undefined, text: string): NavigationEntry[] {
  if (!search) return [];
  const { info } = search;
  const typed = text.trim();
  const rows: NavigationEntry[] = [];
  if (info.kind === "query" && typed) {
    rows.push({ id: "search-apply", group: "search", label: `‘${typed}’ — ${info.scope}에서 검색`, icon: <MagnifyingGlassIcon />, run: () => search.apply(typed) });
  } else if (info.kind === "surface") {
    rows.push({ id: "search-open", group: "search", label: `${info.scope} 검색 열기`, icon: <MagnifyingGlassIcon />, run: () => search.open(typed) });
  }
  if (info.query.trim()) {
    rows.push({ id: "search-clear", group: "search", label: "검색 해제", icon: <XMarkIcon />, activity: `‘${info.query.trim()}’`, run: () => search.apply("") });
  }
  return rows;
}

/**
 * The 찾기 palette: searches the current view when it supports search, then moves to destinations
 * and runs a few commands by name. It never searches asset text where the view has no search.
 */
export function CommandPalette({ open, onClose, entries, search, findPlaces, fallbackFocus }: { open: boolean; onClose: () => void; entries: NavigationEntry[]; search?: PaletteSearch | null; findPlaces?: (query: string) => NavigationEntry[]; fallbackFocus?: () => HTMLElement | null }) {
  const [query, setQuery] = useState("");
  // Tracked by id: when a queue count arrives an entry can move between groups, and the highlight must follow it.
  const [activeId, setActiveId] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  useBackHandler(() => onClose(), 100, open);
  useLayoutEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveId(null);
  }, [open]);

  // Settings sections are only offered once the user types, so the default list stays short.
  // Folders, albums and characters are offered only once the user types (see placeEntries).
  const visible = [...searchEntries(search, query), ...(findPlaces?.(query) ?? []), ...entries.filter((entry) => (query.trim() || entry.group !== "settings") && matchesEntry(entry, query))];
  const ordered = GROUP_ORDER.flatMap((group) => visible.filter((entry) => entry.group === group));
  const found = ordered.findIndex((entry) => entry.id === activeId);
  const current = found >= 0 ? found : 0;
  const setActive = (index: number) => setActiveId(ordered[index]?.id ?? null);
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    listRef.current?.querySelector(`[id="${optionId(current)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const run = (entry: NavigationEntry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Korean IME: Enter or arrows that confirm a composition must not run a command.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!ordered.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + ordered.length) % ordered.length);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault(); setActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault(); setActive(Math.max(0, ordered.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(ordered[current]);
    }
  };

  let index = -1;
  return <RadixDialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="ui-dialog__overlay command-palette__overlay" />
      <RadixDialog.Content className="command-palette" aria-describedby={`${id}-hint`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // A row may have opened another dialog (the view's search editor); leave focus there.
          if (modalDialogOpen()) return;
          (openerRef.current?.isConnected ? openerRef.current : fallbackFocus?.())?.focus();
        }}
        onEscapeKeyDown={(event) => { event.preventDefault(); if (event.isComposing || event.keyCode === 229) return; onClose(); }}>
        <RadixDialog.Title className="command-palette__title">찾기</RadixDialog.Title>
        <div className="command-palette__field">
          <MagnifyingGlassIcon aria-hidden="true" />
          <input autoFocus type="text" role="combobox" aria-label={search ? `${search.info.scope} 검색어 또는 이동할 곳 이름` : "이동할 곳 또는 명령 이름"} aria-expanded="true"
            aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={ordered.length ? optionId(current) : undefined}
            placeholder={search ? "검색하거나 이동할 곳 이름" : "이동할 곳이나 명령 이름"} value={query} spellCheck={false} autoComplete="off"
            onChange={(event) => { setQuery(event.target.value); setActiveId(null); }} onKeyDown={onKeyDown} />
        </div>
        <div ref={listRef} id={`${id}-list`} className="command-palette__list" role="listbox" aria-label={search ? "검색, 이동과 명령" : "이동과 명령"}>
          {ordered.length === 0 && <p className="command-palette__empty">일치하는 이름이 없습니다.</p>}
          {GROUP_ORDER.map((group) => {
            const items = ordered.filter((entry) => entry.group === group);
            if (!items.length) return null;
            return <div key={group} role="group" aria-labelledby={`${id}-${group}`} className="command-palette__group">
              <div id={`${id}-${group}`} className="command-palette__heading" role="presentation">{NAVIGATION_GROUP_LABELS[group]}</div>
              {items.map((entry) => {
                index += 1;
                const own = index;
                return <div key={entry.id} id={optionId(own)} role="option" aria-selected={own === current}
                  aria-label={entry.count === undefined ? (entry.context ? `${entry.label} · ${entry.context}` : undefined) : `${entry.label} ${entry.count.toLocaleString("ko-KR")}개`}
                  aria-current={entry.selected ? "page" : undefined}
                  className="command-palette__option" onPointerMove={() => { if (own !== current) setActive(own); }}
                  onMouseDown={(event) => event.preventDefault()} onClick={() => run(entry)}>
                  <span className="command-palette__icon" aria-hidden="true">{entry.icon}</span>
                  <span className="command-palette__label">{entry.label}</span>
                  {entry.context && <span className="command-palette__meta command-palette__context">{entry.context}</span>}
                  {entry.activity && <span className="command-palette__meta">{entry.activity}</span>}
                  {entry.count !== undefined && <span className="command-palette__count">{entry.count.toLocaleString("ko-KR")}</span>}
                </div>;
              })}
            </div>;
          })}
        </div>
        <div id={`${id}-hint`} className="command-palette__foot">
          <span><kbd>↑↓</kbd> 선택 <kbd>Enter</kbd> 열기 <kbd>Esc</kbd> 닫기</span>
          <span>{search ? `${search.info.scope}에서 검색하거나 이름으로 이동합니다` : "이 화면은 검색이 없어 이름으로 이동만 합니다"}</span>
        </div>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}
