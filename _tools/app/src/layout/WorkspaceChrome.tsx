import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { AdjustmentsHorizontalIcon } from "../shared/ui/ArchiveIcons";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import type { ChromeSearchSpec } from "./ChromeSearch";
import "../styles/chrome.css";
import { ChromeContext, useWorkspaceChrome, type Slot, type Targets, type ChromeMeta, type ChromeSearchActions, type ChromeSearchInfo } from "./WorkspaceChromeContext";

/** A view-specific search editor; `content` renders in the index head, `open` lets the 찾기 palette open it. */
export type ChromeSearchSurfaceSpec = ChromeSearchSpec & { open: (draft: string) => void; content: ReactNode };
export type ViewChromeSpec = {
  navigation?: ReactNode;
  actions?: ReactNode;
  settings?: ReactNode;
  summary?: string;
  /** Plain text search: applied from the 찾기 palette (Ctrl+K / Ctrl+F); there is no separate editor. */
  search?: ChromeSearchSpec;
  searchSurface?: ChromeSearchSurfaceSpec;
  status?: ReactNode;
};
export function WorkspaceChromeProvider({ scope, children }: PropsWithChildren<{ scope: string }>) {
  const [targets, setTargets] = useState<Targets>({ navigation: null, actions: null, search: null, settings: null, header: null, details: null });
  const [registration, setRegistration] = useState<ChromeMeta | null>(null);
  const setTarget = useCallback((slot: Slot, element: HTMLElement | null) => {
    setTargets((current) => current[slot] === element ? current : { ...current, [slot]: element });
  }, []);
  const publish = useCallback((next: ChromeMeta) => {
    setRegistration((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  }, []);
  const unpublish = useCallback((owner: string) => {
    setRegistration((current) => current?.owner === owner ? null : current);
  }, []);
  const meta = registration?.scope === scope ? registration : null;
  const searchActions = useRef(new Map<string, ChromeSearchActions>());
  const setSearchActions = useCallback((owner: string, actions: ChromeSearchActions | null) => {
    if (actions) searchActions.current.set(owner, actions); else searchActions.current.delete(owner);
  }, []);
  const owner = meta?.search ? meta.owner : null;
  const applySearch = useCallback((query: string) => { if (owner) searchActions.current.get(owner)?.apply?.(query); }, [owner]);
  const openSearch = useCallback((draft: string) => { if (owner) searchActions.current.get(owner)?.open?.(draft); }, [owner]);
  const value = useMemo(() => ({ scope, targets, setTarget, publish, unpublish, meta, setSearchActions, applySearch, openSearch }),
    [scope, targets, setTarget, publish, unpublish, meta, setSearchActions, applySearch, openSearch]);
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

/** Stable DOM destinations; view components keep their state and callbacks. */
export function ChromeTarget({ name, className = "" }: { name: Slot; className?: string }) {
  const chrome = useWorkspaceChrome();
  const setTarget = chrome?.setTarget;
  const attach = useCallback((element: HTMLDivElement | null) => setTarget?.(name, element), [name, setTarget]);
  return <div ref={attach} className={className} data-chrome-slot={name} />;
}

export function ChromeContribution({ title, spec }: { title: string; spec: ViewChromeSpec }) {
  const chrome = useWorkspaceChrome();
  const owner = useId();
  const publish = chrome?.publish, unpublish = chrome?.unpublish, scope = chrome?.scope;
  const hasSettings = Boolean(spec.settings), hasNavigation = Boolean(spec.navigation);
  const hasActions = Boolean(spec.actions);
  const searchSpec = spec.searchSurface ?? spec.search;
  const searchKind = spec.searchSurface ? "surface" : spec.search ? "query" : null;
  const searchScope = searchSpec?.scope, searchLabel = searchSpec?.label, searchQuery = searchSpec?.query;
  const summary = spec.summary ?? "현재 화면의 표시 설정";
  useLayoutEffect(() => {
    const search: ChromeSearchInfo | null = searchKind ? { kind: searchKind, scope: searchScope ?? "", label: searchLabel ?? "", query: searchQuery ?? "" } : null;
    if (scope !== undefined) publish?.({ owner, scope, title, summary, settings: hasSettings, navigation: hasNavigation, actions: hasActions, search });
  }, [publish, owner, scope, title, summary, hasSettings, hasNavigation, hasActions, searchKind, searchScope, searchLabel, searchQuery]);
  useLayoutEffect(() => () => unpublish?.(owner), [unpublish, owner]);
  // Callbacks change identity every render; keep the latest ones without republishing.
  const setSearchActions = chrome?.setSearchActions;
  const apply = searchSpec?.onApply, open = spec.searchSurface?.open;
  useLayoutEffect(() => { setSearchActions?.(owner, apply || open ? { apply, open } : null); }, [setSearchActions, owner, apply, open]);
  useLayoutEffect(() => () => setSearchActions?.(owner, null), [setSearchActions, owner]);
  if (!chrome) return null;
  const targets = chrome.targets;
  return <>
    {targets.navigation && spec.navigation && createPortal(spec.navigation, targets.navigation)}
    {targets.actions && spec.actions && createPortal(spec.actions, targets.actions)}
    {targets.search && spec.searchSurface && createPortal(spec.searchSurface.content, targets.search)}
    {targets.settings && spec.settings && createPortal(<div className="chrome-settings-controls" onClick={(event) => event.stopPropagation()}>{spec.settings}</div>, targets.settings)}
  </>;
}

export function ChromeSettingsDock() {
  const chrome = useWorkspaceChrome();
  const [openScope, setOpenScope] = useState<string | null>(null);
  const scope = chrome?.scope;
  useLayoutEffect(() => setOpenScope(null), [scope]);
  if (!chrome) return null;
  const enabled = Boolean(chrome.meta?.settings);
  const open = enabled && openScope === chrome.scope;
  return <div className="workspace-settings-dock" hidden={!enabled}>
    <AnchoredPanel open={open} onOpenChange={(next) => setOpenScope(next ? chrome.scope : null)}
      title="보기 설정"
      trigger={<button type="button" className="workspace-settings-toggle" disabled={!enabled} aria-label="보기 설정" aria-description={enabled ? chrome.meta?.summary : "이 화면에는 보기 설정이 없습니다"}>
        <AdjustmentsHorizontalIcon aria-hidden="true" />
        <span><strong>보기 설정</strong></span>
        <ChevronRightIcon aria-hidden="true" className="workspace-settings-toggle__arrow" />
      </button>}
    >
      <ChromeTarget name="settings" />
    </AnchoredPanel>
  </div>;
}
