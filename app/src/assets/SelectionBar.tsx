import { InformationCircleIcon, MinusCircleIcon, PhotoIcon, StarIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { StarIcon as StarSolidIcon } from "@heroicons/react/24/solid";
import type { AssetView } from "../library/types";
import { Button } from "../shared/ui/Button";

type SelectionBarProps = {
  view: AssetView;
  selectedCount: number;
  inspectorOpen: boolean;
  batchPending: boolean;
  onInspectorToggle: () => void;
  onFavorite: (favorite: boolean) => void;
  onRemoveFromCollection?: () => void;
  onSetCover?: () => void;
  onTrash: () => void;
  onClearSelection: () => void;
};

// 자산 선택 시 갤러리 위에 떠오르는 고정 선택 바. 상단바는 선택과 무관하게
// 제목·보기 설정·창 제어 위치를 유지하고, 선택 명령은 여기에만 나타난다.
export function SelectionBar({
  view, selectedCount, inspectorOpen, batchPending, onInspectorToggle, onFavorite, onRemoveFromCollection, onSetCover, onTrash, onClearSelection,
}: SelectionBarProps) {
  if (selectedCount === 0) return null;
  const inCollection = view.kind === "collection";
  return (
    <div className="asset-selection-bar" role="toolbar" aria-label="선택 작업">
      <strong>{selectedCount}개 선택</strong>
      <span className="view-toolbar__divider" aria-hidden="true" />
      <Button aria-label="좋아요 켜기" size="icon" variant="ghost" disabled={batchPending} onClick={() => onFavorite(true)}><StarSolidIcon aria-hidden="true" /></Button>
      <Button aria-label="좋아요 끄기" size="icon" variant="ghost" disabled={batchPending} onClick={() => onFavorite(false)}><StarIcon aria-hidden="true" /></Button>
      {inCollection && <Button aria-label="이 컬렉션에서 제거" size="icon" variant="ghost" disabled={batchPending} onClick={onRemoveFromCollection}><MinusCircleIcon aria-hidden="true" /></Button>}
      {inCollection && selectedCount === 1 && <Button aria-label="대표 이미지로 지정" size="icon" variant="ghost" disabled={batchPending} onClick={onSetCover}><PhotoIcon aria-hidden="true" /></Button>}
      <Button aria-label="휴지통으로 이동" size="icon" variant="danger" disabled={batchPending} onClick={onTrash}><TrashIcon aria-hidden="true" /></Button>
      <Button aria-label={inspectorOpen ? "정보 닫기" : "정보 열기"} size="icon" variant={inspectorOpen ? "secondary" : "ghost"} onClick={onInspectorToggle}><InformationCircleIcon aria-hidden="true" /></Button>
      <Button aria-label="선택 해제" size="icon" variant="ghost" onClick={onClearSelection}><XMarkIcon aria-hidden="true" /></Button>
    </div>
  );
}