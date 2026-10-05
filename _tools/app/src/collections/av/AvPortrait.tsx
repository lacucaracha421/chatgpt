import { useState, type CSSProperties } from "react";
import { workArtworkThumbnailUrl } from "../../assets/mediaUrl";
import { usePrivacy } from "../../privacy/PrivacyContext";
import type { AvPortrait as AvPortraitData } from "../avTypes";
import "./avPortrait.css";

export type AvPortraitProps = {
  portrait: AvPortraitData | null | undefined;
  name: string;
  size?: number | "detail" | "performer" | "home";
  className?: string;
};

function revisioned(url: string, revision: string) {
  return `${url}?v=${encodeURIComponent(revision)}`;
}

function initials(name: string) {
  return [...name.trim()][0] ?? "?";
}

export function AvPortrait({ portrait, name, size = "detail", className = "" }: AvPortraitProps) {
  const { privacyMode } = usePrivacy();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imageSrc = portrait?.kind === "commons" || portrait?.kind === "stashdb" ? portrait.dataUrl : null;
  const dimension = typeof size === "number" ? size : size === "performer" ? 225 : size === "home" ? 112 : 84;
  const height = size === "performer" ? 300 : size === "home" ? 150 : dimension;
  const classNames = `av-portrait av-portrait--${typeof size === "string" ? size : "custom"}${className ? ` ${className}` : ""}`;
  const style = { "--portrait-width": `${dimension}px`, "--portrait-height": `${height}px` } as CSSProperties;
  if (privacyMode || !portrait || (imageSrc && imageSrc === failedSrc)) return <span className={classNames} style={style} aria-label={`${name} 이니셜`}>{initials(name)}</span>;
  if ((portrait.kind === "commons" || portrait.kind === "stashdb")) return <span className={classNames} style={style}><img src={portrait.dataUrl} alt={`${name} 대표 이미지`} draggable={false} referrerPolicy="no-referrer" onError={() => setFailedSrc(portrait.dataUrl)} /></span>;

  const rect = portrait.rect;
  const backgroundSize = `${100 / rect.w}% ${100 / rect.h}%`;
  const backgroundPosition = `${rect.w >= 1 ? 0 : (rect.x / (1 - rect.w)) * 100}% ${rect.h >= 1 ? 0 : (rect.y / (1 - rect.h)) * 100}%`;
  // The crop is 3:4; square and round boxes show its upper part instead of stretching it.
  return <span className={classNames} style={style} aria-label={`${name} 대표 이미지`}>
    <span className="av-portrait__crop" style={{ backgroundImage: `url("${revisioned(workArtworkThumbnailUrl(portrait.artworkId), portrait.revision)}")`, backgroundSize, backgroundPosition }} />
  </span>;
}
