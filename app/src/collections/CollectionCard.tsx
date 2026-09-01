import { useState } from "react";
import type { CollectionSummary } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";

export function collectionCredit(collection: CollectionSummary): string {
  const credit = collection.type === "manga"
    ? collection.author
    : collection.type === "game"
      ? collection.developer
      : collection.productionCompany;
  return credit?.trim() ?? "";
}

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
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
  const { privacyMode } = usePrivacy();
  const visibleCoverUrl = coverUrl && coverUrl !== failedCoverUrl ? coverUrl : null;

  return (
    <button
      type="button"
      className={`collection-card collection-card--${collection.type}`}
      aria-selected={selected}
      onClick={onClick}
    >
      <span className={`collection-card__object collection-card__object--${collection.type}`}>
        <span className="collection-card__cover">
          {visibleCoverUrl && !privacyMode ? (
            <img
              className="collection-cover-image"
              src={visibleCoverUrl}
              alt={collection.name}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setFailedCoverUrl(visibleCoverUrl)}
            />
          ) : (
            <span className="collection-card__placeholder" aria-hidden="true" />
          )}
          {collection.unreadReleaseCount > 0 && (
            <span className="collection-card__release-badge">신간 {collection.unreadReleaseCount}</span>
          )}
        </span>
      </span>
      <span className="collection-card__meta">
        <span className="collection-card__name">{collection.name}</span>
        <span className="collection-card__credit">{collectionCredit(collection)}</span>
      </span>
    </button>
  );
}
