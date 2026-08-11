export type InternalDragPayload =
  | { kind: "assets"; assetIds: string[] }
  | { kind: "classification"; entryId: string };

export type PointerDragState =
  | { phase: "idle" }
  | { phase: "armed"; payload: InternalDragPayload; startX: number; startY: number }
  | { phase: "dragging"; payload: InternalDragPayload; x: number; y: number };

export type ClassificationDropPosition = "inside";
export type ClassificationDropTarget = {
  entryId: string;
  position: ClassificationDropPosition;
  valid: boolean;
};

export type PointerDragAction =
  | { type: "arm"; payload: InternalDragPayload; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "finish" }
  | { type: "cancel" };

export const POINTER_DRAG_THRESHOLD = 6;

export function pointerDragReducer(state: PointerDragState, action: PointerDragAction): PointerDragState {
  if (action.type === "arm") {
    return { phase: "armed", payload: action.payload, startX: action.x, startY: action.y };
  }
  if (action.type === "finish" || action.type === "cancel") return { phase: "idle" };
  if (state.phase === "idle") return state;
  if (state.phase === "armed") {
    if (Math.hypot(action.x - state.startX, action.y - state.startY) < POINTER_DRAG_THRESHOLD) return state;
    return { phase: "dragging", payload: state.payload, x: action.x, y: action.y };
  }
  return { ...state, x: action.x, y: action.y };
}

export function assetDragIds(assetId: string, selectedIds: ReadonlySet<string>): string[] {
  return selectedIds.has(assetId) ? [...selectedIds] : [assetId];
}
