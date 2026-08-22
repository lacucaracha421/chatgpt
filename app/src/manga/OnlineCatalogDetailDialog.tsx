import { formatBytes } from "../assets/assetMetadata";
import type { CatalogWorkDetail, RemoteReadingProgress } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { CatalogThumbnail } from "./CatalogThumbnail";

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

const categories: Record<number, string> = {
  1: "동인지", 2: "만화", 3: "아티스트 CG", 4: "게임 CG", 5: "서양",
  6: "이미지 세트", 7: "비성인", 8: "코스프레", 9: "아시아 포르노",
  10: "기타", 11: "비공개",
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
  const canResume = progress?.pageCount === detail.fileCount && progress.lastPage > 1;
  const category = detail.category === null ? null : categories[detail.category] ?? null;
  const tagValues = (namespace: string) => detail.tagGroups
    .find((group) => group.namespace === namespace)?.values.join(" · ") ?? null;
  const artists = tagValues("artist");
  const series = tagValues("series");
  const languages = tagValues("language");

  return <Dialog open title={detail.title} variant="medium" onClose={onClose}>
    <div className="online-catalog-detail">
      <div className="online-catalog-detail__summary">
        <CatalogThumbnail
          className="online-catalog-detail__cover"
          src={detail.thumbnailUrl}
          title={detail.title}
          pageCount={detail.fileCount}
        />
        <div className="online-catalog-detail__facts">
          {detail.titleJpn && detail.titleJpn !== detail.title && <p>{detail.titleJpn}</p>}
          <dl>
            {artists && <div><dt>작가</dt><dd>{artists}</dd></div>}
            {series && <div><dt>시리즈</dt><dd>{series}</dd></div>}
            {languages && <div><dt>언어</dt><dd>{languages}</dd></div>}
            {detail.uploader && <div><dt>업로더</dt><dd>{detail.uploader}</dd></div>}
            {category && <div><dt>분류</dt><dd>{category}</dd></div>}
            {detail.posted !== null && <div><dt>게시일</dt><dd>{unixDate(detail.posted)}</dd></div>}
            {detail.updated !== null && <div><dt>수정일</dt><dd>{unixDate(detail.updated)}</dd></div>}
            <div><dt>분량</dt><dd>{detail.fileCount.toLocaleString()}페이지</dd></div>
            {detail.fileSize !== null && <div><dt>크기</dt><dd>{formatBytes(detail.fileSize)}</dd></div>}
            {detail.rating !== null && <div><dt>평점</dt><dd>{(detail.rating / 100).toFixed(2)}</dd></div>}
            <div><dt>조회</dt><dd>{detail.views.toLocaleString()}</dd></div>
          </dl>
        </div>
      </div>
      <div className="online-catalog-detail__tags" aria-label="작품 태그">
        {detail.tagGroups.map((group) => <section key={group.namespace}>
          <h3>{group.namespace}</h3>
          <div>{group.values.map((value) => {
            const query = `${group.namespace}:${value}`;
            return <button key={value} type="button" aria-label={`${query} 검색`} onClick={() => onTagSearch(query)}>{value}</button>;
          })}</div>
        </section>)}
      </div>
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
  </Dialog>;
}
