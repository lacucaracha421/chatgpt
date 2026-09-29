import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  count?: number;
};

export type SegmentedControlProps<T extends string> = {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
  fullWidth?: boolean;
};

type CellGeometry = { left: number; width: number };
type DragSession = {
  pointerId: number;
  startX: number;
  startLeft: number;
  left: number;
  width: number;
  dragging: boolean;
  targetButton: HTMLButtonElement | null;
};

const DRAG_THRESHOLD = 6;
const RUBBER_BAND_LIMIT = 8;

function nearestCell(geometry: readonly (CellGeometry | null)[], center: number): number {
  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  geometry.forEach((cell, index) => {
    if (!cell) return;
    const distance = Math.abs(cell.left + cell.width / 2 - center);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  });
  return nearest;
}

function cellAtPoint(geometry: readonly (CellGeometry | null)[], point: number): number {
  const containing = geometry.findIndex(cell => Boolean(cell && point >= cell.left && point <= cell.left + cell.width));
  return containing >= 0 ? containing : nearestCell(geometry, point);
}

function rubberBand(position: number, minimum: number, maximum: number): number {
  if (position < minimum) return minimum - Math.min(RUBBER_BAND_LIMIT, (minimum - position) / 2);
  if (position > maximum) return maximum + Math.min(RUBBER_BAND_LIMIT, (position - maximum) / 2);
  return position;
}

function sameGeometry(previous: readonly (CellGeometry | null)[], next: readonly (CellGeometry | null)[]): boolean {
  return previous.length === next.length && previous.every((cell, index) => {
    const nextCell = next[index];
    return cell?.left === nextCell?.left && cell?.width === nextCell?.width;
  });
}

export function SegmentedControl<T extends string>({ className, fullWidth = false, label, onChange, options, value }: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const geometryRef = useRef<Array<CellGeometry | null>>([]);
  const dragRef = useRef<DragSession | null>(null);
  const settleTimerRef = useRef<number | undefined>(undefined);
  const handledPointerClickRef = useRef(false);
  const [geometry, setGeometry] = useState<Array<CellGeometry | null>>([]);
  const [drag, setDrag] = useState<{ left: number; width: number; previewIndex: number } | null>(null);
  const [pointerHeld, setPointerHeld] = useState(false);
  const [settlingIndex, setSettlingIndex] = useState<number | null>(null);
  const [initialMeasurement, setInitialMeasurement] = useState(true);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const activeIndex = drag?.previewIndex ?? settlingIndex ?? rovingIndex;
  const activeGeometry = drag ?? geometry[activeIndex] ?? null;
  const measurementKey = `${fullWidth}|${JSON.stringify(options.map(option => [option.value, option.label, option.count ?? null]))}`;

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const measure = () => {
      const trackRect = track.getBoundingClientRect();
      const next = options.map((_, index) => {
        const cell = buttonRefs.current[index];
        if (!cell) return null;
        const cellRect = cell.getBoundingClientRect();
        const width = cellRect.width || cell.offsetWidth;
        if (width <= 0) return null;
        const left = cellRect.width || cellRect.left !== 0
          ? cellRect.left - trackRect.left
          : cell.offsetLeft;
        return { left, width };
      });
      geometryRef.current = next;
      setGeometry(current => sameGeometry(current, next) ? current : next);
    };

    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(track);
    buttonRefs.current.slice(0, options.length).forEach(cell => { if (cell) observer?.observe(cell); });
    window.addEventListener("resize", measure);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [measurementKey, options.length]);

  useEffect(() => {
    if (!initialMeasurement) return;
    setInitialMeasurement(false);
  }, [initialMeasurement]);

  useEffect(() => () => {
    if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
  }, []);

  function clearSettlement() {
    if (settleTimerRef.current !== undefined) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = undefined;
    }
    setSettlingIndex(null);
  }

  function settleTo(index: number) {
    if (settleTimerRef.current !== undefined) window.clearTimeout(settleTimerRef.current);
    setSettlingIndex(index);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = undefined;
      setSettlingIndex(null);
    }, 240);
  }

  function selectIndex(index: number) {
    const option = options[index];
    if (!option) return;
    clearSettlement();
    onChange(option.value);
  }

  function move(index: number, direction: -1 | 1) {
    if (options.length === 0) return;
    const nextIndex = (index + direction + options.length) % options.length;
    selectIndex(nextIndex);
    buttonRefs.current[nextIndex]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      move(index, 1);
    }
  }

  function trackLeft(): number {
    return trackRef.current?.getBoundingClientRect().left ?? 0;
  }

  function endPointer(pointerId: number, cancelled: boolean) {
    const session = dragRef.current;
    if (!session || session.pointerId !== pointerId) return;
    trackRef.current?.releasePointerCapture?.(pointerId);
    dragRef.current = null;
    setDrag(null);
    setPointerHeld(false);
    if (cancelled) {
      clearSettlement();
      return;
    }

    if (!session.dragging && session.targetButton) {
      // Pointer capture on the track keeps some engines (WebKitGTK on the PC) from sending the
      // button its click, so a tap selects here; a click that still follows is swallowed once.
      const index = buttonRefs.current.indexOf(session.targetButton);
      if (index < 0) return;
      handledPointerClickRef.current = true;
      window.setTimeout(() => { handledPointerClickRef.current = false; }, 0);
      selectIndex(index);
      return;
    }

    const center = session.dragging
      ? session.left + session.width / 2
      : (session.startX - trackLeft());
    const index = nearestCell(geometryRef.current, center);
    if (index < 0) return;
    handledPointerClickRef.current = Boolean(session.targetButton);
    settleTo(index);
    onChange(options[index].value);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || options.length === 0) return;
    const startIndex = settlingIndex ?? (selectedIndex >= 0 ? selectedIndex : 0);
    const start = geometryRef.current[startIndex] ?? geometryRef.current.find(Boolean);
    if (!start) return;
    const targetButton = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>(".ui-segmented__cell") : null;
    const session: DragSession = { pointerId: event.pointerId, startX: event.clientX, startLeft: start.left, left: start.left, width: start.width, dragging: false, targetButton };
    dragRef.current = session;
    handledPointerClickRef.current = false;
    setPointerHeld(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const session = dragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const delta = event.clientX - session.startX;
    if (!session.dragging && Math.abs(delta) < DRAG_THRESHOLD) return;
    const cells = geometryRef.current.filter((cell): cell is CellGeometry => Boolean(cell));
    if (cells.length === 0) return;
    const minimum = cells[0].left;
    const maximum = cells[cells.length - 1].left + cells[cells.length - 1].width - session.width;
    session.dragging = true;
    session.left = rubberBand(session.startLeft + delta, minimum, Math.max(minimum, maximum));
    const previewIndex = cellAtPoint(geometryRef.current, session.left + session.width / 2);
    setDrag({ left: session.left, width: session.width, previewIndex });
    event.preventDefault();
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    endPointer(event.pointerId, false);
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    endPointer(event.pointerId, true);
  }

  useEffect(() => {
    if (!pointerHeld) return;
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const session = dragRef.current;
      if (session) endPointer(session.pointerId, true);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [pointerHeld]);

  return (
    <div
      ref={trackRef}
      className={["ui-segmented", fullWidth ? "ui-segmented--full-width" : "", className].filter(Boolean).join(" ")}
      role="radiogroup"
      aria-label={label}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <span
        className={["ui-segmented__thumb", initialMeasurement ? "ui-segmented__thumb--initial" : "", settlingIndex !== null ? "ui-segmented__thumb--settling" : "", pointerHeld ? "ui-segmented__thumb--pressed" : "", drag ? "ui-segmented__thumb--dragging" : ""].filter(Boolean).join(" ")}
        aria-hidden="true"
        style={activeGeometry ? { left: activeGeometry.left, width: activeGeometry.width, visibility: "visible" } : { visibility: "hidden" }}
      />
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => { buttonRefs.current[index] = element; }}
          type="button"
          className="ui-segmented__cell"
          role="radio"
          aria-label={`${option.label}${option.count !== undefined ? ` ${option.count.toLocaleString()}` : ""}`}
          aria-checked={option.value === value}
          tabIndex={index === rovingIndex ? 0 : -1}
          data-segmented-active={index === activeIndex ? "true" : undefined}
          onClick={() => {
            if (handledPointerClickRef.current) {
              handledPointerClickRef.current = false;
              return;
            }
            handledPointerClickRef.current = false;
            selectIndex(index);
          }}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          <span className="ui-segmented__content">
            <span className="ui-segmented__label">
              <span>{option.label}</span>
              {option.count !== undefined && <><span> </span><span className="ui-segmented__count">{option.count.toLocaleString()}</span></>}
            </span>
            <span className="ui-segmented__label-measure" aria-hidden="true">
              <span>{option.label}</span>
              {option.count !== undefined && <><span aria-hidden="true"> </span><span className="ui-segmented__count">{option.count.toLocaleString()}</span></>}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
