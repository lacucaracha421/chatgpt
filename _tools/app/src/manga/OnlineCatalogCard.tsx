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
  onBookmark: (identity: CatalogWorkIdentity, bookmarked: boolean) => void;
};

export function OnlineCatalogCard({ work, opening, bookmarkPending, selected, onOpen, onBookmark }: OnlineCatalogCardProps) {
  const privacyMode = useCatalogMasked();
  return <MangaCard title={work.title} displayTitle={catalogDisplayTitle(work.title)} artist={work.artists.join(" · ")}
    pageCount={work.fileCount} coverUrl={work.thumbnailUrl ? nativeMediaUrl(work.thumbnailUrl) : null} privacyMode={privacyMode}
    opening={opening} selected={selected} bookmarkPending={bookmarkPending} bookmarked={work.bookmarked} savedEdition={work.hasBookmarkedVersion && !work.bookmarked}
    onOpen={(opener) => onOpen(work, opener)} onBookmark={() => onBookmark(catalogIdentityOf(work), !work.bookmarked)} />;
}
