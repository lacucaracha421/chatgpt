import { useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { AssetSummary } from "../library/types";
import type { SelectionState } from "./selection";

/** A menu target never becomes a selection, including when opening its information panel. */
export function useAssetContextTarget(items: AssetSummary[], selection: SelectionState, scope: string) {
  const [target, setTarget] = useState<{ id: string; ids: string[]; scope: string } | null>(null);
  const [info, setInfo] = useState<{ ids: string[]; selection: SelectionState; scope: string } | null>(null);
  const current = target?.scope === scope ? target : null;
  const targetIds = current?.ids ?? items.filter(asset => selection.ids.has(asset.id)).map(asset => asset.id);
  const targetIdSet = new Set(targetIds);
  const targetAssets = items.filter(asset => targetIdSet.has(asset.id));
  const infoIds = new Set(info?.ids);
  const infoAssets = info?.scope === scope && info.selection.ids === selection.ids && info.selection.focusId === selection.focusId
    ? items.filter(asset => infoIds.has(asset.id)) : null;

  return {
    targetId: current?.id ?? null,
    targetIds,
    targetAssets,
    targetsSelection: !current || selection.ids.has(current.id),
    infoAssets,
    showInfo: () => setInfo({ ids: [...targetIds], selection, scope }),
    onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
      // Right-click must not move keyboard focus and leave its mark behind after dismissal.
      if (event.button === 2 && (event.target as HTMLElement).closest("[data-asset-id]")) event.preventDefault();
    },
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      const id = (event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]")?.dataset.assetId;
      if (!id || !items.some(asset => asset.id === id)) { event.preventDefault(); return; }
      setTarget({ id, ids: selection.ids.has(id) ? items.filter(asset => selection.ids.has(asset.id)).map(asset => asset.id) : [id], scope });
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]");
      if (!tile) return;
      event.preventDefault();
      const rect = tile.getBoundingClientRect();
      tile.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    },
    onOpenChange: (open: boolean) => { if (!open) setTarget(null); },
  };
}
