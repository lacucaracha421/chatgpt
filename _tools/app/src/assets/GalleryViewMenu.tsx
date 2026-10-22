import { usePrivacy } from "../privacy/PrivacyContext";
import type { ReactNode } from "react";
import { ViewOptionsMenu } from "../shared/ui/ViewOptionsMenu";
import { ViewOptionsSection } from "../shared/ui/ViewOptionsSection";
import { useGalleryCount } from "./galleryCount";
import { Switch } from "../shared/ui/Switch";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { Button } from "../shared/ui/Button";
import type { AssetSort, AssetMediaFilter, AssetAspectFilter } from "../library/types";

import { DURATION_OPTIONS, type AssetDurationFilter } from "../shared/assetDurationFilter";

const SORT_OPTIONS = [
  { value: "newest", label: "최신순" }, { value: "oldest", label: "오래된순" },
  { value: "favorites", label: "좋아요순" }, { value: "random", label: "랜덤" },
] as const;

const MEDIA_OPTIONS: { value: AssetMediaFilter; label: string }[] = [{ value: "all", label: "전체" }, { value: "images", label: "이미지" }, { value: "videos", label: "영상" }];

const ASPECT_OPTIONS: { value: AssetAspectFilter; label: string }[] = [
  { value: "all", label: "전체" }, { value: "square", label: "정사각형" }, { value: "landscape", label: "가로형" }, { value: "portrait", label: "세로형" },
];

type GalleryViewMenuProps = {
  /** 범위: the folder's 미분류/전체 segment; `scopeHelp` is its ⓘ at the end of the section label. */
  scopeControl?: ReactNode;
  scopeHelp?: ReactNode;
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
  durationFilter?: AssetDurationFilter;
  onDurationFilterChange?: (value: AssetDurationFilter) => void;
  inspectorOpen?: boolean;
  inspectorAvailable?: boolean;
  onInspectorOpenChange?: (value: boolean) => void;
};

/**
 * 보기 for every Asset gallery (plain folders, series, groups, characters, albums, 전체).
 * Order (user, 2026-10-05): what is shown first (범위, 종류), then 배치 and 정렬, the rarely changed
 * 비율 and 표시 switches last. Each group is a labelled section; a section without its handler is left out.
 */
export function GalleryViewMenu({
  scopeControl, scopeHelp, galleryLayout, sort = "newest", onSortChange, onReshuffle, mediaFilter = "all", onMediaFilterChange,
  onGalleryLayoutChange,
  thumbnailRowHeight,
  onThumbnailRowHeightChange: _onThumbnailRowHeightChange,
  aspectFilter = "all",
  onAspectFilterChange,
  durationFilter = "all",
  onDurationFilterChange,
  inspectorOpen,
  inspectorAvailable = true,
  onInspectorOpenChange,
}: GalleryViewMenuProps) {
  const {privacyMode,setPrivacyMode,nsfwFilter,setNsfwFilter} = usePrivacy();
  const [perRow, setPerRow] = useGalleryCount(thumbnailRowHeight);
  return <ViewOptionsMenu
    layout={galleryLayout} options={[{ value: "masonry", label: "폭포수" }, { value: "justified", label: "같은 높이" }]}
    onLayoutChange={value => onGalleryLayoutChange?.(value)} perRow={perRow} min={3} max={12} onPerRowChange={setPerRow}
    leading={<>
      {scopeControl && <ViewOptionsSection title="범위" actions={scopeHelp}>{scopeControl}</ViewOptionsSection>}
      {onMediaFilterChange && <ViewOptionsSection title="종류">
        <SegmentedControl label="종류" options={MEDIA_OPTIONS} value={mediaFilter} onChange={onMediaFilterChange} fullWidth />
      </ViewOptionsSection>}
    </>}>
      {onSortChange && <ViewOptionsSection title="정렬">
        <SegmentedControl label="정렬" options={SORT_OPTIONS} value={sort} onChange={onSortChange} fullWidth />
        {sort === "random" && onReshuffle && <Button variant="ghost" onClick={onReshuffle}>다시 섞기</Button>}
      </ViewOptionsSection>}
      {onAspectFilterChange && <ViewOptionsSection title="비율">
        <SegmentedControl label="비율" options={ASPECT_OPTIONS} value={aspectFilter} onChange={onAspectFilterChange} fullWidth />
      </ViewOptionsSection>}
      {onDurationFilterChange && mediaFilter !== "images" && <ViewOptionsSection title="길이">
        <SegmentedControl label="길이" options={DURATION_OPTIONS} value={durationFilter} onChange={onDurationFilterChange} fullWidth />
      </ViewOptionsSection>}
      <ViewOptionsSection title="표시">
        <Switch label="비공개 모드" checked={privacyMode} onChange={event => setPrivacyMode(event.target.checked)} />
        <Switch label="NSFW 필터" title="전연령 이미지만 보여요" checked={nsfwFilter} onChange={event => setNsfwFilter(event.target.checked)} />
        {onInspectorOpenChange && <Switch label="정보" checked={Boolean(inspectorOpen)} disabled={!inspectorAvailable} onChange={(event) => onInspectorOpenChange(event.target.checked)} />}
      </ViewOptionsSection>
  </ViewOptionsMenu>;
}
