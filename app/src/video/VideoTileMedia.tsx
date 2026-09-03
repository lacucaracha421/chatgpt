import { useEffect, useRef, useState } from "react";
import type { AssetSummary } from "../library/types";
import { playbackUrl, scrubFrameUrl, thumbnailUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";

type VideoAsset = AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> };
type Props = { asset: VideoAsset; active: boolean; onRequestActive(): void; onReleaseActive(): void; onRetry(): void; privacyMode?: boolean };

export function VideoTileMedia({ asset, active, onRequestActive, onReleaseActive, onRetry, privacyMode = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const seekTimer = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [previewRatio, setPreviewRatio] = useState<number | null>(null);
  const [playedRatio, setPlayedRatio] = useState(0);
  const [videoDuration, setVideoDuration] = useState(asset.media.durationMs / 1_000);
  const clearTimers = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
    hoverTimer.current = null;
    seekTimer.current = null;
  };
  useEffect(() => {
    if (!active || privacyMode) return;
    const video = videoRef.current;
    if (!video) return;
    video.src = playbackUrl(asset.id);
    video.muted = true;
    void video.play().catch(() => undefined);
    return () => { video.pause(); video.removeAttribute("src"); video.load(); };
  }, [active, asset.id, privacyMode]);
  useEffect(() => () => clearTimers(), []);
  const leave = () => { clearTimers(); scrubbingRef.current = false; setScrubbing(false); setPreviewRatio(null); onReleaseActive(); };
  const seekToRatio = (ratio: number, live: boolean) => {
    const clamped = Math.max(0, Math.min(1, ratio));
    setPreviewRatio(clamped);
    if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => {
      if (videoRef.current) videoRef.current.currentTime = clamped * asset.media.durationMs / 1_000;
    }, 120);
    if (live) setScrubbing(true);
  };
  const scrubTo = (element: HTMLElement, clientX: number, live: boolean) => {
    const bounds = element.getBoundingClientRect();
    const ratio = (clientX - bounds.left) / Math.max(1, bounds.width);
    seekToRatio(ratio, live);
  };
  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!scrubbingRef.current) return;
    scrubTo(event.currentTarget, event.clientX, false);
  };
  const startScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrubbingRef.current = true;
    onRequestActive();
    scrubTo(event.currentTarget, event.clientX, true);
  };
  const endScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    event.stopPropagation();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    scrubbingRef.current = false;
    setScrubbing(false);
  };
  const durationSeconds = videoDuration;
  const scrubRatio = previewRatio ?? playedRatio;
  const scrubWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const durationMs = Math.max(0, asset.media.durationMs);
    const currentMs = Math.round(scrubRatio * durationMs);
    const nextMs = event.key === "ArrowLeft"
      ? currentMs - 5_000
      : event.key === "ArrowRight"
        ? currentMs + 5_000
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? durationMs
            : null;
    if (nextMs === null) return;
    event.preventDefault();
    event.stopPropagation();
    onRequestActive();
    seekToRatio(durationMs > 0 ? Math.max(0, Math.min(durationMs, nextMs)) / durationMs : 0, false);
  };
  if (asset.media.preparationState === "pending" || asset.media.preparationState === "processing") {
    return <div className="video-tile video-tile--pending"><span className="video-tile__status">미리보기 준비 중</span></div>;
  }
  if (asset.media.preparationState === "failed") {
    return <div className="video-tile video-tile--failed"><span className="video-tile__status">미리보기 준비 실패</span><Button size="sm" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRetry(); }}>다시 시도</Button></div>;
  }
  if (privacyMode) {
    return <div className="video-tile video-tile--private"><Skeleton className="privacy-mask" label="비공개 모드" /></div>;
  }
  const alt = asset.title || asset.originalName;
  return <div className="video-tile" onPointerEnter={() => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(onRequestActive, 200); }} onPointerLeave={leave}>
    {/* 재생 프리뷰가 위에 깔리므로, 정지 타일에서는 scrub 미리보기 프레임을 img로 보여준다. */}
    <img src={previewRatio === null ? thumbnailUrl(asset.id) : scrubFrameUrl(asset.id, Math.round(previewRatio * Math.max(0, asset.media.scrubFrameCount - 1)))} alt={alt} decoding="async" draggable={false} />
    {active && <video
      ref={videoRef}
      src={playbackUrl(asset.id)}
      muted
      playsInline
      draggable={false}
      preload="metadata"
      aria-label={`${alt} 미리보기`}
      onTimeUpdate={(event) => { if (!scrubbingRef.current) setPlayedRatio(Math.min(1, event.currentTarget.currentTime / durationSeconds)); }}
      onSeeked={(event) => { if (!scrubbingRef.current) setPlayedRatio(Math.min(1, event.currentTarget.currentTime / durationSeconds)); }}
      onDurationChange={(event) => { const d = event.currentTarget.duration; if (Number.isFinite(d) && d > 0) setVideoDuration(d); }}
    />}
    <span className="video-tile__duration">{formatDuration(asset.media.durationMs)}</span><span className="video-tile__icon" aria-hidden="true">▶</span>
    <div
      className="video-tile__scrub"
      tabIndex={0}
      onKeyDown={scrubWithKeyboard}
      role="slider"
      aria-label="영상 탐색"
      aria-valuemin={0}
      aria-valuemax={asset.media.durationMs}
      aria-valuenow={Math.round(scrubRatio * asset.media.durationMs)}
      data-scrubbing={scrubbing || undefined}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={startScrub}
      onPointerMove={scrub}
      onPointerUp={endScrub}
      onPointerCancel={(event) => {
        event.stopPropagation();
        scrubbingRef.current = false;
        setScrubbing(false);
      }}
    >
      <span className="video-tile__scrub-fill" style={{ width: `${scrubRatio * 100}%` }} aria-hidden="true" />
      <span className="video-tile__scrub-handle" style={{ left: `${scrubRatio * 100}%` }} aria-hidden="true" />
    </div>
  </div>;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.floor(durationMs / 1_000);
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}