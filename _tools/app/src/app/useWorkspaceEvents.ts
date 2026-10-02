import { useEffect, useLayoutEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AssetView, IngestOutcome } from "../library/types";
import { ALBUM_AUTHORITY_CHANGED_EVENT } from "./useAlbumAuthoritySync";
import { CLASSIFICATION_AUTHORITY_CHANGED_EVENT } from "./useClassificationAuthoritySync";
import { ASSET_LIFECYCLE_CHANGED_EVENT } from "./useAssetAuthoritySync";
import { sameAssetIds, type SidebarDropTarget } from "./workspaceDragTargets";

export type ExtensionIngestListener = (handler: (outcome: IngestOutcome) => void) => Promise<() => void>;

export const subscribeToExtensionIngest: ExtensionIngestListener = async (handler) =>
  listen<IngestOutcome>("extension://ingestion", (event) => handler(event.payload));

export function useWorkspaceAuthorityEvents({ refreshAlbums, refreshClassifications, refreshTrashCount, setAssetRefresh, setVideoPreparationTrigger }: {
  refreshAlbums: () => Promise<void>;
  refreshClassifications: () => Promise<void>;
  refreshTrashCount: () => Promise<void>;
  setAssetRefresh: Dispatch<SetStateAction<number>>;
  setVideoPreparationTrigger: Dispatch<SetStateAction<number>>;
}) {
  // A remote Album change lands in the local replica without a local action, so both the
  // sidebar and the visible AssetBrowser have to re-read it; the sync loop announces only
  // passes whose result actually changed local Album state. The asset refresh matters for
  // membership changes: Album metadata/counts can look identical while the set of Assets
  // in the open Album gallery has changed underneath.
  useEffect(() => {
    const refresh = () => {
      void refreshAlbums();
      setAssetRefresh((current) => current + 1);
    };
    window.addEventListener(ALBUM_AUTHORITY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ALBUM_AUTHORITY_CHANGED_EVENT, refresh);
  }, [refreshAlbums]);
  // A remote Classification change lands in the local replica without a local action, so
  // the sidebar and any open Classification view have to re-read it. The asset refresh
  // matters for assignment changes: the Classification list can look identical while the
  // set of Assets in the open folder has changed underneath.
  useEffect(() => {
    const refresh = () => {
      void refreshClassifications();
      setAssetRefresh((current) => current + 1);
    };
    window.addEventListener(CLASSIFICATION_AUTHORITY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CLASSIFICATION_AUTHORITY_CHANGED_EVENT, refresh);
  }, [refreshClassifications]);
  // A trash or restore from another device changes the trash count without a local action.
  // Assets materialized from the server (e.g. a video saved on mobile) arrive the same way
  // and need their preview prepared, which nothing else would start.
  useEffect(() => {
    const refresh = () => {
      void refreshTrashCount().catch(() => undefined);
      setAssetRefresh((current) => current + 1);
      setVideoPreparationTrigger((current) => current + 1);
    };
    window.addEventListener(ASSET_LIFECYCLE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ASSET_LIFECYCLE_CHANGED_EVENT, refresh);
  }, [refreshTrashCount]);
}

export function useExtensionIngest(subscribeExtensionIngest: ExtensionIngestListener, handleIngested: (outcome: IngestOutcome) => void) {
  const handleIngestedRef = useRef(handleIngested);
  useLayoutEffect(() => { handleIngestedRef.current = handleIngested; }, [handleIngested]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void subscribeExtensionIngest((outcome) => {
      if (!active) return;
      handleIngestedRef.current(outcome);
    }).then((stop) => { if (active) unlisten = stop; else stop(); }).catch(() => undefined);
    return () => { active = false; unlisten?.(); };
  }, [subscribeExtensionIngest]);
}

export function useNativeDragEnd(activeNativeDragAssetIdsRef: RefObject<string[] | null>, setDragTarget: Dispatch<SetStateAction<SidebarDropTarget | null>>) {
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    let clearTimer: number | null = null;
    void listen<string[]>("asset-drag://ended", (event) => {
      if (!active) return;
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        clearTimer = null;
        if (!sameAssetIds(activeNativeDragAssetIdsRef.current, event.payload)) return;
        activeNativeDragAssetIdsRef.current = null;
        setDragTarget(null);
      }, 100);
    }).then((stop) => { if (active) unlisten = stop; else stop(); }).catch(() => undefined);
    return () => {
      active = false;
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      unlisten?.();
    };
  }, []);
}

export function useWorkspaceShortcuts(view: AssetView, navigateView: (next: AssetView) => void, setCreateClassificationRequest: Dispatch<SetStateAction<number>>) {
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      if (editing || !event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        if (["collections", "collection", "manga", "settings", "trash", "similarity_review"].includes(view.kind)) navigateView({ kind: "classification", classificationId: null });
        setCreateClassificationRequest((current) => current + 1);
        return;
      }
      if (key === "1" || key === "2") {
        event.preventDefault();
        const quickViews: AssetView[] = [
          { kind: "classification", classificationId: null },
          { kind: "unsorted" },
        ];
        navigateView(quickViews[Number(key) - 1]);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [view]);
}
