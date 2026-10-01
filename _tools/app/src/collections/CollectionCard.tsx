import { StarIcon } from "@heroicons/react/20/solid";
import { CollectionShelfCase } from "./case/LightCase";
import { GameCase } from "./GameCase";
import { useState, type ButtonHTMLAttributes } from "react";
import { PhysicalCover } from "./physical/PhysicalCover";
import type { CollectionSummary } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import type { ReleaseCaption } from "./releaseCaption";
import { collectionCardDate, collectionCredit } from "./collectionFormat";

export { collectionCardDate, collectionCredit } from "./collectionFormat";

export function CollectionCard({
  collection,
  coverUrl,
  onClick,
  selected,
  scope = "",
  exhibition = false,
  meta = true,
  shelf = false,
  lightCase = false,
  releaseCaption,
  ...buttonProps
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  collection: CollectionSummary;
  coverUrl: string | null;
  onClick: () => void;
  selected: boolean;
  scope?: string;
  exhibition?: boolean;
  /** The year and star rating; a Showcase row keeps only the 신간 marker. */
  meta?: boolean;
  shelf?: boolean;
  lightCase?: boolean;
  /** 신간 marker after the year and stars; without it an unread count still reads "신간 알림 N". */
  releaseCaption?: ReleaseCaption | null;
}) {
  const [failedCoverUrl, setFailedCoverUrl] = useState<string | null>(null);
  const { privacyMode } = usePrivacy();
  const visibleCoverUrl = coverUrl && coverUrl !== failedCoverUrl ? coverUrl : null;
  const date = meta ? collectionCardDate(collection) : "";
  const score = meta ? collection.myScore : null;
  const caption = releaseCaption !== undefined ? releaseCaption
    : collection.unreadReleaseCount > 0 ? { kind: "new" as const, text: `신간 알림 ${collection.unreadReleaseCount}`, date: null } : null;
  const captionText = caption ? `${caption.text}${caption.date ? ` · ${caption.date}` : ""}` : undefined;

  return (
    <button
      {...buttonProps}
      type="button"
      className={`collection-card collection-card--${collection.type}${exhibition ? " collection-card--exhibition" : ""}`}
      data-collection-id={collection.id}
      aria-label={`${collection.name}${collectionCredit(collection) ? ` · ${collectionCredit(collection)}` : ""}`}
      aria-selected={selected}
      aria-description={captionText}
      onClick={onClick}
    >
      {lightCase && collection.type !== "manga" && <span className="collection-card__light" aria-hidden={!shelf}><CollectionShelfCase collection={collection} front={coverUrl} privacy={privacyMode} active={shelf} selected={selected} /></span>}
      <span aria-hidden={lightCase && shelf} className={`collection-card__object collection-card__object--${collection.type}`}>
        <span className="collection-card__cover">
          {visibleCoverUrl && !privacyMode && (collection.type === "game" || collection.type === "av") ? <GameCase src={visibleCoverUrl} alt={collection.name} scope={scope} revision={collection.updatedAt} large={exhibition} onError={() => setFailedCoverUrl(visibleCoverUrl)} /> : visibleCoverUrl && !privacyMode && collection.type === "manga" ? (
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
        </span>
      </span>
      <span className="collection-card__meta">
        <span className="collection-card__name" aria-description={collection.name}>{collection.name}</span>
        <span className="collection-card__credit" aria-description={collectionCredit(collection) || undefined}>{collectionCredit(collection)}</span>
        {/* Right-to-left wrap: when the line is too narrow the year drops first, the stars and marker stay. */}
        <span className="collection-card__line">
          {(score != null || caption) && <span className="collection-card__tail">
            {score != null && <span className="collection-card__score" aria-label={`내 별점 ${score.toFixed(1)}점`}><StarIcon aria-hidden="true" />{score.toFixed(1)}</span>}
            {caption && score != null && <span className="collection-card__sep" aria-hidden="true">·</span>}
            {caption && (
              <span className={`collection-card__release collection-card__release--${caption.kind}`}>
                {caption.text}{caption.date && <span className="collection-card__release-date"> · {caption.date}</span>}
              </span>
            )}
          </span>}
          {date && <span className="collection-card__date">{date}</span>}
        </span>
      </span>
    </button>
  );
}
