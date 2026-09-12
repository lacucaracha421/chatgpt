import { BookmarkIcon } from "../shared/ui/ArchiveIcons";
import { catalogDisplayTitle } from "./catalogDisplayTitle";
import type { CatalogGroupedWork, CatalogWork, CatalogWorkIdentity } from "../library/types";
import { Button } from "../shared/ui/Button";
import { catalogIdentityOf } from "./catalogIdentity";
import { CatalogThumbnail } from "./CatalogThumbnail";

type OnlineCatalogCardProps = {
  work: CatalogGroupedWork;
  onEditions: (work: CatalogGroupedWork) => void;
  opening: boolean;
  bookmarkPending: boolean;
  onOpen: (work: CatalogWork) => void;
  onBookmark: (identity: CatalogWorkIdentity, bookmarked: boolean) => void;
};

export function OnlineCatalogCard({ work, opening, bookmarkPending, onOpen, onBookmark, onEditions }: OnlineCatalogCardProps) {
  const byline = [...work.artists, ...work.series].join(" · ") || "작가 정보 없음";

  return <article className="online-catalog-card">
    <button
      type="button"
      className="online-catalog-card__body"
      aria-label={`${work.title} 상세 보기`}
      disabled={opening}
      onClick={() => onOpen(work)}
    >
      <CatalogThumbnail
        className="online-catalog-card__cover"
        src={work.thumbnailUrl}
        title={work.title}
        pageCount={work.fileCount}
      />
      <span className="online-catalog-card__metadata">
        <strong aria-description={opening ? undefined : work.title}>{opening ? "작품을 여는 중…" : catalogDisplayTitle(work.title)}</strong>
        <span aria-description={byline}>{byline}</span>
        <small>조회 {work.views.toLocaleString()} · {work.fileCount}페이지</small>
      </span>
    </button>
    <div className="online-catalog-card__footer">
    <Button size="sm" variant="ghost" className="online-catalog-card__editions" onClick={() => onEditions(work)}>{work.versionCount}개 판본</Button>
    <button
      type="button"
      className="online-catalog-card__bookmark"
      aria-label={`${work.title} ${work.bookmarked ? "북마크 해제" : "북마크"}`}
      aria-pressed={work.bookmarked}
      disabled={bookmarkPending}
      onClick={() => onBookmark(catalogIdentityOf(work), !work.bookmarked)}
    >
      <BookmarkIcon aria-hidden="true" />
    </button>
    </div>
    {work.hasBookmarkedVersion && !work.bookmarked && <span className="online-catalog-card__saved-edition">북마크된 판본 있음</span>}
  </article>;
}
