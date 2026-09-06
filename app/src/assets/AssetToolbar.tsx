import { ArrowPathIcon, ComputerDesktopIcon, DevicePhoneMobileIcon, EyeSlashIcon, FolderIcon, InformationCircleIcon, PhotoIcon, RectangleGroupIcon, RectangleStackIcon, Square2StackIcon, VideoCameraIcon } from "@heroicons/react/24/outline";
import type { AlbumEntry, AssetAspectFilter, AssetMediaFilter, AssetSort, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Menu } from "../shared/ui/Menu";
import { Select } from "../shared/ui/Select";
import { Slider } from "../shared/ui/Slider";
import { Toggle } from "../shared/ui/Toggle";
import { ViewToolbar } from "../layout/ViewToolbar";

type AssetToolbarProps = {
  galleryLayout?: "masonry" | "justified";
  onGalleryLayoutChange?: (layout: "masonry" | "justified") => void;
  view: AssetView;
  classifications: ClassificationEntry[];
  albums: AlbumEntry[];
  sort: AssetSort;
  mediaFilter: AssetMediaFilter;
  aspectFilter: AssetAspectFilter;
  directOnly: boolean;
  metadataVisible: boolean;
  privacyMode: boolean;
  thumbnailRowHeight: number;
  onSortChange: (sort: AssetSort) => void;
  onMediaFilterChange: (filter: AssetMediaFilter) => void;
  onAspectFilterChange: (filter: AssetAspectFilter) => void;
  onDirectOnlyChange: (value: boolean) => void;
  onMetadataVisibleChange: (value: boolean) => void;
  onPrivacyModeChange: (value: boolean) => void;
  onThumbnailRowHeightChange: (value: number) => void;
  collections?: CollectionSummary[];
  onReshuffle: () => void;
};

// 상단바는 선택 상태와 무관하게 제목·보기 설정·창 제어 슬롯을 고정한다.
// 선택 작업은 SelectionBar(갤러리 위 고정 바)에서 수행한다.
export function AssetToolbar({
  galleryLayout = "masonry", onGalleryLayoutChange, view: rawView, classifications, albums, collections = [], sort, mediaFilter, aspectFilter, directOnly, metadataVisible, privacyMode, thumbnailRowHeight,
  onSortChange, onMediaFilterChange, onAspectFilterChange, onDirectOnlyChange, onMetadataVisibleChange, onPrivacyModeChange, onThumbnailRowHeightChange, onReshuffle,
}: AssetToolbarProps) {
  const view = rawView.kind === "similarity_review" || rawView.kind === "settings" || rawView.kind === "manga" || rawView.kind === "calendar" || rawView.kind === "creators" || rawView.kind === "revisited-bundle"
    ? ({ kind: "classification", classificationId: null } as const)
    : rawView;
  const recent = view.kind === "revisit";
  const filterable = rawView.kind === "classification" || rawView.kind === "unsorted" || rawView.kind === "album" || rawView.kind === "creator";
  const location = view.kind === "revisit" ? "다시보기" : view.kind === "creator" ? "작가" : view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId)?.name ?? "컬렉션" : view.kind === "unsorted" ? "미분류" : view.kind === "trash" ? "휴지통" : view.kind === "album" ? albums.find((entry) => entry.id === view.albumId)?.name ?? "앨범" : view.kind === "collections" ? "컬렉션" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "저장소";

  const MediaFilterIcon = mediaFilter === "images" ? PhotoIcon : mediaFilter === "videos" ? VideoCameraIcon : RectangleStackIcon;
  const mediaFilterLabel = mediaFilter === "images" ? "이미지" : mediaFilter === "videos" ? "영상" : "전체";
  const AspectFilterIcon = aspectFilter === "square" ? Square2StackIcon : aspectFilter === "landscape" ? ComputerDesktopIcon : aspectFilter === "portrait" ? DevicePhoneMobileIcon : RectangleGroupIcon;
  const aspectFilterLabel = aspectFilter === "square" ? "정사각형" : aspectFilter === "landscape" ? "가로형" : aspectFilter === "portrait" ? "세로형" : "전체";
  const reshuffleAction = sort === "random"
    ? <Button size="sm" aria-label="다시 섞기" onClick={onReshuffle}><ArrowPathIcon aria-hidden="true" /><span>다시 섞기</span></Button>
    : !recent
      ? <span className="ui-button ui-button--sm asset-toolbar__action-placeholder" aria-hidden="true"><ArrowPathIcon aria-hidden="true" /><span>다시 섞기</span></span>
      : null;
  const directOnlyAction = view.kind === "classification"
    ? <span className="asset-toolbar__icon-toggle" title="현재 분류만 보기"><Toggle aria-label="이 분류만" checked={directOnly} onChange={(event) => onDirectOnlyChange(event.target.checked)}><FolderIcon aria-hidden="true" /></Toggle></span>
    : null;
  const viewActions = reshuffleAction || directOnlyAction ? <>{reshuffleAction}{directOnlyAction}</> : undefined;

  return (
    <ViewToolbar title={location} ariaLabel="자산 도구" actions={viewActions} chrome={{
      summary: [!recent ? ({ newest: "최신순", oldest: "오래된순", favorites: "좋아요순", random: "랜덤" })[sort] : "다시보기", galleryLayout === "masonry" ? "폭포수" : "같은 높이", filterable && (mediaFilter !== "all" || aspectFilter !== "all" || directOnly) ? `필터 ${Number(mediaFilter !== "all") + Number(aspectFilter !== "all") + Number(directOnly)}` : "", privacyMode ? "비공개" : ""].filter(Boolean).join(" · "),
      status: privacyMode ? <span>비공개 모드</span> : undefined,
      settings: <>
        {!recent && <fieldset className="chrome-settings-group"><legend>정렬 · 필터</legend>
          <Select label="정렬" value={sort} onChange={(event) => onSortChange(event.target.value as AssetSort)}><option value="newest">최신순</option><option value="oldest">오래된순</option><option value="favorites">좋아요순</option><option value="random">랜덤</option></Select>
          {filterable && <>
            <Select label="미디어" value={mediaFilter} onChange={(event) => onMediaFilterChange(event.target.value as AssetMediaFilter)}><option value="all">전체</option><option value="images">이미지</option><option value="videos">영상</option></Select>
            <Select label="비율" value={aspectFilter} onChange={(event) => onAspectFilterChange(event.target.value as AssetAspectFilter)}><option value="all">전체</option><option value="square">정사각형</option><option value="landscape">가로형</option><option value="portrait">세로형</option></Select>
          </>}
          {sort === "random" && <Button onClick={onReshuffle}><ArrowPathIcon aria-hidden="true" />다시 섞기</Button>}
        </fieldset>}
        <fieldset className="chrome-settings-group"><legend>보기</legend>
          <Select label="배치" value={galleryLayout} onChange={(event) => onGalleryLayoutChange?.(event.target.value as "masonry" | "justified")}><option value="masonry">날짜별 폭포수</option><option value="justified">같은 높이의 행</option></Select>
          <Slider label="크기" aria-label="미리보기 크기" min={96} max={320} step={8} value={thumbnailRowHeight} onChange={(event) => onThumbnailRowHeightChange(Number(event.target.value))} />
        </fieldset>
        <fieldset className="chrome-settings-group"><legend>표시</legend>
          <Toggle aria-label="정보 숨기기" checked={!metadataVisible} onChange={(event) => onMetadataVisibleChange(!event.target.checked)}>정보 숨기기</Toggle>
          <Toggle aria-label="비공개 모드" checked={privacyMode} onChange={(event) => onPrivacyModeChange(event.target.checked)}>비공개 모드</Toggle>
          {view.kind === "classification" && <Toggle aria-label="이 분류만" checked={directOnly} onChange={(event) => onDirectOnlyChange(event.target.checked)}>현재 분류만 보기</Toggle>}
        </fieldset>
      </>,
    }}>
      <div className="asset-toolbar__group" aria-label="정렬 및 필터">
        {!recent && <Select label="정렬" value={sort} onChange={(event) => onSortChange(event.target.value as AssetSort)}>
          <option value="newest">최신순</option><option value="oldest">오래된순</option>
          <option value="favorites">좋아요순</option><option value="random">랜덤</option>
        </Select>}
        {filterable && <span className="asset-toolbar__filter-menu" data-active={mediaFilter !== "all"} title={`미디어 필터: ${mediaFilterLabel}`}><Menu label={`미디어 필터: ${mediaFilterLabel}`} trigger={<MediaFilterIcon aria-hidden="true" />} items={[
          { id: "all", label: "전체", icon: <RectangleStackIcon />, selected: mediaFilter === "all", onSelect: () => onMediaFilterChange("all") },
          { id: "images", label: "이미지", icon: <PhotoIcon />, selected: mediaFilter === "images", onSelect: () => onMediaFilterChange("images") },
          { id: "videos", label: "영상", icon: <VideoCameraIcon />, selected: mediaFilter === "videos", onSelect: () => onMediaFilterChange("videos") },
        ]} /></span>}
        {filterable && <span className="asset-toolbar__filter-menu" data-active={aspectFilter !== "all"} title={`비율 필터: ${aspectFilterLabel}`}><Menu label={`비율 필터: ${aspectFilterLabel}`} trigger={<AspectFilterIcon aria-hidden="true" />} items={[
          { id: "all", label: "전체", icon: <RectangleGroupIcon />, selected: aspectFilter === "all", onSelect: () => onAspectFilterChange("all") },
          { id: "square", label: "정사각형", icon: <Square2StackIcon />, selected: aspectFilter === "square", onSelect: () => onAspectFilterChange("square") },
          { id: "landscape", label: "가로형", icon: <ComputerDesktopIcon />, selected: aspectFilter === "landscape", onSelect: () => onAspectFilterChange("landscape") },
          { id: "portrait", label: "세로형", icon: <DevicePhoneMobileIcon />, selected: aspectFilter === "portrait", onSelect: () => onAspectFilterChange("portrait") },
        ]} /></span>}
      </div>
      <div className="asset-toolbar__group" aria-label="보기 설정">
        <Select label="배치" value={galleryLayout} onChange={(event) => onGalleryLayoutChange?.(event.target.value as "masonry" | "justified")}><option value="masonry">날짜별 폭포수</option><option value="justified">같은 높이의 행</option></Select>
        <Slider label="미리보기 크기" min={96} max={320} step={8} value={thumbnailRowHeight} onChange={(event) => onThumbnailRowHeightChange(Number(event.target.value))} />
        <span className="asset-toolbar__icon-toggle" title="정보 숨기기"><Toggle aria-label="정보 숨기기" checked={!metadataVisible} onChange={(event) => onMetadataVisibleChange(!event.target.checked)}><InformationCircleIcon aria-hidden="true" /></Toggle></span>
        <span className="asset-toolbar__icon-toggle" title="비공개 모드"><Toggle aria-label="비공개 모드" checked={privacyMode} onChange={(event) => onPrivacyModeChange(event.target.checked)}><EyeSlashIcon aria-hidden="true" /></Toggle></span>
      </div>
    </ViewToolbar>
  );
}
