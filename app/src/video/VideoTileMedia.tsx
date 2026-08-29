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
  const [previewFrame, setPreviewFrame] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [playedRatio, setPlayedRatio] = useState(0);
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
  const leave = () => { clearTimers(); scrubbingRef.current = false; setScrubbing(false); setPreviewFrame(null); onReleaseActive(); };
  const scrubTo = (element: HTMLElement, clientX: number, live: boolean) => {
    const bounds = element.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / Math.max(1, bounds.width)));
    const frame = Math.round(ratio * Math.max(0, asset.media.scrubFrameCount - 1));
    setPreviewFrame(frame);
    if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => {
      if (videoRef.current) videoRef.current.currentTime = ratio * asset.media.durationMs / 1_000;
    }, 120);
    if (live) setScrubbing(true);
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
  const durationSeconds = Math.max(1, asset.media.durationMs) / 1_000;
  const scrubRatio = previewFrame === null
    ? playedRatio
    : Math.max(0.001, asset.media.scrubFrameCount <= 1 ? 0 : previewFrame / (asset.media.scrubFrameCount - 1));
  if (asset.media.preparationState === "pending" || asset.media.preparationState === "processing") {
    return <div className="video-tile video-tile--pending"><span className="video-tile__status">미리보기 준비 중</span></div>;
  }
  if (asset.media.preparationState === "failed") {
    return <div className="video-tile video-tile--failed"><span className="video-tile__status">미리보기 준비 실패</span><Button size="sm" onClick={(event) => { event.stopPropagation(); onRetry(); }}>다시 시도</Button></div>;
  }
  if (privacyMode) {
    return <div className="video-tile video-tile--private"><Skeleton className="privacy-mask" label="비공개 모드" /></div>;
  }
  const alt = asset.title || asset.originalName;
  return <div className="video-tile" onPointerEnter={() => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); hoverTimer.current = window.setTimeout(onRequestActive, 200); }} onPointerLeave={leave}>
    <img src={previewFrame === null ? thumbnailUrl(asset.id) : scrubFrameUrl(asset.id, previewFrame)} alt={alt} decoding="async" draggable={false} />
    {/* 재생 프리뷰가 위에 깔리므로, 정지 타일에서는 scrub 미리보기 프레임을 img로 보여준다. */}
    {active && <video
      ref={videoRef}
      src={playbackUrl(asset.id)}
      muted
      playsInline
      preload="metadata"
      aria-label={`${alt} 미리보기`}
      onTimeUpdate={(event) => { if (!scrubbingRef.current) setPlayedRatio(Math.min(1, event.currentTarget.currentTime / durationSeconds)); }}
      onSeeked={(event) => { if (!scrubbingRef.current) setPlayedRatio(Math.min(1, event.currentTarget.currentTime / durationSeconds)); }}
    />}
    <span className="video-tile__duration">{formatDuration(asset.media.durationMs)}</span><span className="video-tile__icon" aria-hidden="true">▶</span>
    <div
      className="video-tile__scrub"
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