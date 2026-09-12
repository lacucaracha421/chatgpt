import { formatBytes } from "../assets/assetMetadata";
import type { CatalogWorkDetail, RemoteReadingProgress } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { CatalogThumbnail } from "./CatalogThumbnail";
import { catalogCategoryLabel } from "./catalogCategories";
import { catalogDisplayTitle } from "./catalogDisplayTitle";

const namespaceLabels: Record<string, string> = {
  artist: "작가", group: "그룹", language: "언어", parody: "원작", series: "시리즈",
  character: "등장인물", female: "여성", male: "남성", mixed: "혼합", other: "기타",
  misc: "기타", reclass: "분류", cosplayer: "코스플레이어",
};
const languageLabels: Record<string, string> = {
  korean: "한국어", japanese: "일본어", english: "영어", chinese: "중국어",
  translated: "번역", rewrite: "재작성", textless: "대사 없음",
};

type Props = {
  detail: CatalogWorkDetail;
  progress: RemoteReadingProgress | null;
  bookmarkPending: boolean;
  reading: boolean;
  onBookmark: (bookmarked: boolean) => void;
  onTagSearch: (query: string) => void;
  onRead: () => void;
  onClose: () => void;
};

const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric", month: "short", day: "numeric",
});

function unixDate(value: number) {
  return dateFormatter.format(new Date(value * 1_000));
}

export function OnlineCatalogDetailDialog({
  detail,
  progress,
  bookmarkPending,
  reading,
  onBookmark,
  onTagSearch,
  onRead,
  onClose,
}: Props) {
  const canResume = progress !== null
    && progress.pageCount === detail.fileCount
    && progress.lastPage > 1;
  const category = detail.category === null ? null : catalogCategoryLabel(detail.category);
  const summaryGroups = detail.tagGroups.filter((group) => ["artist", "language"].includes(group.namespace));
  const tags = detail.tagGroups.filter((group) => !["artist", "language"].includes(group.namespace));
  const renderGroup = (group: CatalogWorkDetail["tagGroups"][number]) => <section key={group.namespace}>
    <h3>{namespaceLabels[group.namespace] ?? group.namespace}</h3>
    <div>{group.values.map((value) => {
      const query = `${group.namespace}:${value}`;
      const label = (group.labels?.[value] ?? (group.namespace === "language" ? languageLabels[value] : undefined) ?? value).replace(/_/g, " ");
      return <button key={value} type="button" aria-description={query} aria-label={`${query} 검색`} onClick={() => onTagSearch(query)}>{label}</button>;
    })}</div>
  </section>;

  return <Dialog open title={catalogDisplayTitle(detail.title)} variant="medium" onClose={onClose}>
    <div className="online-catalog-detail">
      <div className="online-catalog-detail__summary">
        <CatalogThumbnail
          className="online-catalog-detail__cover"
          src={detail.thumbnailUrl}
          title={detail.title}
          pageCount={detail.fileCount}
        />
        <div className="online-catalog-detail__info">
        <div className="online-catalog-detail__facts">
          <p className="online-catalog-detail__essentials"><strong>{detail.fileCount.toLocaleString()}페이지</strong>{category && <span>{category}</span>}</p>
          <div className="online-catalog-detail__tags online-catalog-detail__identity">{summaryGroups.map(renderGroup)}</div>
          {canResume && <p className="online-catalog-detail__progress">{progress.lastPage.toLocaleString()}페이지까지 읽음</p>}
        </div>
      {tags.length > 0 && <div className="online-catalog-detail__tags" aria-label="작품 태그">{tags.map(renderGroup)}</div>}
      <details className="online-catalog-detail__extra">
        <summary>추가 정보</summary>
        <div className="online-catalog-detail__facts"><dl>
            <div><dt>원제</dt><dd>{detail.title}</dd></div>
            {detail.titleJpn && detail.titleJpn !== detail.title && <div><dt>일본어 제목</dt><dd>{detail.titleJpn}</dd></div>}
            {detail.uploader && <div><dt>업로더</dt><dd>{detail.uploader}</dd></div>}
            {detail.posted !== null && <div><dt>게시일</dt><dd>{unixDate(detail.posted)}</dd></div>}
            {detail.updated !== null && <div><dt>수정일</dt><dd>{unixDate(detail.updated)}</dd></div>}
            {detail.fileSize !== null && <div><dt>크기</dt><dd>{formatBytes(detail.fileSize)}</dd></div>}
            {detail.rating !== null && <div><dt>평점</dt><dd>{(detail.rating / 100).toFixed(2)}</dd></div>}
            <div><dt>조회</dt><dd>{detail.views.toLocaleString()}</dd></div>
          </dl></div>
      </details>
      <div className="ui-dialog__actions online-catalog-detail__actions">
        <Button disabled={bookmarkPending} onClick={() => onBookmark(!detail.bookmarked)}>
          {detail.bookmarked ? "북마크 해제" : "북마크"}
        </Button>
        <Button onClick={onClose}>닫기</Button>
        <Button variant="primary" disabled={reading} onClick={onRead}>
          {reading ? "불러오는 중…" : canResume ? "이어 읽기" : "읽기"}
        </Button>
      </div>
        </div>
      </div>
    </div>
  </Dialog>;
}
