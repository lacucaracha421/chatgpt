import { useContext } from "react";
import { FolderRegistrationContext } from "../characters/FolderRegistrationContext";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { AlbumEntry, AssetAspectFilter, AssetMediaFilter, AssetSort, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Select } from "../shared/ui/Select";
import { ViewToolbar } from "../layout/ViewToolbar";
import { GalleryDisplaySettings } from "./GalleryDisplaySettings";

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
  const registration = useContext(FolderRegistrationContext);
  const view = rawView.kind === "notes" || rawView.kind === "similarity_review" || rawView.kind === "settings" || rawView.kind === "statistics" || rawView.kind === "manga" || rawView.kind === "calendar" || rawView.kind === "creators" || rawView.kind === "revisited-bundle"
    ? ({ kind: "classification", classificationId: null } as const)
    : rawView;
  const recent = view.kind === "revisit";
  const filterable = rawView.kind === "classification" || rawView.kind === "unsorted" || rawView.kind === "album" || rawView.kind === "creator";
  const location = view.kind === "revisit" ? "다시보기" : view.kind === "creator" ? "작가" : view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId)?.name ?? "컬렉션" : view.kind === "unsorted" ? "미분류" : view.kind === "trash" ? "휴지통" : view.kind === "album" ? albums.find((entry) => entry.id === view.albumId)?.name ?? "앨범" : view.kind === "collections" ? "컬렉션" : classifications.find((entry) => entry.id === view.classificationId)?.name ?? "저장소";

  return (
    <ViewToolbar title={location} ariaLabel="자산 도구" titleAccessory={registration} chrome={{
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
        <GalleryDisplaySettings galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange}
          thumbnailRowHeight={thumbnailRowHeight} onThumbnailRowHeightChange={onThumbnailRowHeightChange}
          metadataVisible={metadataVisible} onMetadataVisibleChange={onMetadataVisibleChange}
          privacyMode={privacyMode} onPrivacyModeChange={onPrivacyModeChange}
          directOnly={directOnly} onDirectOnlyChange={view.kind === "classification" ? onDirectOnlyChange : undefined} />
      </>,
    }} />
  );
}
