import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { collectionCoverUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import type { CollectionCover, CollectionSummary } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";
import { CollectionCoverGrid } from "./CollectionCoverGrid";
import { CollectionInfoPanel } from "./CollectionInfoPanel";
import { CollectionVolumePanel } from "./CollectionVolumePanel";

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
}: CollectionOverlayProps) {
  const { gateway } = useLibrary();
  const [covers, setCovers] = useState<CollectionCover[] | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [shelfFilter, setShelfFilter] = useState<number | null>(null);
  const [volumeLabel, setVolumeLabel] = useState("");

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
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") onExit();
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [onExit]);

  const heroUrl = useMemo(
    () => (selectedCover ? collectionCoverUrl(collectionId, selectedCover.fileName) : null),
    [collectionId, selectedCover],
  );

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
          <Button size="icon" variant="ghost" aria-label="컬렉션 표지 보기 닫기" onClick={onExit}>
            <XMarkIcon aria-hidden="true" />
          </Button>
        }
      />
      <div className="collection-overlay__body">
        {collection && <CollectionInfoPanel collection={collection} />}
        <div className="collection-overlay__hero">
          {covers === null ? (
            <Skeleton className="collection-overlay__hero-skeleton" label="표지를 불러오는 중" />
          ) : heroUrl ? (
            <img key={heroUrl} src={heroUrl} alt={selectedCover?.volumeLabel ?? ""} draggable={false} />
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
    </section>
  );
}
