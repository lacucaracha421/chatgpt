import { memo } from "react";
import { useCatalogMasked } from "../privacy/catalogMask";
import { nativeMediaUrl } from "../assets/mediaUrl";
import { catalogDisplayTitle } from "./catalogDisplayTitle";
import type { CatalogGroupedWork, CatalogWork, CatalogWorkIdentity } from "../library/types";
import { catalogIdentityOf } from "./catalogIdentity";
import { MangaCard } from "./MangaCard";

type OnlineCatalogCardProps = {
  work: CatalogGroupedWork;
  opening: boolean;
  bookmarkPending: boolean;
  selected?: boolean;
  onOpen: (work: CatalogWork, opener: HTMLButtonElement) => void;
  onRead?: (work: CatalogWork, opener: HTMLButtonElement) => void;
  /** Left out inside the 북마크 tab, where every cover is bookmarked and the corner would only repeat it. */
  onBookmark?: (identity: CatalogWorkIdentity, bookmarked: boolean) => void;
};

/** Memoized: appending a page must not re-render the cards already shown (parents pass stable handlers). */
export const OnlineCatalogCard = memo(function OnlineCatalogCard({ work, opening, bookmarkPending, selected, onOpen, onRead, onBookmark }: OnlineCatalogCardProps) {
  const privacyMode = useCatalogMasked();
  return <MangaCard title={work.title} displayTitle={catalogDisplayTitle(work.title)} artist={work.artists.join(" · ")}
    pageCount={work.fileCount} coverUrl={work.thumbnailUrl ? nativeMediaUrl(work.thumbnailUrl) : null} privacyMode={privacyMode}
    opening={opening} selected={selected} bookmarkPending={bookmarkPending} bookmarked={work.bookmarked} savedEdition={work.hasBookmarkedVersion && !work.bookmarked}
    onRead={onRead ? opener => onRead(work, opener) : undefined} onOpen={(opener) => onOpen(work, opener)} onBookmark={onBookmark ? () => onBookmark(catalogIdentityOf(work), !work.bookmarked) : undefined} />;
});
