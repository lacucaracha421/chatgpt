import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AssetBrowser, type AssetBrowserStatus } from "../assets/AssetBrowser";
import { startAssetDrag as nativeStartAssetDrag, type StartAssetDrag } from "../drag-out/startAssetDrag";
import { ClassificationSidebar } from "../classification/ClassificationSidebar";
import { CollectionBrowser } from "../collections/CollectionBrowser";
import { createDefaultCollectionLibraryState, type CollectionLibraryState, type CollectionLibraryStateByType } from "../collections/collectionLibrary";
import { CollectionOverlay } from "../collections/CollectionOverlay";
import {
  type DropSubscriber,
  type IngestionWork,
  subscribeToTauriDrops,
  useFileDrop,
} from "../ingestion/useFileDrop";
import { DropOverlay } from "../ingestion/DropOverlay";
import { WorkTray } from "../ingestion/WorkTray";
import { executeMetadataImport, type MetadataImportWork } from "../ingestion/metadataImport";
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
import type { AlbumEntry, AssetSort, AssetSummary, AssetView, ClassificationEntry, CollectionSummary, IngestOutcome, LibraryGateway } from "../library/types";
import {
  loadUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from "../preferences/uiPreferences";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { DragLayer } from "../shared/ui/DragLayer";
import { pointerDragReducer, type ClassificationDropTarget, type InternalDragPayload, type PointerDragState } from "../shared/interaction/pointerDrag";
import { SettingsView } from "../settings/SettingsView";
import { TrashBrowser } from "../safety/TrashBrowser";
import { SimilarityReviewBrowser } from "../similarity/SimilarityReviewBrowser";
import { useSimilarityIndex } from "../similarity/useSimilarityIndex";
import { useVideoPreparation } from "../video/useVideoPreparation";
import { MangaBrowser } from "../manga/MangaBrowser";
import { MangaViewer } from "../manga/MangaViewer";
import { useDesktopInteractions } from "./useDesktopInteractions";
import { useOnlineCatalogUpdate } from "./useOnlineCatalogUpdate";
import { useReleaseWatchCheck } from "./useReleaseWatchCheck";

export type ExtensionIngestListener = (handler: (outcome: IngestOutcome) => void) => Promise<() => void>;

export const subscribeToExtensionIngest: ExtensionIngestListener = async (handler) =>
  listen<IngestOutcome>("extension://ingestion", (event) => handler(event.payload));

type AppProps = {
  gateway?: LibraryGateway;
  selectFolder?: FolderPicker;
  subscribeDrops?: DropSubscriber;
  startAssetDrag?: StartAssetDrag;
  subscribeExtensionIngest?: ExtensionIngestListener;
};

export function App({
  gateway = libraryGateway,
  selectFolder = selectLibraryFolder,
  subscribeDrops = subscribeToTauriDrops,
  startAssetDrag = nativeStartAssetDrag,
  subscribeExtensionIngest = subscribeToExtensionIngest,
}: AppProps) {
  useDesktopInteractions();
  return (
    <LibraryProvider gateway={gateway}>
      <LibraryScreen selectFolder={selectFolder} subscribeDrops={subscribeDrops} startAssetDrag={startAssetDrag} subscribeExtensionIngest={subscribeExtensionIngest} />
    </LibraryProvider>
  );
}

function LibraryScreen({
  selectFolder,
  subscribeDrops,
  startAssetDrag,
  subscribeExtensionIngest,
}: {
  selectFolder: FolderPicker;
  subscribeDrops: DropSubscriber;
  startAssetDrag: StartAssetDrag;
  subscribeExtensionIngest: ExtensionIngestListener;
}) {
  const { library } = useLibrary();

  return library
    ? <LibraryWorkspace key={library.root} libraryRoot={library.root} subscribeDrops={subscribeDrops} startAssetDrag={startAssetDrag} subscribeExtensionIngest={subscribeExtensionIngest} />
    : <LibrarySetup selectFolder={selectFolder} />;
}

function LibraryWorkspace({ libraryRoot, subscribeDrops, startAssetDrag, subscribeExtensionIngest }: { libraryRoot: string; subscribeDrops: DropSubscriber; startAssetDrag: StartAssetDrag; subscribeExtensionIngest: ExtensionIngestListener }) {
  const { gateway } = useLibrary();
  useOnlineCatalogUpdate(gateway, libraryRoot);
  const [entries, setEntries] = useState<ClassificationEntry[]>([]);
  const [albums, setAlbums] = useState<AlbumEntry[]>([]);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [collectionLibraryState, setCollectionLibraryState] = useState<CollectionLibraryStateByType>(createDefaultCollectionLibraryState);
  const [view, setView] = useState<AssetView>({
    kind: "classification",
    classificationId: null,
  });
  const collectionReturnViewRef = useRef<Extract<AssetView, { kind: "collections" }> | null>(null);
  const [preferences, setPreferences] = useState<UiPreferences>(loadUiPreferences);
  const [sidebarWidth, setSidebarWidth] = useState(preferences.sidebarWidth);
  const [message, setMessage] = useState<string | null>(null);
  const [assetRefresh, setAssetRefresh] = useState(0);
  const [maintenance, setMaintenance] = useState<"restore" | null>(null);
  const [createClassificationRequest, setCreateClassificationRequest] = useState(0);
  const [requestedDate, setRequestedDate] = useState<string | null>(null);
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
  const [metadataImportWorks, setMetadataImportWorks] = useState<MetadataImportWork[]>([]);
  const metadataImportRunningRef = useRef(false);
  const [requestedAsset, setRequestedAsset] = useState<AssetSummary | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const [trashCount, setTrashCount] = useState(0);
  const [mangaViewer, setMangaViewer] = useState<{ seriesId: string; title: string; pageCount: number; galleryId: string | null } | null>(null);
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
  const refreshCollections = useCallback(async () => {
    setCollections(await gateway.listCollections());
  }, [gateway]);
  const refreshSidebar = useCallback(async () => {
    const [nextEntries, nextAlbums, nextCollections] = await Promise.all([
      gateway.listClassifications(),
      gateway.listAlbums(),
      gateway.listCollections(),
    ]);
    setEntries(nextEntries);
    setAlbums(nextAlbums);
    setCollections(nextCollections);
  }, [gateway]);
  const refreshReviewCount = useCallback(async () => {
    const page = await gateway.listSimilarityReviews({ after: null, limit: 1 });
    setReviewCount(page.totalCount);
  }, [gateway]);
  const refreshTrashCount = useCallback(async () => {
    const page = await gateway.listTrash({ after: null, limit: 1 });
    setTrashCount(page.totalCount);
  }, [gateway]);
  const refreshMembershipCounts = useCallback(() => {
    void refreshClassifications();
    void refreshAlbums();
    void refreshTrashCount();
  }, [refreshClassifications, refreshAlbums, refreshTrashCount]);
  const handleIngested = useCallback((result: IngestOutcome) => {
    if (result.status === "added" || (result.status === "exact_duplicate" && result.classificationChanged)) {
      setAssetRefresh((current) => current + 1);
      refreshMembershipCounts();
    }
    if (
      result.status === "added"
      && result.asset.media.kind === "video"
      && result.asset.media.preparationState !== "ready"
    ) {
      setVideoPreparationTrigger((current) => current + 1);
    }
    if (result.status === "review_pending") void refreshReviewCount();
  }, [refreshReviewCount, refreshMembershipCounts]);
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
    libraryRoot,
    ingestMedia: gateway.ingestMedia,
    onIngested: handleIngested,
    onFatalError: setMessage,
  });

  const beginMetadataImport = useCallback(async (folder: string, existingWorkId?: string) => {
    if (metadataImportRunningRef.current) return false;
    metadataImportRunningRef.current = true;
    const workId = existingWorkId ?? crypto.randomUUID();
    const update = (work: MetadataImportWork) => setMetadataImportWorks((current) => {
      const previous = current.find((item) => item.id === work.id);
      // 같은 workId를 재사용하므로 실패해도 이전 시도의 중복·검토 대기 성과는 유지한다.
      const withPrevious = previous && work.status === "failed"
        ? { ...work, total: previous.total, completed: previous.completed, added: previous.added, foldersCreated: previous.foldersCreated, pathsReused: previous.pathsReused, exactDuplicates: previous.exactDuplicates, reviewPending: previous.reviewPending, skipped: previous.skipped }
        : work;
      return current.some((item) => item.id === work.id)
        ? current.map((item) => item.id === work.id ? withPrevious : item)
        : [...current, withPrevious];
    });
    try {
      await executeMetadataImport(gateway, folder, update, workId);
      await refreshClassifications();
      setAssetRefresh((current) => current + 1);
      await refreshReviewCount();
      return true;
    } catch (error) {
      update({ kind: "metadata_import", id: workId, folder, total: 0, completed: 0, added: 0, foldersCreated: 0, pathsReused: 0, exactDuplicates: [], reviewPending: [], skipped: [], failures: [{ fileName: "폴더 검사", message: commandErrorMessage(error, "가져오기 폴더를 검사하지 못했습니다.") }], status: "failed" });
      return false;
    } finally {
      metadataImportRunningRef.current = false;
    }
  }, [gateway, refreshClassifications, refreshReviewCount]);
  useAutoDismiss(message, setMessage);

  useEffect(() => {
    void refreshSidebar();
  }, [refreshSidebar]);
  useEffect(() => {
    void refreshReviewCount().catch((error) => setMessage(commandErrorMessage(error, "유사 검토 개수를 불러오지 못했습니다.")));
    void refreshTrashCount().catch((error) => setMessage(commandErrorMessage(error, "휴지통 개수를 불러오지 못했습니다.")));
  }, [refreshReviewCount, refreshTrashCount]);
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
      } finally {
        if (active) void refreshTrashCount().catch(() => undefined);
      }
    })();
    return () => { active = false; };
  }, [appendMessage, gateway, refreshTrashCount]);
  useReleaseWatchCheck(gateway, libraryRoot, async (result) => {
    await refreshCollections();
    if (result.changedCollections > 0) appendMessage(`새 출간 정보가 있는 작품 ${result.changedCollections}개`);
  });
  useEffect(() => {
    saveUiPreferences(preferences);
  }, [preferences]);
  useEffect(() => {
    if (sidebarWidth === preferences.sidebarWidth) return;
    const timeout = window.setTimeout(() => {
      setPreferences((current) => current.sidebarWidth === sidebarWidth
        ? current
        : { ...current, sidebarWidth });
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [preferences.sidebarWidth, sidebarWidth]);
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
      if (key === "1" || key === "2") {
        event.preventDefault();
        const quickViews: AssetView[] = [
          { kind: "classification", classificationId: null },
          { kind: "unsorted" },
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
    if (next.kind === "collection" && view.kind === "collections") collectionReturnViewRef.current = view;
    if (next.kind === "settings" && view.kind !== "settings") settingsReturnViewRef.current = view;
    if (next.kind === "collections") updatePreferences({ collectionType: next.typeFilter });
    setView(next);
  }

  function openCalendarDay(date: string) {
    updatePreferences({ assetSort: "newest" });
    settingsReturnViewRef.current = { kind: "calendar" };
    setView({ kind: "classification", classificationId: null });
    setRequestedDate(date);
  }

  function updateCollectionLibraryState(type: CollectionSummary["type"], next: CollectionLibraryState) {
    setCollectionLibraryState((current) => ({ ...current, [type]: next }));
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
    setDragTarget(sidebarTargetAt(event.clientX, event.clientY, next.payload, entries, albums));
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
    const metadataWork = metadataImportWorks.find((work) => work.id === workId);
    if (metadataWork) {
      void beginMetadataImport(metadataWork.folder, workId);
      return;
    }
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
    setMetadataImportWorks((current) => current.filter((work) => work.id !== workId));
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
      ? sidebarTargetAt(event.clientX, event.clientY, current.payload, entries, albums)
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
        if (target.kind === "album") {
          await gateway.patchAssetAlbums({ assetIds: payload.assetIds, addAlbumIds: [target.entryId], removeAlbumIds: [] });
        } else {
          await gateway.setAssetClassification({ assetIds: payload.assetIds, classificationId: target.entryId });
        }
        setAssetRefresh((current) => current + 1);
        setMessage(`${payload.assetIds.length}개 자산을 ${target.kind === "album" ? "앨범에 추가" : "폴더로 이동"}했습니다.`);
        return;
      }
      if (payload.kind === "album") await gateway.moveAlbum(payload.entryId, target.entryId);
      else await gateway.moveClassification(payload.entryId, target.entryId);
      setPreferences((current) => ({
        ...current,
        ...(payload.kind === "album"
          ? { expandedAlbumIds: current.expandedAlbumIds.includes(target.entryId) ? current.expandedAlbumIds : [...current.expandedAlbumIds, target.entryId] }
          : { expandedClassificationIds: current.expandedClassificationIds.includes(target.entryId) ? current.expandedClassificationIds : [...current.expandedClassificationIds, target.entryId] }),
      }));
      if (payload.kind === "album") await refreshAlbums();
      else await refreshClassifications();
      setMessage(`${payload.kind === "album" ? "앨범" : "폴더"}을 이동했습니다.`);
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
    <PrivacyProvider privacyMode={preferences.privacyMode} setPrivacyMode={(privacyMode) => updatePreferences({ privacyMode })}>
      <div className="library-workspace" data-privacy-mode={preferences.privacyMode ? "true" : undefined} inert={maintenance !== null ? true : undefined}>
        <AppShell
          sidebar={
            <ClassificationSidebar
              entries={entries}
              albums={albums}
              view={view}
              collectionType={preferences.collectionType}
              expandedIds={preferences.expandedClassificationIds}
              expandedAlbumIds={preferences.expandedAlbumIds}
              sidebarWidth={sidebarWidth}
              createClassificationRequest={createClassificationRequest}
              onViewChange={navigateView}
              onExpandedIdsChange={(expandedClassificationIds) =>
                updatePreferences({ expandedClassificationIds })
              }
              onExpandedAlbumIdsChange={(expandedAlbumIds) =>
                updatePreferences({ expandedAlbumIds })
              }
              onSidebarWidthChange={setSidebarWidth}
              onChanged={() => void refreshClassifications()}
              onAlbumsChanged={() => void refreshAlbums()}
              reviewCount={reviewCount}
              trashCount={trashCount}
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
                {view.kind === "trash" ? <TrashBrowser onCountChange={setTrashCount} /> : view.kind === "settings" ? (
                  <SettingsView
                    restoring={maintenance === "restore"}
                    onRestore={restoreBackup}
                    onExit={() => { setView(settingsReturnViewRef.current); }}
                    onImportFolder={beginMetadataImport}
                    metadataImportRunning={metadataImportWorks.some((work) => work.status === "running")}
                    onCollectionsChanged={refreshCollections}
                    initialSection={view.section}
                    privacyMode={preferences.privacyMode}
                    onPrivacyModeChange={(privacyMode) => updatePreferences({ privacyMode })}
                  />
                ) : view.kind === "similarity_review" ? (
                  <SimilarityReviewBrowser
                    gateway={gateway}
                    onCountChange={setReviewCount}
                    onClose={() => setView({ kind: "classification", classificationId: null })}
                  />
                ) : view.kind === "manga" ? (
                  <MangaBrowser
                    onOpenSeries={(series) => setMangaViewer({ seriesId: series.id, title: series.title, pageCount: series.pageCount, galleryId: series.galleryId })}
                  />
                ) : view.kind === "collection" ? (
                  <CollectionOverlay
                    collectionId={view.collectionId}
                    collections={collections}
                    onOpenSettings={() => navigateView({ kind: "settings", section: "external_services" })}
                    onExit={() => {
                      const detailCollection = collections.find((item) => item.id === view.collectionId);
                      setView(collectionReturnViewRef.current ?? {
                        kind: "collections",
                        typeFilter: detailCollection?.type ?? preferences.collectionType,
                        showcase: false,
                      });
                    }}
                    onChanged={refreshCollections}
                  />
                ) : view.kind === "collections" ? (
                  <CollectionBrowser
                    collections={collections}
                    typeFilter={view.typeFilter}
                    showcase={view.showcase}
                    libraryState={collectionLibraryState[view.typeFilter]}
                    onLibraryStateChange={(next) => updateCollectionLibraryState(view.typeFilter, next)}
                    onViewChange={navigateView}
                    onChanged={refreshCollections}
                  />
                ) : (
                  <AssetBrowser
                    view={view}
                    onViewChange={navigateView}
                    classifications={entries}
                    albums={albums}
                    collections={collections}
                    onCollectionsChanged={() => void refreshCollections()}
                    onMembershipChanged={refreshMembershipCounts}
                    sort={preferences.assetSort}
                    metadataVisible={preferences.metadataVisible}
                    privacyMode={preferences.privacyMode}
                    onPrivacyModeChange={(privacyMode) => updatePreferences({ privacyMode })}
                    thumbnailRowHeight={preferences.thumbnailRowHeight}
                    refreshVersion={assetRefresh}
                    requestedAsset={requestedAsset}
                    onRequestedAssetHandled={() => setRequestedAsset(null)}
                    requestedDate={requestedDate}
                    onRequestedDateHandled={() => setRequestedDate(null)}
                    onOpenCalendarDay={openCalendarDay}
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
                {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
              </section>
            </div>
          }
          status={<StatusBar status={browserStatus} progress={dropState.progress} dropEnabled={dropEnabled} similarityIndex={similarityIndex} />}
        />
        <WorkTray
          works={[...dropState.works, ...nativeDragWorks, ...metadataImportWorks, ...(videoPreparation.work ? [videoPreparation.work] : [])]}
          retryFailed={retryWork}
          dismissWork={dismissWork}
          openReview={() => setView({ kind: "similarity_review" })}
          openExisting={(assetId) => void openExisting(assetId)}
        />
      </div>
      <DropOverlay over={dropState.over} destinationName={entries.find((entry) => entry.id === dropClassificationId)?.name ?? "미분류"} />
      <DragLayer state={dragState} />
      {mangaViewer && <MangaViewer seriesId={mangaViewer.seriesId} title={mangaViewer.title} pageCount={mangaViewer.pageCount} galleryId={mangaViewer.galleryId} onClose={() => setMangaViewer(null)} />}
    </PrivacyProvider>
  );
}

function sidebarTargetAt(x: number, y: number, payload: InternalDragPayload, entries: ClassificationEntry[], albums: AlbumEntry[]): ClassificationDropTarget | null {
  const element = document.elementFromPoint?.(x, y)?.closest<HTMLElement>("[data-classification-id], [data-album-id]");
  const kind = element?.dataset.albumId ? "album" : "classification";
  const entryId = kind === "album" ? element?.dataset.albumId : element?.dataset.classificationId;
  if (!element || !entryId) return null;
  const position = "inside" as const;
  const target = { kind, entryId, position, valid: true } as const;
  const valid = payload.kind === "assets"
    || payload.kind === kind && (kind === "album"
      ? validTreeDrop(payload.entryId, entryId, albums)
      : validClassificationDrop(payload.entryId, target, entries));
  return { ...target, valid };
}

function validClassificationDrop(entryId: string, target: ClassificationDropTarget, entries: ClassificationEntry[]) {
  const entry = entries.find((candidate) => candidate.id === entryId);
  const parent = entries.find((candidate) => candidate.id === target.entryId);
  if (!entry || !parent || entry.parentId === parent.id || parent.id === entry.id || isDescendant(parent.id, entry.id, entries)) return false;
  if (entries.some((candidate) => candidate.id !== entry.id && candidate.parentId === parent.id && candidate.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase())) return false;
  return entry.kind !== "work" || parent.kind === "root";
}

function validTreeDrop(entryId: string, parentId: string, entries: Array<{ id: string; name: string; parentId: string | null }>) {
  const entry = entries.find((candidate) => candidate.id === entryId);
  const parent = entries.find((candidate) => candidate.id === parentId);
  return Boolean(entry && parent
    && entry.parentId !== parent.id
    && parent.id !== entry.id
    && !isDescendant(parent.id, entry.id, entries)
    && !entries.some((candidate) => candidate.id !== entry.id && candidate.parentId === parent.id && candidate.name.toLocaleLowerCase() === entry.name.toLocaleLowerCase()));
}

function isDescendant(candidateId: string | null, ancestorId: string, entries: Array<{ id: string; parentId: string | null }>) {
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
