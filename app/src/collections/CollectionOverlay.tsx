import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { collectionCoverUrl, workArtworkUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionCover, CollectionSummary, CollectionVolume, MangaDexConnection } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { CollectionCoverGrid } from "./CollectionCoverGrid";
import { CollectionInfoPanel } from "./CollectionInfoPanel";
import { CollectionVolumeGrid } from "./CollectionVolumeGrid";
import { CollectionVolumePanel } from "./CollectionVolumePanel";
import { MangaDexImportDialog } from "./MangaDexImportDialog";

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
  const [shelfFilter, setShelfFilter] = useState<number | null>(null);
  const [editionIndex, setEditionIndex] = useState(0);
  const [connection, setConnection] = useState<MangaDexConnection | null | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const collection = collections.find((candidate) => candidate.id === collectionId);
  const isManga = collection?.type === "manga";
  const selectedCover = covers?.find((cover) => cover.fileName === selectedFileName) ?? null;
  const selectedVolume = volumes?.find((volume) => volume.id === selectedVolumeId) ?? null;

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
    if (!isManga) {
      setConnection(null);
      return () => { active = false; };
    }
    setConnection(undefined);
    void gateway.getMangaDexConnection(collectionId).then(
      (next) => { if (active) setConnection(next); },
      () => { if (active) setConnection(null); },
    );
    return () => { active = false; };
  }, [gateway, collectionId, isManga]);

  useEffect(() => {
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [onExit]);

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

  function selectEdition(next: number) {
    setEditionIndex(next);
    setSelectedVolumeId(firstVolumeId(volumes ?? [], next));
  }

  return (
    <section className="collection-overlay" aria-label="컬렉션 표지 보기">
      <ViewToolbar
        title={collection?.name ?? "컬렉션"}
        ariaLabel="컬렉션 표지 도구"
        actions={<>
          {isManga && connection !== undefined && (
            <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => connection ? void refresh() : setImportOpen(true)}>
              {connection ? "MangaDex 새로고침" : "MangaDex 연결"}
            </Button>
          )}
          <Button size="icon" variant="ghost" aria-label="컬렉션 표지 보기 닫기" onClick={onExit}>
            <XMarkIcon aria-hidden="true" />
          </Button>
        </>}
      />
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      <div className="collection-overlay__body">
        {collection && <CollectionInfoPanel collection={collection} />}
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
        {isManga && (
          <CollectionVolumePanel coverCount={volumes?.length ?? 0} volumeLabel={selectedVolume?.displayLabel ?? ""} />
        )}
      </div>
      {isManga && volumes !== null ? (
        <CollectionVolumeGrid
          volumes={volumes}
          selectedVolumeId={selectedVolumeId}
          editionIndex={editionIndex}
          onEditionIndexChange={selectEdition}
          onSelect={setSelectedVolumeId}
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
      {importOpen && collection && (
        <MangaDexImportDialog
          open
          target={{ kind: "existing", collection }}
          onClose={() => setImportOpen(false)}
          onApplied={async () => {
            await onChanged();
            setConnection(await gateway.getMangaDexConnection(collection.id));
          }}
        />
      )}
    </section>
  );
}

function firstVolumeId(volumes: CollectionVolume[], editionIndex: number) {
  return volumes
    .filter((volume) => volume.editionIndex === editionIndex)
    .sort((left, right) => left.volumeNumber - right.volumeNumber)[0]?.id ?? null;
}
