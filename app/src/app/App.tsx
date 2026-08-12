import { useCallback, useEffect, useRef, useState } from "react";
import { AssetBrowser, type AssetBrowserStatus } from "../assets/AssetBrowser";
import { startAssetDrag as nativeStartAssetDrag, type StartAssetDrag } from "../drag-out/startAssetDrag";
import { ClassificationSidebar } from "../classification/ClassificationSidebar";
import {
  type DropSubscriber,
  type IngestionWork,
  subscribeToTauriDrops,
  useFileDrop,
} from "../ingestion/useFileDrop";
import { DropOverlay } from "../ingestion/DropOverlay";
import { WorkTray } from "../ingestion/WorkTray";
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
import type { AlbumEntry, AssetSort, AssetSummary, AssetView, ClassificationEntry, IngestOutcome, LibraryGateway } from "../library/types";
import {
  loadUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from "../preferences/uiPreferences";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { DragLayer } from "../shared/ui/DragLayer";
import { pointerDragReducer, type ClassificationDropTarget, type InternalDragPayload, type PointerDragState } from "../shared/interaction/pointerDrag";
import { SettingsView } from "../settings/SettingsView";
import { TrashBrowser } from "../safety/TrashBrowser";
import { SimilarityReviewBrowser } from "../similarity/SimilarityReviewBrowser";
import { useSimilarityIndex } from "../similarity/useSimilarityIndex";
import { useVideoPreparation } from "../video/useVideoPreparation";
import { MangaBrowser } from "../manga/MangaBrowser";
import { MangaViewer } from "../manga/MangaViewer";

type AppProps = {
  gateway?: LibraryGateway;
  selectFolder?: FolderPicker;
  subscribeDrops?: DropSubscriber;
  startAssetDrag?: StartAssetDrag;
};

export function App({
  gateway = libraryGateway,
  selectFolder = selectLibraryFolder,
  subscribeDrops = subscribeToTauriDrops,
  startAssetDrag = nativeStartAssetDrag,
}: AppProps) {
  return (
    <LibraryProvider gateway={gateway}>
      <LibraryScreen selectFolder={selectFolder} subscribeDrops={subscribeDrops} startAssetDrag={startAssetDrag} />
    </LibraryProvider>
  );
}

function LibraryScreen({
  selectFolder,
  subscribeDrops,
  startAssetDrag,
}: {
  selectFolder: FolderPicker;
  subscribeDrops: DropSubscriber;
  startAssetDrag: StartAssetDrag;
}) {
  const { library } = useLibrary();

  return library
    ? <LibraryWorkspace subscribeDrops={subscribeDrops} startAssetDrag={startAssetDrag} />
    : <LibrarySetup selectFolder={selectFolder} />;
}

function LibraryWorkspace({ subscribeDrops, startAssetDrag }: { subscribeDrops: DropSubscriber; startAssetDrag: StartAssetDrag }) {
  const { gateway } = useLibrary();
  const [entries, setEntries] = useState<ClassificationEntry[]>([]);
  const [albums, setAlbums] = useState<AlbumEntry[]>([]);
  const [view, setView] = useState<AssetView>({
    kind: "classification",
    classificationId: null,
  });
  const [preferences, setPreferences] = useState<UiPreferences>(loadUiPreferences);
  const [message, setMessage] = useState<string | null>(null);
  const [assetRefresh, setAssetRefresh] = useState(0);
  const [maintenance, setMaintenance] = useState<"restore" | null>(null);
  const [createClassificationRequest, setCreateClassificationRequest] = useState(0);
  const [browserStatus, setBrowserStatus] = useState<AssetBrowserStatus>({
    loadedCount: 0,
    selectedAsset: null,
    loading: true,
  });
  const [dragState, setDragState] = useState<PointerDragState>({ phase: "idle" });
  const dragStateRef = useRef<PointerDragState>({ phase: "idle" });
  const [dragTarget, setDragTarget] = useState<ClassificationDropTarget | null>(null);
  const nativeDragStartedRef = useRef(false);
  const nativeDragAssetsRef = useRef(new Map<string, string[]>());
  const [nativeDragWorks, setNativeDragWorks] = useState<IngestionWork[]>([]);
  const [requestedAsset, setRequestedAsset] = useState<AssetSummary | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const [mangaViewer, setMangaViewer] = useState<{ seriesId: string; title: string; pageCount: number } | null>(null);
  const [videoPreparationTrigger, setVideoPreparationTrigger] = useState(0);
  const settingsReturnViewRef = useRef<AssetView>({ kind: "classification", classificationId: null });
  const similarityIndex = useSimilarityIndex(gateway.indexMissingSimilarityHashes);
  const appendMessage = useCallback((next: string) => {
    setMessage((current) => current ? `${current} ${next}` : next);
  }, []);
  const refreshClassifications = useCallback(async () => {
    setEntries(await gateway.listClassifications());
  }, [gateway]);
  const refreshAlbums = useCallback(async () => {
    setAlbums(await gateway.listAlbums());
  }, [gateway]);
  const refreshSidebar = useCallback(async () => {
    const [nextEntries, nextAlbums] = await Promise.all([
      gateway.listClassifications(),
      gateway.listAlbums(),
    ]);
    setEntries(nextEntries);
    setAlbums(nextAlbums);
  }, [gateway]);
  const refreshReviewCount = useCallback(async () => {
    const page = await gateway.listSimilarityReviews({ after: null, limit: 1 });
    setReviewCount(page.totalCount);
  }, [gateway]);
  const handleIngested = useCallback((result: IngestOutcome) => {
    if (result.status === "added") setAssetRefresh((current) => current + 1);
    if (
      result.status === "added"
      && result.asset.media.kind === "video"
      && result.asset.media.preparationState !== "ready"
    ) {
      setVideoPreparationTrigger((current) => current + 1);
    }
    if (result.status === "review_pending") void refreshReviewCount();
  }, [refreshReviewCount]);
  const videoPreparation = useVideoPreparation({
    enabled: maintenance === null,
    trigger: videoPreparationTrigger,
    prepare: gateway.preparePendingVideos,
    retry: gateway.retryVideoPreparation,
    onChanged: () => setAssetRefresh((current) => current + 1),
  });
  const dropEnabled = maintenance === null && view.kind !== "trash" && view.kind !== "similarity_review" && view.kind !== "settings" && view.kind !== "manga";
  const dropClassificationId = view.kind === "classification" ? view.classificationId : null;
  const dropState = useFileDrop({
    subscribe: subscribeDrops,
    enabled: dropEnabled,
    classificationId: dropClassificationId,
    ingestMedia: gateway.ingestMedia,
    onIngested: handleIngested,
    onFatalError: setMessage,
  });
  useAutoDismiss(message, setMessage);

  useEffect(() => {
    void refreshSidebar();
  }, [refreshSidebar]);
  useEffect(() => {
    void refreshReviewCount().catch((error) => setMessage(commandErrorMessage(error, "유사 검토 개수를 불러오지 못했습니다.")));
  }, [refreshReviewCount]);
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
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      if (editing || !event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        setCreateClassificationRequest((current) => current + 1);
        return;
      }
      if (key === "1" || key === "2" || key === "3" || key === "4") {
        event.preventDefault();
        const quickViews: AssetView[] = [
          { kind: "classification", classificationId: null },
          { kind: "unsorted" },
          { kind: "recent" },
          { kind: "favorites" },
        ];
        setView(quickViews[Number(key) - 1]);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  function updatePreferences(update: Partial<UiPreferences>) {
    setPreferences((current) => ({ ...current, ...update }));
  }

  function navigateView(next: AssetView) {
    if (next.kind === "settings" && view.kind !== "settings") settingsReturnViewRef.current = view;
    setView(next);
  }

  function transitionDrag(action: Parameters<typeof pointerDragReducer>[1]) {
    const next = pointerDragReducer(dragStateRef.current, action);
    dragStateRef.current = next;
    setDragState(next);
    return next;
  }

  function startPointerDrag(payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) {
    nativeDragStartedRef.current = false;
    transitionDrag({ type: "arm", payload, x: event.clientX, y: event.clientY });
    setDragTarget(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function movePointerDrag(event: React.PointerEvent<HTMLElement>) {
    const next = transitionDrag({ type: "move", x: event.clientX, y: event.clientY });
    if (next.phase !== "dragging") return;
    event.preventDefault();
    if (next.payload.kind === "assets" && outsideViewport(event.clientX, event.clientY) && !nativeDragStartedRef.current) {
      nativeDragStartedRef.current = true;
      transitionDrag({ type: "cancel" });
      setDragTarget(null);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      void beginNativeDrag(next.payload.assetIds);
      return;
    }
    setDragTarget(classificationTargetAt(event.clientX, event.clientY, next.payload, entries));
  }

  async function beginNativeDrag(assetIds: string[], workId: string = crypto.randomUUID()) {
    nativeDragAssetsRef.current.set(workId, assetIds);
    setNativeDragWorks((current) => {
      const running: IngestionWork = { kind: "drag_out", id: workId, total: 1, completed: 0, added: 0, exactDuplicates: [], reviewPending: [], failures: [], status: "running" };
      return current.some((work) => work.id === workId)
        ? current.map((work) => work.id === workId ? running : work)
        : [...current, running];
    });
    try {
      await startAssetDrag(assetIds);
      setNativeDragWorks((current) => current.map((work) => work.id === workId ? { ...work, completed: 1, status: "completed" } : work));
    } catch (error) {
      const message = commandErrorMessage(error, "탐색기로 자산을 복사하지 못했습니다.");
      setNativeDragWorks((current) => current.map((work) => work.id === workId ? { ...work, completed: 1, failures: [{ fileName: "선택한 자산", message }], status: "failed" } : work));
    }
  }

  function retryWork(workId: string) {
    if (videoPreparation.work?.id === workId) {
      void videoPreparation.retryFailed();
      return;
    }
    const assetIds = nativeDragAssetsRef.current.get(workId);
    if (assetIds) void beginNativeDrag(assetIds, workId);
    else dropState.retryFailed(workId);
  }

  function dismissWork(workId: string) {
    if (videoPreparation.work?.id === workId) videoPreparation.dismissWork();
    nativeDragAssetsRef.current.delete(workId);
    setNativeDragWorks((current) => current.filter((work) => work.id !== workId));
    dropState.dismissWork(workId);
  }

  async function openExisting(assetId: string) {
    try {
      const asset = await gateway.getAsset(assetId);
      setView({ kind: "classification", classificationId: null });
      setRequestedAsset(asset);
    } catch (error) {
      setMessage(commandErrorMessage(error, "기존 자산을 열지 못했습니다."));
    }
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
        await gateway.setAssetClassification({ assetIds: payload.assetIds, classificationId: target.entryId });
        setAssetRefresh((current) => current + 1);
        setMessage(`${payload.assetIds.length}개 자산을 폴더에 추가했습니다.`);
        return;
      }
      const parentId = classificationDropParent(entries, target);
      await gateway.moveClassification(payload.entryId, parentId);
      setPreferences((current) => ({
        ...current,
        expandedClassificationIds: current.expandedClassificationIds.includes(target.entryId)
          ? current.expandedClassificationIds
          : [...current.expandedClassificationIds, target.entryId],
      }));
      await refreshClassifications();
      setMessage("폴더를 이동했습니다.");
    } catch (error) {
      setMessage(commandErrorMessage(error, "드롭 작업을 완료하지 못했습니다."));
    }
  }

  async function restoreBackup(backupId: string) {
    if (maintenance) return;
    setMaintenance("restore");
    try {
      await gateway.restoreMetadataBackup(backupId);
      await refreshSidebar();
      setAssetRefresh((current) => current + 1);
      setMessage("복구가 완료되었습니다.");
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
              albums={albums}
              view={view}
              expandedIds={preferences.expandedClassificationIds}
              expandedAlbumIds={preferences.expandedAlbumIds}
              sidebarWidth={preferences.sidebarWidth}
              createClassificationRequest={createClassificationRequest}
              onViewChange={navigateView}
              onExpandedIdsChange={(expandedClassificationIds) =>
                updatePreferences({ expandedClassificationIds })
              }
              onExpandedAlbumIdsChange={(expandedAlbumIds) =>
                updatePreferences({ expandedAlbumIds })
              }
              onSidebarWidthChange={(sidebarWidth) => updatePreferences({ sidebarWidth })}
              onChanged={() => void refreshClassifications()}
              onAlbumsChanged={() => void refreshAlbums()}
              reviewCount={reviewCount}
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
                {view.kind === "trash" ? <TrashBrowser /> : view.kind === "settings" ? (
                  <SettingsView
                    restoring={maintenance === "restore"}
                    onRestore={restoreBackup}
                    onExit={() => { setView(settingsReturnViewRef.current); }}
                  />
                ) : view.kind === "similarity_review" ? (
                  <SimilarityReviewBrowser
                    gateway={gateway}
                    onCountChange={setReviewCount}
                    onClose={() => setView({ kind: "classification", classificationId: null })}
                  />
                ) : view.kind === "manga" ? (
                  <MangaBrowser
                    onOpenSeries={(series) => setMangaViewer({ seriesId: series.id, title: series.title, pageCount: series.pageCount })}
                  />
                ) : (
                  <AssetBrowser
                    view={view}
                    classifications={entries}
                    sort={preferences.assetSort}
                    metadataVisible={preferences.metadataVisible}
                    thumbnailRowHeight={preferences.thumbnailRowHeight}
                    refreshVersion={assetRefresh}
                    requestedAsset={requestedAsset}
                    onRequestedAssetHandled={() => setRequestedAsset(null)}
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
          status={<StatusBar status={browserStatus} progress={dropState.progress} dropEnabled={dropEnabled} similarityIndex={similarityIndex} />}
        />
        <WorkTray
          works={[...dropState.works, ...nativeDragWorks, ...(videoPreparation.work ? [videoPreparation.work] : [])]}
          retryFailed={retryWork}
          dismissWork={dismissWork}
          openReview={() => setView({ kind: "similarity_review" })}
          openExisting={(assetId) => void openExisting(assetId)}
        />
      </div>
      <DropOverlay over={dropState.over} destinationName={entries.find((entry) => entry.id === dropClassificationId)?.name ?? "미분류"} />
      <DragLayer state={dragState} />
      {mangaViewer && <MangaViewer seriesId={mangaViewer.seriesId} title={mangaViewer.title} pageCount={mangaViewer.pageCount} onClose={() => setMangaViewer(null)} />}
    </>
  );
}

function classificationTargetAt(x: number, y: number, payload: InternalDragPayload, entries: ClassificationEntry[]): ClassificationDropTarget | null {
  const element = document.elementFromPoint?.(x, y)?.closest<HTMLElement>("[data-classification-id]");
  const entryId = element?.dataset.classificationId;
  if (!element || !entryId) return null;
  const position = "inside" as const;
  return { entryId, position, valid: payload.kind === "assets" || validClassificationDrop(payload.entryId, { entryId, position, valid: true }, entries) };
}

function classificationDropParent(_entries: ClassificationEntry[], target: Pick<ClassificationDropTarget, "entryId" | "position">): string {
  return target.entryId;
}

function validClassificationDrop(entryId: string, target: ClassificationDropTarget, entries: ClassificationEntry[]) {
  const entry = entries.find((candidate) => candidate.id === entryId);
  const parent = entries.find((candidate) => candidate.id === target.entryId);
  if (!entry || !parent || entry.parentId === parent.id || parent.id === entry.id || isDescendant(parent.id, entry.id, entries)) return false;
  if (entries.some((candidate) => candidate.id !== entry.id && candidate.parentId === parent.id && candidate.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase())) return false;
  if (entry.kind === "root") return false;
  return entry.kind !== "work" || parent.kind === "root";
}

function isDescendant(candidateId: string | null, ancestorId: string, entries: ClassificationEntry[]) {
  let current = entries.find((entry) => entry.id === candidateId);
  while (current) {
    if (current.id === ancestorId) return true;
    current = entries.find((entry) => entry.id === current?.parentId);
  }
  return false;
}

function outsideViewport(x: number, y: number) {
  return x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;
}
