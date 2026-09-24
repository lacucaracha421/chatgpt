import { ArrowsPointingOutIcon, ArrowsPointingInIcon, PauseIcon, PlayIcon, SpeakerWaveIcon, SpeakerXMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AssetSummary } from "../library/types";
import { playbackUrl, scrubFrameUrl, vaultPlaybackUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";

type VideoAsset = AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> };
const CONTROLS_IDLE_MS = 1_800;
/** Seconds moved by one Left/Right arrow press. */
export const VIDEO_SEEK_STEP_SECONDS = 5;

/** Lets a host (the asset viewer) route arrow keys to the player while focus sits elsewhere. */
export type VideoPlayerHandle = { seekBy: (deltaSeconds: number) => void };

type PlaybackUrlResolver = (assetId: string) => Promise<string>;

const resolveInternalPlaybackUrl: PlaybackUrlResolver = (assetId) =>
  invoke<string>("get_internal_playback_url", { assetId });
const resolveInternalVaultPlaybackUrl: PlaybackUrlResolver = (itemId) =>
  invoke<string>("get_internal_vault_playback_url", { itemId });

/** `vault` plays an encrypted Private Vault item: no scrub frames, vault routes only. */
export function VideoPlayer({ asset, source: mediaSource = "library", resolvePlaybackUrl, ref }: { asset: VideoAsset; source?: "library" | "vault"; resolvePlaybackUrl?: PlaybackUrlResolver; ref?: Ref<VideoPlayerHandle> }) {
  const vault = mediaSource === "vault";
  const protocolUrl = vault ? vaultPlaybackUrl : playbackUrl;
  const resolveHttpUrl = resolvePlaybackUrl ?? (vault ? resolveInternalVaultPlaybackUrl : resolveInternalPlaybackUrl);
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(asset.media.durationMs / 1_000);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [volumeInteracting, setVolumeInteracting] = useState(false);
  const [controlsFocused, setControlsFocused] = useState(false);
  const [source, setSource] = useState<string | undefined>(() => protocolUrl(asset.id));
  const idleTimerRef = useRef<number | null>(null);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  }, []);
  const scheduleIdle = useCallback(() => {
    clearIdleTimer();
    setControlsVisible(true);
    if (!playing || scrubbing || volumeInteracting || controlsFocused) return;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      setControlsVisible(false);
    }, CONTROLS_IDLE_MS);
  }, [clearIdleTimer, controlsFocused, playing, scrubbing, volumeInteracting]);

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    scheduleIdle();
    return clearIdleTimer;
  }, [clearIdleTimer, scheduleIdle]);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(asset.media.durationMs / 1_000);
    setHoverRatio(null);
    setControlsVisible(true);
    setScrubbing(false);
    setVolumeInteracting(false);
    setControlsFocused(false);
    const video = videoRef.current;
    const fallback = protocolUrl(asset.id);
    let active = true;
    const applySource = (next: string) => {
      if (!active) return;
      setSource(next);
      if (video) video.src = next;
    };
    // Linux WebKitGTK uses the lakomics: scheme, which does not stream ranged video well;
    // there the player uses the app's authenticated local HTTP playback URL instead.
    if (fallback.startsWith("lakomics:")) {
      setSource(undefined);
      video?.removeAttribute("src");
      void resolveHttpUrl(asset.id).then(applySource).catch(() => undefined);
    } else {
      applySource(fallback);
    }
    return () => {
      active = false;
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [asset.id, asset.media.durationMs, protocolUrl, resolveHttpUrl]);

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
  const seekBy = (deltaSeconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : safeDuration;
    const from = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const next = Math.max(0, limit > 0 ? Math.min(limit, from + deltaSeconds) : from + deltaSeconds);
    video.currentTime = next;
    setCurrentTime(next);
    scheduleIdle();
  };
  useImperativeHandle(ref, () => ({ seekBy }));
  const hoverTime = hoverRatio === null || !timelineAvailable ? 0 : hoverRatio * safeDuration;
  const hoverFrame = timelineAvailable && hoverRatio !== null
    ? Math.round(hoverRatio * Math.max(0, asset.media.scrubFrameCount - 1))
    : 0;

  return <div
    ref={rootRef}
    className={`video-player${controlsVisible ? "" : " video-player--controls-hidden"}`}
    data-testid="video-player"
    data-controls-visible={controlsVisible}
    tabIndex={0}
    onPointerMove={scheduleIdle}
    onKeyDown={(event) => {
      scheduleIdle();
      if ((event.key === " " || event.code === "Space") && !ownsKeyboard(event.target)) {
        event.preventDefault();
        togglePlayback();
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.altKey && !event.ctrlKey && !event.metaKey) {
        // Arrows belong to the player here: never let a host viewer also treat them as previous/next.
        event.stopPropagation();
        if (consumesArrows(event.target)) return;
        event.preventDefault();
        seekBy(event.key === "ArrowLeft" ? -VIDEO_SEEK_STEP_SECONDS : VIDEO_SEEK_STEP_SECONDS);
      }
    }}
  >
    <video
      ref={videoRef}
      className="video-player__media"
      src={source}
      aria-label={`${title} 영상`}
      playsInline
      preload="metadata"
      tabIndex={-1}
      onPointerDown={(event) => event.preventDefault()}
      onClick={togglePlayback}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)}
      onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
      onDurationChange={(event) => setDuration(event.currentTarget.duration)}
      onVolumeChange={(event) => { setMuted(event.currentTarget.muted); setVolume(event.currentTarget.volume); }}
    />
    <div
      className="video-player__controls"
      aria-hidden={!controlsVisible}
      inert={!controlsVisible ? true : undefined}
      onFocusCapture={() => { setControlsFocused(true); setControlsVisible(true); clearIdleTimer(); }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setControlsFocused(false);
      }}
    >
      <div className="video-player__timeline-wrap">
        {timelineAvailable && hoverRatio !== null && !vault && <img className="video-player__scrub-preview" src={scrubFrameUrl(asset.id, hoverFrame)} alt={`${formatTime(hoverTime)} 미리보기`} style={{ left: `${hoverRatio * 100}%` }} />}
        <input
          type="range"
          className="video-player__timeline"
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
            scheduleIdle();
          }}
          onPointerDown={() => setScrubbing(true)}
          onPointerUp={() => setScrubbing(false)}
          onPointerCancel={() => setScrubbing(false)}
          onPointerMove={(event) => {
            if (!timelineAvailable) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            setHoverRatio(Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))));
          }}
          onPointerLeave={() => setHoverRatio(null)}
        />
      </div>
      <div className="video-player__control-row">
        <Button size="icon" variant="ghost" aria-label={playing ? "일시 정지" : "재생"} aria-description={playing ? "일시 정지" : "재생"} onClick={togglePlayback}>{playing ? <PauseIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}</Button>
        <span className="video-player__time">{formatTime(currentTime)} / {formatTime(safeDuration)}</span>
        <Button size="icon" variant="ghost" aria-label={muted ? "음소거 해제" : "음소거"} aria-description={muted ? "음소거 해제" : "음소거"} onClick={() => { if (videoRef.current) { videoRef.current.muted = !videoRef.current.muted; setMuted(videoRef.current.muted); } }}>{muted ? <SpeakerXMarkIcon aria-hidden="true" /> : <SpeakerWaveIcon aria-hidden="true" />}</Button>
        <input type="range" className="video-player__volume" aria-label="음량" min={0} max={1} step={0.05} value={volume} onPointerDown={() => setVolumeInteracting(true)} onPointerUp={() => setVolumeInteracting(false)} onPointerCancel={() => setVolumeInteracting(false)} onChange={(event) => { const next = Number(event.currentTarget.value); if (videoRef.current) { videoRef.current.volume = next; videoRef.current.muted = false; } setVolume(next); setMuted(false); scheduleIdle(); }} />
        <Button size="icon" variant="ghost" aria-label={fullscreen ? "전체 화면 종료" : "전체 화면"} aria-description={fullscreen ? "전체 화면 종료" : "전체 화면"} onClick={() => { if (fullscreen) void document.exitFullscreen?.(); else void rootRef.current?.requestFullscreen?.(); }}>{fullscreen ? <ArrowsPointingInIcon aria-hidden="true" /> : <ArrowsPointingOutIcon aria-hidden="true" />}</Button>
      </div>
    </div>
  </div>;
}

function ownsKeyboard(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("button,input,select,textarea,[contenteditable=true]"));
}

/** Native sliders and text fields move their own value with arrows. */
function consumesArrows(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("input,select,textarea,[contenteditable=true]"));
}

function formatTime(seconds: number) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor(whole % 3_600 / 60);
  const tail = `${minutes}:${String(whole % 60).padStart(2, "0")}`;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}` : tail;
}
