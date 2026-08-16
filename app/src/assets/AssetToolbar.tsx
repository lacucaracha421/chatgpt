import { EllipsisHorizontalIcon, InformationCircleIcon, AdjustmentsHorizontalIcon, ArrowPathIcon, StarIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import type { AlbumEntry, AssetSort, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Menu, type MenuItem } from "../shared/ui/Menu";
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
  thumbnailRowHeight: number;
  selectedCount: number;
  inspectorOpen: boolean;
  onInspectorToggle: () => void;
  onSortChange: (sort: AssetSort) => void;
  onDirectOnlyChange: (value: boolean) => void;
  onMetadataVisibleChange: (value: boolean) => void;
  onThumbnailRowHeightChange: (value: number) => void;
  onFavorite: (favorite: boolean) => void;
  onMoveToFolder: (classificationId: string | null) => void;
  onAlbum: (albumId: string, operation: "add" | "remove") => void;
  collections?: CollectionSummary[];
  onRemoveFromCollection?: () => void;
  onSetCover?: () => void;
  onTrash: () => void;
  onClearSelection: () => void;
  batchPending: boolean;
  onReshuffle: () => void;
};

export function AssetToolbar({
  view: rawView, classifications, albums, collections = [], onRemoveFromCollection, onSetCover, sort, directOnly, metadataVisible, thumbnailRowHeight, selectedCount, inspectorOpen, onInspectorToggle, onSortChange,
  onDirectOnlyChange, onMetadataVisibleChange, onThumbnailRowHeightChange, onFavorite, onMoveToFolder, onAlbum, onTrash, onClearSelection, batchPending, onReshuffle,
}: AssetToolbarProps) {
  const view = rawView.kind === "similarity_review" || rawView.kind === "settings" || rawView.kind === "manga"
    ? ({ kind: "classification", classificationId: null } as const)
    : rawView;
  const [batchClassificationId, setBatchClassificationId] = useState("");
  const [batchAlbumId, setBatchAlbumId] = useState("");
  const recent = view.kind === "recent";
  const location = view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId)?.name ?? "컬렉션" : view.kind === "favorites" ? "즐겨찾기" : view.kind === "unsorted" ? "미분류" : recent ? "최근" : view.kind === "trash" ? "휴지통" : view.kind === "album" ? albums.find((entry) => entry.id === view.albumId)?.name ?? "앨범" : view.kind === "collections" ? "컬렉션" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "저장소";
  const overflowItems: MenuItem[] = [
    { id: "remove-album", label: "앨범에서 제거", disabled: batchPending || !batchAlbumId, onSelect: () => onAlbum(batchAlbumId, "remove") },
    { id: "favorite-off", label: "좋아요 끄기", disabled: batchPending, onSelect: () => onFavorite(false) },
  ];

  return (
    <ViewToolbar title={location} ariaLabel="자산 도구">
      {selectedCount > 0 ? <>
        <strong>{selectedCount}개 선택</strong>
        <Select label="폴더" value={batchClassificationId} disabled={batchPending} onChange={(event) => setBatchClassificationId(event.target.value)}>
          <option value="">미분류</option>
          {classifications.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </Select>
        <Button disabled={batchPending} onClick={() => onMoveToFolder(batchClassificationId || null)}>폴더로 이동</Button>
        <Select label="앨범" value={batchAlbumId} disabled={batchPending} onChange={(event) => setBatchAlbumId(event.target.value)}>
          <option value="">앨범 선택</option>
          {albums.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </Select>
        <Button disabled={batchPending || !batchAlbumId} onClick={() => onAlbum(batchAlbumId, "add")}>앨범에 추가</Button>
        <Button aria-label="좋아요 켜기" disabled={batchPending} onClick={() => onFavorite(true)}><StarIcon data-icon="inline-start" aria-hidden="true" />좋아요</Button>
        {view.kind === "collection" && selectedCount > 0 && <Button disabled={batchPending} onClick={onRemoveFromCollection}>이 컬렉션에서 제거</Button>}
        {view.kind === "collection" && selectedCount === 1 && <Button disabled={batchPending} onClick={onSetCover}>대표 이미지로 지정</Button>}
        <Button aria-label="휴지통으로 이동" variant="danger" disabled={batchPending} onClick={onTrash}><TrashIcon data-icon="inline-start" aria-hidden="true" />휴지통</Button>
        <Menu label="추가 작업" items={overflowItems} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} />
        <Button aria-label={inspectorOpen ? "정보 닫기" : "정보 열기"} size="icon" variant={inspectorOpen ? "secondary" : "ghost"} onClick={onInspectorToggle}><InformationCircleIcon aria-hidden="true" /></Button>
        <Button aria-label="선택 해제" size="icon" variant="ghost" onClick={onClearSelection}><XMarkIcon aria-hidden="true" /></Button>
      </> : <>
        <Select label="정렬" value={recent ? "newest" : sort} disabled={recent} onChange={(event) => onSortChange(event.target.value as AssetSort)}>
          <option value="newest">최신순</option><option value="oldest">오래된순</option>
          <option value="favorites">좋아요순</option><option value="random">랜덤</option>
        </Select>
        {view.kind === "classification" && <Toggle aria-label="이 분류만" checked={directOnly} onChange={(event) => onDirectOnlyChange(event.target.checked)}><AdjustmentsHorizontalIcon aria-hidden="true" /><span className="asset-toolbar__toggle-text">이 분류만</span></Toggle>}
        <Slider label="미리보기 크기" min={96} max={320} step={8} value={thumbnailRowHeight} onChange={(event) => onThumbnailRowHeightChange(Number(event.target.value))} />
        <Toggle aria-label="정보 표시" checked={metadataVisible} onChange={(event) => onMetadataVisibleChange(event.target.checked)}><InformationCircleIcon aria-hidden="true" /><span className="asset-toolbar__toggle-text">정보 표시</span></Toggle>
        {sort === "random" && !recent && <Button size="icon" aria-label="다시 섞기" onClick={onReshuffle}><ArrowPathIcon aria-hidden="true" /></Button>}
      </>}
    </ViewToolbar>
  );
}
