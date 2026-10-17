import { EllipsisHorizontalIcon, MinusCircleIcon, PhotoIcon, RectangleStackIcon, TrashIcon, UserIcon, UserPlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import type { AssetView } from "../library/types";
import { Button } from "../shared/ui/Button";
import { MotionPresence } from "../shared/ui/MotionPresence";
import "./SelectionBar.css";

type SelectionBarProps = {
  view?: AssetView;
  selectedCount: number;
  batchPending: boolean;
  onAddToAlbum?: () => void;
  onRemoveFromCollection?: () => void;
  onSetCover?: () => void;
  /** 작가 지정 for the selection (desktop artist hub). */
  onAssignArtist?: () => void;
  characterOpen?: boolean;
  onCharacterToggle?: () => void;
  characterPicker?: ReactNode;
  characterLabel?: string;
  /** The tablet's 분류 action files images into folders, so it shows a folder instead of a person. */
  characterIcon?: typeof UserIcon;
  extraActions?: ReactNode;
  onTrash?: () => void;
  onClearSelection: () => void;
  /** Tablet: opens the image menu for the selection (the PC uses its right-click menu). */
  onMore?: () => void;
  /** Tablet: 전체 선택 after the count. Pressed while the whole list is selected; pressing it then lets go of everything. */
  onSelectAll?: () => void;
  allSelected?: boolean;
  /** The list of ids is still on its way. */
  selectAllBusy?: boolean;
  /** Deterministic compact mode for constrained hosts and component tests. */
  compact?: boolean;
};

// 자산 선택 시 갤러리 위에 떠오르는 고정 선택 바. 상단바는 선택과 무관하게
// 제목·보기 설정·창 제어 위치를 유지하고, 선택 명령은 여기에만 나타난다.
export function SelectionBar({
  view, selectedCount, batchPending, onAddToAlbum, onRemoveFromCollection, onSetCover, onAssignArtist, characterOpen = false, onCharacterToggle, characterPicker, characterLabel = "캐릭터", characterIcon: CharacterIcon = UserIcon, extraActions, onTrash, onClearSelection, onMore, onSelectAll, allSelected = false, selectAllBusy = false, compact = false,
}: SelectionBarProps) {
  const inCollection = view?.kind === "collection";
  return (
    <MotionPresence open={selectedCount > 0}>
    <div className={`asset-selection-bar${compact ? " asset-selection-bar--compact" : ""}`} role="toolbar" aria-label="선택 작업">
      <strong>{selectedCount}개 선택</strong>
      {onSelectAll && <Button size="sm" variant="ghost" className="asset-selection-bar__all" aria-pressed={allSelected} aria-busy={selectAllBusy || undefined} disabled={batchPending || selectAllBusy} onClick={onSelectAll}>전체 선택</Button>}
      <span className="view-toolbar__divider" aria-hidden="true" />
      {onAddToAlbum && <Button size="sm" variant="ghost" aria-label="앨범에 추가" disabled={batchPending} onClick={onAddToAlbum}><RectangleStackIcon aria-hidden="true" /><span className="asset-selection-bar__label">앨범에 추가</span></Button>}
      {onCharacterToggle && <div className="asset-selection-bar__character">
        <Button size="sm" variant={characterOpen ? "secondary" : "ghost"} aria-label={`${characterLabel} 지정`} aria-expanded={characterOpen} disabled={batchPending} onClick={onCharacterToggle}><CharacterIcon aria-hidden="true" />{!compact && <span className="asset-selection-bar__label">{characterLabel}</span>}</Button>
        {characterOpen && characterPicker}
      </div>}
      {extraActions}
      {inCollection && <Button aria-label="이 컬렉션에서 빼기" size="icon" variant="ghost" disabled={batchPending} onClick={onRemoveFromCollection}><MinusCircleIcon aria-hidden="true" /></Button>}
      {inCollection && selectedCount === 1 && <Button aria-label="대표 이미지로 지정" size="icon" variant="ghost" disabled={batchPending} onClick={onSetCover}><PhotoIcon aria-hidden="true" /></Button>}
      {onAssignArtist && <Button size="sm" variant="ghost" aria-label="작가 지정" disabled={batchPending} onClick={onAssignArtist}><UserPlusIcon aria-hidden="true" />{!compact && <span className="asset-selection-bar__label">작가 지정</span>}</Button>}
      {/* Trash, menu and clear close the bar as one group (the tablet pushes it to the right end). */}
      <div className="asset-selection-bar__end">
        {onTrash && <Button aria-label="휴지통으로" size="icon" variant="danger" disabled={batchPending} onClick={onTrash}><TrashIcon aria-hidden="true" /></Button>}
        {onMore && <Button aria-label="선택 항목 메뉴" size="icon" variant="ghost" disabled={batchPending} onClick={onMore}><EllipsisHorizontalIcon aria-hidden="true" /></Button>}
        <Button aria-label="선택 해제" size="icon" variant="ghost" onClick={onClearSelection}><XMarkIcon aria-hidden="true" /></Button>
      </div>
    </div>
    </MotionPresence>
  );
}
