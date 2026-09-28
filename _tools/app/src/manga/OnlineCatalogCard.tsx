import { BookmarkIcon } from "../shared/ui/ArchiveIcons";
import { catalogDisplayTitle } from "./catalogDisplayTitle";
import type { CatalogGroupedWork, CatalogWork, CatalogWorkIdentity } from "../library/types";
import { catalogIdentityOf } from "./catalogIdentity";
import { CatalogThumbnail } from "./CatalogThumbnail";

type OnlineCatalogCardProps = {
  work: CatalogGroupedWork;
  opening: boolean;
  bookmarkPending: boolean;
  onOpen: (work: CatalogWork) => void;
  onBookmark: (identity: CatalogWorkIdentity, bookmarked: boolean) => void;
};

/**
 * Cover-led tile matching the mobile catalog: cover, title and artist. Views, series and tags
 * live in the detail dialog, which also lists the editions; the page count and bookmark sit
 * quietly on the cover.
 */
export function OnlineCatalogCard({ work, opening, bookmarkPending, onOpen, onBookmark }: OnlineCatalogCardProps) {
  const artists = work.artists.join(" · ") || "작가 정보 없음";
  const displayTitle = catalogDisplayTitle(work.title);
  const savedEdition = work.hasBookmarkedVersion && !work.bookmarked;

  return <article className="online-catalog-card">
    <button
      type="button"
      className="online-catalog-card__body"
      aria-label={`${work.title} 상세 보기`}
      disabled={opening}
      onClick={() => onOpen(work)}
    >
      <span className="online-catalog-card__frame">
        <CatalogThumbnail
          className="online-catalog-card__cover"
          src={work.thumbnailUrl}
          title={work.title}
          pageCount={work.fileCount}
        />
        <span className="online-catalog-card__pages" aria-hidden="true">{work.fileCount}p</span>
      </span>
      <strong aria-description={opening || displayTitle === work.title ? undefined : work.title}>{opening ? "작품을 여는 중…" : displayTitle}</strong>
      <span className="online-catalog-card__byline">{artists}</span>
    </button>
    <div className="online-catalog-card__overlay">
      <button
        type="button"
        className="online-catalog-card__bookmark"
        aria-label={`${work.title} ${work.bookmarked ? "북마크 해제" : "북마크"}`}
        aria-description={savedEdition ? "북마크된 판본 있음" : undefined}
        aria-pressed={work.bookmarked}
        data-saved-edition={savedEdition || undefined}
        disabled={bookmarkPending}
        onClick={() => onBookmark(catalogIdentityOf(work), !work.bookmarked)}
      >
        <BookmarkIcon aria-hidden="true" />
      </button>
    </div>
  </article>;
}
