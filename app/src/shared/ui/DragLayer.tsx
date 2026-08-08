import type { PointerDragState } from "../interaction/pointerDrag";

export function DragLayer({ state }: { state: PointerDragState }) {
  if (state.phase !== "dragging") return null;
  const label = state.payload.kind === "assets"
    ? `${state.payload.assetIds.length}개 자산`
    : "분류 이동";
  return <div className="ui-drag-layer" style={{ transform: `translate(${state.x + 12}px, ${state.y + 12}px)` }} aria-hidden="true">{label}</div>;
}
