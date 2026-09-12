import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { AdjustmentsHorizontalIcon } from "../shared/ui/ArchiveIcons";
import { useCallback, useId, useLayoutEffect, useMemo, useState, type PropsWithChildren, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnchoredPanel } from "../shared/ui/AnchoredPanel";
import { ChromeSearch, type ChromeSearchSpec } from "./ChromeSearch";
import "../styles/chrome.css";
import { ChromeContext, useWorkspaceChrome, type Slot, type Targets, type ChromeMeta } from "./WorkspaceChromeContext";
export type ViewChromeSpec = {
  navigation?: ReactNode;
  actions?: ReactNode;
  settings?: ReactNode;
  summary?: string;
  search?: ChromeSearchSpec;
  searchSurface?: ReactNode;
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
  const value = useMemo(() => ({ scope, targets, setTarget, publish, unpublish, meta }), [scope, targets, setTarget, publish, unpublish, meta]);
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
  const hasActions = Boolean(spec.actions), hasSearch = Boolean(spec.search || spec.searchSurface);
  const summary = spec.summary ?? "현재 화면의 표시 설정";
  useLayoutEffect(() => {
    if (scope !== undefined) publish?.({ owner, scope, title, summary, settings: hasSettings, navigation: hasNavigation, actions: hasActions, search: hasSearch });
  }, [publish, owner, scope, title, summary, hasSettings, hasNavigation, hasActions, hasSearch]);
  useLayoutEffect(() => () => unpublish?.(owner), [unpublish, owner]);
  if (!chrome) return null;
  const targets = chrome.targets;
  return <>
    {targets.navigation && spec.navigation && createPortal(spec.navigation, targets.navigation)}
    {targets.actions && spec.actions && createPortal(spec.actions, targets.actions)}
    {targets.search && (spec.searchSurface ? createPortal(spec.searchSurface, targets.search) : spec.search ? createPortal(<ChromeSearch {...spec.search} />, targets.search) : null)}
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
