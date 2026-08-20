import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { collectionCoverUrl, workArtworkUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CollectionCover, CollectionSummary, MangaDexConnection } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { CollectionCoverGrid } from "./CollectionCoverGrid";
import { CollectionInfoPanel } from "./CollectionInfoPanel";
import { CollectionVolumePanel } from "./CollectionVolumePanel";
import { MangaDexImportDialog } from "./MangaDexImportDialog";

type CollectionOverlayProps = {
  collectionId: string;
  collections: CollectionSummary[];
  onExit: () => void;
  onChanged: () => Promise<void>;
};

export function CollectionOverlay({
  collectionId,
  collections,
  onExit,
  onChanged,
}: CollectionOverlayProps) {
  const { gateway } = useLibrary();
  const [covers, setCovers] = useState<CollectionCover[] | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [shelfFilter, setShelfFilter] = useState<number | null>(null);
  const [volumeLabel, setVolumeLabel] = useState("");
  const [connection, setConnection] = useState<MangaDexConnection | null | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const collection = collections.find((candidate) => candidate.id === collectionId);
  const selectedCover = covers?.find((cover) => cover.fileName === selectedFileName) ?? null;

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await gateway.listCollectionCovers(collectionId);
        if (!active) return;
        setCovers(next);
        setSelectedFileName(next[0]?.fileName ?? null);
        setVolumeLabel(next[0]?.volumeLabel ?? "");
      } catch (error) {
        if (active) setCovers([]);
      }
    })();
    return () => { active = false; };
  }, [gateway, collectionId]);

  useEffect(() => {
    let active = true;
    if (collection?.type !== "manga") {
      setConnection(null);
      return () => { active = false; };
    }
    setConnection(undefined);
    void gateway.getMangaDexConnection(collectionId).then(
      (next) => { if (active) setConnection(next); },
      () => { if (active) setConnection(null); },
    );
    return () => { active = false; };
  }, [gateway, collectionId, collection?.type]);

  useEffect(() => {
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [onExit]);

  const heroUrl = useMemo(
    () => selectedCover
      ? collectionCoverUrl(collectionId, selectedCover.fileName)
      : collection?.selectedWorkArtworkId
        ? workArtworkUrl(collection.selectedWorkArtworkId)
        : null,
    [collection, collectionId, selectedCover],
  );

  async function refresh() {
    setRefreshing(true);
    setMessage(null);
    try {
      await gateway.refreshMangaDex(collectionId);
      await onChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "MangaDex 정보를 새로고침하지 못했습니다."));
    } finally {
      setRefreshing(false);
    }
  }

  function selectCover(fileName: string) {
    const cover = covers?.find((candidate) => candidate.fileName === fileName);
    setSelectedFileName(fileName);
    setVolumeLabel(cover?.volumeLabel ?? "");
  }

  return (
    <section className="collection-overlay" aria-label="컬렉션 표지 보기">
      <ViewToolbar
        title={collection?.name ?? "컬렉션"}
        ariaLabel="컬렉션 표지 도구"
        actions={
          <>
            {collection?.type === "manga" && connection !== undefined && (
              <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => connection ? void refresh() : setImportOpen(true)}>
                {connection ? "MangaDex 새로고침" : "MangaDex 연결"}
              </Button>
            )}
            <Button size="icon" variant="ghost" aria-label="컬렉션 표지 보기 닫기" onClick={onExit}>
              <XMarkIcon aria-hidden="true" />
            </Button>
          </>
        }
      />
      {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
      <div className="collection-overlay__body">
        {collection && <CollectionInfoPanel collection={collection} />}
        <div className="collection-overlay__hero">
          {covers === null ? (
            <Skeleton className="collection-overlay__hero-skeleton" label="표지를 불러오는 중" />
          ) : heroUrl ? (
            <img key={heroUrl} src={heroUrl} alt={selectedCover?.volumeLabel ?? collection?.name ?? ""} draggable={false} />
          ) : (
            <span className="collection-overlay__hero-empty">표지가 없습니다.</span>
          )}
        </div>
        <CollectionVolumePanel
          coverCount={covers?.length ?? 0}
          volumeLabel={volumeLabel}
          onVolumeLabelChange={setVolumeLabel}
        />
      </div>
      {covers !== null && (
        <CollectionCoverGrid
          collectionId={collectionId}
          covers={covers}
          selectedFileName={selectedFileName}
          shelfFilter={shelfFilter}
          onShelfFilterChange={setShelfFilter}
          onSelect={selectCover}
        />
      )}
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
