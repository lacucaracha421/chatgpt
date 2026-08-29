import { AdjustmentsHorizontalIcon, ArrowPathIcon, EyeSlashIcon, InformationCircleIcon } from "@heroicons/react/24/outline";
import type { AlbumEntry, AssetAspectFilter, AssetMediaFilter, AssetSort, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Select } from "../shared/ui/Select";
import { Slider } from "../shared/ui/Slider";
import { Toggle } from "../shared/ui/Toggle";
import { ViewToolbar } from "../layout/ViewToolbar";

type AssetToolbarProps = {
  view: AssetView;
  classifications: ClassificationEntry[];
  albums: AlbumEntry[];
  sort: AssetSort;
  mediaFilter: AssetMediaFilter;
  aspectFilter: AssetAspectFilter;
  directOnly: boolean;
  metadataVisible: boolean;
  privacyMode: boolean;
  thumbnailRowHeight: number;
  onSortChange: (sort: AssetSort) => void;
  onMediaFilterChange: (filter: AssetMediaFilter) => void;
  onAspectFilterChange: (filter: AssetAspectFilter) => void;
  onDirectOnlyChange: (value: boolean) => void;
  onMetadataVisibleChange: (value: boolean) => void;
  onPrivacyModeChange: (value: boolean) => void;
  onThumbnailRowHeightChange: (value: number) => void;
  collections?: CollectionSummary[];
  onReshuffle: () => void;
};

// 상단바는 선택 상태와 무관하게 제목·보기 설정·창 제어 슬롯을 고정한다.
// 선택 작업은 SelectionBar(갤러리 위 고정 바)에서 수행한다.
export function AssetToolbar({
  view: rawView, classifications, albums, collections = [], sort, mediaFilter, aspectFilter, directOnly, metadataVisible, privacyMode, thumbnailRowHeight,
  onSortChange, onMediaFilterChange, onAspectFilterChange, onDirectOnlyChange, onMetadataVisibleChange, onPrivacyModeChange, onThumbnailRowHeightChange, onReshuffle,
}: AssetToolbarProps) {
  const view = rawView.kind === "similarity_review" || rawView.kind === "settings" || rawView.kind === "manga"
    ? ({ kind: "classification", classificationId: null } as const)
    : rawView;
  const recent = view.kind === "recent";
  const filterable = rawView.kind === "classification" || rawView.kind === "recent" || rawView.kind === "favorites" || rawView.kind === "unsorted" || rawView.kind === "album";
  const location = view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId)?.name ?? "컬렉션" : view.kind === "favorites" ? "즐겨찾기" : view.kind === "unsorted" ? "미분류" : recent ? "최근" : view.kind === "trash" ? "휴지통" : view.kind === "album" ? albums.find((entry) => entry.id === view.albumId)?.name ?? "앨범" : view.kind === "collections" ? "컬렉션" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "저장소";

  return (
    <ViewToolbar title={location} ariaLabel="자산 도구">
      <Select label="정렬" value={recent ? "newest" : sort} disabled={recent} onChange={(event) => onSortChange(event.target.value as AssetSort)}>
        <option value="newest">최신순</option><option value="oldest">오래된순</option>
        <option value="favorites">좋아요순</option><option value="random">랜덤</option>
      </Select>
      {filterable && <Select label="미디어" value={mediaFilter} onChange={(event) => onMediaFilterChange(event.target.value as AssetMediaFilter)}>
        <option value="all">전체</option><option value="images">이미지</option><option value="videos">영상</option>
      </Select>}
      {filterable && <Select label="비율" value={aspectFilter} onChange={(event) => onAspectFilterChange(event.target.value as AssetAspectFilter)}>
        <option value="all">전체</option><option value="square">정사각형</option><option value="landscape">가로형</option><option value="portrait">세로형</option>
      </Select>}
      {view.kind === "classification" && <Toggle aria-label="이 분류만" checked={directOnly} onChange={(event) => onDirectOnlyChange(event.target.checked)}><AdjustmentsHorizontalIcon aria-hidden="true" /></Toggle>}
      <Slider label="미리보기 크기" min={96} max={320} step={8} value={thumbnailRowHeight} onChange={(event) => onThumbnailRowHeightChange(Number(event.target.value))} />
      <Toggle aria-label="정보 표시" checked={metadataVisible} onChange={(event) => onMetadataVisibleChange(event.target.checked)}><InformationCircleIcon aria-hidden="true" /></Toggle>
      <Toggle aria-label="비공개 모드" checked={privacyMode} onChange={(event) => onPrivacyModeChange(event.target.checked)}><EyeSlashIcon aria-hidden="true" /></Toggle>
      {sort === "random" && !recent && <Button size="icon" aria-label="다시 섞기" onClick={onReshuffle}><ArrowPathIcon aria-hidden="true" /></Button>}
    </ViewToolbar>
  );
}
