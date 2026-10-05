import { ChevronRightIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PropsWithChildren, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import type { ChromeSearchSpec } from "./ChromeSearch";
import "../styles/chrome.css";
import { ChromeContext, ChromePresenceContext, useWorkspaceChrome, type Slot, type Targets, type ChromeMeta, type ChromeSearchActions, type ChromeSearchInfo } from "./WorkspaceChromeContext";
import { startViewSwap, swapSearchResults, viewTransitionRunning, type ViewSwap } from "../shared/motion/viewSwap";
import { reducedMotion } from "../shared/motion/curves";

/** A view-specific search editor; `content` renders in the index head, `open` lets the 찾기 palette open it. */
export type ChromeSearchSurfaceSpec = ChromeSearchSpec & { open: (draft: string) => void; content: ReactNode };
export type ViewChromeSpec = {
  navigation?: ReactNode;
  actions?: ReactNode;
  settings?: ReactNode;
  summary?: string;
  /** Plain text search: applied from the 찾기 palette (Ctrl+Q); there is no separate editor. */
  search?: ChromeSearchSpec;
  searchSurface?: ChromeSearchSurfaceSpec;
  status?: ReactNode;
};
const INDEX_HIDDEN_KEY = "lakomics.workspace.indexHidden.v1";
/** 망가 opens with its sidebar closed until the user shows it (user, 2026-10-05); a stored choice wins. */
const INDEX_HIDDEN_DEFAULT: Record<string, boolean> = { manga: true };
/**
 * A user show/hide runs the area switch's view transition (viewTransitions.css): the sidebar fades in or out
 * under the content, whose box moves to its new place and width as one piece (user, 2026-10-05).
 */
const AREA_VIEW_TRANSITION = "data-area-view-transition";
const INDEX_TOGGLE_TRANSITION = "index";
function readIndexHidden(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(INDEX_HIDDEN_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, hidden]) => typeof hidden === "boolean"));
  } catch {
    return {};
  }
}
export function WorkspaceChromeProvider({ scope, pending = false, children }: PropsWithChildren<{ scope: string; pending?: boolean }>) {
  const [storedIndexHidden, updateIndexHidden] = useState(readIndexHidden);
  // Areas without a stored choice use their default; consumers read `indexHidden[area] === true`.
  const indexHidden = useMemo(() => ({ ...INDEX_HIDDEN_DEFAULT, ...storedIndexHidden }), [storedIndexHidden]);
  // The latest requested choice: a second toggle before the first one's snapshot commits wins.
  const requestedIndexHidden = useRef(storedIndexHidden);
  const indexSwap = useRef<ViewSwap | null>(null);
  useEffect(() => () => indexSwap.current?.cancel(), []);
  const setIndexHidden = useCallback((area: string, hidden: boolean) => {
    // The choice is stored explicitly, so a shown 망가 sidebar stays shown despite its closed default.
    const next = { ...requestedIndexHidden.current, [area]: hidden };
    requestedIndexHidden.current = next;
    try { localStorage.setItem(INDEX_HIDDEN_KEY, JSON.stringify(next)); } catch { /* Keep the toggle usable when storage is unavailable. */ }
    // A toggle still running ends at once; one whose snapshot has not committed drops its commit.
    indexSwap.current?.cancel();
    indexSwap.current = null;
    const commit = () => updateIndexHidden(requestedIndexHidden.current);
    // Reduced motion, or another view transition owning the document (an area switch): switch at once.
    const swap = reducedMotion() || viewTransitionRunning() ? null
      : startViewSwap({ attribute: AREA_VIEW_TRANSITION, value: INDEX_TOGGLE_TRANSITION, commit });
    if (!swap) { commit(); return; }
    indexSwap.current = swap;
    void swap.finished.then(() => { if (indexSwap.current === swap) indexSwap.current = null; });
  }, []);
  const [targets, setTargets] = useState<Targets>({ navigation: null, actions: null, search: null, settings: null, header: null, details: null });
  const [registrations, setRegistrations] = useState<ChromeMeta[]>([]);
  const setTarget = useCallback((slot: Slot, element: HTMLElement | null) => {
    setTargets((current) => current[slot] === element ? current : { ...current, [slot]: element });
  }, []);
  const publish = useCallback((next: ChromeMeta) => {
    setRegistrations((current) => JSON.stringify(current.find(item => item.scope === next.scope)) === JSON.stringify(next)
      ? current : [...current.filter(item => item.scope !== next.scope && item.owner !== next.owner), next]);
  }, []);
  const unpublish = useCallback((owner: string) => {
    setRegistrations((current) => current.some(item => item.owner === owner) ? current.filter(item => item.owner !== owner) : current);
  }, []);
  const getMeta = useCallback((targetScope: string) => registrations.find(item => item.scope === targetScope) ?? null, [registrations]);
  const meta = getMeta(scope);
  const searchActions = useRef(new Map<string, ChromeSearchActions>());
  const setSearchActions = useCallback((owner: string, actions: ChromeSearchActions | null) => {
    if (actions) searchActions.current.set(owner, actions); else searchActions.current.delete(owner);
  }, []);
  const owner = meta?.search ? meta.owner : null;
  // The shown results change with the search swap (old stay painted until the new commit).
  const applySearch = useCallback((query: string) => { const apply = owner ? searchActions.current.get(owner)?.apply : undefined; if (apply) swapSearchResults(() => apply(query)); }, [owner]);
  const openSearch = useCallback((draft: string) => { if (owner) searchActions.current.get(owner)?.open?.(draft); }, [owner]);
  const findAction = useRef<(() => void) | null>(null);
  const setFindAction = useCallback((action: (() => void) | null) => { findAction.current = action; }, []);
  const openFind = useCallback(() => findAction.current?.(), []);
  const value = useMemo(() => ({ openFind, setFindAction, scope, pending, targets, setTarget, publish, unpublish, meta, getMeta, setSearchActions, applySearch, openSearch, indexHidden, setIndexHidden }),
    [openFind, setFindAction, scope, pending, targets, setTarget, publish, unpublish, meta, getMeta, setSearchActions, applySearch, openSearch, indexHidden, setIndexHidden]);
  return <ChromeContext.Provider value={value}><ChromePresenceContext.Provider value>{children}</ChromePresenceContext.Provider></ChromeContext.Provider>;
}

/** Stable DOM destinations; view components keep their state and callbacks. */
export function ChromeTarget({ name, className = "" }: { name: Slot; className?: string }) {
  const chrome = useWorkspaceChrome();
  const setTarget = chrome?.setTarget;
  const attach = useCallback((element: HTMLDivElement | null) => setTarget?.(name, element), [name, setTarget]);
  return <div ref={attach} className={className} data-chrome-slot={name} inert={chrome?.pending || undefined} />;
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
        <Squares2X2Icon aria-hidden="true" />
        <span><strong>보기 설정</strong></span>
        <ChevronRightIcon aria-hidden="true" className="workspace-settings-toggle__arrow" />
      </button>}
    >
      <ChromeTarget name="settings" />
    </AnchoredPanel>
  </div>;
}
