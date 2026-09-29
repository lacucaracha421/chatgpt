import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { usePrivacy } from "../../privacy/PrivacyContext";
import "./dvdCase.css";

export type DvdCaseProps = {
  frontArtworkId: string | null | undefined;
  spineArtworkId: string | null | undefined;
  backArtworkId: string | null | undefined;
  revision?: string | number | null;
  interactive?: boolean;
  large?: boolean;
  restingAngle?: number;
  size?: number;
  alt?: string;
  onDoubleClick?: () => void;
};

const KEY_STEP = 15;

function revisioned(url: string, revision: string | number | null | undefined) {
  return revision === null || revision === undefined || revision === "" ? url : `${url}?v=${encodeURIComponent(String(revision))}`;
}

function useReducedMotion(enabled: boolean) {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [enabled]);
  return reduced;
}

export function DvdCase({
  frontArtworkId,
  spineArtworkId,
  backArtworkId,
  revision,
  interactive = false,
  large = interactive,
  restingAngle = interactive ? 0 : 12,
  size = 320,
  alt = "DVD 케이스",
  onDoubleClick,
}: DvdCaseProps) {
  const { privacyMode } = usePrivacy();
  const reducedMotion = useReducedMotion(interactive);
  // Rotation lives outside React state: a drag writes the transform directly once per frame.
  const yaw = useRef(0);
  const frame = useRef(0);
  const drag = useRef<{ x: number; yaw: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const caseRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const artworkUrl = (artworkId: string | null | undefined) => {
    if (privacyMode || !artworkId) return undefined;
    const url = large ? workArtworkUrl(artworkId) : workArtworkThumbnailUrl(artworkId);
    return revisioned(url, revision);
  };
  const faces: Array<{ name: "front" | "back" | "spine"; artworkId: string | null | undefined }> = [
    { name: "front", artworkId: frontArtworkId },
    { name: "back", artworkId: backArtworkId },
    { name: "spine", artworkId: spineArtworkId },
  ];

  function paint() {
    frame.current = 0;
    caseRef.current?.style.setProperty("--dvd-yaw", `${yaw.current}deg`);
  }

  function rotateTo(next: number, immediate: boolean) {
    yaw.current = next;
    if (immediate) {
      if (!frame.current) frame.current = requestAnimationFrame(paint);
    } else {
      cancelAnimationFrame(frame.current);
      paint();
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive || event.button !== 0) return;
    drag.current = { x: event.clientX, yaw: yaw.current };
    stageRef.current?.setPointerCapture?.(event.pointerId);
    stageRef.current?.classList.add("dvd-case--dragging");
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active) return;
    rotateTo(active.yaw + (event.clientX - active.x) * 0.5, true);
  }

  function endDrag() {
    if (!drag.current) return;
    drag.current = null;
    stageRef.current?.classList.remove("dvd-case--dragging");
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!interactive || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") rotateTo(Math.round(yaw.current / 360) * 360, false);
    else rotateTo(yaw.current + (event.key === "ArrowRight" ? KEY_STEP : -KEY_STEP), false);
  }

  const width = Math.round(size * 0.703);
  const depth = Math.max(10, Math.round(size * 0.076));
  const style = {
    "--dvd-width": `${width}px`,
    "--dvd-height": `${size}px`,
    "--dvd-depth": `${depth}px`,
    "--dvd-yaw": `${yaw.current}deg`,
    "--dvd-rest": `${restingAngle}deg`,
    "--dvd-transition": reducedMotion ? "none" : undefined,
  } as CSSProperties;
  const interactionProps = interactive ? {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick,
    onKeyDown,
  } : {};

  return (
    <div
      ref={stageRef}
      className={`dvd-case__stage${interactive ? " dvd-case__stage--interactive" : ""}`}
      style={{ width: width + depth + 18, height: size + 22, "--dvd-width": `${width}px` } as CSSProperties}
      tabIndex={interactive ? 0 : undefined}
      role="img"
      aria-label={alt}
      {...interactionProps}
    >
      <div ref={caseRef} className="dvd-case" style={style}>
        {faces.map(({ name, artworkId }) => {
          const src = artworkUrl(artworkId);
          return (
            <div key={name} className={`dvd-case__face dvd-case__face--${name}${src ? "" : " dvd-case__face--neutral"}`}>
              {src && <img src={src} alt="" loading={interactive ? "eager" : "lazy"} decoding="async" draggable={false} />}
            </div>
          );
        })}
        <div className="dvd-case__face dvd-case__face--edge" />
        <div className="dvd-case__face dvd-case__face--top" />
        <div className="dvd-case__face dvd-case__face--bottom" />
      </div>
    </div>
  );
}
