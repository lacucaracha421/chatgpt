import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import type { CollectionVolume } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";

type CollectionVolumeGridProps = {
  volumes: CollectionVolume[];
  selectedVolumeId: string | null;
  editionIndex: number;
  onEditionIndexChange: (next: number) => void;
  onSelect: (volumeId: string) => void;
};

export function CollectionVolumeGrid({
  volumes,
  selectedVolumeId,
  editionIndex,
  onEditionIndexChange,
  onSelect,
}: CollectionVolumeGridProps) {
  const { privacyMode } = usePrivacy();
  const visible = volumes
    .filter((volume) => volume.editionIndex === editionIndex)
    .sort((left, right) => left.volumeNumber - right.volumeNumber);
  const editionIndexes = [...new Set(volumes.map((volume) => volume.editionIndex))]
    .sort((left, right) => left - right);

  return (
    <section className="collection-overlay__grid-area collection-volume-shelf" aria-labelledby="collection-volume-grid-heading">
      <div className="collection-overlay__grid-heading">
        <div>
          <h3 id="collection-volume-grid-heading">권별 표지</h3>
          <span>총 {visible.length}권</span>
        </div>
        {editionIndexes.length > 1 && (
          <div className="collection-overlay__shelves" role="group" aria-label="판본 선택">
            {editionIndexes.map((drawer) => {
              const label = editionLabel(drawer);
              return (
                <button
                  key={drawer}
                  type="button"
                  className="collection-overlay__shelf-button"
                  aria-label={`${label} 선택`}
                  aria-pressed={editionIndex === drawer}
                  onClick={() => onEditionIndexChange(drawer)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
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
                <span className="collection-volume-shelf__cover">
                  {volume.coverArtworkId && !privacyMode ? (
                    <img className="collection-cover-image" src={workArtworkThumbnailUrl(volume.coverArtworkId)} alt={label} loading="lazy" draggable={false} />
                  ) : (
                    <span className="collection-overlay__cover-placeholder" aria-hidden="true" />
                  )}
                </span>
                <span className="collection-overlay__cover-label">{volume.displayLabel}</span>
                {volume.releaseStatus === "upcoming" && (
                  <span className="collection-overlay__cover-badge" title={volume.localReleaseDate ? `${volume.localReleaseDate} 출간 예정` : undefined}>
                    {volume.localReleaseDate ? `${formatKoreanDate(volume.localReleaseDate)} 예정` : "출간 예정"}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function editionLabel(index: number) {
  return index === 0 ? "기본판" : `대체판 ${index}`;
}

function formatKoreanDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value;
}
