import { collectionCoverThumbnailUrl } from "../assets/mediaUrl";
import type { CollectionCover } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Skeleton } from "../shared/ui/Skeleton";

type CollectionCoverGridProps = {
  collectionId: string;
  covers: CollectionCover[];
  selectedFileName: string | null;
  shelfFilter: number | null;
  onShelfFilterChange: (next: number | null) => void;
  onSelect: (fileName: string) => void;
};

const SHELVES = [1, 2, 3, 4];

export function CollectionCoverGrid({
  collectionId,
  covers,
  selectedFileName,
  shelfFilter,
  onShelfFilterChange,
  onSelect,
}: CollectionCoverGridProps) {
  const { privacyMode } = usePrivacy();
  const visible = shelfFilter === null ? covers : covers.filter((cover) => cover.shelf === shelfFilter);

  return (
    <div className="collection-overlay__grid-area">
      <div className="collection-overlay__shelves" role="group" aria-label="선반">
        {SHELVES.map((shelf) => (
          <button
            key={shelf}
            type="button"
            className="collection-overlay__shelf-button"
            aria-pressed={shelfFilter === shelf}
            aria-label={`선반 ${shelf}`}
            onClick={() => onShelfFilterChange(shelfFilter === shelf ? null : shelf)}
          >
            {shelf}
          </button>
        ))}
      </div>
      <div className="collection-overlay__cover-grid">
        {visible.length === 0 ? (
          <div className="collection-overlay__cover-empty">표지가 없습니다.</div>
        ) : (
          visible.map((cover) => (
            <button
              key={cover.fileName}
              type="button"
              className="collection-overlay__cover-tile"
              aria-pressed={selectedFileName === cover.fileName}
              onClick={() => onSelect(cover.fileName)}
            >
              {privacyMode ? (
                <Skeleton className="privacy-mask collection-overlay__cover-mask" label="비공개 모드" />
              ) : (
                <img
                  className="collection-cover-image"
                  src={collectionCoverThumbnailUrl(collectionId, cover.fileName)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
              )}
              <span className="collection-overlay__cover-label">{cover.volumeLabel}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
