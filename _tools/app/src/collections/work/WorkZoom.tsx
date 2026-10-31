import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref, type RefObject } from "react";

/** One-finger gesture on the stage: "pending" until the axis is chosen, then it either turns the object or scrolls the page. */
export type WorkGesture = "pending" | "turn" | "scroll" | null;
/** A one-finger drag chooses its axis once it has moved this far (CSS px); the rest of the gesture stays on that axis. */
const AXIS_LOCK_PX = 10;
type ZoomState = { zoom: number; session: string; change(factor: number): void; blocked: RefObject<boolean>; gesture: RefObject<WorkGesture> };
const ZoomContext = createContext<ZoomState | null>(null);
export function useWorkTurnBlocked() { return useContext(ZoomContext)?.blocked; }
/** The object waits for a touch drag to choose "turn" before it follows the finger; null outside a zoom stage. */
export function useWorkTurnGesture() { return useContext(ZoomContext)?.gesture; }

/** The work owns zoom, so changing volumes or presentation slots keeps the same scale. */
export function WorkZoomProvider({ workId, reset, children }: { workId: string; reset: number; children: ReactNode }) {
  const [zoom, setZoom] = useState(1);
  const blocked = useRef(false);
  const gesture = useRef<WorkGesture>(null);
  useLayoutEffect(() => { setZoom(1); blocked.current = false; gesture.current = null; }, [workId, reset]);
  const session = useMemo(() => JSON.stringify([workId, reset]), [workId, reset]);
  const change = useCallback((factor: number) => setZoom(value => Math.min(2.5, Math.max(.6, value * factor))), []);
  const value = useMemo(() => ({ zoom, blocked, gesture, session, change }), [zoom, session, change]);
  return <ZoomContext.Provider value={value}>{children}</ZoomContext.Provider>;
}

/** Only object layers scale; controls and backdrops stay fixed at the stage centre. */
export function WorkZoomObject({ children }: { children: ReactNode }) {
  const zoom = useContext(ZoomContext)?.zoom ?? 1;
  return <div className="work-zoom-object" data-zoom={zoom} style={{ "--work-zoom": zoom } as CSSProperties}>{children}</div>;
}

const isEmptyStage = (target: EventTarget | null) => target instanceof Element && !target.closest('.kase,.manga-bigbook,.work-flat-slot,.work-art img,.work-art .privacy-mask,button,a,input,textarea,select,[role="button"]');

export function WorkZoomStage({ enabled = true, stageRef, onEmptyClick, children, ...props }: HTMLAttributes<HTMLDivElement> & { enabled?: boolean; stageRef?: Ref<HTMLDivElement>; onEmptyClick?: () => void; children: ReactNode }) {
  const model = useContext(ZoomContext);
  const node = useRef<HTMLDivElement | null>(null);
  const latest = useRef(model); latest.current = model;
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const distance = useRef<number | null>(null);
  const pinched = useRef(false);
  const suppressClick = useRef(false);
  const clickStart = useRef<{ pointer: number; x: number; y: number; empty: boolean } | null>(null);
  // The stage takes every touch (touch-action: none) so pinches reach it. A one-finger drag picks its axis after AXIS_LOCK_PX:
  // horizontal turns the object (and the page never moves again in that gesture), vertical scrolls the page by hand.
  const scroll = useRef<{ pointer: number; x: number; y: number; target: HTMLElement | null; axis: "x" | "y" | null; active: boolean } | null>(null);
  useLayoutEffect(() => {
    if (pinched.current && model) model.blocked.current = false;
    touches.current.clear(); distance.current = null; pinched.current = false; suppressClick.current = false; scroll.current = null; clickStart.current = null;
    if (model) model.gesture.current = null;
    return () => { if (pinched.current && latest.current) latest.current.blocked.current = false; };
  }, [model?.session, enabled]);
  useEffect(() => {
    const stage = node.current;
    if (!stage || !enabled) return;
    const wheel = (event: WheelEvent) => {
      if (!latest.current) return;
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1);
      latest.current.change(Math.exp(-pixels * .0015));
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, [enabled]);
  function span() {
    const [a, b] = [...touches.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
  }
  function finish() {
    if (!touches.current.size) {
      pinched.current = false;
      scroll.current = null;
      if (model) { model.blocked.current = false; model.gesture.current = null; }
    }
  }
  return <div {...props} ref={element => {
    node.current = element;
    if (typeof stageRef === "function") stageRef(element);
    else if (stageRef) stageRef.current = element;
  }} data-zoom-enabled={enabled || undefined}
    onPointerDownCapture={event => {
      if (!touches.current.size) suppressClick.current = false;
      clickStart.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, empty: isEmptyStage(event.target) };
      if (!enabled || !model || event.pointerType !== "touch") return;
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size === 1) { scroll.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, target: scrollParent(event.currentTarget), axis: null, active: false }; model.gesture.current = "pending"; }
      if (touches.current.size >= 2) {
        if (scroll.current) scroll.current = null;
        model.gesture.current = null;
        pinched.current = true; suppressClick.current = true; model.blocked.current = true; distance.current = span();
      }
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMoveCapture={event => {
      const start = clickStart.current;
      if (start?.pointer === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) suppressClick.current = true;
      if (!touches.current.has(event.pointerId)) return;
      const drag = scroll.current;
      if (drag && drag.pointer === event.pointerId && !pinched.current) {
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (!drag.axis && Math.hypot(dx, dy) >= AXIS_LOCK_PX) {
          // The dominant axis wins and stays: a turn never scrolls the page later, a scroll never turns the object.
          // With nothing to scroll, every drag is a turn.
          drag.axis = drag.target && Math.abs(dy) > Math.abs(dx) ? "y" : "x";
          if (model) model.gesture.current = drag.axis === "y" ? "scroll" : "turn";
          if (drag.axis === "y") { drag.active = true; suppressClick.current = true; if (model) model.blocked.current = true; }
        }
        if (drag.active && drag.target) { drag.target.scrollTop -= dy; drag.x = event.clientX; drag.y = event.clientY; event.preventDefault(); return; }
      }
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const next = span();
      if (next && distance.current && pinched.current) model?.change(next / distance.current);
      distance.current = next;
      if (pinched.current) event.preventDefault();
    }}
    onPointerUpCapture={event => { touches.current.delete(event.pointerId); distance.current = span(); }}
    onPointerCancelCapture={event => { suppressClick.current = true; touches.current.delete(event.pointerId); distance.current = span(); }}
    onPointerDown={event => { if (pinched.current || scroll.current?.active) event.stopPropagation(); else props.onPointerDown?.(event); }}
    onPointerUp={event => { if (pinched.current || scroll.current?.active) event.stopPropagation(); else props.onPointerUp?.(event); finish(); }}
    onPointerCancel={event => { if (pinched.current || scroll.current?.active) event.stopPropagation(); props.onPointerCancel?.(event); finish(); }}
    onClickCapture={event => { if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); } else props.onClickCapture?.(event); }}
    onClick={event => {
      props.onClick?.(event);
      if (!event.defaultPrevented && !suppressClick.current && isEmptyStage(event.target) && (clickStart.current?.empty ?? true)) onEmptyClick?.();
      clickStart.current = null;
    }}
  >{children}</div>;
}

function scrollParent(from: HTMLElement): HTMLElement | null {
  for (let node = from.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}
