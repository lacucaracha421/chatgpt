import { useHorizontalWheel } from "../shared/ui/useHorizontalWheel";
import { formatBytes } from "../assets/assetMetadata";
import { useLayoutEffect, useRef } from "react";
import type { CatalogWork, CatalogWorkDetail } from "../library/types";
import { displayDate } from "../shared/displayDate";
import { BookmarkIcon } from "../shared/ui/ArchiveIcons";
import { Button } from "../shared/ui/Button";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { MangaCover } from "./MangaCard";
import { catalogCategoryLabel } from "./catalogCategories";
import { catalogDisplayTitle } from "./catalogDisplayTitle";
import { catalogIdentityKey } from "./catalogIdentity";
import "./MangaDetail.css";

const namespaceLabels: Record<string, string> = {
  artist: "작가", group: "그룹", language: "언어", parody: "원작", series: "시리즈",
  character: "등장인물", female: "여성", male: "남성", mixed: "혼합", other: "기타",
  misc: "기타", reclass: "분류", cosplayer: "코스플레이어",
};
const languageLabels: Record<string, string> = {
  korean: "한국어", japanese: "일본어", english: "영어", chinese: "중국어",
  translated: "번역", rewrite: "재작성", textless: "대사 없음",
};

export type MangaDetailEdition = CatalogWork & { language: string };

type Props = {
  /** Cover URLs are ready to display; data access belongs to the owning screen. */
  detail: CatalogWorkDetail;
  privacyMode?: boolean;
  bookmarkPending: boolean;
  reading: boolean;
  onBookmark: (bookmarked: boolean) => void;
  onTagSearch: (query: string) => void;
  onRead: () => void;
  editionCount: number;
  editions: MangaDetailEdition[];
  editionsLoading: boolean;
  editionsError: boolean;
  hasMoreEditions: boolean;
  onEdition: (edition: MangaDetailEdition) => void;
  onMoreEditions: () => void;
};

/** Shared detail contents for the PC overlay and the tablet's sheet. */
export function MangaDetail({ detail, privacyMode, bookmarkPending, reading, onBookmark, onTagSearch, onRead,
  editionCount, editions, editionsLoading, editionsError, hasMoreEditions, onEdition, onMoreEditions }: Props) {
  const stripWheel = useHorizontalWheel();
  const extraRef = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (extraRef.current) extraRef.current.open = false;
  }, [detail.provider, detail.providerWorkId]);
  const artist = detail.tagGroups.find(group => group.namespace === "artist")?.values.join(" · ");
  const languages = detail.tagGroups.find(group => group.namespace === "language");
  const language = languages?.values.map(value => languages.labels?.[value] ?? languageLabels[value] ?? value).join(" · ");
  const category = detail.category === null ? null : catalogCategoryLabel(detail.category);
  const meta = [artist, category, `${detail.fileCount.toLocaleString()}쪽`].filter(Boolean).join(" · ");
  const datedMeta = [language, detail.posted === null ? null : displayDate(detail.posted * 1_000)].filter(Boolean).join(" · ");

  return <div className="manga-detail">
    <div className="manga-detail__summary">
      <MangaCover className="manga-detail__cover" src={detail.thumbnailUrl} title={detail.title} privacyMode={privacyMode} />
      <div className="manga-detail__identity">
        <h2 aria-description={detail.title}>{catalogDisplayTitle(detail.title)}</h2>
        <p>{meta}</p>
        {datedMeta && <p>{datedMeta}</p>}
        <div className="manga-detail__actions">
          <Button variant="primary" disabled={reading} aria-busy={reading} onClick={onRead}>{reading ? "불러오는 중…" : "읽기"}</Button>
          <Button size="icon" variant="ghost" className="manga-detail__bookmark" aria-label={detail.bookmarked ? "북마크 해제" : "북마크"}
            aria-pressed={detail.bookmarked} aria-busy={bookmarkPending} disabled={bookmarkPending} onClick={() => onBookmark(!detail.bookmarked)}>
            <BookmarkIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
    {detail.tagGroups.length > 0 && <dl className="manga-detail__tags" aria-label="작품 태그">
      {detail.tagGroups.map(group => <div key={group.namespace}>
        <dt>{namespaceLabels[group.namespace] ?? group.namespace}</dt>
        <dd>{group.values.map(value => {
          const query = `${group.namespace}:${value}`;
          const label = (group.labels?.[value] ?? (group.namespace === "language" ? languageLabels[value] : undefined) ?? value).replace(/_/g, " ");
          return <Button className="manga-detail__tag" key={value} size="sm" variant="ghost" type="button" aria-description={query} aria-label={`${query} 검색`} onClick={() => onTagSearch(query)}>{label}</Button>;
        })}</dd>
      </div>)}
    </dl>}
    {editionCount >= 2 && <section className="manga-detail__editions" aria-label="판본">
      <SectionLabel as="h3" title="판본" />
      <div ref={stripWheel} className="manga-detail__edition-row" aria-busy={editionsLoading}>
        {editions.map(edition => <button type="button" className="manga-detail__edition" key={catalogIdentityKey(edition)}
          aria-label={`${edition.title} 판본 열기`} aria-pressed={catalogIdentityKey(edition) === catalogIdentityKey(detail)} onClick={() => onEdition(edition)}>
          {/* Edition covers are media objects; the open one uses a single ivory outline. */}
          <MangaCover src={edition.thumbnailUrl} title={edition.title} privacyMode={privacyMode} className="manga-detail__edition-cover" />
          <span>{edition.fileCount.toLocaleString()}p · {languageLabels[edition.language] ?? edition.language}</span>
        </button>)}
      </div>
      {(hasMoreEditions || editionsError) && <Button size="sm" variant="quiet" disabled={editionsLoading} onClick={onMoreEditions}>{editionsError ? "다시 시도" : "판본 더 보기"}</Button>}
    </section>}
    <details ref={extraRef} className="manga-detail__extra">
      <summary><SectionLabel title="추가 정보" /></summary>
      <dl>
        <div><dt>원제</dt><dd>{detail.title}</dd></div>
        {detail.titleJpn && detail.titleJpn !== detail.title && <div><dt>일본어 제목</dt><dd>{detail.titleJpn}</dd></div>}
        {detail.uploader && <div><dt>업로더</dt><dd>{detail.uploader}</dd></div>}
        {detail.posted !== null && <div><dt>게시일</dt><dd>{displayDate(detail.posted * 1_000)}</dd></div>}
        {detail.updated !== null && <div><dt>수정일</dt><dd>{displayDate(detail.updated * 1_000)}</dd></div>}
        {detail.fileSize !== null && <div><dt>크기</dt><dd>{formatBytes(detail.fileSize)}</dd></div>}
        {detail.rating !== null && <div><dt>평점</dt><dd>{(detail.rating / 100).toFixed(2)}</dd></div>}
        <div><dt>조회</dt><dd>{detail.views.toLocaleString()}</dd></div>
      </dl>
    </details>
  </div>;
}
