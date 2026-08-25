import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import type { CollectionVolume } from "../library/types";

type CollectionVolumeGridProps = {
  volumes: CollectionVolume[];
  selectedVolumeId: string | null;
  editionIndex: number;
  onEditionIndexChange: (next: number) => void;
  onSelect: (volumeId: string) => void;
};

const DRAWERS = [0, 1, 2, 3];

export function CollectionVolumeGrid({
  volumes,
  selectedVolumeId,
  editionIndex,
  onEditionIndexChange,
  onSelect,
}: CollectionVolumeGridProps) {
  const visible = volumes
    .filter((volume) => volume.editionIndex === editionIndex)
    .sort((left, right) => left.volumeNumber - right.volumeNumber);

  return (
    <section className="collection-overlay__grid-area" aria-labelledby="collection-volume-grid-heading">
      <div className="collection-overlay__grid-heading">
        <div>
          <h3 id="collection-volume-grid-heading">권별 표지</h3>
          <span>총 {visible.length}권</span>
        </div>
        <div className="collection-overlay__shelves" role="group" aria-label="판본 서랍">
          {DRAWERS.map((drawer) => (
            <button
              key={drawer}
              type="button"
              className="collection-overlay__shelf-button"
              aria-label={`서랍 ${drawer + 1}`}
              aria-pressed={editionIndex === drawer}
              onClick={() => onEditionIndexChange(drawer)}
            >
              {drawer + 1}
            </button>
          ))}
        </div>
      </div>
      <div className="collection-overlay__cover-grid">
        {visible.length === 0 ? (
          <div className="collection-overlay__cover-empty">이 판본의 표지가 없습니다.</div>
        ) : (
          visible.map((volume) => {
            const label = `${volume.displayLabel}권 표지`;
            return (
              <button
                key={volume.id}
                type="button"
                className="collection-overlay__cover-tile"
                aria-label={volume.coverArtworkId ? label : `${label} 불러오는 중`}
                aria-pressed={selectedVolumeId === volume.id}
                onClick={() => onSelect(volume.id)}
              >
                {volume.coverArtworkId ? (
                  <img src={workArtworkThumbnailUrl(volume.coverArtworkId)} alt={label} loading="lazy" draggable={false} />
                ) : (
                  <span className="collection-overlay__cover-placeholder" aria-hidden="true" />
                )}
                <span className="collection-overlay__cover-label">{volume.displayLabel}</span>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
