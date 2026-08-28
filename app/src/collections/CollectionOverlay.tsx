import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { collectionCoverUrl, workArtworkUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AladinConnection, CollectionCover, CollectionSummary, CollectionVolume, CreateCollection, IgdbConnection, MangaDexConnection, ReleaseWatchEvent, ReleaseWatchStatus, TmdbConnection, UpdateCollection } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { Menu } from "../shared/ui/Menu";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { CollectionCoverGrid } from "./CollectionCoverGrid";
import { CollectionInfoPanel } from "./CollectionInfoPanel";
import { CollectionEditDialog, type CollectionEditMode } from "./CollectionEditDialog";
import { CollectionVolumeGrid } from "./CollectionVolumeGrid";
import { MangaCoverViewer } from "./MangaCoverViewer";
import { AladinConnectDialog } from "./AladinConnectDialog";
import { MangaDexImportDialog } from "./MangaDexImportDialog";
import { ReleaseWatchSummary } from "./ReleaseWatchSummary";
import { GameCollectionDetail } from "./GameCollectionDetail";
import { IgdbImportDialog } from "./IgdbImportDialog";
import { MovieCollectionDetail } from "./MovieCollectionDetail";
import { TmdbMovieDialog, type TmdbMovieTarget } from "./TmdbMovieDialog";

type CollectionOverlayProps = {
  collectionId: string;
  collections: CollectionSummary[];
  onExit: () => void;
  onChanged: () => Promise<void>;
  onOpenSettings: () => void;
};

export function CollectionOverlay({ collectionId, collections, onExit, onChanged, onOpenSettings }: CollectionOverlayProps) {
  const { gateway } = useLibrary();
  const { privacyMode } = usePrivacy();
  const [covers, setCovers] = useState<CollectionCover[] | null>(null);
  const [volumes, setVolumes] = useState<CollectionVolume[] | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [selectedVolumeId, setSelectedVolumeId] = useState<string | null>(null);
  const [viewerVolumeId, setViewerVolumeId] = useState<string | null>(null);
  const [shelfFilter, setShelfFilter] = useState<number | null>(null);
  const [editionIndex, setEditionIndex] = useState(0);
  const [mangaDexConnection, setMangaDexConnection] = useState<MangaDexConnection | null | undefined>(undefined);
  const [aladinConnection, setAladinConnection] = useState<AladinConnection | null | undefined>(undefined);
  const [igdbConnection, setIgdbConnection] = useState<IgdbConnection | null | undefined>(undefined);
  const [tmdbConnection, setTmdbConnection] = useState<TmdbConnection | null | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [aladinOpen, setAladinOpen] = useState(false);
  const [igdbOpen, setIgdbOpen] = useState(false);
  const [tmdbTarget, setTmdbTarget] = useState<TmdbMovieTarget | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [aladinRefreshing, setAladinRefreshing] = useState(false);
  const [igdbRefreshing, setIgdbRefreshing] = useState(false);
  const [tmdbRefreshing, setTmdbRefreshing] = useState(false);
  const [releaseWatchStatus, setReleaseWatchStatus] = useState<ReleaseWatchStatus | null>(null);
  const [releaseChanges, setReleaseChanges] = useState<ReleaseWatchEvent[]>([]);
  const [releaseWatchSaving, setReleaseWatchSaving] = useState(false);
  const [igdbError, setIgdbError] = useState<string | null>(null);
  const [tmdbError, setTmdbError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<CollectionEditMode | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const viewerOpenerRef = useRef<HTMLElement | null>(null);
  const onChangedRef = useRef(onChanged);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const collection = collections.find((candidate) => candidate.id === collectionId);
  const isManga = collection?.type === "manga";
  const isGame = collection?.type === "game";
  const isMovie = collection?.type === "movie";
  const hasAladinConnection = Boolean(aladinConnection);
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
    if (isManga || isGame || isMovie) {
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
  }, [gateway, collectionId, isGame, isManga, isMovie]);

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
    // 레거시 게임·영화는 로컬 소스 폴더의 표지·아트를 work artwork으로
    // 지연 등록한다. 한 번 등록되면 이후 호출은 새 파일이 없으면 0을 반환한다.
    if (!isGame && !isMovie) return;
    let active = true;
    void (async () => {
      try {
        const imported = await gateway.importCollectionArtworks(collectionId);
        if (active && imported > 0) await onChangedRef.current();
      } catch {
        // 등록에 실패해도 뷰어는 소스 표지로 계속 동작한다.
      }
    })();
    return () => { active = false; };
  }, [gateway, collectionId, isGame, isMovie]);

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
    setIgdbError(null);
    if (!isGame) {
      setIgdbConnection(null);
      return () => { active = false; };
    }
    setIgdbConnection(undefined);
    void gateway.getIgdbConnection(collectionId).then(
      (next) => { if (active) setIgdbConnection(next); },
      (error) => {
        if (active) {
          setIgdbConnection(null);
          setIgdbError(commandErrorMessage(error, "IGDB 연결 상태를 불러오지 못했습니다."));
        }
      },
    );
    return () => { active = false; };
  }, [gateway, collectionId, isGame]);

  useEffect(() => {
    let active = true;
    setTmdbError(null);
    if (!isMovie) {
      setTmdbConnection(null);
      return () => { active = false; };
    }
    setTmdbConnection(undefined);
    void gateway.getTmdbConnection(collectionId).then(
      (next) => { if (active) setTmdbConnection(next); },
      (error) => {
        if (active) {
          setTmdbConnection(null);
          setTmdbError(commandErrorMessage(error, "TMDB 연결 상태를 불러오지 못했습니다."));
        }
      },
    );
    return () => { active = false; };
  }, [gateway, collectionId, isMovie]);

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
      if (event.key === "Escape" && !event.defaultPrevented && viewerVolumeId === null && !importOpen && !aladinOpen && !igdbOpen && tmdbTarget === null) onExit();
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [aladinOpen, igdbOpen, importOpen, onExit, tmdbTarget, viewerVolumeId]);

  const heroUrl = useMemo(
    () => selectedCover
      ? collectionCoverUrl(collectionId, selectedCover.fileName)
      : collection?.selectedWorkArtworkId
        ? workArtworkUrl(collection.selectedWorkArtworkId)
        : null,
    [collection, collectionId, selectedCover],
  );

  const gameCoverUrl = collection?.selectedWorkArtworkId
    ? workArtworkUrl(collection.selectedWorkArtworkId)
    : null;
  const gameHeroUrl = collection?.selectedHeroArtworkId
    ? workArtworkUrl(collection.selectedHeroArtworkId)
    : null;
  const moviePosterUrl = collection?.selectedWorkArtworkId ? workArtworkUrl(collection.selectedWorkArtworkId) : null;
  const movieBackdropUrl = collection?.selectedBackdropArtworkId ? workArtworkUrl(collection.selectedBackdropArtworkId) : null;

  const providerMenu = isManga ? (
    <Menu
      label="연결 및 갱신"
      trigger={<span>연결 및 갱신</span>}
      items={[
        {
          id: "edit",
          label: "편집",
          onSelect: () => collection && setEditMode({ kind: "edit", collection }),
        },
        {
          id: "showcase",
          label: collection?.showcase ? "쇼케이스에서 제거" : "쇼케이스에 추가",
          onSelect: () => void toggleShowcase(),
        },
        {
          id: "delete",
          label: "삭제",
          destructive: true,
          onSelect: () => setDeleteOpen(true),
        },
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
  ) : null;

  async function submitEdit(input: CreateCollection | UpdateCollection) {
    if (editMode?.kind !== "edit") return;
    await gateway.updateCollection(collectionId, input as UpdateCollection);
    await onChanged();
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

  async function refreshIgdb() {
    setIgdbRefreshing(true);
    setIgdbError(null);
    try {
      await gateway.refreshIgdbGame(collectionId);
      await onChanged();
    } catch (error) {
      setIgdbError(commandErrorMessage(error, "IGDB 정보를 새로고침하지 못했습니다."));
    } finally {
      setIgdbRefreshing(false);
    }
  }

  async function refreshTmdb() {
    setTmdbRefreshing(true);
    setTmdbError(null);
    try {
      await gateway.refreshTmdbMovie(collectionId);
      await onChanged();
      setTmdbConnection(await gateway.getTmdbConnection(collectionId));
    } catch (error) {
      setTmdbError(commandErrorMessage(error, "TMDB 정보를 새로고침하지 못했습니다."));
    } finally {
      setTmdbRefreshing(false);
    }
  }

  function openIgdbSettings() {
    setIgdbOpen(false);
    onOpenSettings();
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
      {isGame && collection ? (
        <GameCollectionDetail
          collection={collection}
          coverUrl={gameCoverUrl}
          heroUrl={gameHeroUrl}
          providerConnected={Boolean(igdbConnection)}
          providerBusy={igdbConnection === undefined || igdbRefreshing}
          providerError={igdbError}
          onEdit={() => setEditMode({ kind: "edit", collection })}
          onToggleShowcase={() => void toggleShowcase()}
          onDelete={() => setDeleteOpen(true)}
          onRefreshProvider={() => void refreshIgdb()}
          onChangeArtwork={() => setIgdbOpen(true)}
        />
      ) : isMovie && collection ? (
        <MovieCollectionDetail
          collection={collection}
          posterUrl={moviePosterUrl}
          backdropUrl={movieBackdropUrl}
          providerConnected={Boolean(tmdbConnection)}
          providerBusy={tmdbConnection === undefined || tmdbRefreshing}
          providerError={tmdbError}
          onEdit={() => setEditMode({ kind: "edit", collection })}
          onToggleShowcase={() => void toggleShowcase()}
          onDelete={() => setDeleteOpen(true)}
          onConnectProvider={() => setTmdbTarget({ kind: "existing", collectionId: collection.id })}
          onRefreshProvider={() => void refreshTmdb()}
          onChangeArtwork={() => setTmdbTarget({ kind: "artwork", collectionId: collection.id })}
        />
      ) : isManga ? (
        <div className="collection-overlay__manga-layout" role="region" aria-label="만화 상세">
            <div className="collection-overlay__manga-main">
              {volumes !== null && (
                <CollectionVolumeGrid
                  volumes={volumes}
                  selectedVolumeId={selectedVolumeId}
                  editionIndex={editionIndex}
                  onEditionIndexChange={selectEdition}
                  onSelect={openVolume}
                />
              )}
            </div>
            <aside className="collection-overlay__manga-aside">
              {collection && <CollectionInfoPanel collection={collection} />}
              {providerMenu}
            </aside>
        </div>
      ) : (
        <>
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
        </>
      )}
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
      {igdbOpen && collection && isGame && (
        <IgdbImportDialog
          open
          target={{ kind: "existing", collectionId: collection.id }}
          onClose={() => setIgdbOpen(false)}
          onOpenSettings={openIgdbSettings}
          onApplied={async () => {
            setIgdbOpen(false);
            try {
              await onChanged();
              setIgdbError(null);
              setIgdbConnection(await gateway.getIgdbConnection(collection.id));
            } catch (error) {
              setIgdbConnection(null);
              setIgdbError(commandErrorMessage(error, "IGDB 정보를 갱신하지 못했습니다."));
            }
          }}
        />
      )}
      {tmdbTarget && collection && isMovie && (
        <TmdbMovieDialog
          open
          target={tmdbTarget}
          onClose={() => setTmdbTarget(null)}
          onOpenSettings={() => {
            setTmdbTarget(null);
            onOpenSettings();
          }}
          onApplied={async () => {
            try {
              await onChanged();
              setTmdbConnection(await gateway.getTmdbConnection(collection.id));
              setTmdbError(null);
            } catch (error) {
              setTmdbError(commandErrorMessage(error, "TMDB 정보를 갱신하지 못했습니다."));
            }
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
      {editMode && (
        <CollectionEditDialog
          open
          mode={editMode}
          onClose={() => setEditMode(null)}
          onSubmit={submitEdit}
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

function aladinResultMessage(result: { added: number; updated: number; unchanged: number; ignored: number }) {
  return `국내 발매 정보: 추가 ${result.added}권, 갱신 ${result.updated}권, 유지 ${result.unchanged}권, 제외 ${result.ignored}개`;
}

function firstVolumeId(volumes: CollectionVolume[], editionIndex: number) {
  return volumes
    .filter((volume) => volume.editionIndex === editionIndex)
    .sort((left, right) => left.volumeNumber - right.volumeNumber)[0]?.id ?? null;
}
