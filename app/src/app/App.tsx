import { useCallback, useEffect, useRef, useState } from "react";
import { AssetBrowser, type AssetBrowserStatus } from "../assets/AssetBrowser";
import { ClassificationSidebar } from "../classification/ClassificationSidebar";
import {
  type DropSubscriber,
  type FileDropResult,
  subscribeToTauriDrops,
  useFileDrop,
} from "../ingestion/useFileDrop";
import { AppShell } from "../layout/AppShell";
import { StatusBar } from "../layout/StatusBar";
import { libraryGateway } from "../library/client";
import { commandErrorMessage } from "../library/errorMessage";
import { LibraryProvider, useLibrary } from "../library/LibraryContext";
import {
  LibrarySetup,
  selectLibraryFolder,
  type FolderPicker,
} from "../library/LibrarySetup";
import type { AssetSort, AssetView, ClassificationEntry, LibraryGateway } from "../library/types";
import {
  loadUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from "../preferences/uiPreferences";
import { Toast } from "../shared/ui/Toast";
import { DragLayer } from "../shared/ui/DragLayer";
import { pointerDragReducer, type ClassificationDropPosition, type ClassificationDropTarget, type InternalDragPayload, type PointerDragState } from "../shared/interaction/pointerDrag";
import { SafetyDialog } from "../safety/SafetyDialog";
import { TrashBrowser } from "../safety/TrashBrowser";

type AppProps = {
  gateway?: LibraryGateway;
  selectFolder?: FolderPicker;
  subscribeDrops?: DropSubscriber;
};

export function App({
  gateway = libraryGateway,
  selectFolder = selectLibraryFolder,
  subscribeDrops = subscribeToTauriDrops,
}: AppProps) {
  return (
    <LibraryProvider gateway={gateway}>
      <LibraryScreen selectFolder={selectFolder} subscribeDrops={subscribeDrops} />
    </LibraryProvider>
  );
}

function LibraryScreen({
  selectFolder,
  subscribeDrops,
}: {
  selectFolder: FolderPicker;
  subscribeDrops: DropSubscriber;
}) {
  const { library } = useLibrary();

  return library
    ? <LibraryWorkspace subscribeDrops={subscribeDrops} />
    : <LibrarySetup selectFolder={selectFolder} />;
}

function LibraryWorkspace({ subscribeDrops }: { subscribeDrops: DropSubscriber }) {
  const { gateway } = useLibrary();
  const [entries, setEntries] = useState<ClassificationEntry[]>([]);
  const [view, setView] = useState<AssetView>({
    kind: "classification",
    classificationId: null,
  });
  const [preferences, setPreferences] = useState<UiPreferences>(loadUiPreferences);
  const [message, setMessage] = useState<string | null>(null);
  const [assetRefresh, setAssetRefresh] = useState(0);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [maintenance, setMaintenance] = useState<"restore" | null>(null);
  const [browserStatus, setBrowserStatus] = useState<AssetBrowserStatus>({
    loadedCount: 0,
    selectedAsset: null,
    loading: true,
  });
  const [dragState, setDragState] = useState<PointerDragState>({ phase: "idle" });
  const dragStateRef = useRef<PointerDragState>({ phase: "idle" });
  const [dragTarget, setDragTarget] = useState<ClassificationDropTarget | null>(null);
  const appendMessage = useCallback((next: string) => {
    setMessage((current) => current ? `${current} ${next}` : next);
  }, []);
  const refreshClassifications = useCallback(async () => {
    setEntries(await gateway.listClassifications());
  }, [gateway]);
  const handleDropResult = useCallback((result: FileDropResult) => {
    setMessage(result.message);
    if (result.status === "added") setAssetRefresh((current) => current + 1);
  }, []);
  const dropEnabled = maintenance === null && view.kind === "classification" && view.classificationId !== null;
  const progress = useFileDrop({
    subscribe: subscribeDrops,
    enabled: dropEnabled,
    classificationId: view.kind === "classification" ? view.classificationId : null,
    ingestImage: gateway.ingestImage,
    onResult: handleDropResult,
  });

  useEffect(() => {
    void refreshClassifications();
  }, [refreshClassifications]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await gateway.ensureDailyBackup();
      } catch (error) {
        if (active) appendMessage(commandErrorMessage(error, "관리 정보 자동 백업에 실패했습니다."));
      }
      try {
        const result = await gateway.purgeExpiredTrash();
        if (active && result.failedAssetIds.length > 0) {
          appendMessage(`자동 삭제하지 못한 자산이 ${result.failedAssetIds.length}개 있습니다.`);
        }
      } catch (error) {
        if (active) appendMessage(commandErrorMessage(error, "휴지통 자동 정리를 실행하지 못했습니다."));
      }
    })();
    return () => { active = false; };
  }, [appendMessage, gateway]);
  useEffect(() => {
    saveUiPreferences(preferences);
  }, [preferences]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    document.body.classList.toggle("is-pointer-dragging", dragState.phase === "dragging");
    return () => document.body.classList.remove("is-pointer-dragging");
  }, [dragState.phase]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || dragStateRef.current.phase === "idle") return;
      transitionDrag({ type: "cancel" });
      setDragTarget(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);

  function updatePreferences(update: Partial<UiPreferences>) {
    setPreferences((current) => ({ ...current, ...update }));
  }

  function transitionDrag(action: Parameters<typeof pointerDragReducer>[1]) {
    const next = pointerDragReducer(dragStateRef.current, action);
    dragStateRef.current = next;
    setDragState(next);
    return next;
  }

  function startPointerDrag(payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) {
    transitionDrag({ type: "arm", payload, x: event.clientX, y: event.clientY });
    setDragTarget(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function movePointerDrag(event: React.PointerEvent<HTMLElement>) {
    const next = transitionDrag({ type: "move", x: event.clientX, y: event.clientY });
    if (next.phase !== "dragging") return;
    event.preventDefault();
    setDragTarget(classificationTargetAt(event.clientX, event.clientY, next.payload, entries));
  }

  function cancelPointerDrag(event: React.PointerEvent<HTMLElement>) {
    transitionDrag({ type: "cancel" });
    setDragTarget(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function finishPointerDrag(event: React.PointerEvent<HTMLElement>) {
    const current = dragStateRef.current;
    const target = current.phase === "dragging"
      ? classificationTargetAt(event.clientX, event.clientY, current.payload, entries)
      : null;
    transitionDrag({ type: "finish" });
    setDragTarget(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!target?.valid || current.phase !== "dragging") return;
    void performInternalDrop(current.payload, target);
  }

  async function performInternalDrop(payload: InternalDragPayload, target: ClassificationDropTarget) {
    try {
      if (payload.kind === "assets") {
        await gateway.patchAssetClassifications({ assetIds: payload.assetIds, addClassificationIds: [target.entryId], removeClassificationIds: [] });
        setAssetRefresh((current) => current + 1);
        setMessage(`${payload.assetIds.length}개 자산을 분류했습니다.`);
        return;
      }
      const parentId = classificationDropParent(entries, target);
      await gateway.moveClassification(payload.entryId, parentId);
      await refreshClassifications();
      setMessage("분류를 이동했습니다.");
    } catch (error) {
      setMessage(commandErrorMessage(error, "드롭 작업을 완료하지 못했습니다."));
    }
  }

  async function restoreBackup(backupId: string) {
    if (maintenance) return;
    setMaintenance("restore");
    try {
      await gateway.restoreMetadataBackup(backupId);
      await refreshClassifications();
      setAssetRefresh((current) => current + 1);
      setSafetyOpen(false);
      setMessage("복구가 완료되었습니다. 다음 단계에서 파일 검사를 실행할 수 있습니다.");
    } finally {
      setMaintenance(null);
    }
  }

  return (
    <>
      <div className="library-workspace" inert={maintenance !== null ? true : undefined}>
        <AppShell
          sidebar={
            <ClassificationSidebar
              entries={entries}
              view={view}
              expandedIds={preferences.expandedClassificationIds}
              sidebarWidth={preferences.sidebarWidth}
              onViewChange={setView}
              onExpandedIdsChange={(expandedClassificationIds) =>
                updatePreferences({ expandedClassificationIds })
              }
              onSidebarWidthChange={(sidebarWidth) => updatePreferences({ sidebarWidth })}
              onChanged={() => void refreshClassifications()}
              onOpenSafety={() => setSafetyOpen(true)}
              dragTarget={dragTarget}
              onPointerDragStart={startPointerDrag}
              onPointerDragMove={movePointerDrag}
              onPointerDragEnd={finishPointerDrag}
              onPointerDragCancel={cancelPointerDrag}
            />
          }
          content={
            <div className="library-content">
              <section className="library-content__browser" aria-label="자산 내용">
                {view.kind === "trash" ? <TrashBrowser /> : (
                  <AssetBrowser
                    view={view}
                    classifications={entries}
                    sort={preferences.assetSort}
                    metadataVisible={preferences.metadataVisible}
                    thumbnailRowHeight={preferences.thumbnailRowHeight}
                    refreshVersion={assetRefresh}
                    onSortChange={(assetSort: AssetSort) => updatePreferences({ assetSort })}
                    onMetadataVisibleChange={(metadataVisible) => updatePreferences({ metadataVisible })}
                    onThumbnailRowHeightChange={(thumbnailRowHeight) => updatePreferences({ thumbnailRowHeight })}
                    onStatusChange={setBrowserStatus}
                    onPointerDragStart={startPointerDrag}
                    onPointerDragMove={movePointerDrag}
                    onPointerDragEnd={finishPointerDrag}
                    onPointerDragCancel={cancelPointerDrag}
                  />
                )}
                {message && <Toast>{message}</Toast>}
              </section>
            </div>
          }
          status={<StatusBar status={browserStatus} progress={progress} dropEnabled={dropEnabled} />}
        />
      </div>
      <DragLayer state={dragState} />
      <SafetyDialog
        open={safetyOpen}
        restoring={maintenance === "restore"}
        onClose={() => setSafetyOpen(false)}
        onRestore={restoreBackup}
      />
    </>
  );
}

function classificationTargetAt(x: number, y: number, payload: InternalDragPayload, entries: ClassificationEntry[]): ClassificationDropTarget | null {
  const element = document.elementFromPoint?.(x, y)?.closest<HTMLElement>("[data-classification-id]");
  const entryId = element?.dataset.classificationId;
  if (!element || !entryId) return null;
  const rect = element.getBoundingClientRect();
  const relativeY = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  const position: ClassificationDropPosition = relativeY < 0.25 ? "before" : relativeY > 0.75 ? "after" : "inside";
  return { entryId, position, valid: payload.kind === "assets" || validClassificationDrop(payload.entryId, { entryId, position, valid: true }, entries) };
}

function classificationDropParent(entries: ClassificationEntry[], target: Pick<ClassificationDropTarget, "entryId" | "position">): string | null {
  const entry = entries.find((candidate) => candidate.id === target.entryId);
  return target.position === "inside" ? target.entryId : entry?.parentId ?? null;
}

function validClassificationDrop(entryId: string, target: ClassificationDropTarget, entries: ClassificationEntry[]) {
  const entry = entries.find((candidate) => candidate.id === entryId);
  const parentId = classificationDropParent(entries, target);
  if (!entry || target.entryId === entryId || parentId === entryId || isDescendant(parentId, entryId, entries)) return false;
  if (entry.kind === "root") return parentId === null;
  const parent = entries.find((candidate) => candidate.id === parentId);
  if (entry.kind === "work") return parent?.kind === "root";
  return parentId === null || parent !== undefined;
}

function isDescendant(candidateId: string | null, ancestorId: string, entries: ClassificationEntry[]) {
  let current = entries.find((entry) => entry.id === candidateId);
  while (current) {
    if (current.id === ancestorId) return true;
    current = entries.find((entry) => entry.id === current?.parentId);
  }
  return false;
}
