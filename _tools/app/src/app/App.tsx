import {listen} from "@tauri-apps/api/event";
import { useWorkloadProfile } from "./workloadProfile";
import {ASSET_LIFECYCLE_CHANGED_EVENT, useAssetAuthoritySync} from './useAssetAuthoritySync';
import {useMobilePublications} from './useMobilePublications';
import {useCatalogBookmarkSync} from './useCatalogBookmarkSync';
import {useAlbumAuthoritySync} from './useAlbumAuthoritySync';
import {
  useClassificationAuthoritySync,
} from './useClassificationAuthoritySync';
import { useCharacterAutomation } from "../characters/useCharacterAutomation";
import { useCharacterHub } from "../characters/useCharacterHub";
import { CharacterFolderContent } from "../characters/CharacterFolderContent";
import { applyInitialCountOrder, reorderFolders } from "../classification/folderOrder";
import { useNotesCloseGuard } from "../notes/useNotesCloseGuard";
import { lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AssetBrowser, type AssetBrowserStatus, type AssetNavigationMemory } from "../assets/AssetBrowser";
import { startAssetDrag as nativeStartAssetDrag, type StartAssetDrag } from "../drag-out/startAssetDrag";
import { ClassificationSidebar } from "../classification/ClassificationSidebar";
import { createDefaultCollectionLibraryState, type CollectionLibraryState, type CollectionLibraryStateByType } from "../collections/collectionLibrary";
import type { CollectionNavigationMemory } from "../collections/CollectionBrowser";
import {
  type DropSubscriber,
  type IngestionWork,
  type NativeFileDragDisposition,
  type NativeFileDropEvent,
  subscribeToTauriDrops,
  useFileDrop,
} from "../ingestion/useFileDrop";
import { DropOverlay } from "../ingestion/DropOverlay";
import { AppShell } from "../layout/AppShell";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import { hasWorkspaceIndex, WorkspaceNavigation, workspaceArea } from "../layout/WorkspaceNavigation";
import { AreaPainted, AreaSwitch, MotionScope, viewReady } from "../shared/motion/AreaSwitch";
import { ChromeContext, useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { LightweightModeIndicator, WindowControls } from "../layout/WindowControls";
import { libraryGateway } from "../library/client";
import { commandErrorMessage } from "../library/errorMessage";
import { LibraryProvider, useLibrary } from "../library/LibraryContext";
import {
  LibrarySetup,
  selectLibraryFolder,
  type FolderPicker,
} from "../library/LibrarySetup";
import type { AlbumEntry, AssetSort, AssetSummary, AssetView, ClassificationEntry, CloudCaptureSyncResult, CollectionSummary, IngestOutcome, LibraryGateway } from "../library/types";
import {
  loadUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from "../preferences/uiPreferences";
import { useAppZoom } from "../preferences/useAppZoom";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { DragLayer } from "../shared/ui/DragLayer";
import { pointerDragReducer, type InternalDragPayload, type PointerDragState } from "../shared/interaction/pointerDrag";
import { useSimilarityIndex } from "../similarity/useSimilarityIndex";
import { useSimilarityReviewInbound } from "../similarity/useSimilarityReviewInbound";
import { useVideoPreparation } from "../video/useVideoPreparation";
import { useDesktopInteractions } from "./useDesktopInteractions";
import { useOnlineCatalogUpdate } from "./useOnlineCatalogUpdate";
import { useCloudCaptureSync } from "./useCloudCaptureSync";
import { useCloudBackfillSupervisor } from "./useCloudBackfillSupervisor";
import { useCollectionOpen } from "../statistics/useCollectionOpen";
import { useReleaseWatchCheck } from "./useReleaseWatchCheck";
import { useExternalVaultAvailability, type VaultLeaveReason } from "../external-vault/useExternalVaultAvailability";
import { confirmLeaveVaultRecovery } from "../external-vault/vaultRecoveryGuard";
import { reattachVaultImport } from "../external-vault/vaultImportJob";
import { BackNavigationProvider, useBackHandler, useBackRequest } from "../shared/navigation/BackNavigation";
import { FaultGameProvider } from "../games/FaultGame";

import { CloudStatusCenter } from "./CloudStatusCenter";
import { backNavigationTab, initialWorkspaceView } from "./workspaceNavigation";
import { nativeDropClientPoint, outsideViewport, sameAssetIds, sidebarTargetAt, type SidebarDropTarget } from "./workspaceDragTargets";
import { subscribeToExtensionIngest, useExtensionIngest, useNativeDragEnd, useWorkspaceAuthorityEvents, useWorkspaceShortcuts, type ExtensionIngestListener } from "./useWorkspaceEvents";
import { useMetadataImport } from "./useMetadataImport";
import { useDailyLibraryMaintenance } from "./useDailyLibraryMaintenance";

export { subscribeToExtensionIngest, type ExtensionIngestListener } from "./useWorkspaceEvents";

const CollectionBrowser = lazy(() => import("../collections/CollectionBrowser").then((module) => ({ default: module.CollectionBrowser })));
const CollectionOverlay = lazy(() => import("../collections/CollectionOverlay").then((module) => ({ default: module.CollectionOverlay })));
const ArtistHub = lazy(() => import("../artists/ArtistHub").then((module) => ({ default: module.ArtistHub })));
const AlbumOverview = lazy(() => import("../albums/AlbumOverview").then((module) => ({ default: module.AlbumOverview })));
const ExchangeView = lazy(() => import("../exchange/ExchangeView").then((module) => ({ default: module.ExchangeView })));
const HomeView = lazy(() => import("../home/HomeView").then((module) => ({ default: module.HomeView })));
const NotesView = lazy(() => import("../notes/NotesView").then((module) => ({default:module.NotesView})));
const SettingsView = lazy(() => import("../settings/SettingsView").then((module) => ({ default: module.SettingsView })));
const StatisticsPanel = lazy(() => import("../statistics/StatisticsPanel").then((module) => ({ default: module.StatisticsPanel })));
const TrashBrowser = lazy(() => import("../safety/TrashBrowser").then((module) => ({ default: module.TrashBrowser })));
const SimilarityReviewBrowser = lazy(() => import("../similarity/SimilarityReviewBrowser").then((module) => ({ default: module.SimilarityReviewBrowser })));
const MangaBrowser = lazy(() => import("../manga/MangaBrowser").then((module) => ({ default: module.MangaBrowser })));
const MangaViewer = lazy(() => import("../manga/MangaViewer").then((module) => ({ default: module.MangaViewer })));
const ExternalVaultBrowser = lazy(() => import("../external-vault/ExternalVaultBrowser").then((module) => ({ default: module.ExternalVaultBrowser })));

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
  return (
    <BackNavigationProvider>
      <DesktopInteractions />
      <LibraryProvider gateway={gateway}>
        <LibraryScreen selectFolder={selectFolder} subscribeDrops={subscribeDrops} startAssetDrag={startAssetDrag} subscribeExtensionIngest={subscribeExtensionIngest} />
      </LibraryProvider>
    </BackNavigationProvider>
  );
}

function DesktopInteractions() {
  useNotesCloseGuard();
  useDesktopInteractions(useBackRequest());
  return null;
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
  const workload = useWorkloadProfile();
  useOnlineCatalogUpdate(gateway, libraryRoot);
  useCloudBackfillSupervisor(gateway, libraryRoot);
  useCatalogBookmarkSync(gateway, libraryRoot);
  useAssetAuthoritySync(gateway, libraryRoot);
  useAlbumAuthoritySync(gateway, libraryRoot);
  useClassificationAuthoritySync(gateway, libraryRoot);
  const [entries, setEntries] = useState<ClassificationEntry[]>([]);
  const [albums, setAlbums] = useState<AlbumEntry[]>([]);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [collectionsRead, setCollectionsRead] = useState<{ gateway: typeof gateway; root: string } | null>(null);
  const [collectionLibraryState, setCollectionLibraryState] = useState<CollectionLibraryStateByType>(createDefaultCollectionLibraryState);
  const collectionNavigationMemory = useRef<CollectionNavigationMemory>(new Map());
  const assetNavigationMemory = useRef<AssetNavigationMemory>(new Map());
  // The app opens on Home (HOME-DASH-001); the rail's 에셋 opens the library.
  const [view, setView] = useState<AssetView>(initialWorkspaceView);
  const area = workspaceSwitchKey(view);
  const [shownArea, setShownArea] = useState(area);
  const [areaSettling, setAreaSettling] = useState(false);
  const shownView = useRef(view);
  if (area === shownArea) shownView.current = view;
  const viewHistoryRef = useRef<AssetView[]>([]);
  useCollectionOpen(gateway, libraryRoot, view.kind === "collection" ? view.collectionId : null);
  const collectionWorkOrderRef = useRef<string[]>([]);
  const collectionReturnViewRef = useRef<Extract<AssetView, { kind: "collections" }> | null>(null);
  const [preferences, setPreferences] = useState<UiPreferences>(loadUiPreferences);
  useMobilePublications(gateway, libraryRoot, preferences.classificationOrderIds);
  const appZoomError = useAppZoom(preferences.appZoom);
  useEffect(() => {
    setPreferences((current) => applyInitialCountOrder(entries, current));
  }, [entries]);
  const [sidebarWidth, setSidebarWidth] = useState(preferences.sidebarWidth);
  const [message, setMessage] = useState<string | null>(null);
  const handlePrivateVaultLeave = useCallback((reason: VaultLeaveReason) => {
    setView((current) => current.kind === "private_vault"
      ? { kind: "classification", classificationId: null }
      : current);
    setMessage(reason === "locked" ? "비밀 보관함을 잠갔습니다." : "비밀 보관함의 연결이 끊겼습니다.");
  }, []);
  const { status: privateVaultStatus, refresh: refreshPrivateVaultStatus, update: updatePrivateVaultStatus } = useExternalVaultAvailability({
    gateway,
    view,
    onLeave: handlePrivateVaultLeave,
  });
  // A vault import started before a webview reload keeps running in the backend; follow it.
  useEffect(() => { void reattachVaultImport(gateway); }, [gateway]);
  const privateVaultVisible = Boolean(privateVaultStatus && privateVaultStatus.state !== "absent" && gateway.listEncryptedVaultItems);
  const [assetRefresh, setAssetRefresh] = useState(0);
  useEffect(() => {
    let live=true;let unlisten:(()=>void)|undefined;
    void listen("library://auto-tag-inbox",()=>setAssetRefresh(value=>value+1)).then(stop=>{if(live)unlisten=stop;else stop();},()=>undefined);
    return ()=>{live=false;unlisten?.();};
  },[]);
  const characterHub = useCharacterHub(assetRefresh);
  const [clearAssetSelectionRequest, setClearAssetSelectionRequest] = useState(0);
  const [maintenance, setMaintenance] = useState<"restore" | null>(null);
  const [createClassificationRequest, setCreateClassificationRequest] = useState(0);
  const [createAlbumRequest, setCreateAlbumRequest] = useState(0);
  const [browserStatus, setBrowserStatus] = useState<AssetBrowserStatus>({
    loadedCount: 0,
    selectedAsset: null,
    loading: true,
  });
  const [dragState, setDragState] = useState<PointerDragState>({ phase: "idle" });
  const dragStateRef = useRef<PointerDragState>({ phase: "idle" });
  const [dragTarget, setDragTarget] = useState<SidebarDropTarget | null>(null);
  const nativeDragStartedRef = useRef(false);
  const activeNativeDragAssetIdsRef = useRef<string[] | null>(null);
  const nativeDragAssetsRef = useRef(new Map<string, string[]>());
  const [nativeDragWorks, setNativeDragWorks] = useState<IngestionWork[]>([]);
  const [requestedAsset, setRequestedAsset] = useState<AssetSummary | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const [videoReviewAssetIds, setVideoReviewAssetIds] = useState<string[]>([]);
  const [trashCount, setTrashCount] = useState(0);
  const [mangaViewer, setMangaViewer] = useState<{ seriesId: string; title: string; pageCount: number; galleryId: string | null; artist: string } | null>(null);
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
    setCollectionsRead(null);
    setCollections(await gateway.listCollections());
    setCollectionsRead({ gateway, root: libraryRoot });
  }, [gateway, libraryRoot]);
  useEffect(() => gateway.subscribeCollectionsChanged?.(() => { void refreshCollections(); }), [gateway, refreshCollections]);
  const refreshSidebar = useCallback(async () => {
    setCollectionsRead(null);
    const classifications = gateway.listClassifications(), albums = gateway.listAlbums();
    const collectionRead = gateway.listCollections();
    try {
      const [nextEntries, nextAlbums, nextCollections] = await Promise.all([
        classifications, albums, collectionRead,
      ]);
      // Publish ready collections with the other sidebar data in one update turn.
      setEntries(nextEntries);
      setAlbums(nextAlbums);
      setCollections(nextCollections);
      setCollectionsRead({ gateway, root: libraryRoot });
    } catch (error) {
      // Preserve the independent collection read if another sidebar source fails.
      void collectionRead.then(next => {
        setCollections(next);
        setCollectionsRead({ gateway, root: libraryRoot });
      }).catch(() => undefined);
      throw error;
    }
  }, [gateway, libraryRoot]);
  const refreshReviewCount = useCallback(async () => {
    const page = await gateway.listSimilarityReviews({ after: null, limit: 1 });
    setReviewCount(page.totalCount);
  }, [gateway]);
  const [unsortedCount, setUnsortedCount] = useState<number | null>(null);
  const [settingsSectionRequest, setSettingsSectionRequest] = useState(0);
  const unsortedGatewayRef = useRef(gateway);
  useEffect(() => { unsortedGatewayRef.current = gateway; setUnsortedCount(null); }, [gateway]);
  // Read only when the status panel, 더보기 or the 찾기 palette opens: the unsorted queue count is a COUNT over the library.
  const refreshUnsortedCount = useCallback(async () => {
    const page = await gateway.listAssets({ classificationId: null, albumId: null, collectionId: null, directOnly: false, unclassifiedOnly: true, mediaKind: null, aspectRatio: null, sort: "newest", randomPivot: null, after: null, limit: 1 });
    // A late answer from a previous gateway must not overwrite the reset.
    if (unsortedGatewayRef.current !== gateway) return;
    setUnsortedCount(page.totalCount ?? null);
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
  const refreshCharacterViews = useCallback(() => {
    characterHub.refresh();
    refreshMembershipCounts();
  }, [characterHub.refresh, refreshMembershipCounts]);
  const refreshAutomaticCharacterViews = useCallback((membershipChanged: boolean) => {
    characterHub.refresh();
    if (membershipChanged) void refreshClassifications();
  }, [characterHub.refresh, refreshClassifications]);
  const characterAutomation = useCharacterAutomation(refreshAutomaticCharacterViews);
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
  const handleCloudCaptureSync = useCallback((result: CloudCaptureSyncResult) => {
    if (result.added > 0 || result.classificationChanged > 0) {
      setAssetRefresh((current) => current + 1);
      refreshMembershipCounts();
    }
    if (result.videoAdded > 0) setVideoPreparationTrigger((current) => current + 1);
    if (result.reviewPending > 0) void refreshReviewCount();
  }, [refreshMembershipCounts, refreshReviewCount]);
  useWorkspaceAuthorityEvents({ refreshAlbums, refreshClassifications, refreshTrashCount, setAssetRefresh, setVideoPreparationTrigger });
  // A mobile similarity decision applied on this PC trashed an image and resolved a pair.
  const handleSimilarityInbound = useCallback(() => {
    void refreshReviewCount().catch(() => undefined);
    window.dispatchEvent(new Event(ASSET_LIFECYCLE_CHANGED_EVENT));
  }, [refreshReviewCount]);
  useSimilarityReviewInbound(gateway, handleSimilarityInbound);
  useCloudCaptureSync(gateway, libraryRoot, handleCloudCaptureSync);
  useExtensionIngest(subscribeExtensionIngest, handleIngested);
  const videoPreparation = useVideoPreparation({
    enabled: maintenance === null && !workload.restricted,
    trigger: videoPreparationTrigger,
    prepare: gateway.preparePendingVideos,
    retry: gateway.retryVideoPreparation,
    onChanged: () => setAssetRefresh((current) => current + 1),
  });
  const dropEnabled = maintenance === null && view.kind !== "trash" && view.kind !== "similarity_review" && view.kind !== "settings" && view.kind !== "statistics" && view.kind !== "manga" && view.kind !== "notes" && view.kind !== "exchange" && view.kind !== "private_vault";
  const dropClassificationId = view.kind === "classification" ? view.classificationId : null;
  function handleNativeDragEvent(event: NativeFileDropEvent, disposition: NativeFileDragDisposition) {
    const assetIds = activeNativeDragAssetIdsRef.current;
    if (!assetIds || disposition !== "internal") {
      if (event.type !== "leave" && event.type !== "cancel") setDragTarget(null);
      else if (assetIds) setDragTarget(null);
      return;
    }
    if (event.type === "leave" || event.type === "cancel") {
      setDragTarget(null);
      return;
    }
    const point = nativeDropClientPoint(event.position);
    const payload: InternalDragPayload = { kind: "assets", assetIds };
    const target = sidebarTargetAt(point.x, point.y, payload, entries, albums);
    if (event.type === "drop") {
      activeNativeDragAssetIdsRef.current = null;
      setDragTarget(null);
      if (target?.valid) void performInternalDrop(payload, target);
      return;
    }
    setDragTarget(target);
  }
  const dropState = useFileDrop({
    subscribe: subscribeDrops,
    enabled: dropEnabled,
    classificationId: dropClassificationId,
    libraryRoot,
    ingestMedia: gateway.ingestMedia,
    onIngested: handleIngested,
    onFatalError: setMessage,
    onNativeDragEvent: handleNativeDragEvent,
  });

  async function importFiles() {
    const destination = dropClassificationId;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const paths = await open({ multiple: true, directory: false, title: "라이브러리로 가져올 파일" });
      if (paths) dropState.importPaths(Array.isArray(paths) ? paths : [paths], destination);
    } catch (error) { setMessage(commandErrorMessage(error, "가져올 파일을 선택하지 못했습니다.")); }
  }

  const { metadataImportWorks, setMetadataImportWorks, beginMetadataImport } = useMetadataImport(gateway, refreshClassifications, refreshReviewCount, setAssetRefresh);
  useAutoDismiss(message, setMessage);

  useEffect(() => {
    void refreshSidebar();
  }, [refreshSidebar]);
  useEffect(() => {
    void refreshReviewCount().catch((error) => setMessage(commandErrorMessage(error, "유사 검토 개수를 불러오지 못했습니다.")));
    void refreshTrashCount().catch((error) => setMessage(commandErrorMessage(error, "휴지통 개수를 불러오지 못했습니다.")));
  }, [refreshReviewCount, refreshTrashCount]);
  useDailyLibraryMaintenance(gateway, workload.restricted, appendMessage, refreshTrashCount);
  useReleaseWatchCheck(gateway, libraryRoot, async (result) => {
    await refreshCollections();
    if (result.changedCollections > 0) appendMessage(`${result.provider === "mangadex" ? "MangaDex 새 권" : "Kakao 신간"} 정보가 있는 작품 ${result.changedCollections}개`);
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
  useNativeDragEnd(activeNativeDragAssetIdsRef, setDragTarget);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || dragStateRef.current.phase === "idle") return;
      transitionDrag({ type: "cancel" });
      setDragTarget(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  useWorkspaceShortcuts(view, navigateView, setCreateClassificationRequest);

  function updatePreferences(update: Partial<UiPreferences>) {
    setPreferences((current) => ({ ...current, ...update }));
  }

  /** Set when Home opened another tab: back (mouse, Escape) from that tab's first screen returns to Home. */
  const homeReturnRef = useRef(false);
  function navigateView(next: AssetView, options: { fromHome?: boolean } = {}) {
    // A vault recovery key shown once in Settings is lost if Settings closes (asks first).
    if (view.kind === "settings" && !confirmLeaveVaultRecovery()) return;
    // Re-opening a settings section must switch to it even when the view object is unchanged.
    if (next.kind === "settings") setSettingsSectionRequest((current) => current + 1);
    if (next.kind === "collection" && view.kind === "collections") collectionReturnViewRef.current = view;
    if (next.kind === "settings" && view.kind !== "settings") settingsReturnViewRef.current = view;
    if (next.kind === "collections") updatePreferences({ collectionType: next.typeFilter });
    if (JSON.stringify(next) === JSON.stringify(view)) return;
    // A new 내용 검색 (or 그래도 보기) replaces the current one, so searches never stack in history.
    if (view.kind === "description_search" && next.kind === "description_search") { /* replace */ }
    else if (backNavigationTab(next) === backNavigationTab(view)) viewHistoryRef.current.push(view);
    else {
      viewHistoryRef.current = [];
      homeReturnRef.current = Boolean(options.fromHome) && view.kind === "home";
    }
    setView(next);
  }

  function navigateBack(fallback?: AssetView) {
    const previous = viewHistoryRef.current.pop() ?? fallback;
    if (!previous || backNavigationTab(previous) !== backNavigationTab(view)) {
      if (!homeReturnRef.current || view.kind === "home") return false;
      homeReturnRef.current = false;
      setView({ kind: "home" });
      return true;
    }
    setView(previous);
    return true;
  }
  useBackHandler(() => navigateBack(), 0, maintenance === null);

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
    activeNativeDragAssetIdsRef.current = null;
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
    activeNativeDragAssetIdsRef.current = [...assetIds];
    nativeDragAssetsRef.current.set(workId, assetIds);
    setNativeDragWorks((current) => {
      const running: IngestionWork = { kind: "drag_out", id: workId, total: 1, completed: 0, added: 0, exactDuplicates: [], reviewPending: [], failures: [], status: "running" };
      return current.some((work) => work.id === workId)
        ? current.map((work) => work.id === workId ? running : work)
        : [...current, running];
    });
    try {
      if(preferences.privacyMode || preferences.nsfwFilter) await startAssetDrag(assetIds,{privacyMode:preferences.privacyMode,nsfwFilter:preferences.nsfwFilter});
      else await startAssetDrag(assetIds);
      setNativeDragWorks((current) => current.map((work) => work.id === workId ? { ...work, completed: 1, status: "completed" } : work));
    } catch (error) {
      if (sameAssetIds(activeNativeDragAssetIdsRef.current, assetIds)) activeNativeDragAssetIdsRef.current = null;
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

  async function openExisting(assetId: string, options: { fromHome?: boolean } = {}) {
    try {
      const asset = await gateway.getAsset(assetId);
      navigateView({ kind: "classification", classificationId: null }, options);
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

  useEffect(() => {
    if (dragState.phase !== "dragging" || dragTarget?.position !== "inside" || !dragTarget.valid) return;
    const target = dragTarget;
    const timer = window.setTimeout(() => setPreferences((current) => {
      const key = target.kind === "album" ? "expandedAlbumIds" : "expandedClassificationIds";
      return current[key].includes(target.entryId) ? current : { ...current, [key]: [...current[key], target.entryId] };
    }), 600);
    return () => window.clearTimeout(timer);
  }, [dragState.phase, dragTarget?.kind, dragTarget?.entryId, dragTarget?.position, dragTarget?.valid]);

  useEffect(() => {
    if (dragState.phase !== "dragging") return;
    const timer = window.setInterval(() => {
      const state = dragStateRef.current;
      if (state.phase !== "dragging") return;
      const scroller = document.elementFromPoint?.(state.x, state.y)?.closest<HTMLElement>(".workspace-index__scroll");
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const edge = 36;
      const delta = state.y < rect.top + edge ? -10 : state.y > rect.bottom - edge ? 10 : 0;
      if (delta) {
        scroller.scrollTop += delta;
        setDragTarget(sidebarTargetAt(state.x, state.y, state.payload, entries, albums));
      }
    }, 32);
    return () => window.clearInterval(timer);
  }, [dragState.phase, entries, albums]);

  async function performInternalDrop(payload: InternalDragPayload, target: SidebarDropTarget) {
    try {
      if (payload.kind === "assets") {
        if (target.kind === "album") {
          await gateway.patchAssetAlbums({ assetIds: payload.assetIds, addAlbumIds: [target.entryId], removeAlbumIds: [] });
        } else {
          await gateway.setAssetClassification({ assetIds: payload.assetIds, classificationId: target.entryId });
        }
        setAssetRefresh((current) => current + 1);
        refreshMembershipCounts();
        setMessage(`${payload.assetIds.length}개 자산을 ${target.kind === "album" ? "앨범에 추가" : "폴더로 이동"}했습니다.`);
        return;
      }
      const destination = entries.find((entry) => entry.id === target.entryId);
      const parentId = target.position === "inside" ? target.entryId : destination?.parentId ?? null;
      if (payload.kind === "album") await gateway.moveAlbum(payload.entryId, target.entryId);
      else if (entries.find((entry) => entry.id === payload.entryId)?.parentId !== parentId) await gateway.moveClassification(payload.entryId, parentId);
      setPreferences((current) => ({
        ...current,
        ...(payload.kind === "classification" ? { classificationOrderIds: reorderFolders(entries, current.classificationOrderIds, payload.entryId, target, parentId) } : {}),
        ...(payload.kind === "album"
          ? { expandedAlbumIds: current.expandedAlbumIds.includes(target.entryId) ? current.expandedAlbumIds : [...current.expandedAlbumIds, target.entryId] }
          : { expandedClassificationIds: parentId && !current.expandedClassificationIds.includes(parentId) ? [...current.expandedClassificationIds, parentId] : current.expandedClassificationIds }),
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

  async function restoreCloudMetadataBackup() {
    if (maintenance || !gateway.restoreCloudMetadataBackup) {
      throw new Error("서버 메타데이터 복원을 사용할 수 없습니다.");
    }
    setMaintenance("restore");
    try {
      const result = await gateway.restoreCloudMetadataBackup();
      await refreshSidebar();
      setAssetRefresh((current) => current + 1);
      setVideoPreparationTrigger((current) => current + 1);
      setMessage(`서버 복원이 완료되었습니다. 원본 ${result.originalsRestored.toLocaleString()}개 복원`);
      return result;
    } finally {
      setMaintenance(null);
    }
  }

  return (
    <PrivacyProvider gateway={gateway} libraryKey={libraryRoot} ratingRevision={assetRefresh} nsfwFilter={preferences.nsfwFilter} setNsfwFilter={(nsfwFilter) => updatePreferences({nsfwFilter})} privacyMode={preferences.privacyMode} setPrivacyMode={(privacyMode) => updatePreferences({ privacyMode })}>
      <FaultGameProvider>
      <div className="library-workspace" data-privacy-mode={preferences.privacyMode ? "true" : undefined} inert={maintenance !== null ? true : undefined}>
        <WorkspaceChromeProvider scope={JSON.stringify(shownView.current)} pending={area !== shownArea}>
        <AppShell
          sidebar={
            <WorkspaceNavigation view={shownView.current} requestedView={view} settling={areaSettling} collectionType={preferences.collectionType}
              width={sidebarWidth} onWidthChange={setSidebarWidth} onNavigate={navigateView}
              reviewCount={reviewCount} trashCount={trashCount} onImportFiles={dropEnabled ? () => void importFiles() : undefined}
              unsortedCount={unsortedCount} onQueuesRequested={() => void refreshUnsortedCount().catch(() => undefined)}
              privateVaultAvailable={privateVaultVisible}
              collections={collections}
              places={{ classifications: entries, albums, characters: characterHub.targets, characterGroups: characterHub.groups }}
              assetNavigation={<ClassificationSidebar embedded characters={characterHub.targets} characterGroups={characterHub.groups}
              entries={entries}
              albums={albums}
              view={shownView.current}
              collectionType={preferences.collectionType}
              expandedIds={preferences.expandedClassificationIds}
              pinnedIds={preferences.pinnedClassificationIds}
              orderIds={preferences.classificationOrderIds}
              onPinnedIdsChange={(pinnedClassificationIds) => updatePreferences({ pinnedClassificationIds })}
              expandedAlbumIds={preferences.expandedAlbumIds}
              sidebarWidth={sidebarWidth}
              createClassificationRequest={createClassificationRequest}
              createAlbumRequest={createAlbumRequest}
              onViewChange={navigateView}
              onExpandedIdsChange={(expandedClassificationIds) =>
                updatePreferences({ expandedClassificationIds })
              }
              onExpandedAlbumIdsChange={(expandedAlbumIds) =>
                updatePreferences({ expandedAlbumIds })
              }
              onSidebarWidthChange={setSidebarWidth}
              onCharactersChanged={() => { setAssetRefresh(value => value + 1); refreshCharacterViews(); }}
              onChanged={() => void refreshClassifications()}
              onAlbumsChanged={() => void refreshAlbums()}
              reviewCount={reviewCount}
              trashCount={trashCount}
              dragTarget={dragTarget}
              onPointerDragStart={startPointerDrag}
              onPointerDragMove={movePointerDrag}
              onPointerDragEnd={finishPointerDrag}
              onPointerDragCancel={cancelPointerDrag}
              onClearAssetSelection={() => setClearAssetSelectionRequest((current) => current + 1)}
            />} />
          }
          content={
            <div className="workspace-content">
              <div className="workspace-titlebar" data-tauri-drag-region="deep"><ChromeTarget name="header" className="workspace-titlebar__context" />
                <LightweightModeIndicator />
                <CloudStatusCenter gateway={gateway} libraryRoot={libraryRoot} characterAutomation={characterAutomation} progress={dropState.progress} similarityIndex={similarityIndex}
                  browserStatus={browserStatus} dropEnabled={dropEnabled}
                  works={[...dropState.works, ...nativeDragWorks, ...metadataImportWorks, ...(videoPreparation.work ? [videoPreparation.work] : [])]}
                  retryWork={retryWork} dismissWork={dismissWork} openExisting={(assetId) => void openExisting(assetId)}
                  reviewCount={reviewCount} unsortedCount={unsortedCount}
                  onOpenChange={(open) => { if (open) void refreshUnsortedCount().catch(() => undefined); }}
                  onNavigate={navigateView} />
                <WindowControls /></div>
            <div className="library-content">
              <section className="library-content__browser" aria-label="자산 내용">
                <MotionScope><WorkspaceAreaSwitch view={view} shownView={shownView.current} collections={collections} sidebarWidth={sidebarWidth} onShown={setShownArea} onSettlingChange={setAreaSettling} ready={(host, area) => (area !== "collections" || (collectionsRead?.gateway === gateway && collectionsRead.root === libraryRoot)) && viewReady(host)}><Suspense fallback={<DeferredViewFallback />}>
                {view.kind === "private_vault" ? (
                  privateVaultVisible && privateVaultStatus
                    ? <ExternalVaultBrowser gateway={gateway} status={privateVaultStatus} onStatusChange={updatePrivateVaultStatus}
                        onContentChanged={() => void refreshPrivateVaultStatus()} privacyMode={preferences.privacyMode} />
                    : <DeferredViewFallback />
                ) : view.kind === "home" ? (
                  <HomeView collections={collections} collectionsReady={collectionsRead?.gateway === gateway && collectionsRead.root === libraryRoot} reviewCount={reviewCount} unsortedCount={unsortedCount} trashCount={trashCount}
                    refreshVersion={assetRefresh} onNavigate={(next) => navigateView(next, { fromHome: true })} onOpenAsset={(assetId) => void openExisting(assetId, { fromHome: true })}
                    onQueuesRequested={() => void refreshUnsortedCount().catch(() => undefined)}
                    characters={characterHub.targets} classifications={entries} />
                ) : view.kind === "notes" ? <NotesView key={view.noteId ?? "notes"} noteId={view.noteId} /> : view.kind === "exchange" ? <ExchangeView /> : view.kind === "statistics" ? <StatisticsPanel /> : view.kind === "trash" ? <TrashBrowser onCountChange={setTrashCount} /> : view.kind === "settings" ? (
                  <SettingsView
                    restoring={maintenance === "restore"}
                    onRestore={restoreBackup}
                    onExit={() => { if (confirmLeaveVaultRecovery()) setView(settingsReturnViewRef.current); }}
                    onImportFolder={beginMetadataImport}
                    metadataImportRunning={metadataImportWorks.some((work) => work.status === "running")}
                    onCollectionsChanged={refreshCollections}
                    onCloudCaptureSynced={handleCloudCaptureSync}
                    onRestoreCloudMetadata={restoreCloudMetadataBackup}
                    onPrivateVaultChanged={async () => { await refreshPrivateVaultStatus(); }}
                    initialSection={view.section}
                    sectionRequest={settingsSectionRequest}
                    privacyMode={preferences.privacyMode}
                    onPrivacyModeChange={(privacyMode) => updatePreferences({ privacyMode })}
                    appZoom={preferences.appZoom}
                    onAppZoomChange={(appZoom) => updatePreferences({ appZoom })}
                    appZoomError={appZoomError}
                  />
                ) : view.kind === "similarity_review" ? (
                  <SimilarityReviewBrowser
                    gateway={gateway}
                    videoAssetIds={videoReviewAssetIds}
                    onCountChange={setReviewCount}
                    onClose={() => { setVideoReviewAssetIds([]); void refreshMembershipCounts(); void refreshCollections(); navigateBack({ kind: "classification", classificationId: null }); }}
                  />
                ) : view.kind === "manga" ? (
                  <MangaBrowser
                    onOpenSeries={(series) => setMangaViewer({ seriesId: series.id, title: series.title, pageCount: series.pageCount, galleryId: series.galleryId, artist: series.author })}
                  />
                ) : view.kind === "collection" ? (
                  <CollectionOverlay
                    collectionId={view.collectionId}
                    listOrder={collectionWorkOrderRef.current}
                    initialTmdbSearch={view.tmdbSearch}
                    onTmdbSearchConsumed={() => setView(current => current.kind === "collection" ? { kind: "collection", collectionId: current.collectionId } : current)}
                    collections={collections}
                    onOpenSettings={() => navigateView({ kind: "settings", section: "catalog" })}
                    onOpenCollection={(collectionId) => {
                      const current = collections.find(item => item.id === view.collectionId);
                      if (current?.type === "game" || current?.type === "av" || current?.type === "movie") setView({ kind: "collection", collectionId });
                      else navigateView({ kind: "collection", collectionId });
                    }}
                    onExit={() => {
                      const detailCollection = collections.find((item) => item.id === view.collectionId);
                      navigateBack(collectionReturnViewRef.current ?? {
                        kind: "collections",
                        typeFilter: detailCollection?.type ?? preferences.collectionType,
                        showcase: false,
                      });
                    }}
                    onChanged={refreshCollections}
                  />
                ) : view.kind === "collections" ? (
                  <CollectionBrowser
                    releaseProvider={view.kind === "collections" ? view.releaseProvider : undefined}
                    releaseCalendar={view.kind === "collections" ? view.releaseCalendar : undefined}
                    collections={collections}
                    typeFilter={view.typeFilter}
                    showcase={view.showcase}
                    libraryState={collectionLibraryState[view.typeFilter]}
                    navigationMemory={collectionNavigationMemory.current}
                    onLibraryStateChange={(next) => updateCollectionLibraryState(view.typeFilter, next)}
                    onViewChange={navigateView}
                    onOpenWork={(collectionId, order) => { collectionWorkOrderRef.current = order; navigateView({ kind: "collection", collectionId }); }}
                    onChanged={refreshCollections}
                  />
                ) : view.kind === "albums" ? (
                  <AlbumOverview albums={albums} onNavigate={navigateView} onCreateAlbum={() => setCreateAlbumRequest((current) => current + 1)} onChanged={() => void refreshAlbums()} />
                ) : view.kind === "artists" ? (
                  <ArtistHub view={view} onNavigate={navigateView} privacyMode={preferences.privacyMode} />
                ) : (
                  <CharacterFolderContent albums={albums} requestedAsset={requestedAsset} onRequestedAssetHandled={() => setRequestedAsset(null)} view={view} hub={{ ...characterHub, refresh: refreshCharacterViews }} clearSelectionRequest={clearAssetSelectionRequest} galleryDrag={{ onPointerDragStart: startPointerDrag, onPointerDragMove: movePointerDrag, onPointerDragEnd: finishPointerDrag, onPointerDragCancel: cancelPointerDrag }} classifications={entries} galleryLayout={preferences.galleryLayout} onGalleryLayoutChange={(galleryLayout) => updatePreferences({ galleryLayout })} privacyMode={preferences.privacyMode} onPrivacyModeChange={(privacyMode) => updatePreferences({ privacyMode })} metadataVisible={preferences.metadataVisible} onMetadataVisibleChange={(metadataVisible) => updatePreferences({ metadataVisible })} thumbnailRowHeight={preferences.thumbnailRowHeight} onThumbnailRowHeightChange={(thumbnailRowHeight) => updatePreferences({ thumbnailRowHeight })} refreshVersion={assetRefresh} onNavigate={navigateView} onAssetsChanged={() => { setAssetRefresh(value => value + 1); refreshCharacterViews(); }}>
                  <AssetBrowser
                    navigationMemory={assetNavigationMemory.current}
                    view={view}
                    onViewChange={navigateView}
                    onReviewVideos={(assetIds) => { setVideoReviewAssetIds(assetIds); navigateView({ kind: "similarity_review" }); }}
                    classifications={entries}
                    characterTargets={characterHub.targets}
                    characterGroups={characterHub.groups}
                    onCharactersChanged={() => { setAssetRefresh(value => value + 1); refreshCharacterViews(); }}
                    albums={albums}
                    collections={collections}
                    onCollectionsChanged={() => void refreshCollections()}
                    onMembershipChanged={refreshMembershipCounts}
                    sort={preferences.assetSort}
                    galleryLayout={preferences.galleryLayout}
                    onGalleryLayoutChange={(galleryLayout) => updatePreferences({ galleryLayout })}
                    metadataVisible={preferences.metadataVisible}
                    privacyMode={preferences.privacyMode}
                    onPrivacyModeChange={(privacyMode) => updatePreferences({ privacyMode })}
                    thumbnailRowHeight={preferences.thumbnailRowHeight}
                    refreshVersion={assetRefresh}
                    clearSelectionRequest={clearAssetSelectionRequest}
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
                    onExitDescriptionSearch={() => {
                      // 검색 해제 leaves the search entirely: skip any search state still in history and return to
                      // the view before it; without one, open 에셋 전체 without recording the search for back.
                      const history = viewHistoryRef.current;
                      while (history[history.length - 1]?.kind === "description_search") history.pop();
                      if (!navigateBack()) setView({ kind: "classification", classificationId: null });
                    }}
                  />
                  </CharacterFolderContent>
                )}
                </Suspense></WorkspaceAreaSwitch></MotionScope>
                {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
              </section>
            </div>
            </div>
          }
        />
        </WorkspaceChromeProvider>
      </div>
      <DropOverlay over={dropState.over} destinationName={entries.find((entry) => entry.id === dropClassificationId)?.name ?? "미분류"} />
      <DragLayer state={dragState} />
      {mangaViewer && <Suspense fallback={null}><MangaViewer seriesId={mangaViewer.seriesId} title={mangaViewer.title} pageCount={mangaViewer.pageCount} galleryId={mangaViewer.galleryId} artist={mangaViewer.artist} onClose={() => setMangaViewer(null)} /></Suspense>}
      </FaultGameProvider>
    </PrivacyProvider>
  );
}

function DeferredViewFallback() {
  return <div className="library-content__deferred" role="status" aria-label="화면 불러오는 중" />;
}

function workspaceSwitchKey(view: AssetView) { return view.kind === "collection" ? "collection-work" : workspaceArea(view); }

/** Prepare chrome for the requested scope while the shell still paints the outgoing scope. */
function WorkspaceAreaSwitch({view, shownView, collections, sidebarWidth, onShown, onSettlingChange, ready, children}: {view: AssetView; shownView: AssetView; collections: CollectionSummary[]; sidebarWidth: number; onShown(area: string): void; onSettlingChange(settling: boolean): void; ready(host: HTMLElement, area: string): boolean; children: ReactNode}) {
  const chrome = useWorkspaceChrome();
  const area = workspaceSwitchKey(view), scope = JSON.stringify(view);
  const indexWidth = (target: AssetView) => hasWorkspaceIndex(target, collections, chrome?.getMeta(JSON.stringify(target)) ?? null)
    && !(workspaceArea(target) === "manga" && chrome?.indexHidden.manga) ? sidebarWidth : 0;
  // Prepare at the final width; the index swaps on the same frame as the opacity clock.
  return <AreaSwitch activeKey={area} retained={["home", "manga"]} onShown={onShown} onSettlingChange={onSettlingChange} incomingWidthDelta={indexWidth(shownView) - indexWidth(view)} ready={ready} waitForReady={area === "collection-work" || area === "collections"} views={{[area]: <WorkspaceChromeScope chrome={chrome} scope={scope}>{children}</WorkspaceChromeScope>}}/>;
}

const NO_CHROME_TARGETS = { navigation: null, actions: null, search: null, settings: null, header: null, details: null };
function WorkspaceChromeScope({chrome, scope, children}: {chrome: ReturnType<typeof useWorkspaceChrome>; scope: string; children: ReactNode}) {
  const painted = useContext(AreaPainted);
  // A portal escapes the stage's opacity. Only the painted tree may use the shell's slots.
  return <ChromeContext.Provider value={chrome ? {...chrome, scope, targets: painted ? chrome.targets : NO_CHROME_TARGETS} : null}>{children}</ChromeContext.Provider>;
}
