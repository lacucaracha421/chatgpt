import { Select } from "../shared/ui/Select";
import { Slider } from "../shared/ui/Slider";
import { Toggle } from "../shared/ui/Toggle";

type GalleryDisplaySettingsProps = {
  galleryLayout: "masonry" | "justified";
  thumbnailRowHeight: number;
  metadataVisible: boolean;
  privacyMode: boolean;
  directOnly?: boolean;
  onGalleryLayoutChange?: (layout: "masonry" | "justified") => void;
  onThumbnailRowHeightChange: (value: number) => void;
  onMetadataVisibleChange: (value: boolean) => void;
  onPrivacyModeChange: (value: boolean) => void;
  onDirectOnlyChange?: (value: boolean) => void;
};

export function GalleryDisplaySettings({
  galleryLayout,
  thumbnailRowHeight,
  metadataVisible,
  privacyMode,
  directOnly,
  onGalleryLayoutChange,
  onThumbnailRowHeightChange,
  onMetadataVisibleChange,
  onPrivacyModeChange,
  onDirectOnlyChange,
}: GalleryDisplaySettingsProps) {
  return <>
    <fieldset className="chrome-settings-group"><legend>보기</legend>
      <Select label="배치" value={galleryLayout} onChange={(event) => onGalleryLayoutChange?.(event.target.value as "masonry" | "justified")}><option value="masonry">날짜별 폭포수</option><option value="justified">같은 높이의 행</option></Select>
      <Slider label="크기" aria-label="미리보기 크기" min={96} max={320} step={8} value={thumbnailRowHeight} onChange={(event) => onThumbnailRowHeightChange(Number(event.target.value))} />
    </fieldset>
    <fieldset className="chrome-settings-group"><legend>표시</legend>
      <Toggle aria-label="정보 숨기기" checked={!metadataVisible} onChange={(event) => onMetadataVisibleChange(!event.target.checked)}>정보 숨기기</Toggle>
      <Toggle aria-label="비공개 모드" checked={privacyMode} onChange={(event) => onPrivacyModeChange(event.target.checked)}>비공개 모드</Toggle>
      {onDirectOnlyChange && <Toggle aria-label="이 분류만" checked={Boolean(directOnly)} onChange={(event) => onDirectOnlyChange(event.target.checked)}>현재 분류만 보기</Toggle>}
    </fieldset>
  </>;
}
