import { EyeSlashIcon, InformationCircleIcon, AdjustmentsHorizontalIcon, ArrowPathIcon, MinusCircleIcon, PhotoIcon, StarIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
import type { AlbumEntry, AssetSort, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
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
  directOnly: boolean;
  metadataVisible: boolean;
  privacyMode: boolean;
  thumbnailRowHeight: number;
  selectedCount: number;
  inspectorOpen: boolean;
  onInspectorToggle: () => void;
  onSortChange: (sort: AssetSort) => void;
  onDirectOnlyChange: (value: boolean) => void;
  onMetadataVisibleChange: (value: boolean) => void;
  onPrivacyModeChange: (value: boolean) => void;
  onThumbnailRowHeightChange: (value: number) => void;
  onFavorite: (favorite: boolean) => void;
  collections?: CollectionSummary[];
  onRemoveFromCollection?: () => void;
  onSetCover?: () => void;
  onTrash: () => void;
  onClearSelection: () => void;
  batchPending: boolean;
  onReshuffle: () => void;
};

export function AssetToolbar({
  view: rawView, classifications, albums, collections = [], onRemoveFromCollection, onSetCover, sort, directOnly, metadataVisible, privacyMode, thumbnailRowHeight, selectedCount, inspectorOpen, onInspectorToggle, onSortChange,
  onDirectOnlyChange, onMetadataVisibleChange, onPrivacyModeChange, onThumbnailRowHeightChange, onFavorite, onTrash, onClearSelection, batchPending, onReshuffle,
}: AssetToolbarProps) {
  const view = rawView.kind === "similarity_review" || rawView.kind === "settings" || rawView.kind === "manga"
    ? ({ kind: "classification", classificationId: null } as const)
    : rawView;
  const recent = view.kind === "recent";
  const location = view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId)?.name ?? "컬렉션" : view.kind === "favorites" ? "즐겨찾기" : view.kind === "unsorted" ? "미분류" : recent ? "최근" : view.kind === "trash" ? "휴지통" : view.kind === "album" ? albums.find((entry) => entry.id === view.albumId)?.name ?? "앨범" : view.kind === "collections" ? "컬렉션" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "저장소";

  return (
    <ViewToolbar title={location} ariaLabel="자산 도구">
      <Select label="정렬" value={recent ? "newest" : sort} disabled={recent} onChange={(event) => onSortChange(event.target.value as AssetSort)}>
        <option value="newest">최신순</option><option value="oldest">오래된순</option>
        <option value="favorites">좋아요순</option><option value="random">랜덤</option>
      </Select>
      {view.kind === "classification" && <Toggle aria-label="이 분류만" checked={directOnly} onChange={(event) => onDirectOnlyChange(event.target.checked)}><AdjustmentsHorizontalIcon aria-hidden="true" /></Toggle>}
      <Slider label="미리보기 크기" min={96} max={320} step={8} value={thumbnailRowHeight} onChange={(event) => onThumbnailRowHeightChange(Number(event.target.value))} />
      <Toggle aria-label="정보 표시" checked={metadataVisible} onChange={(event) => onMetadataVisibleChange(event.target.checked)}><InformationCircleIcon aria-hidden="true" /></Toggle>
      <Toggle aria-label="비공개 모드" checked={privacyMode} onChange={(event) => onPrivacyModeChange(event.target.checked)}><EyeSlashIcon aria-hidden="true" /></Toggle>
      {sort === "random" && !recent && <Button size="icon" aria-label="다시 섞기" onClick={onReshuffle}><ArrowPathIcon aria-hidden="true" /></Button>}
      {selectedCount > 0 && <>
        <span className="view-toolbar__divider" aria-hidden="true" />
        <strong>{selectedCount}개 선택</strong>
        <Button aria-label="좋아요 켜기" size="icon" variant="ghost" disabled={batchPending} onClick={() => onFavorite(true)}><StarSolidIcon aria-hidden="true" /></Button>
        <Button aria-label="좋아요 끄기" size="icon" variant="ghost" disabled={batchPending} onClick={() => onFavorite(false)}><StarIcon aria-hidden="true" /></Button>
        {view.kind === "collection" && <Button aria-label="이 컬렉션에서 제거" size="icon" variant="ghost" disabled={batchPending} onClick={onRemoveFromCollection}><MinusCircleIcon aria-hidden="true" /></Button>}
        {view.kind === "collection" && selectedCount === 1 && <Button aria-label="대표 이미지로 지정" size="icon" variant="ghost" disabled={batchPending} onClick={onSetCover}><PhotoIcon aria-hidden="true" /></Button>}
        <Button aria-label="휴지통으로 이동" size="icon" variant="danger" disabled={batchPending} onClick={onTrash}><TrashIcon aria-hidden="true" /></Button>
        <Button aria-label={inspectorOpen ? "정보 닫기" : "정보 열기"} size="icon" variant={inspectorOpen ? "secondary" : "ghost"} onClick={onInspectorToggle}><InformationCircleIcon aria-hidden="true" /></Button>
        <Button aria-label="선택 해제" size="icon" variant="ghost" onClick={onClearSelection}><XMarkIcon aria-hidden="true" /></Button>
      </>}
    </ViewToolbar>
  );
}