import {useAssetMask} from "../privacy/PrivacyContext";
import {Skeleton} from "../shared/ui/Skeleton";
import { ArrowsPointingOutIcon, ArrowsPointingInIcon, PauseIcon, PlayIcon, SpeakerWaveIcon, SpeakerXMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref, type VideoHTMLAttributes } from "react";
import { Button } from "../shared/ui/Button";

export type VideoPlayerAsset = {
  contentRating?: import("../shared/privacy/contentMask").ContentRating | null;
  id: string;
  title?: string | null;
  originalName: string;
  thumbnailRevision?: string | null;
  media: {durationMs: number; scrubFrameCount: number};
};
const CONTROLS_IDLE_MS = 1_800;
/** Seconds moved by one Left/Right arrow press. */
export const VIDEO_SEEK_STEP_SECONDS = 5;

/** Lets a host (the asset viewer) route arrow keys to the player while focus sits elsewhere. */
export type VideoPlayerHandle = { seekBy: (deltaSeconds: number) => void; togglePlayback: () => void; currentTimeMs: () => number };
/** Longest time the pre-seek frame may cover the video if `seeked` never fires. */
const SEEK_FREEZE_MAX_MS = 1_500;

export type PlaybackUrlResolver = (assetId: string) => Promise<string>;
export type ScrubFrameUrlBuilder = (assetId: string, frameIndex: number, revision?: string | null) => string;
export type VideoPlayerMediaEvents = Partial<Pick<VideoHTMLAttributes<HTMLVideoElement>,
  "onAbort" | "onCanPlay" | "onDurationChange" | "onEmptied" | "onEnded" | "onError" |
  "onLoadedMetadata" | "onLoadStart" | "onPause" | "onPlay" | "onPlaying" | "onSeeked" |
  "onStalled" | "onSuspend" | "onTimeUpdate" | "onVolumeChange" | "onWaiting"
>>;

export type VideoPlayerProps = {
  asset: VideoPlayerAsset;
  source?: "library" | "vault";
  resolvePlaybackUrl?: PlaybackUrlResolver;
  /** A host-owned URL. Passing `null` deliberately leaves the media waiting for its source. */
  sourceUrl?: string | null;
  scrubFrameUrlBuilder?: ScrubFrameUrlBuilder | null;
  poster?: string;
  autoPlay?: boolean;
  loop?: boolean;
  preload?: VideoHTMLAttributes<HTMLVideoElement>["preload"];
  controlsList?: string;
  disablePictureInPicture?: boolean;
  controlsVisible?: boolean;
  onControlsActivity?(): void;
  togglePlaybackOnMediaClick?: boolean;
  mediaRef?: Ref<HTMLVideoElement>;
  mediaEvents?: VideoPlayerMediaEvents;
  ref?: Ref<VideoPlayerHandle>;
};

type VideoPlayerSurfaceProps = Omit<VideoPlayerProps, "sourceUrl"> & {sourceUrl: string | null};

type TauriInternals = {
  convertFileSrc?: (path: string, protocol?: string) => string;
  invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

function tauriInternals(): TauriInternals | undefined {
  return (globalThis as typeof globalThis & {__TAURI_INTERNALS__?: TauriInternals}).__TAURI_INTERNALS__;
}

function desktopMediaOrigin(): string {
  const convert = tauriInternals()?.convertFileSrc;
  return (globalThis as typeof globalThis & {isTauri?: boolean}).isTauri && convert
    ? convert("", "lakomics").replace(/\/$/, "")
    : "http://lakomics.localhost";
}

const desktopPlaybackUrl = (assetId: string, vault: boolean) =>
  `${desktopMediaOrigin()}/${vault ? "vault-playback" : "playback"}/${encodeURIComponent(assetId)}`;
const desktopScrubFrameUrl: ScrubFrameUrlBuilder = (assetId, frameIndex, revision) => {
  const base = `${desktopMediaOrigin()}/scrub-frame/${encodeURIComponent(assetId)}/${frameIndex}`;
  return revision ? `${base}/v${encodeURIComponent(revision)}` : base;
};
const desktopInvoke = <T,>(command: string, args: Record<string, unknown>) => {
  const invoke = tauriInternals()?.invoke;
  return invoke ? Promise.resolve(invoke<T>(command, args)) : Promise.reject(new Error("Tauri IPC is unavailable"));
};
const resolveInternalPlaybackUrl: PlaybackUrlResolver = assetId => desktopInvoke("get_internal_playback_url", {assetId});
const resolveInternalVaultPlaybackUrl: PlaybackUrlResolver = itemId => desktopInvoke("get_internal_vault_playback_url", {itemId});
/**
 * `vault` plays an encrypted Private Vault item: no scrub frames, vault routes only.
 */
export function VideoPlayer(props: VideoPlayerProps) {
  const masked=useAssetMask({contentRating:props.asset.contentRating,kind:'video'});
  return masked?<Skeleton className="privacy-mask" label="이미지 숨김"/>:<UnmaskedVideoPlayer {...props}/>;
}
function UnmaskedVideoPlayer(props: VideoPlayerProps) {
  const vault = props.source === "vault";
  const hasExternalSource = Object.prototype.hasOwnProperty.call(props, "sourceUrl");
  return <VideoPlayerSurface
    {...props}
    sourceUrl={hasExternalSource ? props.sourceUrl ?? null : desktopPlaybackUrl(props.asset.id, vault)}
    resolvePlaybackUrl={props.resolvePlaybackUrl ?? (vault ? resolveInternalVaultPlaybackUrl : resolveInternalPlaybackUrl)}
    scrubFrameUrlBuilder={props.scrubFrameUrlBuilder === undefined ? desktopScrubFrameUrl : props.scrubFrameUrlBuilder}
  />;
}

/** Shared player surface. Hosts provide media/platform seams, so this export has no desktop dependency. */
export function VideoPlayerSurface(props: VideoPlayerSurfaceProps) {
  const {asset, source: mediaSource = "library", resolvePlaybackUrl, scrubFrameUrlBuilder: buildScrubFrameUrl = null, poster, autoPlay, loop, preload = "metadata", controlsList, disablePictureInPicture, controlsVisible: controlledControlsVisible, onControlsActivity, togglePlaybackOnMediaClick = true, mediaRef, mediaEvents, ref} = props;
  const vault = mediaSource === "vault";
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(asset.media.durationMs / 1_000);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [localControlsVisible, setLocalControlsVisible] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [volumeInteracting, setVolumeInteracting] = useState(false);
  const [controlsFocused, setControlsFocused] = useState(false);
  const [source, setSource] = useState<string | undefined>(() => props.sourceUrl ?? undefined);
  const idleTimerRef = useRef<number | null>(null);
  const freezeRef = useRef<HTMLCanvasElement>(null);
  const freezeTimerRef = useRef<number | null>(null);
  const [frozen, setFrozen] = useState(false);
  const frozenRef = useRef(false);
  const controlsVisible = controlledControlsVisible ?? localControlsVisible;

  const setVideoRef = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    if (typeof mediaRef === "function") mediaRef(element);
    else if (mediaRef) mediaRef.current = element;
  }, [mediaRef]);

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  }, []);
  const scheduleIdle = useCallback(() => {
    clearIdleTimer();
    if (controlledControlsVisible !== undefined) {
      onControlsActivity?.();
      return;
    }
    setLocalControlsVisible(true);
    if (!playing || scrubbing || volumeInteracting || controlsFocused) return;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      setLocalControlsVisible(false);
    }, CONTROLS_IDLE_MS);
  }, [clearIdleTimer, controlledControlsVisible, controlsFocused, onControlsActivity, playing, scrubbing, volumeInteracting]);

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    if (controlledControlsVisible !== undefined) {
      clearIdleTimer();
      return clearIdleTimer;
    }
    scheduleIdle();
    return clearIdleTimer;
  }, [clearIdleTimer, controlledControlsVisible, scheduleIdle]);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(asset.media.durationMs / 1_000);
    setHoverRatio(null);
    setLocalControlsVisible(true);
    setScrubbing(false);
    setVolumeInteracting(false);
    setControlsFocused(false);
    const video = videoRef.current;
    const fallback = props.sourceUrl ?? undefined;
    let active = true;
    const applySource = (next: string | undefined) => {
      if (!active) return;
      setSource(next);
      if (video) {
        if (next) video.src = next;
        else video.removeAttribute("src");
      }
    };
    // Linux WebKitGTK uses the lakomics: scheme, which does not stream ranged video well;
    // there the player uses the app's authenticated local HTTP playback URL instead.
    if (fallback?.startsWith("lakomics:")) {
      setSource(undefined);
      video?.removeAttribute("src");
      if (resolvePlaybackUrl) void resolvePlaybackUrl(asset.id).then(applySource).catch(() => undefined);
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
  }, [asset.id, asset.media.durationMs, props.sourceUrl, resolvePlaybackUrl]);

  const releaseFrame = useCallback(() => {
    if (freezeTimerRef.current !== null) window.clearTimeout(freezeTimerRef.current);
    freezeTimerRef.current = null;
    frozenRef.current = false;
    setFrozen(false);
  }, []);
  useEffect(() => releaseFrame, [releaseFrame]);
  /** Some engines (WebKitGTK) show black while a seek flushes; hold the current frame over it until `seeked`. */
  const holdFrame = () => {
    // While a frame is already held (a drag seeks many times), keep that good frame: a capture taken
    // mid-seek can be the engine's black flush frame, which made releasing the scrubber flicker.
    if (frozenRef.current) {
      if (freezeTimerRef.current !== null) window.clearTimeout(freezeTimerRef.current);
      freezeTimerRef.current = window.setTimeout(releaseFrame, SEEK_FREEZE_MAX_MS);
      return;
    }
    const video = videoRef.current;
    const canvas = freezeRef.current;
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth) return;
    const context = canvas.getContext?.("2d");
    if (!context) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    try { context.drawImage(video, 0, 0); } catch { return; }
    frozenRef.current = true;
    setFrozen(true);
    if (freezeTimerRef.current !== null) window.clearTimeout(freezeTimerRef.current);
    freezeTimerRef.current = window.setTimeout(releaseFrame, SEEK_FREEZE_MAX_MS);
  };
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
    if (next === from) return;
    holdFrame();
    video.currentTime = next;
    setCurrentTime(next);
    scheduleIdle();
  };
  useImperativeHandle(ref, () => ({ seekBy, togglePlayback, currentTimeMs: () => Math.max(0, Math.round((videoRef.current?.currentTime ?? 0) * 1000)) }));
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
      ref={setVideoRef}
      className="video-player__media"
      src={source}
      poster={poster}
      aria-label={`${title} 영상`}
      playsInline
      preload={preload}
      autoPlay={autoPlay}
      loop={loop}
      controlsList={controlsList}
      disablePictureInPicture={disablePictureInPicture}
      tabIndex={-1}
      onPointerDown={(event) => event.preventDefault()}
      onClick={togglePlaybackOnMediaClick ? togglePlayback : undefined}
      onLoadStart={mediaEvents?.onLoadStart}
      onWaiting={mediaEvents?.onWaiting}
      onStalled={mediaEvents?.onStalled}
      onPlaying={mediaEvents?.onPlaying}
      onCanPlay={mediaEvents?.onCanPlay}
      onSuspend={mediaEvents?.onSuspend}
      onAbort={mediaEvents?.onAbort}
      onEmptied={mediaEvents?.onEmptied}
      onError={mediaEvents?.onError}
      onLoadedMetadata={mediaEvents?.onLoadedMetadata}
      onPlay={(event) => { setPlaying(true); mediaEvents?.onPlay?.(event); }}
      onPause={(event) => { setPlaying(false); mediaEvents?.onPause?.(event); }}
      onEnded={(event) => {
        setPlaying(false);
        mediaEvents?.onEnded?.(event);
      }}
      // Release only after the last of several queued seeks has landed.
      onSeeked={(event) => { if (!event.currentTarget.seeking) releaseFrame(); mediaEvents?.onSeeked?.(event); }}
      onTimeUpdate={(event) => {
        setCurrentTime(event.currentTarget.currentTime);
        mediaEvents?.onTimeUpdate?.(event);
      }}
      onDurationChange={(event) => {
        setDuration(event.currentTarget.duration);
        mediaEvents?.onDurationChange?.(event);
      }}
      onVolumeChange={(event) => { setMuted(event.currentTarget.muted); setVolume(event.currentTarget.volume); mediaEvents?.onVolumeChange?.(event); }}
    />
    <canvas ref={freezeRef} className="video-player__freeze" aria-hidden="true" style={{display: frozen ? undefined : "none"}} />
    <div
      className="video-player__controls"
      aria-hidden={!controlsVisible}
      inert={!controlsVisible ? true : undefined}
      onPointerDown={event => { event.stopPropagation(); scheduleIdle(); }}
      onPointerMove={event => { event.stopPropagation(); scheduleIdle(); }}
      onPointerUp={event => { event.stopPropagation(); scheduleIdle(); }}
      onPointerCancel={event => { event.stopPropagation(); scheduleIdle(); }}
      onClick={event => event.stopPropagation()}
      onFocusCapture={() => { setControlsFocused(true); if (controlledControlsVisible === undefined) setLocalControlsVisible(true); else onControlsActivity?.(); clearIdleTimer(); }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setControlsFocused(false);
      }}
    >
      <div className="video-player__timeline-wrap">
        {timelineAvailable && hoverRatio !== null && !vault && buildScrubFrameUrl && <img className="video-player__scrub-preview" src={buildScrubFrameUrl(asset.id, hoverFrame, asset.thumbnailRevision)} alt={`${formatTime(hoverTime)} 미리보기`} style={{ left: `${hoverRatio * 100}%` }} />}
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
            if (videoRef.current) { holdFrame(); videoRef.current.currentTime = next; }
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
