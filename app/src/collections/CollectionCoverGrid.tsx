import { collectionCoverUrl } from "../assets/mediaUrl";
import type { CollectionCover } from "../library/types";

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
              <img
                src={collectionCoverUrl(collectionId, cover.fileName)}
                alt={cover.volumeLabel}
                loading="lazy"
                draggable={false}
              />
              <span className="collection-overlay__cover-label">{cover.volumeLabel}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
