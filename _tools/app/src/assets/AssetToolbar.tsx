import { useContext, type ReactNode } from "react";
import { FolderRegistrationContext } from "../characters/FolderRegistrationContext";
import { ArrowPathIcon, ArrowsUpDownIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import type { AlbumEntry, AssetAspectFilter, AssetMediaFilter, AssetSort, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { hasAutoTagFilter, useAutoTagFilter } from "../autotags/autoTagFilter";
import { Menu } from "../shared/ui/Menu";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { GalleryViewMenu } from "./GalleryViewMenu";

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
  totalCount?: number | null;
  inspectorOpen?: boolean;
  inspectorAvailable?: boolean;
  onInspectorOpenChange?: (open: boolean) => void;
  /** View-level play entry shown beside the title. */
  playAction?: ReactNode;
  /** Replaces the location title (an artist page names its artist). */
  title?: string;
  /** Extra header content after the title, e.g. artist actions. */
  titleAccessory?: ReactNode;
};

// 상단바는 선택 상태와 무관하게 제목·보기 설정·창 제어 슬롯을 고정한다.
// 선택 작업은 SelectionBar(갤러리 위 고정 바)에서 수행한다.
export function AssetToolbar({
  galleryLayout = "masonry", onGalleryLayoutChange, view: rawView, classifications, albums, collections = [], sort, mediaFilter, aspectFilter, directOnly, metadataVisible, privacyMode, thumbnailRowHeight,
  onSortChange, onMediaFilterChange, onAspectFilterChange, onDirectOnlyChange, onMetadataVisibleChange, onPrivacyModeChange, onThumbnailRowHeightChange, onReshuffle, totalCount = null, inspectorOpen = false, inspectorAvailable = false, onInspectorOpenChange, playAction, title, titleAccessory,
}: AssetToolbarProps) {
  void metadataVisible;
  void onMetadataVisibleChange;
  void onPrivacyModeChange;
  const registration = useContext(FolderRegistrationContext);
  const view = rawView.kind === "home" || rawView.kind === "notes" || rawView.kind === "exchange" || rawView.kind === "private_vault" || rawView.kind === "similarity_review" || rawView.kind === "settings" || rawView.kind === "statistics" || rawView.kind === "manga" || rawView.kind === "artists"
    ? ({ kind: "classification", classificationId: null } as const)
    : rawView;
  const filterable = rawView.kind === "classification" || rawView.kind === "unsorted" || rawView.kind === "album" || rawView.kind === "creator";
  const autoTagFiltered = hasAutoTagFilter(useAutoTagFilter());
  // Folder counts are unfiltered, so they are hidden while a media, aspect or 자동 태그 filter narrows the view.
  const countSummary = mediaFilter === "all" && aspectFilter === "all" && !autoTagFiltered ? folderCountSummary(rawView, classifications, directOnly) : null;
  const location = title ?? (view.kind === "creator" ? "작가" : view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId)?.name ?? "컬렉션" : view.kind === "unsorted" ? "미분류" : view.kind === "trash" ? "휴지통" : view.kind === "album" ? albums.find((entry) => entry.id === view.albumId)?.name ?? "앨범" : view.kind === "collections" ? "컬렉션" : view.kind === "albums" ? "앨범" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "전체");
  const sortLabel = ({ newest: "최신순", oldest: "오래된순", favorites: "좋아요순", random: "랜덤" } as const)[sort];
  const directOnlyApplies = rawView.kind === "classification" && Boolean(rawView.classificationId) && !rawView.characterId && !rawView.characterGroupId;
  const controls = <div className="asset-toolbar__controls">
    {filterable && <SegmentedControl label="종류" options={[{ value: "all", label: "전체" }, { value: "images", label: "이미지" }, { value: "videos", label: "영상" }]} value={mediaFilter} onChange={onMediaFilterChange} />}
    <Menu label="정렬" align="end" triggerClassName="asset-toolbar__quiet-menu" trigger={<><ArrowsUpDownIcon aria-hidden="true" /><span>{sortLabel}</span><ChevronDownIcon aria-hidden="true" /></>} items={[
      { id: "newest", label: "최신순", group: "sort", selected: sort === "newest", onSelect: () => onSortChange("newest") },
      { id: "oldest", label: "오래된순", group: "sort", selected: sort === "oldest", onSelect: () => onSortChange("oldest") },
      { id: "favorites", label: "좋아요순", group: "sort", selected: sort === "favorites", onSelect: () => onSortChange("favorites") },
      { id: "random", label: "랜덤", group: "sort", selected: sort === "random", onSelect: () => onSortChange("random") },
      ...(sort === "random" ? [{ id: "reshuffle", label: "다시 섞기", icon: <ArrowPathIcon aria-hidden="true" />, onSelect: onReshuffle }] : []),
    ]} />
    {filterable && <Menu label="비율" align="end" triggerClassName="asset-toolbar__quiet-menu" trigger={<><span>비율</span><ChevronDownIcon aria-hidden="true" /></>} items={[
      { id: "aspect-all", label: "전체 비율", group: "aspect", selected: aspectFilter === "all", onSelect: () => onAspectFilterChange("all") },
      { id: "aspect-square", label: "정사각형", group: "aspect", selected: aspectFilter === "square", onSelect: () => onAspectFilterChange("square") },
      { id: "aspect-landscape", label: "가로형", group: "aspect", selected: aspectFilter === "landscape", onSelect: () => onAspectFilterChange("landscape") },
      { id: "aspect-portrait", label: "세로형", group: "aspect", selected: aspectFilter === "portrait", onSelect: () => onAspectFilterChange("portrait") },
    ]} />}
    <GalleryViewMenu galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange}
      thumbnailRowHeight={thumbnailRowHeight} onThumbnailRowHeightChange={onThumbnailRowHeightChange}
      directOnly={directOnly} onDirectOnlyChange={directOnlyApplies ? onDirectOnlyChange : undefined}
      inspectorOpen={inspectorOpen} inspectorAvailable={inspectorAvailable} onInspectorOpenChange={onInspectorOpenChange} />
  </div>;

  return (
    <ViewToolbar title={location} titleContent={<>{location}{totalCount !== null && <small className="asset-toolbar__title-count" aria-hidden="true">{totalCount.toLocaleString("ko-KR")}</small>}</>} ariaLabel="자산 도구" titleAccessory={<>{registration}{playAction}{titleAccessory}{controls}</>} chrome={{
      summary: [sortLabel, galleryLayout === "masonry" ? "폭포수" : "같은 높이", filterable && (mediaFilter !== "all" || aspectFilter !== "all" || directOnly) ? `필터 ${Number(mediaFilter !== "all") + Number(aspectFilter !== "all") + Number(directOnly)}` : "", privacyMode ? "비공개" : ""].filter(Boolean).join(" · "),
      status: countSummary || privacyMode ? <>{countSummary && <span className="asset-toolbar__count">{countSummary}</span>}{privacyMode && <span>비공개 모드</span>}</> : undefined,
    }} />
  );
}

const formatCount = (count: number) => count.toLocaleString("ko-KR");

/**
 * Header count for a folder: everything the folder view shows by default (with subfolders),
 * plus the direct-only number. When 이 폴더만 is on, the shown number comes first and says so.
 */
export function folderCountSummary(view: AssetView, classifications: ClassificationEntry[], directOnly: boolean): string | null {
  if (view.kind !== "classification" || !view.classificationId || view.characterId || view.characterGroupId) return null;
  const entry = classifications.find((candidate) => candidate.id === view.classificationId);
  if (!entry || entry.assetCount === undefined) return null;
  const direct = entry.assetCount;
  const total = entry.totalAssetCount ?? direct;
  if (directOnly) return total === direct ? `이 폴더만 ${formatCount(direct)}장` : `이 폴더만 ${formatCount(direct)}장 표시 · 하위 포함 ${formatCount(total)}장`;
  return total === direct ? `${formatCount(total)}장` : `${formatCount(total)}장 · 이 폴더만 ${formatCount(direct)}장`;
}
