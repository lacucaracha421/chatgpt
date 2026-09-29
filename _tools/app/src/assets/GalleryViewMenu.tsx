import { Squares2X2Icon } from "@heroicons/react/24/outline";
import { Menu } from "../shared/ui/Menu";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { Slider } from "../shared/ui/Slider";
import { Switch } from "../shared/ui/Switch";
import type { AssetAspectFilter } from "../library/types";

const aspectIcon = (paths: string[]) => <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{paths.map((d) => <path key={d} d={d} />)}</svg>;
const ASPECT_OPTIONS: ReadonlyArray<{ value: AssetAspectFilter; label: string; icon: ReturnType<typeof aspectIcon> }> = [
  { value: "all", label: "전체", icon: aspectIcon(["M2.75 6.75h8.5v8.5h-8.5z", "M13.75 4.75h3.5v10.5h-3.5z"]) },
  { value: "square", label: "정사각형", icon: aspectIcon(["M4.75 4.75h10.5v10.5H4.75z"]) },
  { value: "landscape", label: "가로형", icon: aspectIcon(["M2.75 5.75h14.5v8.5H2.75z"]) },
  { value: "portrait", label: "세로형", icon: aspectIcon(["M5.75 2.75h8.5v14.5h-8.5z"]) },
];

type GalleryViewMenuProps = {
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
  galleryLayout,
  onGalleryLayoutChange,
  thumbnailRowHeight,
  onThumbnailRowHeightChange,
  aspectFilter = "all",
  onAspectFilterChange,
  inspectorOpen,
  inspectorAvailable = true,
  onInspectorOpenChange,
}: GalleryViewMenuProps) {
  return <Menu
    label="보기"
    align="end"
    triggerClassName="asset-toolbar__quiet-menu"
    trigger={<><Squares2X2Icon aria-hidden="true" /><span>보기</span></>}
    contentClassName="asset-view-menu"
    content={<div className="asset-view-menu__content" onKeyDown={(event) => event.stopPropagation()}>
      <section className="asset-view-menu__section">
        <span className="asset-view-menu__label">배치</span>
        <SegmentedControl label="배치" options={[{ value: "masonry", label: "폭포수" }, { value: "justified", label: "같은 높이" }]} value={galleryLayout} onChange={(value) => onGalleryLayoutChange?.(value)} fullWidth />
      </section>
      <section className="asset-view-menu__section">
        <Slider label="크기" aria-label="미리보기 크기" min={96} max={320} step={8} value={thumbnailRowHeight} onChange={(event) => onThumbnailRowHeightChange(Number(event.target.value))} />
      </section>
      {onAspectFilterChange && <section className="asset-view-menu__section">
        <span className="asset-view-menu__label" id="asset-view-menu-aspect">비율</span>
        <div className="asset-view-menu__aspects" role="radiogroup" aria-labelledby="asset-view-menu-aspect">
          {ASPECT_OPTIONS.map((option) => <button key={option.value} type="button" role="radio" aria-checked={aspectFilter === option.value} className="asset-view-menu__aspect" onClick={() => onAspectFilterChange(option.value)}>{option.icon}<span>{option.label}</span></button>)}
        </div>
      </section>}
      {onInspectorOpenChange && <Switch label="정보" checked={Boolean(inspectorOpen)} disabled={!inspectorAvailable} onChange={(event) => onInspectorOpenChange(event.target.checked)} />}
    </div>}
  />;
}
