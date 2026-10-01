import { useState } from "react";
import { BookmarkIcon } from "../shared/ui/ArchiveIcons";
import { Badge } from "../shared/ui/Badge";
import { Skeleton } from "../shared/ui/Skeleton";
import { StableImage } from "../shared/ui/StableImage";

export type MangaCardProps = {
  title: string;
  displayTitle?: string;
  artist?: string;
  pageCount: number;
  coverUrl: string | null;
  privacyMode?: boolean;
  opening?: boolean;
  onOpen: (opener: HTMLButtonElement) => void;
  selected?: boolean;
  bookmarked?: boolean;
  savedEdition?: boolean;
  bookmarkPending?: boolean;
  onBookmark?: () => void;
};

/** Shared cover object: the corner bookmark and page badge belong to the artwork. */
export function MangaCard({ title, displayTitle = title, artist, pageCount, coverUrl, privacyMode, opening, onOpen, selected, bookmarked, savedEdition, bookmarkPending, onBookmark }: MangaCardProps) {
  return <article className="manga-card">
    <button type="button" className="manga-card__body" aria-label={`${title} 상세 보기`} aria-pressed={selected} disabled={opening} onClick={(event) => onOpen(event.currentTarget)}>
      <span className="manga-card__frame ui-selectable-media" aria-selected={selected ?? false}>
        <MangaCover src={coverUrl} title={title} privacyMode={privacyMode} className="manga-card__cover" />
        <Badge variant="scrim" className="manga-card__pages">{pageCount}p</Badge>
        {selected && <span className="ui-selection-check" aria-hidden="true" />}
      </span>
      <strong className="manga-card__title" aria-description={displayTitle !== title ? title : undefined}>{displayTitle}</strong>
      <span className="manga-card__artist">{artist?.trim() || "작가 미상"}</span>
    </button>
    {onBookmark && <button type="button" className="manga-card__bookmark"
      aria-label={`${title} ${bookmarked ? "북마크 해제" : "북마크"}`} aria-pressed={bookmarked}
      aria-description={savedEdition ? "북마크된 판본 있음" : undefined} data-saved-edition={savedEdition || undefined}
      disabled={bookmarkPending} onClick={onBookmark}><BookmarkIcon aria-hidden="true" /></button>}
  </article>;
}

export function MangaCover({ src, title, privacyMode, className = "" }: { src: string | null; title: string; privacyMode?: boolean; className?: string }) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (privacyMode) return <Skeleton className={`${className} privacy-mask`} label="비공개 모드" />;
  return <span className={`${className} manga-cover`} aria-busy={Boolean(src && src !== loadedSrc && src !== failedSrc)}>
    {src && src !== failedSrc && <StableImage src={src} alt={`${title} 표지`} referrerPolicy="no-referrer" draggable={false}
      loading="lazy" className="manga-cover__image" style={loadedSrc ? undefined : { visibility: "hidden" }}
      onLoad={(event) => setLoadedSrc(event.currentTarget.getAttribute("src"))}
      onError={(event) => setFailedSrc(event.currentTarget.getAttribute("src"))} />}
  </span>;
}

export function MangaSkeletonGrid() {
  return <div className="manga-grid" aria-label="망가 불러오는 중">
    {Array.from({ length: 12 }, (_, index) => <div className="manga-card manga-card--skeleton" key={index}>
      <Skeleton className="manga-card__frame" label="표지" />
      <Skeleton className="manga-card__title" label="제목" />
      <Skeleton className="manga-card__artist" label="작가" />
    </div>)}
  </div>;
}
