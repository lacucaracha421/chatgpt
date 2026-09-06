import { GameCase } from "./GameCase";
import { useState, type ButtonHTMLAttributes } from "react";
import { PhysicalCover } from "./physical/PhysicalCover";
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
  scope = "",
  exhibition = false,
  ...buttonProps
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  collection: CollectionSummary;
  coverUrl: string | null;
  onClick: () => void;
  selected: boolean;
  scope?: string;
  exhibition?: boolean;
}) {
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
  const { privacyMode } = usePrivacy();
  const visibleCoverUrl = coverUrl && coverUrl !== failedCoverUrl ? coverUrl : null;

  return (
    <button
      {...buttonProps}
      type="button"
      className={`collection-card collection-card--${collection.type}${exhibition ? " collection-card--exhibition" : ""}`}
      data-collection-id={collection.id}
      aria-label={`${collection.name}${collectionCredit(collection) ? ` · ${collectionCredit(collection)}` : ""}`}
      aria-selected={selected}
      onClick={onClick}
    >
      <span className={`collection-card__object collection-card__object--${collection.type}`}>
        <span className="collection-card__cover">
          {visibleCoverUrl && !privacyMode && collection.type === "game" ? <GameCase src={visibleCoverUrl} alt={collection.name} scope={scope} revision={collection.updatedAt} large={exhibition} onError={() => setFailedCoverUrl(visibleCoverUrl)} /> : visibleCoverUrl && !privacyMode && collection.type === "manga" ? (
            <PhysicalCover kind="book" src={visibleCoverUrl} alt={collection.name} scope={scope} revision={collection.updatedAt} large={exhibition} onError={() => setFailedCoverUrl(visibleCoverUrl)} />
          ) : visibleCoverUrl && !privacyMode ? (
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
        <span className="collection-card__name" title={collection.name}>{collection.name}</span>
        <span className="collection-card__credit" title={collectionCredit(collection) || undefined}>{collectionCredit(collection)}</span>
      </span>
    </button>
  );
}
