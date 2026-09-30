import { usePrivacy } from "../privacy/PrivacyContext";
import { nativeMediaUrl } from "../assets/mediaUrl";
import { catalogDisplayTitle } from "./catalogDisplayTitle";
import type { CatalogGroupedWork, CatalogWork, CatalogWorkIdentity } from "../library/types";
import { catalogIdentityOf } from "./catalogIdentity";
import { MangaCard } from "./MangaCard";

type OnlineCatalogCardProps = {
  work: CatalogGroupedWork;
  opening: boolean;
  bookmarkPending: boolean;
  onOpen: (work: CatalogWork) => void;
  onBookmark: (identity: CatalogWorkIdentity, bookmarked: boolean) => void;
};

export function OnlineCatalogCard({ work, opening, bookmarkPending, onOpen, onBookmark }: OnlineCatalogCardProps) {
  const { privacyMode } = usePrivacy();
  return <MangaCard title={work.title} displayTitle={catalogDisplayTitle(work.title)} artist={work.artists.join(" · ")}
    pageCount={work.fileCount} coverUrl={work.thumbnailUrl ? nativeMediaUrl(work.thumbnailUrl) : null} privacyMode={privacyMode}
    opening={opening} bookmarkPending={bookmarkPending} bookmarked={work.bookmarked} savedEdition={work.hasBookmarkedVersion && !work.bookmarked}
    onOpen={() => onOpen(work)} onBookmark={() => onBookmark(catalogIdentityOf(work), !work.bookmarked)} />;
}
