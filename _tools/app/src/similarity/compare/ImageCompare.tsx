import { ArrowsRightLeftIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import { SegmentedControl } from "../../shared/ui/SegmentedControl";
import {
  FIT, FLICKER_MS, compareViewForKey, fitted, flickerShowsB, panBy, stepWipe, toggleActualSize, transformFor, wipeAt, zoomAt,
  type CompareMode, type CompareSize, type CompareView,
} from "./compareView";
import "./imageCompare.css";

/**
 * Shared A/B image comparison for the similarity review (PC canonical, tablet the same piece):
 * 나란히 (two panes), 깜빡임 (B held or swapped every 500 ms over A) and 와이프 (a draggable divider
 * shows B to its right). Both images always share one zoom/pan view. Mouse and touch: drag pans
 * a zoomed view, wheel or pinch zooms around the pointer, a double click or tap toggles 1:1.
 * Keyboard: + / - / 0 and arrows on a focused image; the divider is a slider.
 * Each client loads its own pixels through `render`; this piece only places them.
 */
export type CompareImage = {
  /** Short badge name: "A", "기존 이미지". */
  name: string;
  /** Accessible name of the image surface. */
  label: string;
  /** Intrinsic size; 0 when unknown (the image then fills the box). */
  size: CompareSize;
  render(props: {className: string; style: CSSProperties; original: boolean}): ReactNode;
};

const IMAGE_CLASS = "image-compare__image";
const MODES = [{value: "side", label: "나란히"}, {value: "flicker", label: "깜빡임"}, {value: "wipe", label: "와이프"}] as const;

/** Mode, shared view, flicker and wipe state for one review screen; zoom and hold reset per pair. */
export function useImageCompare(pairKey: string | undefined) {
  const [mode, setModeValue] = useState<CompareMode>("side");
  const [viewState, setViewState] = useState<{key: string | undefined; view: CompareView}>({key: pairKey, view: FIT});
  const [heldState, setHeldState] = useState<{key: string | undefined; held: boolean}>({key: pairKey, held: false});
  const [auto, setAuto] = useState(false);
  const [phase, setPhase] = useState(false);
  const [wipe, setWipe] = useState(50);
  const view = viewState.key === pairKey ? viewState.view : FIT;
  const held = heldState.key === pairKey && heldState.held;
  const setView = useCallback((next: CompareView) => setViewState({key: pairKey, view: next}), [pairKey]);
  const setHeld = useCallback((next: boolean) => setHeldState({key: pairKey, held: next}), [pairKey]);
  const setMode = useCallback((next: CompareMode) => { setModeValue(next); setAuto(false); setPhase(false); setHeldState({key: pairKey, held: false}); }, [pairKey]);
  // The derived values above already show the fit on the first render of a new pair; this
  // drops the old pair's zoom so it does not return with that pair after an undo.
  useEffect(() => { setViewState({key: pairKey, view: FIT}); setHeldState({key: pairKey, held: false}); }, [pairKey]);
  useEffect(() => {
    if (!auto || mode !== "flicker") return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") setPhase(value => !value); }, FLICKER_MS);
    return () => window.clearInterval(timer);
  }, [auto, mode]);
  const toggleAuto = useCallback(() => { setAuto(value => !value); setPhase(false); }, []);
  return {mode, setMode, view, setView, held, setHeld, auto, toggleAuto, wipe, setWipe, showB: mode === "flicker" && flickerShowsB(held, auto, phase)};
}

export type ImageCompareState = ReturnType<typeof useImageCompare>;

function useBox(ref: RefObject<HTMLElement | null>) {
  const [box, setBox] = useState<CompareSize>({width: 0, height: 0});
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => setBox(current => current.width === node.clientWidth && current.height === node.clientHeight ? current : {width: node.clientWidth, height: node.clientHeight});
    read();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", read); return () => window.removeEventListener("resize", read); }
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

/**
 * One gesture surface: drag pans (when zoomed), two fingers pinch, the wheel zooms, a double tap
 * or double click toggles 1:1 around the point, keys zoom and pan. It reports a new shared view;
 * it never owns one.
 */
function useCompareSurface(host: RefObject<HTMLElement | null>, view: CompareView, onView: (view: CompareView) => void, image: CompareSize) {
  const box = useBox(host);
  const pointers = useRef(new Map<number, {x: number; y: number}>());
  const pinch = useRef<{view: CompareView; distance: number; mid: {x: number; y: number}} | null>(null);
  const tap = useRef<{x: number; y: number; t: number; moved: boolean} | null>(null);
  const lastTap = useRef<{x: number; y: number; t: number} | null>(null);
  const latest = useRef({view, box, image, onView});
  latest.current = {view, box, image, onView};
  const shown = () => fitted(latest.current.box, latest.current.image);
  const local = (event: {clientX: number; clientY: number}, node: Element) => {
    const rect = node.getBoundingClientRect();
    return {x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2};
  };
  // A passive React wheel listener cannot keep the page from scrolling, so this one is native.
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const {view: current, onView: report} = latest.current;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const next = zoomAt(current, local(event, node), current.scale * Math.exp(-delta * 0.002), shown());
      if (next !== current) report(next);
    };
    node.addEventListener("wheel", wheel, {passive: false});
    return () => node.removeEventListener("wheel", wheel);
  }, [host]);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button > 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = local(event, event.currentTarget);
    pointers.current.set(event.pointerId, point);
    tap.current = pointers.current.size === 1 ? {...point, t: performance.now(), moved: false} : null;
    if (pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()];
      pinch.current = {view: latest.current.view, distance: Math.hypot(p.x - q.x, p.y - q.y) || 1, mid: {x: (p.x + q.x) / 2, y: (p.y + q.y) / 2}};
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = local(event, event.currentTarget);
    pointers.current.set(event.pointerId, point);
    if (tap.current && Math.hypot(point.x - tap.current.x, point.y - tap.current.y) > 10) tap.current.moved = true;
    const {view: current, onView: report} = latest.current;
    if (pointers.current.size === 2 && pinch.current) {
      const [p, q] = [...pointers.current.values()];
      const from = pinch.current;
      report(zoomAt(from.view, from.mid, from.view.scale * Math.hypot(p.x - q.x, p.y - q.y) / from.distance, shown()));
    } else if (pointers.current.size === 1 && current.scale > 1) {
      const next = panBy(current, point.x - previous.x, point.y - previous.y, shown());
      if (next !== current) report(next);
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const point = pointers.current.get(event.pointerId);
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const pressed = tap.current;
    tap.current = null;
    if (!point || !pressed || pressed.moved || performance.now() - pressed.t > 300) return;
    const now = performance.now(), last = lastTap.current;
    if (last && now - last.t < 350 && Math.hypot(point.x - last.x, point.y - last.y) < 40) {
      lastTap.current = null;
      latest.current.onView(toggleActualSize(latest.current.view, point, latest.current.image.width, shown()));
    } else lastTap.current = {...point, t: now};
  };
  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => { pointers.current.delete(event.pointerId); pinch.current = null; tap.current = null; };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // Esc on a zoomed image returns to the fit first; the screen closes on the next Esc.
    const next = event.key === "Escape" ? (latest.current.view.scale > 1 ? FIT : null) : compareViewForKey(latest.current.view, event.key);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    latest.current.onView(next);
  };
  return {box, handlers: {onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown}};
}

export type CompareSurfaceState = Pick<ImageCompareState, "mode" | "view" | "setView" | "showB" | "wipe" | "setWipe">;

/**
 * The two image surfaces, in A, B order, for the client's own layout. 나란히 places them apart.
 * In 깜빡임 and 와이프 the client stacks both in one cell (they carry `data-stage`): A's surface
 * takes the gestures and B lies on top without catching any, showing or clipping only its image.
 * The images keep their place in the tree across modes, so switching never reloads or blanks them.
 */
export function ImageCompare({state, images, className}: {state: CompareSurfaceState; images: readonly [CompareImage, CompareImage]; className?: (index: 0 | 1) => string}) {
  return <>
    <CompareSurface state={state} images={images} index={0} className={className?.(0)} />
    <CompareSurface state={state} images={images} index={1} className={className?.(1)} />
  </>;
}

function CompareSurface({state, images, index, className}: {state: CompareSurfaceState; images: readonly [CompareImage, CompareImage]; index: 0 | 1; className?: string}) {
  const {mode, view, setView, showB, wipe, setWipe} = state;
  const host = useRef<HTMLElement | null>(null);
  const image = images[index];
  const {box, handlers} = useCompareSurface(host, view, setView, image.size);
  const dragging = useRef<number | null>(null);
  const stage = mode !== "side";
  const top = stage && index === 1;
  const layer: CSSProperties | undefined = !top ? undefined : mode === "wipe" ? {clipPath: `inset(0 0 0 ${wipe}%)`} : {opacity: showB ? 1 : 0};
  const moveDivider = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = host.current?.getBoundingClientRect();
    if (rect) setWipe(wipeAt(event.clientX, rect));
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragging.current !== event.pointerId) return;
    event.stopPropagation();
    dragging.current = null;
  };
  const percent = Math.round(wipe);
  const [a, b] = images;
  return <section ref={host} className={["image-compare__surface", className].filter(Boolean).join(" ")}
    data-compare={index === 0 ? "a" : "b"} data-stage={stage || undefined} data-zoomed={view.scale > 1 || undefined}
    data-showing={stage && index === 0 ? (mode === "wipe" ? "wipe" : showB ? "B" : "A") : undefined}
    aria-label={!stage ? image.label : index === 0 ? "비교 화면" : undefined} tabIndex={top ? undefined : 0} {...handlers}>
    <div className="image-compare__layer" style={layer}>
      {image.render({className: IMAGE_CLASS, style: {transform: transformFor(view, box, image.size)}, original: view.scale > 1})}
    </div>
    {!stage && <Badge variant="scrim" aria-hidden="true">{image.name}</Badge>}
    {top && mode === "flicker" && <Badge variant="scrim" aria-hidden="true">{showB ? b.name : a.name}</Badge>}
    {top && mode === "wipe" && <>
      <div className="image-compare__divider" style={{left: `${wipe}%`}} role="slider" tabIndex={0} aria-label="와이프 위치" aria-orientation="horizontal"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${a.name} ${percent}% · ${b.name} ${100 - percent}%`}
        onPointerDown={event => {
          event.stopPropagation();
          if (event.button > 0) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          dragging.current = event.pointerId;
        }}
        onPointerMove={event => { if (dragging.current === event.pointerId) { event.stopPropagation(); moveDivider(event); } }}
        onPointerUp={endDrag} onPointerCancel={endDrag}
        onKeyDown={event => {
          const next = stepWipe(wipe, event.key, event.shiftKey);
          if (next === null) return;
          event.preventDefault();
          event.stopPropagation();
          setWipe(next);
        }}>
        <span className="image-compare__knob" aria-hidden="true"><ArrowsRightLeftIcon /></span>
      </div>
      <Badge variant="scrim" aria-hidden="true">{a.name}</Badge>
      <Badge variant="scrim" className="image-compare__badge-end" aria-hidden="true">{b.name}</Badge>
    </>}
  </section>;
}

/** 비교 방식 and, while flickering, hold-to-show-B and the automatic swap. */
export function CompareTools({state, names, className}: {state: ImageCompareState; names: readonly [string, string]; className?: string}) {
  const {mode, setMode, setHeld, auto, toggleAuto} = state;
  const release = () => setHeld(false);
  return <div className={["image-compare-tools", className].filter(Boolean).join(" ")}>
    <SegmentedControl label="비교 방식" options={MODES} value={mode} onChange={setMode} />
    {mode === "flicker" && <div className="image-compare-tools__flicker">
      <Button variant="secondary" className="image-compare-tools__hold" aria-label={`누르는 동안 ${names[1]} 보기`}
        onPointerDown={event => { if (event.button <= 0) setHeld(true); }} onPointerUp={release} onPointerLeave={release} onPointerCancel={release}
        onKeyDown={event => { if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); setHeld(true); } }}
        onKeyUp={event => { if (event.key === " " || event.key === "Enter") release(); }} onBlur={release}>
        누르는 동안 {names[1]}
      </Button>
      <IconButton label={auto ? "자동 깜빡임 멈춤" : "자동 깜빡임"} icon={auto ? PauseIcon : PlayIcon} active={auto} onClick={toggleAuto} />
    </div>}
  </div>;
}

