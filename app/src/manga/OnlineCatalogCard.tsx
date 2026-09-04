import { StarIcon as StarOutlineIcon } from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
import type { CatalogWork } from "../library/types";
import { CatalogThumbnail } from "./CatalogThumbnail";

type OnlineCatalogCardProps = {
  work: CatalogWork;
  opening: boolean;
  bookmarkPending: boolean;
  onOpen: (work: CatalogWork) => void;
  onBookmark: (workId: number, bookmarked: boolean) => void;
};

export function OnlineCatalogCard({ work, opening, bookmarkPending, onOpen, onBookmark }: OnlineCatalogCardProps) {
  const BookmarkIcon = work.bookmarked ? StarSolidIcon : StarOutlineIcon;
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
        <strong title={opening ? undefined : work.title}>{opening ? "작품을 여는 중…" : work.title}</strong>
        <span title={byline}>{byline}</span>
        <small>조회 {work.views.toLocaleString()} · {work.fileCount}페이지</small>
      </span>
    </button>
    <button
      type="button"
      className="online-catalog-card__bookmark"
      aria-label={`${work.title} ${work.bookmarked ? "북마크 해제" : "북마크"}`}
      aria-pressed={work.bookmarked}
      disabled={bookmarkPending}
      onClick={() => onBookmark(work.id, !work.bookmarked)}
    >
      <BookmarkIcon aria-hidden="true" />
    </button>
  </article>;
}
