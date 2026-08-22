import type { CollectionSummary } from "../library/types";

const TYPE_LABEL: Record<CollectionSummary["type"], string> = {
  game: "게임",
  manga: "만화",
  movie: "영화",
};

export function CollectionCard({
  collection,
  coverUrl,
  onClick,
  selected,
}: {
  collection: CollectionSummary;
  coverUrl: string | null;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      className={`collection-card collection-card--${collection.type}`}
      aria-selected={selected}
      onClick={onClick}
    >
      <span className="collection-card__cover">
        {coverUrl ? (
          <img src={coverUrl} alt={collection.name} loading="lazy" draggable={false} />
        ) : (
          <span className="collection-card__placeholder" aria-hidden="true" />
        )}
        {collection.unreadReleaseCount > 0 && (
          <span className="collection-card__release-badge">신간 {collection.unreadReleaseCount}</span>
        )}
      </span>
      <span className="collection-card__meta">
        <span className="collection-card__type">{TYPE_LABEL[collection.type]}</span>
        <span className="collection-card__name">{collection.name}</span>
        <span className="collection-card__count">{collection.assetCount}개</span>
      </span>
    </button>
  );
}
