import { FolderIcon, MinusCircleIcon, PhotoIcon, HeartIcon, TrashIcon, UserIcon, UserPlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { HeartIcon as HeartSolidIcon } from "@heroicons/react/24/solid";
import type { AssetView } from "../library/types";
import { Button } from "../shared/ui/Button";
import "./SelectionBar.css";

type SelectionBarProps = {
  view?: AssetView;
  selectedCount: number;
  batchPending: boolean;
  onFavorite?: (favorite: boolean) => void;
  onAddToAlbum?: () => void;
  onRemoveFromCollection?: () => void;
  onSetCover?: () => void;
  /** 작가 지정 for the selection (desktop artist hub). */
  onAssignArtist?: () => void;
  characterOpen?: boolean;
  onCharacterToggle?: () => void;
  characterPicker?: ReactNode;
  characterLabel?: string;
  characterShortcut?: string | null;
  extraActions?: ReactNode;
  onTrash?: () => void;
  onClearSelection: () => void;
  /** Deterministic compact mode for constrained hosts and component tests. */
  compact?: boolean;
};

// 자산 선택 시 갤러리 위에 떠오르는 고정 선택 바. 상단바는 선택과 무관하게
// 제목·보기 설정·창 제어 위치를 유지하고, 선택 명령은 여기에만 나타난다.
export function SelectionBar({
  view, selectedCount, batchPending, onFavorite, onAddToAlbum, onRemoveFromCollection, onSetCover, onAssignArtist, characterOpen = false, onCharacterToggle, characterPicker, characterLabel = "캐릭터", characterShortcut = "C", extraActions, onTrash, onClearSelection, compact = false,
}: SelectionBarProps) {
  if (selectedCount === 0) return null;
  const inCollection = view?.kind === "collection";
  return (
    <div className={`asset-selection-bar${compact ? " asset-selection-bar--compact" : ""}`} role="toolbar" aria-label="선택 작업">
      <strong>{selectedCount}개 선택</strong>
      <span className="view-toolbar__divider" aria-hidden="true" />
      {onAddToAlbum && <Button size="sm" variant="primary" disabled={batchPending} onClick={onAddToAlbum}><FolderIcon aria-hidden="true" />앨범에 추가</Button>}
      {onCharacterToggle && <div className="asset-selection-bar__character">
        <Button size="sm" variant={characterOpen ? "secondary" : "ghost"} aria-label={`${characterLabel} 지정`} aria-expanded={characterOpen} disabled={batchPending} onClick={onCharacterToggle}><UserIcon aria-hidden="true" />{!compact && <><span className="asset-selection-bar__label">{characterLabel}</span>{characterShortcut && <kbd>{characterShortcut}</kbd>}</>}</Button>
        {characterOpen && characterPicker}
      </div>}
      {extraActions}
      {onFavorite && <>
        <Button aria-label="좋아요 켜기" size="icon" variant="ghost" disabled={batchPending} onClick={() => onFavorite(true)}><HeartSolidIcon aria-hidden="true" /></Button>
        <Button aria-label="좋아요 끄기" size="icon" variant="ghost" disabled={batchPending} onClick={() => onFavorite(false)}><HeartIcon aria-hidden="true" /></Button>
      </>}
      {inCollection && <Button aria-label="이 컬렉션에서 제거" size="icon" variant="ghost" disabled={batchPending} onClick={onRemoveFromCollection}><MinusCircleIcon aria-hidden="true" /></Button>}
      {inCollection && selectedCount === 1 && <Button aria-label="대표 이미지로 지정" size="icon" variant="ghost" disabled={batchPending} onClick={onSetCover}><PhotoIcon aria-hidden="true" /></Button>}
      {onAssignArtist && <Button size="sm" variant="ghost" aria-label="작가 지정" disabled={batchPending} onClick={onAssignArtist}><UserPlusIcon aria-hidden="true" />{!compact && <span className="asset-selection-bar__label">작가 지정</span>}</Button>}
      {onTrash && <Button aria-label="휴지통으로 이동" size="icon" variant="danger" disabled={batchPending} onClick={onTrash}><TrashIcon aria-hidden="true" /></Button>}
      <Button aria-label="선택 해제" size="icon" variant="ghost" onClick={onClearSelection}><XMarkIcon aria-hidden="true" /></Button>
    </div>
  );
}
