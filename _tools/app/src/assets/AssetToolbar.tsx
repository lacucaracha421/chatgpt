import { useContext, type ReactNode } from "react";
import { FolderRegistrationContext } from "../characters/FolderRegistrationContext";
import { ArrowPathIcon, ArrowsUpDownIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import type { AlbumEntry, AssetAspectFilter, AssetMediaFilter, AssetSort, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
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
  inspectorOpen?: boolean;
  inspectorAvailable?: boolean;
  onInspectorOpenChange?: (open: boolean) => void;
  /** Replaces the location title (an artist page names its artist). */
  title?: string;
  /** Extra header content after the title, e.g. artist actions. */
  titleAccessory?: ReactNode;
};

// 상단바는 선택 상태와 무관하게 제목·보기 설정·창 제어 슬롯을 고정한다.
// 선택 작업은 SelectionBar(갤러리 위 고정 바)에서 수행한다.
export function AssetToolbar({
  galleryLayout = "masonry", onGalleryLayoutChange, view: rawView, classifications, albums, collections = [], sort, mediaFilter, aspectFilter, directOnly, metadataVisible, privacyMode, thumbnailRowHeight,
  onSortChange, onMediaFilterChange, onAspectFilterChange, onDirectOnlyChange, onMetadataVisibleChange, onPrivacyModeChange, onThumbnailRowHeightChange, onReshuffle, inspectorOpen = false, inspectorAvailable = false, onInspectorOpenChange, title, titleAccessory,
}: AssetToolbarProps) {
  void metadataVisible;
  void onMetadataVisibleChange;
  void onPrivacyModeChange;
  const registration = useContext(FolderRegistrationContext);
  const view = rawView.kind === "home" || rawView.kind === "notes" || rawView.kind === "exchange" || rawView.kind === "private_vault" || rawView.kind === "similarity_review" || rawView.kind === "settings" || rawView.kind === "statistics" || rawView.kind === "manga" || rawView.kind === "artists"
    ? ({ kind: "classification", classificationId: null } as const)
    : rawView;
  const filterable = rawView.kind === "classification" || rawView.kind === "unsorted" || rawView.kind === "album" || rawView.kind === "creator";
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
    <GalleryViewMenu galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange}
      thumbnailRowHeight={thumbnailRowHeight} onThumbnailRowHeightChange={onThumbnailRowHeightChange}
      aspectFilter={filterable ? aspectFilter : undefined} onAspectFilterChange={filterable ? onAspectFilterChange : undefined}
      directOnly={directOnly} onDirectOnlyChange={directOnlyApplies ? onDirectOnlyChange : undefined}
      inspectorOpen={inspectorOpen} inspectorAvailable={inspectorAvailable} onInspectorOpenChange={onInspectorOpenChange} />
  </div>;

  return (
    <ViewToolbar title={location} ariaLabel="자산 도구" titleAccessory={<>{registration}{titleAccessory}{controls}</>} chrome={{
      summary: [sortLabel, galleryLayout === "masonry" ? "폭포수" : "같은 높이", filterable && (mediaFilter !== "all" || aspectFilter !== "all" || (directOnlyApplies && !directOnly)) ? `필터 ${Number(mediaFilter !== "all") + Number(aspectFilter !== "all") + Number(directOnlyApplies && !directOnly)}` : "", privacyMode ? "비공개" : ""].filter(Boolean).join(" · "),
      status: privacyMode ? <span>비공개 모드</span> : undefined,
    }} />
  );
}
