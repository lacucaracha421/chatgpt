import { createContext, useContext } from "react";

export type Slot = "navigation" | "actions" | "search" | "settings" | "header";
export type Targets = Record<Slot, HTMLElement | null>;
export type ChromeMeta = { owner: string; scope: string; title: string; summary: string; settings: boolean; navigation: boolean; actions: boolean; search: boolean };
type ChromeContextValue = {
  scope: string;
  targets: Targets;
  setTarget: (slot: Slot, element: HTMLElement | null) => void;
  publish: (meta: ChromeMeta) => void;
  unpublish: (owner: string) => void;
  meta: ChromeMeta | null;
};

// Keep the context identity independent of Fast Refresh component updates,
// including consumers loaded later through React.lazy.
export const ChromeContext = createContext<ChromeContextValue | null>(null);
export const useWorkspaceChrome = () => useContext(ChromeContext);
