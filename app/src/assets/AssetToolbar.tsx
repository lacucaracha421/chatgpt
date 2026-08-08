import { Shuffle, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AssetSort, AssetView, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Select } from "../shared/ui/Select";
import { Slider } from "../shared/ui/Slider";
import { Toggle } from "../shared/ui/Toggle";

type AssetToolbarProps = {
  view: AssetView;
  classifications: ClassificationEntry[];
  sort: AssetSort;
  directOnly: boolean;
  metadataVisible: boolean;
  thumbnailRowHeight: number;
  selectedCount: number;
  onSortChange: (sort: AssetSort) => void;
  onDirectOnlyChange: (value: boolean) => void;
  onMetadataVisibleChange: (value: boolean) => void;
  onThumbnailRowHeightChange: (value: number) => void;
  onFavorite: (favorite: boolean) => void;
  onClassification: (classificationId: string, operation: "add" | "remove") => void;
  onTrash: () => void;
  batchPending: boolean;
  onReshuffle: () => void;
};

export function AssetToolbar({
  view, classifications, sort, directOnly, metadataVisible, thumbnailRowHeight, selectedCount, onSortChange,
  onDirectOnlyChange, onMetadataVisibleChange, onThumbnailRowHeightChange, onFavorite, onClassification, onTrash, batchPending, onReshuffle,
}: AssetToolbarProps) {
  const [batchClassificationId, setBatchClassificationId] = useState("");
  const recent = view.kind === "recent";
  const location = view.kind === "favorites" ? "즐겨찾기" : view.kind === "unsorted" ? "미분류함" : recent ? "최근" : view.kind === "trash" ? "휴지통" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "전체 자산";
  return (
    <header className="asset-toolbar" role="toolbar" aria-label="자산 도구">
      <h2>{location}</h2>
      <div className="asset-toolbar__controls">
        {selectedCount > 0 ? <>
          <strong>{selectedCount}개 선택</strong>
          <Select label="일괄 분류" value={batchClassificationId} disabled={batchPending} onChange={(event) => setBatchClassificationId(event.target.value)}>
            <option value="">분류 선택</option>
            {classifications.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </Select>
          <Button disabled={batchPending || !batchClassificationId} onClick={() => onClassification(batchClassificationId, "add")}>분류 추가</Button>
          <Button disabled={batchPending || !batchClassificationId} onClick={() => onClassification(batchClassificationId, "remove")}>분류 제거</Button>
          <Button disabled={batchPending} onClick={() => onFavorite(true)}><Star aria-hidden="true" />즐겨찾기 추가</Button>
          <Button disabled={batchPending} onClick={() => onFavorite(false)}>즐겨찾기 제거</Button>
          <Button aria-label="선택 항목 휴지통으로 이동" variant="danger" disabled={batchPending} onClick={onTrash}><Trash2 aria-hidden="true" />휴지통</Button>
        </> : <>
        <Select label="정렬" value={recent ? "newest" : sort} disabled={recent} onChange={(event) => onSortChange(event.target.value as AssetSort)}>
          <option value="newest">최신순</option><option value="oldest">오래된순</option>
          <option value="favorites">좋아요순</option><option value="random">랜덤</option>
        </Select>
        {view.kind === "classification" && <Toggle checked={directOnly} onChange={(event) => onDirectOnlyChange(event.target.checked)}>이 분류만</Toggle>}
        <Slider label="미리보기 크기" min={96} max={320} step={8} value={thumbnailRowHeight} onChange={(event) => onThumbnailRowHeightChange(Number(event.target.value))} />
        <Toggle checked={metadataVisible} onChange={(event) => onMetadataVisibleChange(event.target.checked)}>정보 표시</Toggle>
        {sort === "random" && !recent && <Button size="icon" aria-label="다시 섞기" onClick={onReshuffle}><Shuffle aria-hidden="true" /></Button>}
        </>}
      </div>
    </header>
  );
}
