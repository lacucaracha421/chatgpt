import { ArrowUturnLeftIcon, ChevronDownIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { displayCount } from "../../shared/displayDate";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import {
  candidateAvailable, initialSplit, moveLine, placeLine, sameSplit, spineIsBorrowed, spineWarning, surfaceBounds,
  SURFACE_NAMES, type AutoSplit, type Split, type Surface, type SurfaceChoice,
} from "./avReviewModel";

/** The strip of a DVD cover that a spine-less jacket borrows its spine from (server `spineSource`). */
export type SpineSource = { url: string; width: number; height: number; x1: number; x2: number };
export type SurfaceOption = { value: SurfaceChoice; label: string; meta: string | null; thumb: ReactNode };
export type SurfaceControl = {
  surface: Surface;
  /** What the label under the zone shows: name, the state word when it is not the plain candidate, a chevron. */
  face: ReactNode;
  ariaLabel: string;
  value: SurfaceChoice;
  options: SurfaceOption[];
};

/** One crop of an image, positioned inside a box of the crop's own aspect ratio. */
export function Crop({ src, sourceWidth, x, width, height, className, alt = "" }: {
  src: string | null; sourceWidth: number; x: number; width: number; height: number; className?: string; alt?: string;
}) {
  const style: CSSProperties = { aspectRatio: `${Math.max(1, width)} / ${height}` };
  return <span className={`av-crop${className ? ` ${className}` : ""}`} style={style}>
    {src && <img src={src} alt={alt} draggable={false} style={{ width: `${(sourceWidth / Math.max(1, width)) * 100}%`, left: `${(-x / Math.max(1, width)) * 100}%` }} />}
  </span>;
}

/** A spine reads sideways, as on a shelf: the thumbnail is the strip turned a quarter, long enough to be readable. */
function SpineThumb({ src, sourceWidth, sourceHeight, x, width }: { src: string | null; sourceWidth: number; sourceHeight: number; x: number; width: number }) {
  const length = 160;
  const thickness = Math.max(6, Math.round((length * Math.max(1, width)) / sourceHeight));
  return <span className="av-menu-spine" style={{ width: length, height: thickness }}>
    <Crop src={src} sourceWidth={sourceWidth} x={x} width={width} height={sourceHeight} className="av-menu-spine__strip" />
  </span>;
}

/** The inside of one chooser row, the same on the PC menu and the tablet sheet. */
export function AvSurfaceOptionFace({ option }: { option: SurfaceOption }) {
  return <>
    {option.thumb}
    <span className="av-cap-menu__text"><span>{option.label}</span>{option.meta && <small className="numeric">{option.meta}</small>}</span>
  </>;
}

export function AvCoverStage({
  code, jacketUrl, jacketWidth, jacketHeight, privacy, isWrap, auto, split, onSplit, choices, currentImages, spineSource,
  hasCurrent, disabled = false, currentNotes, control,
}: {
  code: string;
  jacketUrl: string | null;
  jacketWidth: number;
  jacketHeight: number;
  privacy: boolean;
  isWrap: boolean;
  auto: AutoSplit;
  split: Split;
  onSplit(next: Split): void;
  choices: Record<Surface, SurfaceChoice>;
  /** The destination's image per surface (null when it has none). */
  currentImages: Record<Surface, string | null>;
  /** Which surfaces the destination has an image for, when that is known before the image itself is (default: those with a URL). */
  hasCurrent?: Record<Surface, boolean>;
  spineSource?: SpineSource | null;
  /** A short note on the destination's image, shown beside "지금 것 유지" (for example `직접 고름`). */
  currentNotes?: Partial<Record<Surface, string>>;
  disabled?: boolean;
  /** Wraps one surface label with the client's chooser (a menu on the PC, a bottom sheet on the tablet). */
  control(props: SurfaceControl): ReactNode;
}) {
  const jacketRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"x1" | "x2" | null>(null);
  const [focused, setFocused] = useState<"x1" | "x2" | null>(null);
  const width = jacketWidth;
  const borrowed = spineIsBorrowed(auto, split, width);
  const latest = useRef({ split, borrowed, onSplit });
  latest.current = { split, borrowed, onSplit };
  const percent = (value: number) => `${(value / width) * 100}%`;
  const zones: Surface[] = isWrap ? ["back", "spine", "front"] : ["front"];
  const warning = spineWarning(auto, split, width);
  const moved = isWrap && !sameSplit(split, initialSplit(auto, width));
  const activeLine = dragging ?? focused;

  function lineKeyDown(line: "x1" | "x2", event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onSplit(moveLine(split, line, (event.shiftKey ? 10 : 1) * (event.key === "ArrowLeft" ? -1 : 1), width, borrowed));
  }
  function beginDrag(line: "x1" | "x2", event: PointerEvent<HTMLButtonElement>) {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.focus();
    setDragging(line);
    const move = (next: globalThis.PointerEvent) => {
      const rect = jacketRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const current = latest.current;
      current.onSplit(placeLine(current.split, line, ((next.clientX - rect.left) / rect.width) * width, width, current.borrowed));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      setDragging(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  }

  const value = (line: "x1" | "x2") => activeLine === line
    ? <span className={`av-split__value numeric${line === "x1" ? " is-left" : ""}`} aria-hidden="true">{line === "x1" ? `뒤표지 ${displayCount(split.x1)}` : `앞표지 ${displayCount(width - split.x2)}`} · 책등 {displayCount(split.x2 - split.x1)}px</span>
    : null;
  const lineProps = (line: "x1" | "x2") => ({
    type: "button" as const,
    role: "slider" as const,
    disabled,
    "aria-valuemin": line === "x1" ? 1 : split.x1 + 1,
    "aria-valuemax": line === "x1" ? split.x2 - 1 : width - 1,
    "aria-valuenow": split[line],
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => beginDrag(line, event),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => lineKeyDown(line, event),
    onFocus: () => setFocused(line),
    onBlur: () => setFocused(current => current === line ? null : current),
  });

  const has = (surface: Surface) => hasCurrent ? hasCurrent[surface] : Boolean(currentImages[surface]);
  const cropOf = (surface: Surface) => surfaceBounds(surface, split, width, isWrap);
  const sizeText = (surface: Surface) => `${displayCount(cropOf(surface).width)} × ${displayCount(jacketHeight)}`;
  function optionsFor(surface: Surface): SurfaceOption[] {
    const options: SurfaceOption[] = [];
    const bounds = cropOf(surface);
    const spineStrip = (src: string | null, sourceWidth: number, sourceHeight: number, x: number, strip: number) => <SpineThumb src={privacy ? null : src} sourceWidth={sourceWidth} sourceHeight={sourceHeight} x={x} width={strip} />;
    const faceThumb = (src: string | null, sourceWidth: number, sourceHeight: number, x: number, strip: number) => surface === "spine"
      ? spineStrip(src, sourceWidth, sourceHeight, x, strip)
      : <Crop src={privacy ? null : src} sourceWidth={sourceWidth} x={x} width={strip} height={sourceHeight} className="av-menu-thumb" />;
    if (surface === "spine" && borrowed) {
      options.push({
        value: "candidate", label: "DVD 표지의 책등", meta: null,
        thumb: spineSource ? spineStrip(spineSource.url, spineSource.width, spineSource.height, spineSource.x1, spineSource.x2 - spineSource.x1) : <span className="av-menu-spine av-menu-thumb--empty" style={{ width: 160, height: 12 }} />,
      });
    } else if (candidateAvailable(auto, split, width, surface)) {
      options.push({ value: "candidate", label: "후보", meta: sizeText(surface), thumb: faceThumb(jacketUrl, width, jacketHeight, bounds.x, bounds.width) });
    }
    if (has(surface)) options.push({ value: "keep", label: "지금 것 유지", meta: currentNotes?.[surface] ?? null, thumb: <span className={surface === "spine" ? "av-menu-spine av-menu-spine--plain" : "av-menu-thumb av-menu-thumb--image"}>{!privacy && currentImages[surface] && <img src={currentImages[surface]!} alt="" draggable={false} />}</span> });
    options.push({ value: "clear", label: "비우기", meta: null, thumb: surface === "spine" ? <span className="av-menu-spine av-menu-thumb--empty" style={{ width: 160, height: 12 }} /> : <span className="av-menu-thumb av-menu-thumb--empty" /> });
    return options;
  }
  function wordOf(surface: Surface, value: SurfaceChoice) {
    if (value === "keep") return "지금";
    if (value === "clear") return "없음";
    return surface === "spine" && borrowed ? "DVD" : null;
  }
  function labelFor(surface: Surface, className?: string) {
    const value = choices[surface];
    const word = wordOf(surface, value);
    const text = value === "keep" ? "지금 것 유지" : value === "clear" ? "비움" : "후보 사용";
    return <span key={surface} className={`av-cap-slot${className ? ` ${className}` : ""}`} style={className ? undefined : { left: percent(cropOf(surface).x + cropOf(surface).width / 2) }}>
      {control({
        surface, value, options: optionsFor(surface), ariaLabel: `${SURFACE_NAMES[surface]}: ${text}`,
        face: <>{SURFACE_NAMES[surface]}{word && <> <span className="av-cap__state">{word}</span></>}<ChevronDownIcon className="av-cap__chev" aria-hidden="true" /></>,
      })}
    </span>;
  }
  // A portrait jacket has only a front zone; a spine or back the destination already has is still reachable.
  const extras: Surface[] = isWrap ? [] : (["spine", "back"] as const).filter(surface => has(surface));

  const ratio = jacketWidth / jacketHeight;
  return <div className={`av-stage${isWrap ? "" : " is-front-only"}`}>
    <div className="av-stage__jacket" style={{ width: `min(100%, calc(var(--hero-h) * ${ratio.toFixed(4)}))` }}>
      <div ref={jacketRef} className="av-split" style={{ aspectRatio: `${jacketWidth} / ${jacketHeight}` }}>
        {privacy || !jacketUrl
          ? <span className="av-split__privacy" role="img" aria-label="표지 숨김" />
          : <img src={jacketUrl} alt={`${code} 펼친 재킷`} draggable={false} />}
        {zones.map(surface => {
          const bounds = cropOf(surface);
          if (bounds.width < 1) return null;
          const style = { left: percent(bounds.x), width: percent(bounds.width) };
          if (choices[surface] === "keep" && has(surface)) {
            return <span key={surface} className="av-split__keep" style={style}>
              {!privacy && currentImages[surface] && <img src={currentImages[surface]!} alt={`지금 ${SURFACE_NAMES[surface]}`} draggable={false} />}
              <Badge variant="scrim">지금</Badge>
            </span>;
          }
          return choices[surface] === "clear" ? <span key={surface} className="av-split__off" style={style} /> : null;
        })}
        {isWrap && (borrowed
          ? <>
            <button {...lineProps("x1")} className={`av-split__line is-joined is-left${activeLine ? " is-focus" : ""}`} style={{ left: percent(split.x1) }}
              aria-label="뒤표지 쪽 선" aria-description="끌어 벌리면 이 재킷에서 책등을 자릅니다" />
            <button {...lineProps("x2")} className={`av-split__line is-joined is-right${activeLine ? " is-focus" : ""}`} style={{ left: percent(split.x2) }}
              aria-label="앞표지 쪽 선" aria-description="끌어 벌리면 이 재킷에서 책등을 자릅니다" />
            <span className={`av-split__joined${activeLine ? " is-focus" : ""}`} style={{ left: percent(split.x1) }} aria-hidden="true">{value(activeLine ?? "x1")}</span>
          </>
          : <>
            <button {...lineProps("x1")} className={`av-split__line${activeLine === "x1" ? " is-focus" : ""}`} style={{ left: percent(split.x1) }} aria-label="뒤표지와 책등 사이 선">{value("x1")}</button>
            <button {...lineProps("x2")} className={`av-split__line${activeLine === "x2" ? " is-focus" : ""}`} style={{ left: percent(split.x2) }} aria-label="책등과 앞표지 사이 선">{value("x2")}</button>
          </>)}
      </div>
      <div className="av-caps">
        {zones.map(surface => labelFor(surface))}
        {extras.length > 0 && <span className="av-caps__extra">{extras.map(surface => labelFor(surface, "is-extra"))}</span>}
      </div>
      <div className="av-stage__foot">
        {warning && <span className="av-stage__warn" role="status"><ExclamationTriangleIcon aria-hidden="true" />{warning === "narrow" ? "책등이 좁아요" : "책등이 넓어요"}</span>}
        {(moved || warning) && <Button size="sm" variant="quiet" disabled={disabled} onClick={() => onSplit(initialSplit(auto, width))}><ArrowUturnLeftIcon aria-hidden="true" />자동으로</Button>}
        <span className="av-stage__size numeric">{displayCount(jacketWidth)} × {displayCount(jacketHeight)}</span>
      </div>
    </div>
  </div>;
}
