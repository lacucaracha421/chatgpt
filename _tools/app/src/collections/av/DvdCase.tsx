import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../../assets/mediaUrl";
import { usePrivacy } from "../../privacy/PrivacyContext";
import "./dvdCase.css";

export type DvdPose = "front" | "spine" | "back";
export type DvdCaseProps = {
  frontArtworkId: string | null | undefined;
  spineArtworkId: string | null | undefined;
  backArtworkId: string | null | undefined;
  revision?: string | number | null;
  pose?: DvdPose;
  interactive?: boolean;
  large?: boolean;
  restingAngle?: number;
  size?: number;
  alt?: string;
  onPoseChange?: (pose: DvdPose) => void;
  onDoubleClick?: () => void;
};

const POSE_ANGLES: Record<DvdPose, number> = { front: 0, spine: 90, back: 180 };
const POSES: DvdPose[] = ["front", "spine", "back"];

function normalize(value: number) {
  return ((value % 360) + 360) % 360;
}

function shortestDistance(target: number, current: number) {
  return ((target - current + 540) % 360) - 180;
}

function nearestPose(yaw: number): DvdPose {
  const current = normalize(yaw);
  return POSES.reduce((best, candidate) => {
    const distance = Math.abs(shortestDistance(POSE_ANGLES[candidate], current));
    return distance < best.distance ? { pose: candidate, distance } : best;
  }, { pose: "front" as DvdPose, distance: Number.POSITIVE_INFINITY }).pose;
}

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
  pose = "front",
  interactive = false,
  large = interactive,
  restingAngle = interactive ? 0 : 12,
  size = 320,
  alt = "DVD 케이스",
  onPoseChange,
  onDoubleClick,
}: DvdCaseProps) {
  const { privacyMode } = usePrivacy();
  const reducedMotion = useReducedMotion(interactive);
  const [yaw, setYaw] = useState(POSE_ANGLES[pose]);
  const [pitch, setPitch] = useState(0);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const caseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drag.current) {
      setYaw(POSE_ANGLES[pose]);
      setPitch(0);
    }
  }, [pose]);

  const artworkUrl = (artworkId: string | null | undefined) => {
    if (privacyMode || !artworkId) return undefined;
    const url = large ? workArtworkUrl(artworkId) : workArtworkThumbnailUrl(artworkId);
    return revisioned(url, revision);
  };
  const faces: Array<{ name: DvdPose; artworkId: string | null | undefined }> = [
    { name: "front", artworkId: frontArtworkId },
    { name: "back", artworkId: backArtworkId },
    { name: "spine", artworkId: spineArtworkId },
  ];

  function applyYaw(nextYaw: number, nextPitch = pitch) {
    setYaw(nextYaw);
    setPitch(Math.max(-20, Math.min(20, nextPitch)));
  }

  function snap() {
    const selected = nearestPose(yaw);
    const nextYaw = yaw + shortestDistance(POSE_ANGLES[selected], normalize(yaw));
    setYaw(nextYaw);
    setPitch(0);
    onPoseChange?.(selected);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!interactive) return;
    drag.current = { x: event.clientX, y: event.clientY, yaw, pitch };
    if (caseRef.current && typeof caseRef.current.setPointerCapture === "function") caseRef.current.setPointerCapture(event.pointerId);
    caseRef.current?.classList.add("dvd-case--dragging");
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active) return;
    applyYaw(active.yaw + (event.clientX - active.x) * 0.55, active.pitch - (event.clientY - active.y) * 0.25);
  }

  function endDrag() {
    if (!drag.current) return;
    drag.current = null;
    caseRef.current?.classList.remove("dvd-case--dragging");
    snap();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!interactive || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") {
      setYaw(0);
      setPitch(0);
      onPoseChange?.("front");
      return;
    }
    const next = nearestPose(yaw + (event.key === "ArrowRight" ? 90 : -90));
    setYaw(POSE_ANGLES[next]);
    setPitch(0);
    onPoseChange?.(next);
  }

  const width = Math.round(size * 0.703);
  const depth = Math.max(10, Math.round(size * 0.076));
  const style = {
    "--dvd-width": `${width}px`,
    "--dvd-height": `${size}px`,
    "--dvd-depth": `${depth}px`,
    "--dvd-wrap-width": `${width * 2 + depth}px`,
    "--dvd-yaw": `${yaw}deg`,
    "--dvd-pitch": `${pitch}deg`,
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
      ref={caseRef}
      className={`dvd-case__stage${interactive ? " dvd-case__stage--interactive" : ""}`}
      style={{ width: width + depth + 18, height: size + 22 }}
      tabIndex={interactive ? 0 : undefined}
      role="img"
      aria-label={alt}
      data-pose={nearestPose(yaw)}
      {...interactionProps}
    >
      <div className="dvd-case" style={style}>
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
