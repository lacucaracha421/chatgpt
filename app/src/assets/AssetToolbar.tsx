import { Shuffle, Star } from "lucide-react";
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
  onReshuffle: () => void;
};

export function AssetToolbar({
  view, classifications, sort, directOnly, metadataVisible, selectedAsset, onSortChange,
  onDirectOnlyChange, onMetadataVisibleChange, onFavorite, onReshuffle,
}: AssetToolbarProps) {
  const recent = view.kind === "recent";
  const location = view.kind === "favorites" ? "Favorites" : recent ? "Recent" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "Assets";
  return (
    <header className="asset-toolbar">
      <h2>{location}</h2>
      <div className="asset-toolbar__controls">
        <Select label="Sort" value={recent ? "newest" : sort} disabled={recent} onChange={(event) => onSortChange(event.target.value as AssetSort)}>
          <option value="newest">Newest</option><option value="oldest">Oldest</option>
          <option value="favorites">Favorites</option><option value="random">Random</option>
        </Select>
        {view.kind === "classification" && <Toggle checked={directOnly} onChange={(event) => onDirectOnlyChange(event.target.checked)}>Direct only</Toggle>}
        <Toggle checked={metadataVisible} onChange={(event) => onMetadataVisibleChange(event.target.checked)}>Metadata</Toggle>
        {selectedAsset && <Button size="icon" aria-label={selectedAsset.favorite ? "Remove favorite" : "Add favorite"} onClick={onFavorite}><Star aria-hidden="true" fill={selectedAsset.favorite ? "currentColor" : "none"} /></Button>}
        {sort === "random" && !recent && <Button size="icon" aria-label="Reshuffle" onClick={onReshuffle}><Shuffle aria-hidden="true" /></Button>}
      </div>
    </header>
  );
}
