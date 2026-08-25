import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { collectionCoverUrl, workArtworkUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AladinConnection, CollectionCover, CollectionSummary, CollectionVolume, MangaDexConnection, ReleaseWatchEvent, ReleaseWatchStatus } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { CollectionCoverGrid } from "./CollectionCoverGrid";
import { CollectionInfoPanel } from "./CollectionInfoPanel";
import { CollectionVolumeGrid } from "./CollectionVolumeGrid";
import { CollectionVolumePanel } from "./CollectionVolumePanel";
import { MangaCoverViewer } from "./MangaCoverViewer";
import { AladinConnectDialog } from "./AladinConnectDialog";
import { MangaDexImportDialog } from "./MangaDexImportDialog";
import { ReleaseWatchSummary } from "./ReleaseWatchSummary";

type CollectionOverlayProps = {
  collectionId: string;
  collections: CollectionSummary[];
  onExit: () => void;
  onChanged: () => Promise<void>;
};

export function CollectionOverlay({ collectionId, collections, onExit, onChanged }: CollectionOverlayProps) {
  const { gateway } = useLibrary();
  const [covers, setCovers] = useState<CollectionCover[] | null>(null);
  const [volumes, setVolumes] = useState<CollectionVolume[] | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [selectedVolumeId, setSelectedVolumeId] = useState<string | null>(null);
  const [viewerVolumeId, setViewerVolumeId] = useState<string | null>(null);
  const [shelfFilter, setShelfFilter] = useState<number | null>(null);
  const [editionIndex, setEditionIndex] = useState(0);
  const [mangaDexConnection, setMangaDexConnection] = useState<MangaDexConnection | null | undefined>(undefined);
  const [aladinConnection, setAladinConnection] = useState<AladinConnection | null | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [aladinOpen, setAladinOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [aladinRefreshing, setAladinRefreshing] = useState(false);
  const [releaseWatchStatus, setReleaseWatchStatus] = useState<ReleaseWatchStatus | null>(null);
  const [releaseChanges, setReleaseChanges] = useState<ReleaseWatchEvent[]>([]);
  const [releaseWatchSaving, setReleaseWatchSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const viewerOpenerRef = useRef<HTMLElement | null>(null);
  const onChangedRef = useRef(onChanged);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const collection = collections.find((candidate) => candidate.id === collectionId);
  const isManga = collection?.type === "manga";
  const hasAladinConnection = Boolean(aladinConnection);
  const selectedCover = covers?.find((cover) => cover.fileName === selectedFileName) ?? null;
  const selectedVolume = volumes?.find((volume) => volume.id === selectedVolumeId) ?? null;
  const viewerVolumes = useMemo(
    () => (volumes ?? [])
      .filter((volume): volume is CollectionVolume & { coverArtworkId: string } => (
        volume.editionIndex === editionIndex && volume.coverArtworkId !== null
      ))
      .sort((left, right) => left.volumeNumber - right.volumeNumber),
    [editionIndex, volumes],
  );

  useEffect(() => {
    if (isManga) {
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
  }, [gateway, collectionId, isManga]);

  useEffect(() => {
    let active = true;
    setReleaseChanges([]);
    if (!isManga) return () => { active = false; };
    void gateway.takeUnreadReleaseChanges(collectionId).then(
      async (events) => {
        if (!active) return;
        setReleaseChanges(events);
        if (events.length > 0) await onChangedRef.current();
      },
      () => undefined,
    );
    return () => { active = false; };
  }, [gateway, collectionId, isManga]);

  useEffect(() => {
    if (!isManga) {
      setVolumes([]);
      setSelectedVolumeId(null);
      return;
    }
    let active = true;
    setVolumes(null);
    setSelectedVolumeId(null);
    setEditionIndex(0);
    void (async () => {
      try {
        const initial = await gateway.listCollectionVolumes(collectionId);
        if (!active) return;
        setVolumes(initial);
        setSelectedVolumeId(firstVolumeId(initial, 0));
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
        if (active) {
          setVolumes((current) => current ?? []);
          setMessage(commandErrorMessage(error, "권별 표지를 불러오지 못했습니다."));
        }
      }
    })();
    return () => { active = false; };
  }, [gateway, collectionId, isManga]);

  useEffect(() => {
    let active = true;
    setReleaseWatchStatus(null);
    if (!hasAladinConnection) return () => { active = false; };
    void gateway.getReleaseWatchStatus(collectionId).then(
      (status) => { if (active) setReleaseWatchStatus(status); },
      () => undefined,
    );
    return () => { active = false; };
  }, [collectionId, gateway, hasAladinConnection]);

  useEffect(() => {
    let active = true;
    if (!isManga) {
      setMangaDexConnection(null);
      return () => { active = false; };
    }
    setMangaDexConnection(undefined);
    void gateway.getMangaDexConnection(collectionId).then(
      (next) => { if (active) setMangaDexConnection(next); },
      () => { if (active) setMangaDexConnection(null); },
    );
    return () => { active = false; };
  }, [gateway, collectionId, isManga]);

  useEffect(() => {
    let active = true;
    if (!isManga) {
      setAladinConnection(null);
      return () => { active = false; };
    }
    setAladinConnection(undefined);
    void gateway.getAladinConnection(collectionId).then(
      (next) => { if (active) setAladinConnection(next); },
      () => { if (active) setAladinConnection(null); },
    );
    return () => { active = false; };
  }, [gateway, collectionId, isManga]);

  useEffect(() => {
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape" && viewerVolumeId === null && !importOpen && !aladinOpen) onExit();
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [aladinOpen, importOpen, onExit, viewerVolumeId]);

  const heroUrl = useMemo(
    () => isManga && selectedVolume?.coverArtworkId
      ? workArtworkUrl(selectedVolume.coverArtworkId)
      : selectedCover
        ? collectionCoverUrl(collectionId, selectedCover.fileName)
        : collection?.selectedWorkArtworkId
          ? workArtworkUrl(collection.selectedWorkArtworkId)
          : null,
    [collection, collectionId, isManga, selectedCover, selectedVolume],
  );

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

  async function refreshAladin() {
    setAladinRefreshing(true);
    setMessage(null);
    try {
      const result = await gateway.refreshAladin(collectionId);
      const refreshed = await gateway.listCollectionVolumes(collectionId);
      setVolumes(refreshed);
      setSelectedVolumeId((current) => current && refreshed.some((volume) => volume.id === current)
        ? current
        : firstVolumeId(refreshed, editionIndex));
      setAladinConnection(await gateway.getAladinConnection(collectionId));
      setReleaseWatchStatus(await gateway.getReleaseWatchStatus(collectionId));
      setMessage(aladinResultMessage(result));
    } catch (error) {
      setMessage(commandErrorMessage(error, "Aladin 정보를 새로고침하지 못했습니다."));
    } finally {
      setAladinRefreshing(false);
    }
  }

  async function toggleReleaseWatch() {
    if (!releaseWatchStatus) return;
    setReleaseWatchSaving(true);
    setMessage(null);
    try {
      setReleaseWatchStatus(await gateway.setReleaseWatchEnabled(collectionId, !releaseWatchStatus.enabled));
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

  return (
    <section className="collection-overlay" aria-label="컬렉션 표지 보기">
      <ViewToolbar
        title={collection?.name ?? "컬렉션"}
        ariaLabel="컬렉션 표지 도구"
        actions={<>
          <Button size="icon" variant="ghost" aria-label="컬렉션 표지 보기 닫기" onClick={onExit}>
            <XMarkIcon aria-hidden="true" />
          </Button>
        </>}
      />
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      <ReleaseWatchSummary events={releaseChanges} />
      <div className={`collection-overlay__body${isManga ? " collection-overlay__body--manga" : ""}`}>
        {isManga && (
          <Menu
            label="연결 및 갱신"
            trigger={<span>연결 및 갱신</span>}
            items={[
              {
                id: "mangadex",
                label: mangaDexConnection ? "MangaDex 새로고침" : "MangaDex 연결",
                disabled: mangaDexConnection === undefined || refreshing,
                onSelect: () => mangaDexConnection ? void refresh() : setImportOpen(true),
              },
              {
                id: "aladin",
                label: aladinConnection ? "Aladin 새로고침" : "Aladin 연결",
                disabled: aladinConnection === undefined || aladinRefreshing,
                onSelect: () => aladinConnection ? void refreshAladin() : setAladinOpen(true),
              },
              ...(aladinConnection && releaseWatchStatus ? [{
                id: "release-watch",
                label: releaseWatchStatus.enabled ? "신간 알림 끄기" : "신간 알림 켜기",
                disabled: releaseWatchSaving,
                onSelect: () => void toggleReleaseWatch(),
              }] : []),
            ]}
          />
        )}
        <div className="collection-overlay__hero">
          {!isManga && covers === null ? (
            <Skeleton className="collection-overlay__hero-skeleton" label="표지를 불러오는 중" />
          ) : heroUrl ? (
            <img
              key={heroUrl}
              src={heroUrl}
              alt={selectedVolume ? `${selectedVolume.displayLabel}권 표지` : selectedCover?.volumeLabel ?? collection?.name ?? ""}
              draggable={false}
            />
          ) : (
            <span className="collection-overlay__hero-empty">표지가 없습니다.</span>
          )}
        </div>
        <div className="collection-overlay__details">
          {collection && <CollectionInfoPanel collection={collection} />}
          {isManga && (
            <CollectionVolumePanel
              coverCount={volumes?.length ?? 0}
              volumeLabel={selectedVolume?.displayLabel ?? ""}
              localReleaseDate={selectedVolume?.localReleaseDate ?? null}
              isbn13={selectedVolume?.isbn13 ?? null}
              releaseStatus={selectedVolume?.releaseStatus ?? null}
            />
          )}
        </div>
      </div>
      {isManga && volumes !== null ? (
        <CollectionVolumeGrid
          volumes={volumes}
          selectedVolumeId={selectedVolumeId}
          editionIndex={editionIndex}
          onEditionIndexChange={selectEdition}
          onSelect={openVolume}
        />
      ) : !isManga && covers !== null ? (
        <CollectionCoverGrid
          collectionId={collectionId}
          covers={covers}
          selectedFileName={selectedFileName}
          shelfFilter={shelfFilter}
          onShelfFilterChange={setShelfFilter}
          onSelect={setSelectedFileName}
        />
      ) : null}
      {viewerVolumeId && viewerVolumes.some((volume) => volume.id === viewerVolumeId) && (
        <MangaCoverViewer
          workTitle={collection?.name ?? "컬렉션"}
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
      {aladinOpen && collection && (
        <AladinConnectDialog
          open
          collectionId={collection.id}
          initialQuery={collection.name}
          onClose={() => setAladinOpen(false)}
          onApplied={async (result) => {
            const refreshed = await gateway.listCollectionVolumes(collection.id);
            setVolumes(refreshed);
            setSelectedVolumeId((current) => current && refreshed.some((volume) => volume.id === current)
              ? current
              : firstVolumeId(refreshed, editionIndex));
            setAladinConnection(await gateway.getAladinConnection(collection.id));
            setMessage(aladinResultMessage(result));
          }}
        />
      )}
    </section>
  );
}

function aladinResultMessage(result: { added: number; updated: number; unchanged: number; ignored: number }) {
  return `국내 발매 정보: 추가 ${result.added}권, 갱신 ${result.updated}권, 유지 ${result.unchanged}권, 제외 ${result.ignored}개`;
}

function firstVolumeId(volumes: CollectionVolume[], editionIndex: number) {
  return volumes
    .filter((volume) => volume.editionIndex === editionIndex)
    .sort((left, right) => left.volumeNumber - right.volumeNumber)[0]?.id ?? null;
}
