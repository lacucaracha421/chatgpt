import { ChevronLeftIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { collectionCoverUrl, workArtworkUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { BookConnection, CollectionCover, CollectionSummary, CollectionVolume, CollectionVolumeRangeInput, CreateCollection, MangaDexConnection, ReleaseWatchEvent, ReleaseWatchStatus, UpdateCollection, VolumeImportProgress, VolumeOwnership } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { CollectionSidebarSection } from "./CollectionSidebarSection";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { useBackHandler, useBackNavigationContext } from "../shared/navigation/BackNavigation";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { CollectionCoverGrid } from "./CollectionCoverGrid";
import { CollectionInfoPanel } from "./CollectionInfoPanel";
import { CollectionEditDialog, type CollectionEditMode } from "./CollectionEditDialog";
import { CollectionVolumeGrid, CollectionEditionSelector } from "./CollectionVolumeGrid";
import { MangaCoverViewer } from "./MangaCoverViewer";
import { KakaoConnectDialog } from "./KakaoConnectDialog";
import { MangaDexImportDialog } from "./MangaDexImportDialog";
import { ReleaseWatchSummary } from "./ReleaseWatchSummary";
import { CollectionOwnershipPanel } from "./CollectionOwnershipPanel";
import { MangaConnections } from "./MangaConnections";
import { invalidateReleaseData, useReleaseData } from "./releaseData";
import { latestKoreanRelease, localDay } from "./releaseCaption";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { CollectionWorkScreen, type CollectionWorkData } from "./work/CollectionWorkScreen";
import { useWorkRecord } from "./work/useWorkRecord";
import { useCoverFocus } from "./work/useCoverFocus";
import { CollectionWorkOverlay } from "./work/CollectionWorkOverlay";

type CollectionOverlayProps = {
  collectionId: string;
  initialTmdbSearch?: { query: string; mediaType: "movie" | "tv" };
  onTmdbSearchConsumed?: () => void;
  collections: CollectionSummary[];
  listOrder?: string[];
  onExit: () => void;
  onChanged: () => Promise<void>;
  onOpenSettings: () => void;
  onOpenCollection?: (collectionId: string) => void;
};

export function CollectionOverlay(props: CollectionOverlayProps) {
  const collection = props.collections.find(item => item.id === props.collectionId);
  if (collection && (collection.type === "game" || collection.type === "av" || collection.type === "movie")) return <CollectionWorkOverlay collection={collection} collections={props.collections} listOrder={props.listOrder} initialTmdbSearch={props.initialTmdbSearch} onTmdbSearchConsumed={props.onTmdbSearchConsumed} onExit={props.onExit} onChanged={props.onChanged} onOpenSettings={props.onOpenSettings} onOpenCollection={props.onOpenCollection} />;
  return <LegacyCollectionOverlay {...props} />;
}

function LegacyCollectionOverlay({ collectionId, collections, onExit, onChanged, onOpenCollection }: CollectionOverlayProps) {
  const sidebar = Boolean(useWorkspaceChrome());
  const { gateway, library } = useLibrary();
  const { privacyMode } = usePrivacy();
  const [covers, setCovers] = useState<CollectionCover[] | null>(null);
  const [volumes, setVolumes] = useState<CollectionVolume[] | null>(null);
  const [volumesCollectionId, setVolumesCollectionId] = useState<string | null>(null);
  const [volumeGridOpen, setVolumeGridOpen] = useState(false);
  const [ownership, setOwnership] = useState<{ id: string; rows: VolumeOwnership[] } | null>(null);
  const lastMangaData = useRef<CollectionWorkData | null>(null);
  const [volumeImport, setVolumeImport] = useState<VolumeImportProgress | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [selectedVolumeId, setSelectedVolumeId] = useState<string | null>(null);
  const [viewerVolumeId, setViewerVolumeId] = useState<string | null>(null);
  const [shelfFilter, setShelfFilter] = useState<number | null>(null);
  const [editionIndex, setEditionIndex] = useState(0);
  const [mangaDexConnection, setMangaDexConnection] = useState<MangaDexConnection | null | undefined>(undefined);
  const [kakaoConnection, setBookConnection] = useState<BookConnection | null | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [kakaoOpen, setKakaoOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [kakaoRefreshing, setKakaoRefreshing] = useState(false);
  const [releaseWatchStatus, setReleaseWatchStatus] = useState<ReleaseWatchStatus | null>(null);
  const [releaseChanges, setReleaseChanges] = useState<ReleaseWatchEvent[]>([]);
  const [releaseWatchSaving, setReleaseWatchSaving] = useState(false);
  const [editMode, setEditMode] = useState<CollectionEditMode | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const viewerOpenerRef = useRef<HTMLElement | null>(null);
  const onChangedRef = useRef(onChanged);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const collection = collections.find((candidate) => candidate.id === collectionId);
  const hasCollection = Boolean(collection);
  const isManga = collection?.type === "manga";
  const releases = useReleaseData(gateway.collectionTracking, collections, Boolean(isManga));
  const personal = useWorkRecord(isManga ? collection : undefined);
  const focus = useCoverFocus(isManga && volumesCollectionId === collectionId ? collectionId : null, volumes);
  const isGame = collection?.type === "game";
  const isAv = collection?.type === "av";
  const hasBookConnection = Boolean(kakaoConnection);
  const needsBookReconnect = kakaoConnection?.provider === "aladin";
  const selectedCover = covers?.find((cover) => cover.fileName === selectedFileName) ?? null;
  const viewerVolumes = useMemo(
    () => (volumes ?? [])
      .filter((volume): volume is CollectionVolume & { coverArtworkId: string } => (
        volume.editionIndex === editionIndex && volume.coverArtworkId !== null
      ))
      .sort((left, right) => left.volumeNumber - right.volumeNumber),
    [editionIndex, volumes],
  );

  useEffect(() => {
    if (!hasCollection || isManga || isGame || isAv) {
      setCovers([]);
      setSelectedFileName(null);
      return;
    }
    let active = true;
    void gateway.listCollectionCovers(collectionId).then(
      (next) => {
        if (!active) return;
        setCovers(next);
        setSelectedFileName(next[0]?.fileName ?? null);
      },
      () => { if (active) setCovers([]); },
    );
    return () => { active = false; };
  }, [gateway, collectionId, hasCollection, isGame, isManga, isAv]);

  useEffect(() => {
    if (!isManga || !releases.data) return;
    setReleaseChanges(releases.data.inbox.filter(item => item.collectionId === collectionId).map(item => item.event));
  }, [releases.data, collectionId, isManga]);

  useEffect(() => {
    if (!isManga) {
      setVolumes([]);
      setSelectedVolumeId(null);
      return;
    }
    let active = true;
    // Keep the old work until the next work's volumes arrive.
    setVolumeImport(null);
    void (async () => {
      try {
        const initial = await gateway.listCollectionVolumes(collectionId, (progress) => {
          if (active) setVolumeImport(progress);
        });
        if (!active) return;
        setVolumeImport(null);
        setVolumes(initial);
        setVolumesCollectionId(collectionId);
        setEditionIndex(0);
        setSelectedVolumeId(firstVolumeId(initial, 0));
      } catch (error) {
        if (active) {
          setVolumes([]); // no-flash-ok: failed incoming work settles as an empty result
          setVolumesCollectionId(collectionId);
          setEditionIndex(0);
          setSelectedVolumeId(null);
          setMessage(commandErrorMessage(error, "권별 표지를 불러오지 못했습니다."));
        }
      }
    })();
    return () => { active = false; };
  }, [gateway, collectionId, isManga]);

  useEffect(() => {
    let active = true;
    setReleaseWatchStatus(null);
    if (!hasBookConnection) return () => { active = false; };
    void gateway.getReleaseWatchStatus(collectionId).then(
      (status) => { if (active) setReleaseWatchStatus(status); },
      () => undefined,
    );
    return () => { active = false; };
  }, [collectionId, gateway, hasBookConnection]);

  useEffect(() => {
    let active = true;
    if (!isManga) {
      setMangaDexConnection(null);
      return () => { active = false; };
    }
    setMangaDexConnection(undefined);
    void (async () => {
      let next: MangaDexConnection | null;
      try {
        next = await gateway.getMangaDexConnection(collectionId);
      } catch {
        if (active) setMangaDexConnection(null);
        return;
      }
      if (!active) return;
      setMangaDexConnection(next);
      if (!next) return;
      try {
        const result = await gateway.syncMangaDexVolumeCovers(collectionId);
        const refreshed = await gateway.listCollectionVolumes(collectionId);
        if (!active) return;
        setVolumes(refreshed);
        setSelectedVolumeId((current) => current && refreshed.some((volume) => volume.id === current)
          ? current
          : firstVolumeId(refreshed, 0));
        if (result.failed > 0) {
          setMessage(`표지 ${result.failed}개를 불러오지 못했습니다. 다음 새로고침에서 다시 시도합니다.`);
        }
      } catch (error) {
        if (active) setMessage(commandErrorMessage(error, "권별 표지를 불러오지 못했습니다."));
      }
    })();
    return () => { active = false; };
  }, [gateway, collectionId, isManga]);

  useEffect(() => {
    let active = true;
    if (!isManga) {
      setBookConnection(null);
      return () => { active = false; };
    }
    setBookConnection(undefined);
    void gateway.getBookConnection(collectionId).then(
      (next) => { if (active) setBookConnection(next); },
      () => { if (active) setBookConnection(null); },
    );
    return () => { active = false; };
  }, [gateway, collectionId, isManga]);

  const backNavigation = useBackNavigationContext();
  const canExit = viewerVolumeId === null && !volumeGridOpen && !importOpen && !kakaoOpen && editMode === null && !deleteOpen;
  useBackHandler(onExit, 10, canExit);
  useEffect(() => {
    if (backNavigation || !canExit) return;
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onExit();
      }
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [backNavigation, canExit, onExit]);

  const heroUrl = useMemo(
    () => selectedCover
      ? collectionCoverUrl(collectionId, selectedCover.fileName)
      : collection?.selectedWorkArtworkId
        ? workArtworkUrl(collection.selectedWorkArtworkId)
        : null,
    [collection, collectionId, selectedCover],
  );

  async function submitEdit(input: CreateCollection | UpdateCollection) {
    if (editMode?.kind !== "edit") return;
    await gateway.updateCollection(collectionId, input as UpdateCollection);
    await onChanged();
  }

  async function submitMangaSettings(input: CollectionVolumeRangeInput) {
    if (editMode?.kind !== "edit" || editMode.collection.type !== "manga") return;
    if (!gateway.setCollectionVolumeRange) return;
    await gateway.setCollectionVolumeRange(collectionId, input);
    await onChanged();
    const refreshed = await gateway.listCollectionVolumes(collectionId);
    setVolumes(refreshed);
    setSelectedVolumeId((current) => current && refreshed.some((volume) => volume.id === current)
      ? current
      : firstVolumeId(refreshed, editionIndex));
  }

  async function toggleShowcase() {
    if (!collection) return;
    try {
      await gateway.setCollectionShowcase(collection.id, !collection.showcase);
      await onChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "쇼케이스를 변경하지 못했습니다."));
    }
  }

  async function removeCollection() {
    if (!collection) return;
    try {
      await gateway.deleteCollection(collection.id);
      setDeleteOpen(false);
      await onChanged();
      onExit();
    } catch (error) {
      setMessage(commandErrorMessage(error, "컬렉션을 삭제하지 못했습니다."));
    }
  }

  async function refresh() {
    setRefreshing(true);
    setMessage(null);
    try {
      await gateway.refreshMangaDex(collectionId);
      await onChanged();
      const initial = await gateway.listCollectionVolumes(collectionId);
      setVolumes(initial);
      const result = await gateway.syncMangaDexVolumeCovers(collectionId);
      const refreshed = await gateway.listCollectionVolumes(collectionId);
      setVolumes(refreshed);
      setSelectedVolumeId((current) => current && refreshed.some((volume) => volume.id === current)
        ? current
        : firstVolumeId(refreshed, editionIndex));
      if (result.failed > 0) {
        setMessage(`표지 ${result.failed}개를 불러오지 못했습니다. 다음 새로고침에서 다시 시도합니다.`);
      }
    } catch (error) {
      setMessage(commandErrorMessage(error, "MangaDex 정보를 새로고침하지 못했습니다."));
    } finally {
      setRefreshing(false);
    }
  }

  async function refreshKakao() {
    setKakaoRefreshing(true);
    setMessage(null);
    try {
      const result = await gateway.refreshKakao(collectionId);
      const refreshed = await gateway.listCollectionVolumes(collectionId);
      setVolumes(refreshed);
      setSelectedVolumeId((current) => current && refreshed.some((volume) => volume.id === current)
        ? current
        : firstVolumeId(refreshed, editionIndex));
      setBookConnection(await gateway.getBookConnection(collectionId));
      setReleaseWatchStatus(await gateway.getReleaseWatchStatus(collectionId));
      setMessage(kakaoResultMessage(result));
      invalidateReleaseData();
    } catch (error) {
      setMessage(commandErrorMessage(error, "Kakao 정보를 새로고침하지 못했습니다."));
    } finally {
      setKakaoRefreshing(false);
    }
  }

  async function toggleReleaseWatch(enabled: boolean) {
    if (!releaseWatchStatus || releaseWatchSaving) return;
    setReleaseWatchSaving(true);
    setMessage(null);
    try {
      setReleaseWatchStatus(await gateway.setReleaseWatchEnabled(collectionId, enabled));
      invalidateReleaseData();
    } catch (error) {
      setMessage(commandErrorMessage(error, "신간 알림 설정을 바꾸지 못했습니다."));
    } finally {
      setReleaseWatchSaving(false);
    }
  }

  function selectEdition(next: number) {
    setViewerVolumeId(null);
    setEditionIndex(next);
    setSelectedVolumeId(firstVolumeId(volumes ?? [], next));
  }

  function openVolume(volumeId: string) {
    const volume = volumes?.find((candidate) => candidate.id === volumeId);
    if (!volume?.coverArtworkId) return;
    viewerOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedVolumeId(volumeId);
    setViewerVolumeId(volumeId);
  }

  function closeViewer() {
    setViewerVolumeId(null);
    requestAnimationFrame(() => viewerOpenerRef.current?.focus());
  }

  const mangaData = useMemo<CollectionWorkData | null>(() => {
    if (!isManga || !collection || volumes === null || volumesCollectionId !== collectionId) return lastMangaData.current;
    const visible = volumes.filter(volume => volume.editionIndex === editionIndex).sort((left, right) => left.volumeNumber - right.volumeNumber);
    const picked = visible.find(volume => volume.id === selectedVolumeId) ?? visible[0];
    const value: CollectionWorkData = {
      collection, record: personal.record, av: null, covers: null, related: null, artworks: [], providerConnected: Boolean(mangaDexConnection || kakaoConnection),
      position: picked?.volumeNumber ?? 0, total: visible.length,
      case: { title: collection.name, platform: "other", privacy: privacyMode, front: picked?.coverArtworkId ? workArtworkUrl(picked.coverArtworkId) : null, spine: null, back: null },
      manga: { volumes: visible, activeVolumeId: picked?.id ?? null, editionIndex, latestKoreanVolume: latestKoreanRelease(releases.data?.board.get(collectionId), editionIndex, localDay()), focuses: focus.focuses, ownedNumbers: ownership?.id === collectionId ? ownership.rows.filter(row => row.editionIndex === editionIndex && (row.physical || row.digital)).map(row => row.volumeNumber) : null, scope: library?.root ?? "", revision: "", // Covers have immutable artwork identities; record saves must not recreate the renderer.
        ownership: <section className="work-manga-ownership"><SectionLabel title="소장" /><CollectionOwnershipPanel compact collectionId={collectionId} volumes={volumes} editionIndex={editionIndex} onOwnershipChanged={rows => setOwnership({ id: collectionId, rows })} releaseWatch={{ enabled: releaseWatchStatus?.enabled ?? false, disabled: !kakaoConnection || !releaseWatchStatus || releaseWatchSaving || (needsBookReconnect && !releaseWatchStatus.enabled), unavailableReason: !kakaoConnection || needsBookReconnect ? "Kakao 연결 후 설정할 수 있습니다." : undefined, onChange: enabled => void toggleReleaseWatch(enabled) }} /><CollectionEditionSelector volumes={volumes} editionIndex={editionIndex} onEditionIndexChange={selectEdition} /></section>,
        management: <section className="work-manga-management"><SectionLabel title="발매 정보" /><MangaConnections mangaDex={mangaDexConnection} kakao={kakaoConnection} mangaDexBusy={mangaDexConnection === undefined || refreshing} kakaoBusy={kakaoConnection === undefined || kakaoRefreshing} onConnectMangaDex={() => setImportOpen(true)} onRefreshMangaDex={() => void refresh()} onConnectKakao={() => setKakaoOpen(true)} onRefreshKakao={() => void refreshKakao()} hideConnectionPrompt={collection.hideConnectionPrompt} /><ReleaseWatchSummary events={releaseChanges} />{releaseChanges.length > 0 && gateway.collectionTracking && <Button size="sm" disabled={releaseWatchSaving} onClick={async () => { setReleaseWatchSaving(true); try { await gateway.collectionTracking!.acknowledge(collectionId, releaseChanges.map(event => event.id)); setReleaseChanges([]); void onChangedRef.current().catch(() => undefined); } catch (error) { setMessage(commandErrorMessage(error, "신간 알림을 확인 처리하지 못했습니다.")); } finally { setReleaseWatchSaving(false); } }}>표시된 신간 알림 확인</Button>}</section>,
      },
    };
    lastMangaData.current = value;
    return value;
  }, [isManga, collection, volumes, volumesCollectionId, collectionId, selectedVolumeId, editionIndex, personal.record, privacyMode, focus.focuses, ownership, library?.root, mangaDexConnection, kakaoConnection, refreshing, kakaoRefreshing, releaseWatchStatus, releaseWatchSaving, releaseChanges, releases.data, gateway]);

  if (!collection) return (
    <section className="collection-overlay" aria-label="컬렉션 표지 보기">
      <ViewToolbar title="컬렉션" ariaLabel="컬렉션 표지 도구"
        leadingAction={<Button size="icon" variant="ghost" aria-label="컬렉션으로 돌아가기" onClick={onExit}><ChevronLeftIcon aria-hidden="true" /></Button>} />
      <EmptyState title="컬렉션을 찾을 수 없습니다.">
        <Button onClick={onExit}>돌아가기</Button>
      </EmptyState>
    </section>
  );

  return (
    <section className="collection-overlay" aria-label="컬렉션 표지 보기">
      {isManga && (mangaData ? <CollectionWorkScreen data={mangaData} pending={volumesCollectionId !== collectionId} actions={{
        onClose: onExit, onStep: offset => { const visible = mangaData.manga?.volumes ?? []; const index = visible.findIndex(volume => volume.id === mangaData.manga?.activeVolumeId); const next = visible[index + offset]; if (next) setSelectedVolumeId(next.id); },
        onPickVolume: setSelectedVolumeId, onEnlargeManga: () => { const id = mangaData.manga?.activeVolumeId; if (id) openVolume(id); },
        onEdit: item => setEditMode({ kind: "edit", collection: item }), onShowcase: () => void toggleShowcase(),
        onSave: async (item, edit) => { const record = await personal.save(item, edit); void onChanged().catch(error => setMessage(commandErrorMessage(error, "기록 화면을 갱신하지 못했습니다."))); return record; },
        onOpenPerson: () => undefined, onOpenCollection, onCopyCode: () => undefined,
        onManage: () => [
          { id: "volumes", label: "권별 표지 · 소장", onSelect: () => setVolumeGridOpen(true) },
          { id: "mangadex", label: "MangaDex 연결 · 가져오기", onSelect: () => setImportOpen(true) },
          { id: "mangadex-refresh", label: "MangaDex 새로고침", disabled: !mangaDexConnection || refreshing, onSelect: () => void refresh() },
          { id: "kakao", label: "Kakao 연결", onSelect: () => setKakaoOpen(true) },
          { id: "kakao-refresh", label: "국내 발매 정보 새로고침", disabled: !kakaoConnection || kakaoRefreshing, onSelect: () => void refreshKakao() },
          { id: "focus", label: "책등 초점 다시 찾기", onSelect: focus.retry },
          { id: "delete", label: "컬렉션 삭제", destructive: true, onSelect: () => setDeleteOpen(true) },
        ],
      }} /> : <div className="work-loading"><Skeleton label={volumeImport ? `표지 ${volumeImport.imported}/${volumeImport.total} 가져오는 중…` : "만화 작품 화면"} /><Button onClick={onExit}>닫기</Button></div>)}
      {!isManga && <>
      {sidebar && collection && !isAv && <CollectionSidebarSection>
        <h2 className="collection-detail-sidebar__title">{collection.name}</h2>
        <CollectionInfoPanel collection={collection} compact />
      </CollectionSidebarSection>}
      <ViewToolbar
        title={collection?.name ?? "컬렉션"}
        ariaLabel="컬렉션 표지 도구"
        leadingAction={<>
          <Button size="icon" variant="ghost" aria-label="컬렉션으로 돌아가기" onClick={onExit}>
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
        </>}
      />
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      <div className="collection-overlay__body">
        <div className="collection-overlay__hero">
          {covers === null || privacyMode ? (
            <Skeleton className="collection-overlay__hero-skeleton" label="표지를 불러오는 중" />
          ) : heroUrl ? (
            <img
              key={heroUrl}
              src={heroUrl}
              alt={selectedCover?.volumeLabel ?? collection?.name ?? ""}
              draggable={false}
            />
          ) : (
            <span className="collection-overlay__hero-empty">표지가 없습니다.</span>
          )}
        </div>
        <div className="collection-overlay__details">
          {collection && <CollectionInfoPanel collection={collection} />}
        </div>
      </div>
      {covers !== null && (
        <CollectionCoverGrid
          collectionId={collectionId}
          covers={covers}
          selectedFileName={selectedFileName}
          shelfFilter={shelfFilter}
          onShelfFilterChange={setShelfFilter}
          onSelect={setSelectedFileName}
        />
      )}
      </>}
      {isManga && message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      {volumeGridOpen && <Dialog open title="권별 표지 · 소장" onClose={() => setVolumeGridOpen(false)}><CollectionVolumeGrid volumes={volumes ?? []} selectedVolumeId={selectedVolumeId} editionIndex={editionIndex} onEditionIndexChange={selectEdition} onSelect={id => { setSelectedVolumeId(id); setVolumeGridOpen(false); }} /></Dialog>}
      {viewerVolumeId && viewerVolumes.some((volume) => volume.id === viewerVolumeId) && (
        <MangaCoverViewer
          workTitle={collection?.name ?? "컬렉션"}
          scope={library?.root ?? ""}
          revision={collection?.updatedAt ?? ""}
          volumes={viewerVolumes}
          activeVolumeId={viewerVolumeId}
          onActiveVolumeChange={(volumeId) => {
            setViewerVolumeId(volumeId);
            setSelectedVolumeId(volumeId);
          }}
          onClose={closeViewer}
        />
      )}
      {importOpen && collection && (
        <MangaDexImportDialog
          open
          target={{ kind: "existing", collection }}
          onClose={() => setImportOpen(false)}
          onApplied={async () => {
            await onChanged();
            setMangaDexConnection(await gateway.getMangaDexConnection(collection.id));
          }}
        />
      )}
      {kakaoOpen && collection && (
        <KakaoConnectDialog
          open
          collectionId={collection.id}
          initialQuery={kakaoConnection?.query ?? collection.name}
          onClose={() => setKakaoOpen(false)}
          onApplied={async (result) => {
            const refreshed = await gateway.listCollectionVolumes(collection.id);
            setVolumes(refreshed);
            setSelectedVolumeId((current) => current && refreshed.some((volume) => volume.id === current)
              ? current
              : firstVolumeId(refreshed, editionIndex));
            setBookConnection(await gateway.getBookConnection(collection.id));
            setMessage(kakaoResultMessage(result));
          }}
        />
      )}
      {editMode && (
        <CollectionEditDialog
          open
          mode={editMode}
          onClose={() => setEditMode(null)}
          onSubmit={submitEdit}
          onSubmitMangaSettings={editMode.kind === "edit" && editMode.collection.type === "manga" ? submitMangaSettings : undefined}
        />
      )}
      {deleteOpen && collection && (
        <Dialog open title="컬렉션 삭제" onClose={() => setDeleteOpen(false)}>
          <div className="collection-browser__delete">
            <p>컬렉션 '{collection.name}'을 삭제합니다. 속한 자산은 라이브러리에 보존됩니다.</p>
            <div className="ui-dialog__actions">
              <Button type="button" onClick={() => setDeleteOpen(false)}>취소</Button>
              <Button type="button" variant="danger" onClick={() => void removeCollection()}>삭제</Button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function kakaoResultMessage(result: { added: number; updated: number; unchanged: number; ignored: number }) {
  return `국내 발매 정보: 추가 ${result.added}권, 갱신 ${result.updated}권, 유지 ${result.unchanged}권, 제외 ${result.ignored}개`;
}

function firstVolumeId(volumes: CollectionVolume[], editionIndex: number) {
  return volumes
    .filter((volume) => volume.editionIndex === editionIndex)
    .sort((left, right) => left.volumeNumber - right.volumeNumber)[0]?.id ?? null;
}
