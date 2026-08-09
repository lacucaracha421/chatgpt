import { useEffect, useRef, useState } from "react";
import type { AssetSummary } from "../library/types";
import { playbackUrl, scrubFrameUrl, thumbnailUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";

type VideoAsset = AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> };
type Props = { asset: VideoAsset; active: boolean; onRequestActive(): void; onReleaseActive(): void; onRetry(): void };

export function VideoTileMedia({ asset, active, onRequestActive, onReleaseActive, onRetry }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const seekTimer = useRef<number | null>(null);
  const [previewFrame, setPreviewFrame] = useState<number | null>(null);
  const clearTimers = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
    hoverTimer.current = null;
    seekTimer.current = null;
  };
  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;
    video.src = playbackUrl(asset.id);
    video.muted = true;
    void video.play().catch(() => undefined);
    return () => { video.pause(); video.removeAttribute("src"); video.load(); };
  }, [active, asset.id]);
  useEffect(() => () => clearTimers(), []);
  const leave = () => { clearTimers(); setPreviewFrame(null); onReleaseActive(); };
  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
    const frame = Math.round(ratio * Math.max(0, asset.media.scrubFrameCount - 1));
    setPreviewFrame(frame);
    if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => {
      if (videoRef.current) videoRef.current.currentTime = ratio * asset.media.durationMs / 1_000;
    }, 120);
  };
  if (asset.media.preparationState === "pending" || asset.media.preparationState === "processing") {
    return <div className="video-tile video-tile--pending"><span className="video-tile__status">미리보기 준비 중</span></div>;
  }
  if (asset.media.preparationState === "failed") {
    return <div className="video-tile video-tile--failed"><span className="video-tile__status">미리보기 준비 실패</span><Button size="sm" onClick={(event) => { event.stopPropagation(); onRetry(); }}>다시 시도</Button></div>;
  }
  const alt = asset.title || asset.originalName;
  return <div className="video-tile" onPointerEnter={() => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(onRequestActive, 200); }} onPointerLeave={leave}>
    <img src={previewFrame === null ? thumbnailUrl(asset.id) : scrubFrameUrl(asset.id, previewFrame)} alt={alt} draggable={false} />
    {active && <video ref={videoRef} src={playbackUrl(asset.id)} muted playsInline preload="metadata" aria-label={`${alt} 미리보기`} />}
    <span className="video-tile__duration">{formatDuration(asset.media.durationMs)}</span><span className="video-tile__icon" aria-hidden="true">▶</span>
    <div className="video-tile__scrub" role="slider" aria-label="영상 탐색" aria-valuemin={0} aria-valuemax={asset.media.durationMs} aria-valuenow={previewFrame === null ? 0 : Math.round(previewFrame / Math.max(1, asset.media.scrubFrameCount - 1) * asset.media.durationMs)} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture?.(event.pointerId); scrub(event); }} onPointerMove={scrub} onPointerUp={(event) => { event.stopPropagation(); event.currentTarget.releasePointerCapture?.(event.pointerId); }} />
  </div>;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.floor(durationMs / 1_000);
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}
