import {useAssetMask} from "../privacy/PrivacyContext";
import { formatDuration } from "./formatDuration";
import { useEffect, useRef, useState } from "react";
import { ClockIcon } from "@heroicons/react/24/outline";
import type { AssetSummary } from "../library/types";
import { assetThumbnailUrl, playbackUrl, scrubFrameUrl } from "../assets/mediaUrl";
import { useWorkloadProfile } from "../app/workloadProfile";
import { Button } from "../shared/ui/Button";
import { Badge } from "../shared/ui/Badge";
import { Skeleton } from "../shared/ui/Skeleton";
import { StableImage } from "../shared/ui/StableImage";
import { waitForVideoFrame } from "./waitForVideoFrame";

type VideoAsset = AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> };
type Props = { asset: VideoAsset; active: boolean; onRequestActive(): void; onReleaseActive(): void; onRetry(): void; privacyMode?: boolean; /** `null`: the Asset has no thumbnail, so no still image is requested. */ thumbnailSrc?: string | null; playbackSrc?: string; compactBadge?: boolean; durationVisible?: boolean; /** The video itself reported its length while previewing. */ onDurationKnown?(durationMs: number): void };

export function VideoTileMedia({ asset, active, onRequestActive, onReleaseActive, onRetry, privacyMode:requestedPrivacy = false, thumbnailSrc, playbackSrc, compactBadge = false, durationVisible = true, onDurationKnown }: Props) {
  const privacyMode=useAssetMask(asset,requestedPrivacy);
  const videoRef = useRef<HTMLVideoElement>(null);
  const freezeRef = useRef<HTMLCanvasElement>(null);
  const [frozen, setFrozen] = useState(false);
  const frozenRef = useRef(false);
  const wantedStill = useRef<string | null>(null);
  /** Detaches the gallery-cell leave listener armed while the pointer is on the cell's own controls. */
  const cellWatch = useRef<(() => void) | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const seekTimer = useRef<number | null>(null);
  const frameTimer = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const cancelFrame = useRef<(() => void) | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const presented = useRef(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [previewRatio, setPreviewRatio] = useState<number | null>(null);
  const [playedRatio, setPlayedRatio] = useState(0);
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  /** The hover preview plays the video itself; the still stays until its first frame is on screen. */
  const [videoShown, setVideoShown] = useState(false);
  const [videoDuration, setVideoDuration] = useState(asset.media.durationMs / 1_000);
  const clearTimers = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
    if (frameTimer.current !== null) window.clearInterval(frameTimer.current);
    hoverTimer.current = null;
    seekTimer.current = null;
    frameTimer.current = null;
  };
  useEffect(() => {
    if (!active || !playbackRequested || privacyMode) return;
    const video = videoRef.current;
    if (!video) return;
    const source = playbackSrc ?? playbackUrl(asset.id);
    if (video.getAttribute("src") !== source) video.src = source;
    if (pendingSeek.current === null) {
      cancelFrame.current = waitForVideoFrame(video, 0, () => {
        presented.current = true;
        setVideoShown(true);
        if (!scrubbingRef.current) setPreviewRatio(null);
      });
    }
    video.muted = true;
    void video.play()?.catch(() => undefined);
    return () => { cancelFrame.current?.(); presented.current = false; frozenRef.current = false; setFrozen(false); video.pause(); video.removeAttribute("src"); video.load(); setVideoShown(false); };
  }, [active, asset.id, playbackRequested, playbackSrc, privacyMode]);
  useEffect(() => {
    // Once startup is requested, hold the current still instead of cycling unrelated frames.
    if (playbackRequested) return;
    if (!active || privacyMode || videoShown || previewRatio !== null || asset.media.scrubFrameCount <= 1) {
      setHoverFrame(null);
      return;
    }
    const frameCount = asset.media.scrubFrameCount;
    const frames = [0.14, 0.38, 0.62, 0.86].map((ratio) => Math.min(frameCount - 1, Math.round(ratio * (frameCount - 1))));
    let index = 0;
    setHoverFrame(frames[index]);
    frameTimer.current = window.setInterval(() => {
      index = (index + 1) % frames.length;
      setHoverFrame(frames[index]);
    }, 720);
    return () => {
      if (frameTimer.current !== null) window.clearInterval(frameTimer.current);
      frameTimer.current = null;
    };
  }, [active, asset.media.scrubFrameCount, privacyMode, videoShown, previewRatio, playbackRequested]);
  useEffect(() => () => { cancelFrame.current?.(); clearTimers(); cellWatch.current?.(); }, []);
  const leave = () => { cancelFrame.current?.(); pendingSeek.current = null; presented.current = false; frozenRef.current = false; setFrozen(false); cellWatch.current?.(); clearTimers(); scrubbingRef.current = false; setScrubbing(false); setPreviewRatio(null); setHoverFrame(null); setPlaybackRequested(false); setVideoShown(false); onReleaseActive(); };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  // The gallery cell's heart and other hover controls sit outside this tile: moving onto them must
  // not stop (and later restart) the preview, so the hover ends when the pointer leaves the cell.
  const leaveTile = (event: React.PointerEvent<HTMLDivElement>) => {
    const cell = event.currentTarget.closest<HTMLElement>("[data-asset-id]");
    // The native pointerout target: React reports a target outside its own tree as the window.
    const next = event.nativeEvent.relatedTarget;
    if (!cell || cell === event.currentTarget || !(next instanceof Node) || !cell.contains(next)) { leave(); return; }
    cellWatch.current?.();
    const onCellLeave = () => leaveRef.current();
    cell.addEventListener("pointerleave", onCellLeave, { once: true });
    cellWatch.current = () => { cell.removeEventListener("pointerleave", onCellLeave); cellWatch.current = null; };
  };
  const enterTile = () => {
    if (cellWatch.current) { cellWatch.current(); return; }
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => { setPlaybackRequested(true); onRequestActive(); }, 160);
  };
  const seekToRatio = (ratio: number, live: boolean) => {
    const clamped = Math.max(0, Math.min(1, ratio));
    // Revealing the image beneath a playing video would itself flash back to the old thumbnail.
    // Keep the visible video frame until either the scrub image decodes or the seek frame presents.
    const video = videoRef.current;
    const canvas = freezeRef.current;
    if (presented.current && !frozenRef.current && video && canvas && video.readyState >= 2 && video.videoWidth) {
      const context = canvas.getContext("2d");
      if (context) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        try {
          context.drawImage(video, 0, 0);
          frozenRef.current = true;
          setFrozen(true);
        } catch { /* The existing still remains available if capture is unsupported. */ }
      }
    }
    cancelFrame.current?.();
    presented.current = false;
    setVideoShown(false);
    setPreviewRatio(clamped);
    const target = clamped * asset.media.durationMs / 1_000;
    pendingSeek.current = target;
    if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => {
      const video = videoRef.current;
      if (!video) return;
      pendingSeek.current = null;
      cancelFrame.current = waitForVideoFrame(video, target, () => {
        presented.current = true;
        setVideoShown(true);
        if (!scrubbingRef.current) {
          frozenRef.current = false;
          setFrozen(false);
          setPreviewRatio(null);
        }
      });
      video.currentTime = target;
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
    setPlaybackRequested(true);
    onRequestActive();
    scrubTo(event.currentTarget, event.clientX, true);
  };
  const endScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    event.stopPropagation();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    scrubbingRef.current = false;
    setScrubbing(false);
    if (presented.current) {
      frozenRef.current = false;
      setFrozen(false);
      setPreviewRatio(null);
    }
  };
  const durationSeconds = videoDuration;
  // An unknown length (0) shows "—", not "0:00", until the video itself reports one.
  const shownDurationMs = asset.media.durationMs || Math.round(videoDuration * 1_000) || null;
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
    setPlaybackRequested(true);
    onRequestActive();
    seekToRatio(durationMs > 0 ? Math.max(0, Math.min(durationMs, nextMs)) / durationMs : 0, false);
  };
  if (asset.media.preparationState === "pending" || asset.media.preparationState === "processing") {
    return <PendingVideoTile />;
  }
  if (asset.media.preparationState === "failed") {
    return <div className="video-tile video-tile--failed"><span className="video-tile__status">미리보기 준비 실패</span><Button size="sm" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }} onClick={(event) => { event.stopPropagation(); onRetry(); }}>다시 시도</Button></div>;
  }
  if (privacyMode) {
    return <div className="video-tile video-tile--private"><Skeleton className="privacy-mask" label="비공개 모드" /></div>;
  }
  const alt = asset.title || asset.originalName;
  const previewFrame = previewRatio === null ? hoverFrame : Math.round(previewRatio * Math.max(0, asset.media.scrubFrameCount - 1));
  const stillUrl = previewFrame === null || asset.media.scrubFrameCount <= 0 ? (thumbnailSrc === null ? null : thumbnailSrc ?? assetThumbnailUrl(asset)) : scrubFrameUrl(asset.id, previewFrame, asset.thumbnailRevision);
  wantedStill.current = stillUrl;
  return <div className="video-tile" onPointerEnter={enterTile} onPointerLeave={leaveTile}>
    {/* 재생 프리뷰가 위에 깔리므로, 영상 첫 프레임이 뜨기 전까지는 scrub 미리보기 프레임을 img로 보여준다. */}
    {stillUrl && <StableImage src={stillUrl} alt={alt} style={{opacity: videoShown && !scrubbing ? 0 : undefined}} decoding="async" decodeFirst={false} draggable={false} onLoad={event => {
      const image = event.currentTarget;
      const loaded = image.getAttribute("src");
      const decoded = () => {
        if (!image.isConnected || wantedStill.current !== loaded) return;
        frozenRef.current = false;
        setFrozen(false);
      };
      if (typeof image.decode === "function") void image.decode().then(decoded, () => undefined);
      else decoded();
    }} />}
    {active && playbackRequested && <video
      ref={videoRef}
      src={playbackSrc ?? playbackUrl(asset.id)}
      muted
      loop
      playsInline
      data-shown={videoShown || undefined}
      draggable={false}
      preload="metadata"
      aria-label={`${alt} 미리보기`}
      onTimeUpdate={(event) => { if (!scrubbingRef.current) setPlayedRatio(Math.min(1, event.currentTarget.currentTime / Math.max(0.001, durationSeconds))); }}
      onSeeked={(event) => { if (!scrubbingRef.current) setPlayedRatio(Math.min(1, event.currentTarget.currentTime / Math.max(0.001, durationSeconds))); }}
      onDurationChange={(event) => { const d = event.currentTarget.duration; if (Number.isFinite(d) && d > 0) { setVideoDuration(d); onDurationKnown?.(Math.round(d * 1_000)); } }}
    />}
    <canvas ref={freezeRef} aria-hidden="true" style={{display: frozen ? undefined : "none", position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none"}} />
    {durationVisible && <Badge className="video-tile__duration" variant="scrim">{compactBadge ? `▶ ${formatDuration(shownDurationMs)}` : formatDuration(shownDurationMs)}</Badge>}{!compactBadge && <span className="video-tile__icon" aria-hidden="true">▶</span>}
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
        if (presented.current) {
          frozenRef.current = false;
          setFrozen(false);
          setPreviewRatio(null);
        }
      }}
    >
      <span className="video-tile__scrub-fill" style={{ width: `${scrubRatio * 100}%` }} aria-hidden="true" />
      <span className="video-tile__scrub-handle" style={{ left: `${scrubRatio * 100}%` }} aria-hidden="true" />
    </div>
  </div>;
}

function PendingVideoTile() {
  const { restricted, ready } = useWorkloadProfile();
  return <div className="video-tile video-tile--pending">
    <ClockIcon className="video-tile__status-icon" aria-hidden="true" />
    <span className="video-tile__status">{ready && restricted ? "절약 모드로 대기 중" : "준비 중"}</span>
  </div>;
}
