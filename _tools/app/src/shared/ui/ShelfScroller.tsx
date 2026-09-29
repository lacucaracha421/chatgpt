import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

type ShelfScrollerProps = {
  children: ReactNode;
  previousLabel?: string;
  nextLabel?: string;
};

/** Horizontal shelf with wheel panning, pointer drag, glide, and paging arrows. */
export function ShelfScroller({ children, previousLabel = "이전 발매 예정", nextLabel = "다음 발매 예정" }: ShelfScrollerProps) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = () => {
    const node = track.current;
    if (!node) return;
    setEdges({ start: node.scrollLeft <= 2, end: node.scrollLeft + node.clientWidth >= node.scrollWidth - 2 });
  };
  useEffect(() => {
    measure();
    const node = track.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [children]);

  const target = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const stop = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; target.current = null; };
  const easeTo = (left: number) => {
    const node = track.current;
    if (!node) return;
    target.current = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, left));
    if (frame.current !== null) return;
    const step = () => {
      const goal = target.current;
      if (goal === null || !track.current) { frame.current = null; return; }
      const distance = goal - track.current.scrollLeft;
      if (Math.abs(distance) < 0.5) { track.current.scrollLeft = goal; frame.current = null; target.current = null; return; }
      track.current.scrollLeft += distance * 0.22;
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };
  useEffect(() => stop, []);

  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      const vertical = Math.abs(event.deltaY) > Math.abs(event.deltaX);
      const raw = vertical ? event.deltaY : event.deltaX;
      const delta = event.deltaMode === 1 ? raw * 40 : event.deltaMode === 2 ? raw * node.clientWidth : raw;
      const from = target.current ?? node.scrollLeft;
      const max = node.scrollWidth - node.clientWidth;
      if ((delta < 0 && from <= 0) || (delta > 0 && from >= max - 1)) return;
      event.preventDefault();
      easeTo(from + delta * 1.6);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);

  const drag = useRef<{ x: number; left: number; moved: boolean; lastX: number; lastT: number; velocity: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || !track.current) return;
    stop();
    drag.current = { x: event.clientX, left: track.current.scrollLeft, moved: false, lastX: event.clientX, lastT: event.timeStamp, velocity: 0 };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const node = track.current;
    if (!state || !node) return;
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) < 4) return;
    if (!state.moved) { state.moved = true; setDragging(true); node.setPointerCapture?.(event.pointerId); }
    const dt = Math.max(1, event.timeStamp - state.lastT);
    state.velocity = 0.8 * ((event.clientX - state.lastX) / dt) + 0.2 * state.velocity;
    state.lastX = event.clientX; state.lastT = event.timeStamp;
    node.scrollLeft = state.left - dx;
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = track.current;
    const state = drag.current;
    if (node?.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId);
    if (!state?.moved) { drag.current = null; return; }
    if (node && Math.abs(state.velocity) > 0.2) easeTo(node.scrollLeft - state.velocity * 260);
    window.setTimeout(() => { setDragging(false); drag.current = null; }, 0);
  };
  const clickCapture = (event: ReactMouseEvent) => {
    if (drag.current?.moved) { event.preventDefault(); event.stopPropagation(); }
    drag.current = null;
  };
  const page = (direction: 1 | -1) => {
    const node = track.current;
    if (node) easeTo((target.current ?? node.scrollLeft) + direction * node.clientWidth * 0.9);
  };
  return <div className="home-shelf">
    <div ref={track} className={`home-shelf__track${dragging ? " is-dragging" : ""}`} onScroll={measure}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
      onClickCapture={clickCapture} onDragStart={(event) => event.preventDefault()}>{children}</div>
    {!edges.start && <button type="button" className="home-shelf__arrow home-shelf__arrow--prev" aria-label={previousLabel} onClick={() => page(-1)}><ChevronRightIcon aria-hidden="true" /></button>}
    {!edges.end && <button type="button" className="home-shelf__arrow home-shelf__arrow--next" aria-label={nextLabel} onClick={() => page(1)}><ChevronRightIcon aria-hidden="true" /></button>}
  </div>;
}

