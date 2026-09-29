import { Squares2X2Icon } from "@heroicons/react/24/outline";
import { Menu } from "../shared/ui/Menu";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { Slider } from "../shared/ui/Slider";
import { Switch } from "../shared/ui/Switch";

type GalleryViewMenuProps = {
  galleryLayout: "masonry" | "justified";
  onGalleryLayoutChange?: (layout: "masonry" | "justified") => void;
  thumbnailRowHeight: number;
  onThumbnailRowHeightChange: (value: number) => void;
  directOnly?: boolean;
  onDirectOnlyChange?: (value: boolean) => void;
  inspectorOpen?: boolean;
  inspectorAvailable?: boolean;
  onInspectorOpenChange?: (value: boolean) => void;
};

export function GalleryViewMenu({
  galleryLayout,
  onGalleryLayoutChange,
  thumbnailRowHeight,
  onThumbnailRowHeightChange,
  directOnly,
  onDirectOnlyChange,
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
      {onDirectOnlyChange && <Switch label="현재 분류만 보기" checked={Boolean(directOnly)} onChange={(event) => onDirectOnlyChange(event.target.checked)} />}
      {onInspectorOpenChange && <Switch label="정보" checked={Boolean(inspectorOpen)} disabled={!inspectorAvailable} onChange={(event) => onInspectorOpenChange(event.target.checked)} />}
    </div>}
  />;
}

