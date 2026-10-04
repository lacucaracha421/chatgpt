import { usePrivacy } from "../privacy/PrivacyContext";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/ui/Button";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { useContext, type ReactNode } from "react";
import { FolderRegistrationContext } from "../characters/FolderRegistrationContext";
import type { AlbumEntry, AssetAspectFilter, AssetMediaFilter, AssetSort, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { GalleryViewMenu } from "./GalleryViewMenu";

type AssetToolbarProps = {
  scopeControl?: ReactNode;
  galleryLayout?: "masonry" | "justified";
  onGalleryLayoutChange?: (layout: "masonry" | "justified") => void;
  view: AssetView;
  classifications: ClassificationEntry[];
  albums: AlbumEntry[];
  sort: AssetSort;
  mediaFilter: AssetMediaFilter;
  aspectFilter: AssetAspectFilter;
  metadataVisible: boolean;
  privacyMode: boolean;
  thumbnailRowHeight: number;
  onSortChange: (sort: AssetSort) => void;
  onMediaFilterChange: (filter: AssetMediaFilter) => void;
  onAspectFilterChange: (filter: AssetAspectFilter) => void;
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
  /** Header content before the title, e.g. the 내용 검색 badge. */
  titleLeading?: ReactNode;
};

// 상단바는 선택 상태와 무관하게 제목·보기 설정·창 제어 슬롯을 고정한다.
// 선택 작업은 SelectionBar(갤러리 위 고정 바)에서 수행한다.
export function AssetToolbar({
  scopeControl, galleryLayout = "masonry", onGalleryLayoutChange, view: rawView, classifications, albums, collections = [], sort, mediaFilter, aspectFilter, metadataVisible, privacyMode, thumbnailRowHeight,
  onSortChange, onMediaFilterChange, onAspectFilterChange, onMetadataVisibleChange, onPrivacyModeChange, onThumbnailRowHeightChange, onReshuffle, inspectorOpen = false, inspectorAvailable = false, onInspectorOpenChange, title, titleAccessory, titleLeading,
}: AssetToolbarProps) {
  const {nsfwFilter} = usePrivacy();
  void metadataVisible;
  void onMetadataVisibleChange;
  void onPrivacyModeChange;
  const workspace = useWorkspaceChrome();
  const registration = useContext(FolderRegistrationContext);
  const view = rawView.kind === "home" || rawView.kind === "notes" || rawView.kind === "exchange" || rawView.kind === "private_vault" || rawView.kind === "similarity_review" || rawView.kind === "settings" || rawView.kind === "statistics" || rawView.kind === "manga" || rawView.kind === "artists"
    ? ({ kind: "classification", classificationId: null } as const)
    : rawView;
  const filterable = rawView.kind === "classification" || rawView.kind === "unsorted" || rawView.kind === "album" || rawView.kind === "creator";
  // 내용 검색 results keep their relevance order: no sort choice.
  const ranked = rawView.kind === "description_search";
  const location = title ?? (view.kind === "description_search" ? view.query : view.kind === "creator" ? "작가" : view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId)?.name ?? "컬렉션" : view.kind === "unsorted" ? "미분류" : view.kind === "trash" ? "휴지통" : view.kind === "album" ? albums.find((entry) => entry.id === view.albumId)?.name ?? "앨범" : view.kind === "collections" ? "컬렉션" : view.kind === "albums" ? "앨범" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "전체");
  const sortLabel = ranked ? "관련도순" : ({ newest: "최신순", oldest: "오래된순", favorites: "좋아요순", random: "랜덤" } as const)[sort];
  const viewControls = <GalleryViewMenu scopeControl={scopeControl} galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange} sort={sort} onSortChange={ranked ? undefined : onSortChange} onReshuffle={onReshuffle}
      mediaFilter={filterable ? mediaFilter : undefined} onMediaFilterChange={filterable ? onMediaFilterChange : undefined}
      thumbnailRowHeight={thumbnailRowHeight} onThumbnailRowHeightChange={onThumbnailRowHeightChange}
      aspectFilter={filterable ? aspectFilter : undefined} onAspectFilterChange={filterable ? onAspectFilterChange : undefined}
      inspectorOpen={inspectorOpen} inspectorAvailable={inspectorAvailable} onInspectorOpenChange={onInspectorOpenChange} />;

  return <>
    <ViewToolbar title={location} ariaLabel="자산 도구" leadingAction={titleLeading} titleAccessory={<>{registration}{titleAccessory}</>} trailingAction={<div className="asset-toolbar__controls">{workspace && <Button variant="quiet" aria-label="에셋 검색" aria-keyshortcuts="Control+K Control+F" onClick={workspace.openFind}><MagnifyingGlassIcon aria-hidden="true" /><span>검색</span></Button>}{viewControls}</div>} chrome={{
      summary: [sortLabel, galleryLayout === "masonry" ? "폭포수" : "같은 높이", filterable && (mediaFilter !== "all" || aspectFilter !== "all") ? `필터 ${Number(mediaFilter !== "all") + Number(aspectFilter !== "all")}` : "", privacyMode ? "비공개" : "", nsfwFilter ? "NSFW 필터" : ""].filter(Boolean).join(" · "),
      status: privacyMode || nsfwFilter ? <span>{[privacyMode ? "비공개 모드" : "", nsfwFilter ? "NSFW 필터" : ""].filter(Boolean).join(" · ")}</span> : undefined,
    }} />
  </>;
}
