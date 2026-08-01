import { Shuffle, Star, Trash2 } from "lucide-react";
import type { AssetSort, AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Select } from "../shared/ui/Select";
import { Toggle } from "../shared/ui/Toggle";

type AssetToolbarProps = {
  view: AssetView;
  classifications: ClassificationEntry[];
  sort: AssetSort;
  directOnly: boolean;
  metadataVisible: boolean;
  selectedAsset: AssetSummary | null;
  onSortChange: (sort: AssetSort) => void;
  onDirectOnlyChange: (value: boolean) => void;
  onMetadataVisibleChange: (value: boolean) => void;
  onFavorite: () => void;
  onTrash: () => void;
  onReshuffle: () => void;
};

export function AssetToolbar({
  view, classifications, sort, directOnly, metadataVisible, selectedAsset, onSortChange,
  onDirectOnlyChange, onMetadataVisibleChange, onFavorite, onTrash, onReshuffle,
}: AssetToolbarProps) {
  const recent = view.kind === "recent";
  const location = view.kind === "favorites" ? "즐겨찾기" : recent ? "최근" : view.kind === "trash" ? "휴지통" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "전체 자산";
  return (
    <header className="asset-toolbar">
      <h2>{location}</h2>
      <div className="asset-toolbar__controls">
        <Select label="정렬" value={recent ? "newest" : sort} disabled={recent} onChange={(event) => onSortChange(event.target.value as AssetSort)}>
          <option value="newest">최신순</option><option value="oldest">오래된순</option>
          <option value="favorites">좋아요순</option><option value="random">랜덤</option>
        </Select>
        {view.kind === "classification" && <Toggle checked={directOnly} onChange={(event) => onDirectOnlyChange(event.target.checked)}>이 분류만</Toggle>}
        <Toggle checked={metadataVisible} onChange={(event) => onMetadataVisibleChange(event.target.checked)}>정보 표시</Toggle>
        {selectedAsset && <Button size="icon" aria-label={selectedAsset.favorite ? "좋아요 끄기" : "좋아요 켜기"} onClick={onFavorite}><Star aria-hidden="true" fill={selectedAsset.favorite ? "currentColor" : "none"} /></Button>}
        {selectedAsset && <Button aria-label="휴지통으로 이동" variant="danger" onClick={onTrash}><Trash2 aria-hidden="true" />휴지통으로 이동</Button>}
        {sort === "random" && !recent && <Button size="icon" aria-label="다시 섞기" onClick={onReshuffle}><Shuffle aria-hidden="true" /></Button>}
      </div>
    </header>
  );
}
