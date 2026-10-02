import type { ReactNode } from "react";
import { ViewOptionsMenu } from "../shared/ui/ViewOptionsMenu";
import { useGalleryCount } from "./galleryCount";
import { Switch } from "../shared/ui/Switch";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { Button } from "../shared/ui/Button";
import type { AssetSort, AssetMediaFilter, AssetAspectFilter } from "../library/types";

const SORT_OPTIONS = [
  { value: "newest", label: "최신순" }, { value: "oldest", label: "오래된순" },
  { value: "favorites", label: "좋아요순" }, { value: "random", label: "랜덤" },
] as const;

const aspectIcon = (paths: string[]) => <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{paths.map((d) => <path key={d} d={d} />)}</svg>;
const ASPECT_OPTIONS: ReadonlyArray<{ value: AssetAspectFilter; label: string; icon: ReturnType<typeof aspectIcon> }> = [
  { value: "all", label: "전체", icon: aspectIcon(["M2.75 6.75h8.5v8.5h-8.5z", "M13.75 4.75h3.5v10.5h-3.5z"]) },
  { value: "square", label: "정사각형", icon: aspectIcon(["M4.75 4.75h10.5v10.5H4.75z"]) },
  { value: "landscape", label: "가로형", icon: aspectIcon(["M2.75 5.75h14.5v8.5H2.75z"]) },
  { value: "portrait", label: "세로형", icon: aspectIcon(["M5.75 2.75h8.5v14.5h-8.5z"]) },
];

type GalleryViewMenuProps = {
  scopeControl?: ReactNode;
  sort?: AssetSort;
  onSortChange?: (sort: AssetSort) => void;
  onReshuffle?: () => void;
  mediaFilter?: AssetMediaFilter;
  onMediaFilterChange?: (filter: AssetMediaFilter) => void;
  galleryLayout: "masonry" | "justified";
  onGalleryLayoutChange?: (layout: "masonry" | "justified") => void;
  thumbnailRowHeight: number;
  onThumbnailRowHeightChange: (value: number) => void;
  aspectFilter?: AssetAspectFilter;
  onAspectFilterChange?: (value: AssetAspectFilter) => void;
  inspectorOpen?: boolean;
  inspectorAvailable?: boolean;
  onInspectorOpenChange?: (value: boolean) => void;
};

export function GalleryViewMenu({
  scopeControl, galleryLayout, sort = "newest", onSortChange, onReshuffle, mediaFilter = "all", onMediaFilterChange,
  onGalleryLayoutChange,
  thumbnailRowHeight,
  onThumbnailRowHeightChange: _onThumbnailRowHeightChange,
  aspectFilter = "all",
  onAspectFilterChange,
  inspectorOpen,
  inspectorAvailable = true,
  onInspectorOpenChange,
}: GalleryViewMenuProps) {
  const [perRow, setPerRow] = useGalleryCount(thumbnailRowHeight);
  return <ViewOptionsMenu
    layout={galleryLayout} options={[{ value: "masonry", label: "폭포수" }, { value: "justified", label: "같은 높이" }]}
    onLayoutChange={value => onGalleryLayoutChange?.(value)} perRow={perRow} min={3} max={12} onPerRowChange={setPerRow}>
      {onSortChange && <section className="asset-view-menu__section">
        <span className="asset-view-menu__label">정렬</span>
        <div className="asset-view-menu__aspects" role="radiogroup" aria-label="정렬">
          {SORT_OPTIONS.map(option => <button key={option.value} type="button" className="asset-view-menu__aspect"
            role="radio" aria-checked={sort === option.value} onClick={() => onSortChange(option.value)}>{option.label}</button>)}
        </div>
        {sort === "random" && onReshuffle && <Button variant="ghost" onClick={onReshuffle}>다시 섞기</Button>}
      </section>}
      {onMediaFilterChange && <SegmentedControl label="종류" options={[{ value: "all", label: "전체" }, { value: "images", label: "이미지" }, { value: "videos", label: "영상" }]} value={mediaFilter} onChange={onMediaFilterChange} fullWidth />}
      {onAspectFilterChange && <section className="asset-view-menu__section">
        <span className="asset-view-menu__label" id="asset-view-menu-aspect">비율</span>
        <div className="asset-view-menu__aspects" role="radiogroup" aria-labelledby="asset-view-menu-aspect">
          {ASPECT_OPTIONS.map((option) => <button key={option.value} type="button" role="radio" aria-checked={aspectFilter === option.value} className="asset-view-menu__aspect" onClick={() => onAspectFilterChange(option.value)}>{option.icon}<span>{option.label}</span></button>)}
        </div>
      </section>}
      {scopeControl}
      {onInspectorOpenChange && <Switch label="정보" checked={Boolean(inspectorOpen)} disabled={!inspectorAvailable} onChange={(event) => onInspectorOpenChange(event.target.checked)} />}
  </ViewOptionsMenu>;
}
