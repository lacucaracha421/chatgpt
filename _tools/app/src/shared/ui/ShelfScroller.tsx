import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useHorizontalWheel } from "./useHorizontalWheel";

type ShelfScrollerProps = {
  children: ReactNode;
  previousLabel?: string;
  nextLabel?: string;
  wholeCards?: boolean;
};

/** Horizontal shelf with wheel panning, pointer drag, glide, and paging arrows. */
export function ShelfScroller({ children, previousLabel = "이전 발매 예정", nextLabel = "다음 발매 예정", wholeCards = false }: ShelfScrollerProps) {
  const track = useRef<HTMLDivElement>(null);
  const shelf = useRef<HTMLDivElement>(null);
  const cardStep = useRef(0);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = () => {
    const node = track.current;
    if (!node) return;
    if (wholeCards && shelf.current) {
      const content = node.firstElementChild as HTMLElement | null;
      const card = content?.querySelector<HTMLElement>("button");
      if (content && card && card.offsetWidth > 0) {
        const outerStyle = getComputedStyle(shelf.current);
        const style = getComputedStyle(content);
        const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        const gap = parseFloat(style.columnGap) || 0;
        const available = shelf.current.clientWidth - (parseFloat(outerStyle.paddingLeft) || 0) - (parseFloat(outerStyle.paddingRight) || 0);
        const step = card.offsetWidth + gap;
        const count = Math.max(1, Math.floor((available - padding + gap) / step));
        const width = Math.min(available, count * step - gap + padding);
        if (width > 0) node.style.width = `${width}px`;
        cardStep.current = step;
      }
    }
    setEdges({ start: node.scrollLeft <= 2, end: node.scrollLeft + node.clientWidth >= node.scrollWidth - 2 });
  };
  useLayoutEffect(() => {
    measure();
    const node = track.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (wholeCards && shelf.current) observer.observe(shelf.current);
    if (wholeCards && node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [children, wholeCards]);

  const target = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const stop = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; target.current = null; };
  const easeTo = (left: number) => {
    const node = track.current;
    if (!node) return;
    const destination = wholeCards && cardStep.current ? Math.round(left / cardStep.current) * cardStep.current : left;
    target.current = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, destination));
    if (Math.abs(target.current - node.scrollLeft) < 0.5) { stop(); measure(); return; }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      node.scrollLeft = target.current;
      stop();
      measure();
      return;
    }
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

  const bindWheel = useHorizontalWheel({
    getLeft: () => target.current ?? track.current?.scrollLeft ?? 0,
    pan: delta => easeTo((target.current ?? track.current?.scrollLeft ?? 0) + (wholeCards && cardStep.current ? Math.sign(delta) * Math.max(cardStep.current, Math.abs(delta) * 1.6) : delta * 1.6)),
  });
  const bindTrack = useCallback((node: HTMLDivElement | null) => {
    track.current = node;
    const cleanup = bindWheel(node);
    return () => { cleanup?.(); track.current = null; };
  }, [bindWheel]);

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
    if (node && (wholeCards || Math.abs(state.velocity) > 0.2)) easeTo(node.scrollLeft - state.velocity * 260);
    window.setTimeout(() => { setDragging(false); drag.current = null; }, 0);
  };
  const clickCapture = (event: ReactMouseEvent) => {
    if (drag.current?.moved) { event.preventDefault(); event.stopPropagation(); }
    drag.current = null;
  };
  const page = (direction: 1 | -1) => {
    const node = track.current;
    if (node) easeTo((target.current ?? node.scrollLeft) + direction * (wholeCards && cardStep.current ? Math.max(1, Math.floor(node.clientWidth / cardStep.current)) * cardStep.current : node.clientWidth * 0.9));
  };
  return <div ref={shelf} className={`home-shelf${wholeCards ? " home-shelf--whole-cards" : ""}`}>
    <div ref={bindTrack} className={`home-shelf__track${dragging ? " is-dragging" : ""}`} onScroll={measure} onScrollEnd={() => { if (wholeCards && target.current === null && !drag.current) easeTo(track.current?.scrollLeft ?? 0); }}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
      onClickCapture={clickCapture} onDragStart={(event) => event.preventDefault()}>{children}</div>
    {!edges.start && <button type="button" className="home-shelf__arrow home-shelf__arrow--prev" aria-label={previousLabel} onClick={() => page(-1)}><ChevronRightIcon aria-hidden="true" /></button>}
    {!edges.end && <button type="button" className="home-shelf__arrow home-shelf__arrow--next" aria-label={nextLabel} onClick={() => page(1)}><ChevronRightIcon aria-hidden="true" /></button>}
  </div>;
}
