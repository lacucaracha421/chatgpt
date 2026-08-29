import { ArrowsPointingOutIcon, ArrowsPointingInIcon, PauseIcon, PlayIcon, SpeakerWaveIcon, SpeakerXMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import type { AssetSummary } from "../library/types";
import { playbackUrl, scrubFrameUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";

type VideoAsset = AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> };

export function VideoPlayer({ asset }: { asset: VideoAsset }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(asset.media.durationMs / 1_000);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(asset.media.durationMs / 1_000);
    setHoverRatio(null);
    const video = videoRef.current;
    if (video) video.src = playbackUrl(asset.id);
    return () => {
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [asset.id, asset.media.durationMs]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };
  const title = asset.title || asset.originalName;
  const storedDuration = Number.isFinite(asset.media.durationMs) && asset.media.durationMs > 0
    ? asset.media.durationMs / 1_000
    : 0;
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : storedDuration;
  const timelineAvailable = safeDuration > 0;
  const hoverTime = hoverRatio === null || !timelineAvailable ? 0 : hoverRatio * safeDuration;
  const hoverFrame = timelineAvailable && hoverRatio !== null
    ? Math.round(hoverRatio * Math.max(0, asset.media.scrubFrameCount - 1))
    : 0;

  return <div
    ref={rootRef}
    className="video-player"
    data-testid="video-player"
    tabIndex={0}
    onKeyDown={(event) => {
      if ((event.key === " " || event.code === "Space") && !ownsKeyboard(event.target)) {
        event.preventDefault();
        togglePlayback();
      }
    }}
  >
    <video
      ref={videoRef}
      className="video-player__media"
      src={playbackUrl(asset.id)}
      aria-label={`${title} 영상`}
      playsInline
      preload="metadata"
      onClick={togglePlayback}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)}
      onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
      onDurationChange={(event) => setDuration(event.currentTarget.duration)}
      onVolumeChange={(event) => { setMuted(event.currentTarget.muted); setVolume(event.currentTarget.volume); }}
    />
    <div className="video-player__controls">
      <div className="video-player__timeline-wrap">
        {timelineAvailable && hoverRatio !== null && <img className="video-player__scrub-preview" src={scrubFrameUrl(asset.id, hoverFrame)} alt={`${formatTime(hoverTime)} 미리보기`} style={{ left: `${hoverRatio * 100}%` }} />}
        <input
          type="range"
          aria-label="재생 위치"
          min={0}
          max={safeDuration}
          step={0.01}
          disabled={!timelineAvailable}
          value={timelineAvailable ? Math.min(currentTime, safeDuration) : 0}
          onChange={(event) => {
            if (!timelineAvailable) return;
            const next = Number(event.currentTarget.value);
            if (videoRef.current) videoRef.current.currentTime = next;
            setCurrentTime(next);
          }}
          onPointerMove={(event) => {
            if (!timelineAvailable) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            setHoverRatio(Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))));
          }}
          onPointerLeave={() => setHoverRatio(null)}
        />
      </div>
      <div className="video-player__control-row">
        <Button size="icon" variant="ghost" aria-label={playing ? "일시 정지" : "재생"} onClick={togglePlayback}>{playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}</Button>
        <span className="video-player__time">{formatTime(currentTime)} / {formatTime(safeDuration)}</span>
        <Button size="icon" variant="ghost" aria-label={muted ? "음소거 해제" : "음소거"} onClick={() => { if (videoRef.current) { videoRef.current.muted = !videoRef.current.muted; setMuted(videoRef.current.muted); } }}>{muted ? <SpeakerXMarkIcon aria-hidden="true" /> : <SpeakerWaveIcon aria-hidden="true" />}</Button>
        <input type="range" className="video-player__volume" aria-label="음량" min={0} max={1} step={0.05} value={volume} onChange={(event) => { const next = Number(event.currentTarget.value); if (videoRef.current) { videoRef.current.volume = next; videoRef.current.muted = false; } setVolume(next); setMuted(false); }} />
        <Button size="icon" variant="ghost" aria-label={fullscreen ? "전체 화면 종료" : "전체 화면"} onClick={() => { if (fullscreen) void document.exitFullscreen?.(); else void rootRef.current?.requestFullscreen?.(); }}>{fullscreen ? <ArrowsPointingInIcon aria-hidden="true" /> : <ArrowsPointingOutIcon aria-hidden="true" />}</Button>
      </div>
    </div>
  </div>;
}

function ownsKeyboard(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("button,input,select,textarea,[contenteditable=true]"));
}

function formatTime(seconds: number) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor(whole % 3_600 / 60);
  const tail = `${minutes}:${String(whole % 60).padStart(2, "0")}`;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}` : tail;
}
