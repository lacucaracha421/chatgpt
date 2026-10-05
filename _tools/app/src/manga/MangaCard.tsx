import { useEffect, useRef, useState } from "react";
import { useCatalogMasked } from "../privacy/catalogMask";
import { BookmarkToggle } from "../shared/ui/BookmarkToggle";
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
  onRead?: (opener: HTMLButtonElement) => void;
  selected?: boolean;
  bookmarked?: boolean;
  savedEdition?: boolean;
  bookmarkPending?: boolean;
  onBookmark?: () => void;
};

/** Shared cover object: the corner bookmark and page badge belong to the artwork. */
export function MangaCard({ title, displayTitle = title, artist, pageCount, coverUrl, privacyMode, opening, onOpen, onRead, selected, bookmarked, savedEdition, bookmarkPending, onBookmark }: MangaCardProps) {
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClick = () => { if (clickTimer.current !== null) clearTimeout(clickTimer.current); clickTimer.current = null; };
  useEffect(() => cancelClick, []);
  useEffect(() => { if (opening) cancelClick(); }, [opening]);
  return <article className="manga-card">
    <button type="button" className="manga-card__body" aria-label={`${title} 상세 보기`} aria-pressed={selected} disabled={opening} onClick={event => {
      cancelClick();
      const opener = event.currentTarget;
      if (!onRead || event.detail === 0) { onOpen(opener); return; }
      // Wait for a second pointer click so the detail never flashes before the reader.
      if (event.detail === 1) clickTimer.current = setTimeout(() => { clickTimer.current = null; onOpen(opener); }, 500);
    }} onDoubleClick={onRead ? event => { cancelClick(); onRead(event.currentTarget); } : undefined}>
      <span className="manga-card__frame ui-selectable-media" aria-selected={selected ?? false}>
        <MangaCover src={coverUrl} title={title} privacyMode={privacyMode} className="manga-card__cover" reportBusy={false} />
        <Badge variant="scrim" className="manga-card__pages">{pageCount}p</Badge>
        {selected && <span className="ui-selection-check" aria-hidden="true" />}
      </span>
      <strong className="manga-card__title" aria-description={displayTitle !== title ? title : undefined}>{displayTitle}</strong>
      <span className="manga-card__artist">{artist?.trim() || "작가 미상"}</span>
    </button>
    {onBookmark && <BookmarkToggle form="corner" className="manga-card__bookmark" bookmarked={!!bookmarked}
      label={`${title} ${bookmarked ? "북마크 해제" : "북마크"}`}
      aria-description={savedEdition ? "북마크된 판본 있음" : undefined} data-saved-edition={savedEdition || undefined}
      disabled={bookmarkPending} onClick={onBookmark} />}
  </article>;
}

export function MangaCover({ src, title, privacyMode, className = "", reportBusy = true }: { src: string | null; title: string; privacyMode?: boolean; className?: string; reportBusy?: boolean }) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const masked = useCatalogMasked(privacyMode);
  if (masked) return <Skeleton className={`${className} privacy-mask`} label="비공개 모드" />;
  // Lazy grid covers must not hold area readiness; the area prepares its viewport images.
  return <span className={`${className} manga-cover`} aria-busy={reportBusy ? Boolean(src && src !== loadedSrc && src !== failedSrc) : undefined}>
    {src && src !== failedSrc && <StableImage src={src} alt={`${title} 표지`} referrerPolicy="no-referrer" draggable={false}
      loading="lazy" className="manga-cover__image" style={loadedSrc ? undefined : { visibility: "hidden" }}
      onLoad={(event) => setLoadedSrc(event.currentTarget.getAttribute("src"))}
      onError={(event) => setFailedSrc(event.currentTarget.getAttribute("src"))} />}
  </span>;
}

/** `more` is the row shown under loaded cards while the next page arrives: the same columns, one row tall. */
export function MangaSkeletonGrid({ more = false }: { more?: boolean } = {}) {
  return <div className={more ? "manga-grid manga-grid--more" : "manga-grid"} aria-label={more ? "다음 망가 불러오는 중" : "망가 불러오는 중"}>
    {Array.from({ length: 12 }, (_, index) => <div className="manga-card manga-card--skeleton" key={index}>
      <Skeleton className="manga-card__frame" label="표지" />
      <Skeleton className="manga-card__title" label="제목" />
      <Skeleton className="manga-card__artist" label="작가" />
    </div>)}
  </div>;
}
