import { BusyLabel } from "../shared/ui/BusyLabel";
import { useMotionSurface } from "../shared/ui/useMotionSurface";
import {AssetImage} from "../privacy/AssetImage";
import {FindEntryContent} from "../shared/FindEntryContent";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useEffect, useId, useLayoutEffect, useRef, useState, useDeferredValue, useMemo, type KeyboardEvent } from "react";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { MagnifyingGlassIcon } from "../shared/ui/ArchiveIcons";
import { modalDialogOpen } from "./modalDialog";
import type { ChromeSearchInfo } from "./WorkspaceChromeContext";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { FIND_SCOPES, findGroups, GROUP_LIMIT, readRecent, rememberRecent, type FindScope } from "./findModel";
import { NAVIGATION_GROUP_LABELS, type NavigationEntry, type NavigationEntryGroup } from "./navigationEntries";

export type PaletteSearch = { info: ChromeSearchInfo; apply: (query: string) => void; open: (draft: string) => void };

/** Rows for the current view's own search. None when the view has no search (pc-design-reference §5). */
function searchEntries(search: PaletteSearch | null | undefined, text: string): NavigationEntry[] {
  if (!search) return [];
  const { info } = search;
  const typed = text.trim();
  const rows: NavigationEntry[] = [];
  if (info.kind === "query" && typed) {
    rows.push({ id: "search-apply", group: "search", label: `${info.scope}에서 ‘${typed}’ 검색`, icon: <MagnifyingGlassIcon />, run: () => search.apply(typed) });
  } else if (info.kind === "surface") {
    rows.push({ id: "search-open", group: "search", label: typed ? `${info.scope}에서 ‘${typed}’ 검색` : `${info.scope} 검색 열기`, icon: <MagnifyingGlassIcon />, run: () => search.open(typed) });
  }
  if (info.query.trim()) {
    rows.push({ id: "search-clear", group: "search", label: "검색 해제", icon: <XMarkIcon />, activity: `‘${info.query.trim()}’`, run: () => search.apply("") });
  }
  return rows;
}

/** Device-local names and the current screen's existing search contract. */
export function CommandPalette({ open, onClose, entries, search, findPlaces, findTags, fallbackFocus, recentKey = "workspace", loading = false, error }: {
  open: boolean; onClose: () => void; entries: NavigationEntry[]; search?: PaletteSearch | null;
  findPlaces?: (query: string) => NavigationEntry[]; findTags?: (query: string) => NavigationEntry[];
  fallbackFocus?: () => HTMLElement | null; recentKey?: string; loading?: boolean; error?: string | null;
}) {
  const { privacyMode } = usePrivacy();
  const surfaceRef = useMotionSurface("dialog");
  const scrimRef = useMotionSurface("scrim");
  const [scope, setScope] = useState<FindScope>("전체");
  const [expanded, setExpanded] = useState<NavigationEntryGroup[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
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
    setScope("전체");
    setExpanded([]);
    setRecentIds(readRecent(recentKey));
    setActiveId(null);
  }, [open, recentKey]);

  // Deferred filtering leaves the last complete list painted while typing stays immediate.
  const filteredQuery = useDeferredValue(query);
  const groups = useMemo(() => findGroups([
    ...searchEntries(search, filteredQuery), ...(findTags?.(filteredQuery) ?? []),
    ...(findPlaces?.(filteredQuery) ?? []), ...entries,
  ], filteredQuery, scope, recentIds), [entries, search, findTags, findPlaces, filteredQuery, scope, recentIds]);
  const displayed = groups.map(({ group, items }) => ({ group, items: [
    ...(expanded.includes(group) ? items : items.slice(0, GROUP_LIMIT)),
    ...(items.length > GROUP_LIMIT ? [{ id: `find-expand-${group}`, group,
      label: expanded.includes(group) ? "접기" : `${NAVIGATION_GROUP_LABELS[group]} ${items.length - GROUP_LIMIT}개 더 보기`, icon: null,
      run: () => setExpanded(previous => previous.includes(group) ? previous.filter(value => value !== group) : [...previous, group]),
    }] : []),
  ] }));
  const ordered = displayed.flatMap(({ items }) => items);
  const found = ordered.findIndex((entry) => entry.id === activeId);
  const current = found >= 0 ? found : 0;
  const setActive = (index: number) => setActiveId(ordered[index]?.id ?? null);
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    listRef.current?.querySelector(`[id="${optionId(current)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const run = (entry: NavigationEntry | undefined, alternate = false) => {
    if (!entry || query !== filteredQuery) return;
    if (entry.id.startsWith("find-expand-")) { entry.run(); return; }
    if (entry.group !== "search" && entry.group !== "action" && entry.group !== "tag") setRecentIds(rememberRecent(recentKey, entry.id));
    onClose();
    (alternate && entry.runAlternate ? entry.runAlternate : entry.run)();
  };
  const hasAlternate = ordered.some((entry) => entry.runAlternate);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Korean IME: Enter or arrows that confirm a composition must not run a command.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Tab") {
      event.preventDefault();
      setScope(FIND_SCOPES[(FIND_SCOPES.indexOf(scope) + (event.shiftKey ? FIND_SCOPES.length - 1 : 1)) % FIND_SCOPES.length]);
      setExpanded([]);
      setActiveId(null);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
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
      run(ordered[current], event.shiftKey);
    }
  };

  let index = -1;
  return <RadixDialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <RadixDialog.Portal>
      <RadixDialog.Overlay ref={scrimRef} className="ui-dialog__overlay command-palette__overlay" />
      <RadixDialog.Content ref={surfaceRef} className="command-palette" aria-describedby={`${id}-hint`}
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
          <input autoFocus type="text" role="combobox" aria-label="작품, 작가, 메모 제목, 폴더, 화면 또는 명령 이름" aria-expanded="true"
            aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={ordered.length ? optionId(current) : undefined}
            placeholder="작품, 작가, 메모, 폴더 찾기" value={query} spellCheck={false} autoComplete="off"
            onChange={(event) => { setQuery(event.target.value); setExpanded([]); setActiveId(null); }} onKeyDown={onKeyDown} />
        </div>
        <div className="command-palette__scopes" role="group" aria-label="찾기 범위">
          {FIND_SCOPES.map(name => <Button key={name} size="sm" variant="ghost" aria-pressed={scope === name}
            onMouseDown={event => event.preventDefault()} onClick={() => { setScope(name); setExpanded([]); setActiveId(null); }}>{name}</Button>)}
        </div>
        <div ref={listRef} id={`${id}-list`} className="command-palette__list" role="listbox" aria-label="찾기 결과" aria-busy={loading || query !== filteredQuery}>
          <BusyLabel busy={loading && ordered.length === 0} idle={!loading && ordered.length === 0 && <p className="command-palette__empty">{query.trim() ? "일치하는 이름이 없습니다." : "확인할 것과 최근 연 항목이 없습니다."}</p>}><p className="command-palette__empty">이름을 불러오는 중…</p></BusyLabel>
          {displayed.map(({ group, items }) => {
            return <div key={group} role="group" aria-labelledby={`${id}-${group}`} className="command-palette__group">
              <div id={`${id}-${group}`} className="command-palette__heading" role="presentation">{NAVIGATION_GROUP_LABELS[group]}</div>
              {items.map((entry) => {
                index += 1;
                const own = index;
                return <div key={entry.id} id={optionId(own)} role="option" aria-selected={own === current}
                  aria-label={entry.count === undefined ? (entry.context ? `${entry.label} · ${entry.context}` : undefined) : `${entry.label} ${entry.count.toLocaleString("ko-KR")}개`}
                  aria-current={entry.selected ? "page" : undefined}
                  className="command-palette__option" onPointerMove={() => { if (own !== current) setActive(own); }}
                  onMouseDown={(event) => event.preventDefault()} onClick={(event) => run(entry, event.shiftKey)}>
                  <FindEntryContent entry={entry} query={filteredQuery} privacy={privacyMode} media={entry.thumbnail && entry.group !== "work" ? <AssetImage src={entry.thumbnail} alt=""/> : undefined}/>
                </div>;
              })}
            </div>;
          })}
        </div>
        {error && <p role="status" className="command-palette__empty">{error}</p>}
        <div id={`${id}-hint`} className="command-palette__foot">
          <span><kbd>↑↓</kbd> 선택 <kbd>Enter</kbd> 열기{hasAlternate && <> <kbd>Shift</kbd>+<kbd>Enter</kbd> 태그 제외</>} <kbd>Esc</kbd> 닫기</span>
          <span><kbd>Tab</kbd> 범위 바꾸기</span>
        </div>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}
