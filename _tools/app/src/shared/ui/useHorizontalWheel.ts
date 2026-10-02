import { useCallback, useRef } from "react";

const GESTURE_IDLE_MS = 300;

type HorizontalWheelOptions = {
  /** Animated shelves use their pending destination when testing the ends. */
  getLeft?(): number;
  pan?(delta: number): void;
};

/** One handler per strip: a consumed gesture stays here until the wheel is idle. */
export function createHorizontalWheelHandler(node: HTMLElement, options: HorizontalWheelOptions = {}) {
  let lastAt: number | null = null;
  let latched = false;
  return (event: WheelEvent) => {
    if (event.ctrlKey || event.defaultPrevented) return;
    const raw = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (raw === 0) return;
    const delta = raw * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? node.clientWidth : 1);
    if (lastAt === null || event.timeStamp - lastAt >= GESTURE_IDLE_MS) latched = false;
    lastAt = event.timeStamp;

    const max = Math.max(0, node.scrollWidth - node.clientWidth);
    const left = Math.max(0, Math.min(max, options.getLeft?.() ?? node.scrollLeft));
    const canScroll = delta < 0 ? left > 1 : left < max - 1;
    if (!latched && !canScroll) return;
    latched = true;
    event.preventDefault();
    event.stopPropagation();
    if (canScroll) {
      if (options.pan) options.pan(delta);
      else node.scrollLeft = Math.max(0, Math.min(max, left + delta));
    }
  };
}

/** Non-passive wheel handling and touch containment, shared by PC and tablet strips. */
export function useHorizontalWheel(options: HorizontalWheelOptions = {}) {
  const current = useRef(options);
  current.current = options;
  return useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const wheel = createHorizontalWheelHandler(node, {
      getLeft: () => current.current.getLeft?.() ?? node.scrollLeft,
      pan: delta => {
        if (current.current.pan) current.current.pan(delta);
        else node.scrollLeft = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, node.scrollLeft + delta));
      },
    });
    const overscroll = node.style.overscrollBehaviorX;
    node.style.overscrollBehaviorX = "contain";
    node.addEventListener("wheel", wheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", wheel);
      node.style.overscrollBehaviorX = overscroll;
    };
  }, []);
}
