import { createContext, useContext } from "react";

export type Slot = "navigation" | "actions" | "search" | "settings" | "header" | "details";
export type Targets = Record<Slot, HTMLElement | null>;
/**
 * What the 찾기 palette may offer for the current view. "query" applies typed text directly;
 * "surface" opens the view's own search editor (e.g. the online catalog with tag suggestions).
 */
export type ChromeSearchInfo = { kind: "query" | "surface"; scope: string; label: string; query: string };
export type ChromeMeta = { owner: string; scope: string; title: string; summary: string; settings: boolean; navigation: boolean; actions: boolean; search: ChromeSearchInfo | null };
export type ChromeSearchActions = { apply?: (query: string) => void; open?: (draft: string) => void };
type ChromeContextValue = {
  scope: string;
  targets: Targets;
  setTarget: (slot: Slot, element: HTMLElement | null) => void;
  publish: (meta: ChromeMeta) => void;
  unpublish: (owner: string) => void;
  meta: ChromeMeta | null;
  /** Latest search callbacks per contribution owner; kept out of `meta` so it stays serializable. */
  setSearchActions: (owner: string, actions: ChromeSearchActions | null) => void;
  applySearch: (query: string) => void;
  openSearch: (draft: string) => void;
};

// Keep the context identity independent of Fast Refresh component updates,
// including consumers loaded later through React.lazy.
export const ChromeContext = createContext<ChromeContextValue | null>(null);
export const useWorkspaceChrome = () => useContext(ChromeContext);
