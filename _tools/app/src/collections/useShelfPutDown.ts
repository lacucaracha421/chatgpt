import { useRef, type MouseEvent, type PointerEvent } from "react";

const CONTROL = '.collection-card, [data-volume-id], button, a, input, select, textarea, label, [role="button"], [role="radio"], [role="slider"], [contenteditable="true"], .ui-section-bar, .ui-segmented, .collection-type-header, .collection-chips';
const isControl = (target: EventTarget) => target instanceof Element && Boolean(target.closest(CONTROL));

/** Empty shelf clicks put a case down; controls and gestures keep their own action. */
export function useShelfPutDown(onPutDown: () => void) {
  const gesture = useRef<{ id: number; x: number; y: number; moved: boolean; control: boolean } | null>(null);
  const move = (event: PointerEvent<HTMLElement>) => {
    const start = gesture.current;
    if (start && start.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) start.moved = true;
  };
  const cancel = () => { if (gesture.current) gesture.current.moved = true; };
  return {
    onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
      if (event.isPrimary === false) { cancel(); return; }
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: event.button !== 0, control: isControl(event.target) };
    },
    onPointerMoveCapture: move,
    onPointerUpCapture: move,
    onPointerCancelCapture: cancel,
    onScrollCapture: cancel,
    onWheelCapture: cancel,
    onDragStartCapture: cancel,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (event.detail === 0 && isControl(event.target)) { gesture.current = null; return; }
      if (gesture.current?.moved) { event.preventDefault(); event.stopPropagation(); }
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (!event.defaultPrevented && !gesture.current?.control && !isControl(event.target)) onPutDown();
      gesture.current = null;
    },
  };
}
