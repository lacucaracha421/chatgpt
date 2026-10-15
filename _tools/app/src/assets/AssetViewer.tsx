import { useAssetMasks, usePrivacy } from "../privacy/PrivacyContext";
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderArrowDownIcon,
  InformationCircleIcon,
  LanguageIcon,
  RectangleStackIcon,
  HeartIcon,
  TrashIcon,
  UserIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { HeartIcon as HeartSolidIcon } from "@heroicons/react/24/solid";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { CenteredFilmstrip, filmstripControlsOffset } from "../shared/viewer/CenteredFilmstrip";
import { useViewerMotion, type TileRect } from "../shared/viewer/useViewerMotion";
import { ImageTextNotes, type ImageTextNotesHandle } from "../shared/viewer/ImageTextNotes";
import { ImageTextContext } from "../shared/viewer/ImageTextContext";
import { useDisplayedImage } from "../shared/viewer/useDisplayedImage";
import { NO_VIEWER_ZONES, sameViewerZones, viewerZonesAt, viewerZonesShown, type ViewerZoneSet } from "../shared/viewer/viewerZones";
import { useImageText } from "../shared/viewer/useImageText";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { artistHandle } from "../artists/format";
import { useAssetArtist } from "../artists/artistStore";
import type { ArtistSummary } from "../artists/types";
import { useOptionalLibrary } from "../library/LibraryContext";
import type { AlbumEntry, AssetSummary, ClassificationEntry } from "../library/types";
import { breadcrumbPath } from "../shared/breadcrumb";
import { displayDate, displayTime } from "../shared/displayDate";
import { Button } from "../shared/ui/Button";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { IconButton } from "../shared/ui/IconButton";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Menu } from "../shared/ui/Menu";
import { Skeleton } from "../shared/ui/Skeleton";
import { StableImage } from "../shared/ui/StableImage";
import { popToggle } from "../shared/motion/togglePop";
import { pcViewerClosed, pcViewerOpened } from "../shared/pcPerfLog";
import { VIDEO_SEEK_STEP_SECONDS, VideoPlayer, type VideoPlayerHandle } from "../video/VideoPlayer";
import { assetThumbnailUrl, assetUrl, vaultAssetUrl, vaultThumbnailUrl } from "./mediaUrl";

/** An overlay (top bar, arrows, film strip) fades out after this much pointer idle time inside its zone. */
export const VIEWER_CHROME_IDLE_MS = 1_200;
export const VIEWER_MAX_ZOOM = 8;
const WHEEL_STEP_DELTA = 40;
const WHEEL_STEP_COOLDOWN_MS = 180;

type AssetViewerProps = {
  originRect?: TileRect;
  items: AssetSummary[];
  activeId: string | null;
  onActiveIdChange: (id: string) => void;
  onClose: () => void;
  onAssetOpened?: (asset: AssetSummary) => void | Promise<void>;
  onToggleFavorite?: (asset: AssetSummary) => void;
  onTrash?: (asset: AssetSummary) => void;
  /** Saves a copy of the asset to a chosen PC folder (Private Vault). */
  onExport?: (asset: AssetSummary) => void;
  privacyMode?: boolean;
  /** `vault`: encrypted Private Vault item routes. */
  mediaSource?: "library" | "vault";
  totalCount?: number | null;
  classifications?: ClassificationEntry[];
  albums?: AlbumEntry[];
  onAddToAlbum?: (asset: AssetSummary, albumId: string) => void;
  folders?: ClassificationEntry[];
  onMoveToFolder?: (asset: AssetSummary, folderId: string) => void;
  renderCharacterPicker?: (asset: AssetSummary, close: () => void) => ReactNode;
  renderInfo?: (asset: AssetSummary) => ReactNode;
  /** Context actions of the place the viewer was opened from (a character's 이 캐릭터에서 빼기). */
  renderExtraActions?: (asset: AssetSummary) => ReactNode;
  /** "이 프레임을 썸네일로": makes the video frame at `timeMs` the asset's thumbnail. */
  onSetVideoThumbnail?: (asset: AssetSummary, timeMs: number) => void;
  /** The playing video reported its length. */
  onVideoDurationKnown?: (asset: AssetSummary, durationMs: number) => void;
  onNearEnd?: () => void;
};

/** Right-click actions on the viewer's video: only rendered when there is one to offer. */
function ViewerMediaContextMenu({ enabled, onSetThumbnail, children }: { enabled: boolean; onSetThumbnail: () => void; children: ReactElement }) {
  return enabled ? <ContextMenu items={[{ id: "frame-thumbnail", label: "이 프레임을 썸네일로", onSelect: onSetThumbnail }]}>{children}</ContextMenu> : children;
}

/** Folders an asset may be moved to from the viewer: everything except the 오리지널 root. */
export function movableViewerFolders(classifications: ClassificationEntry[]): ClassificationEntry[] {
  return classifications.filter(entry => !(entry.parentId === null && (entry.id === "lakomics-originals" || entry.name === "오리지널")));
}

export function AssetViewer({
  items,
  originRect,
  activeId,
  onActiveIdChange,
  onClose,
  onAssetOpened,
  onToggleFavorite,
  onTrash,
  onExport,
  privacyMode: requestedPrivacy = false,
  mediaSource = "library",
  totalCount,
  classifications,
  albums,
  onAddToAlbum,
  folders,
  onMoveToFolder,
  renderCharacterPicker,
  renderInfo,
  renderExtraActions,
  onSetVideoThumbnail,
  onVideoDurationKnown,
  onNearEnd,
}: AssetViewerProps) {
  const library = useOptionalLibrary();
  const index = items.findIndex((item) => item.id === activeId);
  const asset = items[index];
  const artist = useAssetArtist(mediaSource === "library" ? asset : null);
  const masked = useAssetMasks();
  const {nsfwFilter}=usePrivacy();
  const privacyMode = masked(asset, requestedPrivacy);
  const motion = useViewerMotion(activeId, onClose, originRect, asset?.width && asset?.height ? asset.width / asset.height : 1, !privacyMode && activeId ? (mediaSource === "vault" ? vaultAssetUrl(activeId) : assetUrl(activeId)) : undefined, activeId, privacyMode);
  const [stripGrown, setStripGrown] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const stripActive = useRef(false);
  const stripGrowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [replacementFailed, setReplacementFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [characterOpen, setCharacterOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [textSelection, setTextSelection] = useState<{ assetId: string; index: number } | null>(null);
  const [textPanning, setTextPanning] = useState(false);
  const textPanTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openedAssetIds = useRef(new Set<string>());
  const nearEndLengthRef = useRef<number | null>(null);
  const wheelRef = useRef({ accumulated: 0, lastStepAt: 0 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const detachWheelRef = useRef<(() => void) | null>(null);
  // A native, non-passive listener so Ctrl+wheel can stop the WebView's own page zoom. Attached when the
  // stage mounts (the dialog content mounts after this component's effects run).
  const attachStage = useCallback((stage: HTMLDivElement | null) => {
    detachWheelRef.current?.();
    detachWheelRef.current = null;
    stageRef.current = stage;
    setStageElement(stage);
    if (!stage) return;
    const listener = (event: globalThis.WheelEvent) => wheelHandlerRef.current(event);
    stage.addEventListener("wheel", listener, { passive: false });
    detachWheelRef.current = () => stage.removeEventListener("wheel", listener);
  }, []);
  const wheelHandlerRef = useRef<(event: globalThis.WheelEvent) => void>(() => undefined);
  const notesRef = useRef<ImageTextNotesHandle>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // Ctrl+wheel zoom for images: scale around the pointer, drag to pan while zoomed; resets per asset.
  const [textGesture, setTextGesture] = useState(false);
  const textGestureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(textGestureTimer.current), []);
  const holdTextLayout = () => { setTextGesture(true); clearTimeout(textGestureTimer.current); textGestureTimer.current = setTimeout(() => setTextGesture(false), 140); };
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const videoPlayerRef = useRef<VideoPlayerHandle>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const favoriteButtonRef = useRef<HTMLButtonElement>(null);
  const chromeTimerRef = useRef<number | null>(null);
  // Overlays show only while the pointer is in their own zone (`viewerZones.ts`), or while held: pointer on the
  // overlay, keyboard focus in it, an open menu or character panel (top bar), an active strip drag.
  const pointerZonesRef = useRef<ViewerZoneSet>(NO_VIEWER_ZONES);
  const pointerOverRef = useRef({ top: false, left: false, right: false });
  const characterOpenRef = useRef(false);
  characterOpenRef.current = characterOpen;
  const keyboardFocusRef = useRef(false);
  const [zones, setZones] = useState<ViewerZoneSet>(NO_VIEWER_ZONES);
  const viewerOpen = Boolean(asset);
  const total = totalCount != null && Number.isFinite(totalCount) && totalCount >= items.length ? totalCount : items.length;
  const showFilmstrip = Boolean(asset && items.length > 1);
  const textEligible = Boolean(asset?.media.kind === "image" && !privacyMode && mediaSource === "library" && !imageFailed);
  const displayed = useDisplayedImage(stageElement);
  const displayedAsset = items.find(item => assetUrl(item.id) === displayed?.src);
  const { entries: textEntries, pending: textPending } = useImageText(textEligible ? asset.id : null, library?.gateway);
  const textEntry = displayedAsset ? textEntries[displayedAsset.id] : undefined;
  const textBusy = textEligible && Boolean(textEntry?.busy || (displayedAsset?.id === asset.id && textPending));
  const textBusyVisible = useDelayedBusy(textBusy, { delay: 400 });
  const lines = textEligible ? textEntry?.text?.lines ?? [] : [];
  const hasText = lines.length > 0;
  const textCurrent = Boolean(asset && displayedAsset?.id === asset.id);
  const selectedLine = textSelection && textSelection.assetId === asset?.id && textCurrent ? textSelection.index : null;
  const selectText = (line: number) => {
    if (!textCurrent || !asset) return;
    setTextSelection(current => current?.assetId === asset.id && current.index === line ? null : { assetId: asset.id, index: line });
  };
  const selectTextRow = (line: number) => {
    selectText(line);
    if (!textCurrent || !displayed || zoom.scale <= 1 || !stageRef.current || selectedLine === line) return;
    const box = lines[line]?.box;
    const marker = box ? { x: box.x0 / 1000 * displayed.rect.width, y: box.y0 / 1000 * displayed.rect.height } : null;
    if (!marker) return;
    const stage = stageRef.current;
    const x = stage.clientWidth / 2 + zoom.x + (marker.x - displayed.rect.width / 2) * zoom.scale;
    const y = stage.clientHeight / 2 + zoom.y + (marker.y - displayed.rect.height / 2) * zoom.scale;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    // Keep the badge clear of the top bar and the visible filmstrip.
    const dx = clamp(x, 14, stage.clientWidth - 14) - x;
    const dy = clamp(y, 70, stage.clientHeight - (showFilmstrip ? 154 : 14)) - y;
    if (!dx && !dy) return;
    setTextPanning(true);
    setZoom(current => ({ ...current, x: current.x + dx, y: current.y + dy }));
    clearTimeout(textPanTimer.current);
    textPanTimer.current = setTimeout(() => setTextPanning(false), 200);
  };
  const toggleText = () => setTextOpen(open => !open);

  /** Recomputes which overlays are shown; returns whether an open menu or panel holds the top bar (nothing announces when that ends, so the idle clock re-checks). */
  const refreshZones = useCallback(() => {
    const root = chromeRef.current;
    const focusIn = (selector: string) => keyboardFocusRef.current && Boolean(root?.querySelector(selector)?.contains(document.activeElement));
    const menuOpen = characterOpenRef.current || Boolean(root?.querySelector('.asset-viewer__topbar .ui-menu__trigger[data-state="open"]'));
    const next = viewerZonesShown(pointerZonesRef.current, {
      top: pointerOverRef.current.top || menuOpen || focusIn(".asset-viewer__topbar"),
      left: pointerOverRef.current.left || focusIn(".asset-viewer__edge--left"),
      right: pointerOverRef.current.right || focusIn(".asset-viewer__edge--right"),
      bottom: stripActive.current || focusIn(".asset-viewer__filmstrip"),
    });
    setZones((current) => sameViewerZones(current, next) ? current : next);
    return menuOpen;
  }, []);

  /** Starts the idle clock: when it runs out the pointer no longer counts as being in a zone. */
  const armIdle = useCallback(() => {
    if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = window.setTimeout(() => {
      chromeTimerRef.current = null;
      pointerZonesRef.current = NO_VIEWER_ZONES;
      if (refreshZones()) armIdle();
    }, VIEWER_CHROME_IDLE_MS);
  }, [refreshZones]);

  /** Keeps the overlays the pointer or keyboard is using alive for another idle period. */
  const revealChrome = useCallback(() => { refreshZones(); armIdle(); }, [armIdle, refreshZones]);

  useEffect(() => () => clearTimeout(stripGrowTimer.current), []);
  useEffect(() => () => clearTimeout(textPanTimer.current), []);
  // Opt-in PC timing log: open intent to first picture and to the decoded full image. No-ops when off.
  useLayoutEffect(() => {
    if (!viewerOpen) return;
    pcViewerOpened();
    return pcViewerClosed;
  }, [viewerOpen]);

  useEffect(() => {
    if (!viewerOpen) {
      setTextOpen(false);
      setInfoOpen(false);
      setCharacterOpen(false);
      openedAssetIds.current.clear();
      nearEndLengthRef.current = null;
      return;
    }
    return () => {
      if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current);
      chromeTimerRef.current = null;
      pointerZonesRef.current = NO_VIEWER_ZONES;
    };
  }, [viewerOpen]);

  useEffect(() => {
    setTextSelection(null);
    setTextPanning(false);
    clearTimeout(textPanTimer.current);
    setImageFailed(false);
    setReplacementFailed(false);
    setVideoPlaying(false);
    setCharacterOpen(false);
    setZoom(current => current.scale === 1 && current.x === 0 && current.y === 0 ? current : { scale: 1, x: 0, y: 0 });
  }, [asset?.id]);


  useEffect(() => {
    if (!asset || index < 0 || !onNearEnd || index < items.length - 5 || nearEndLengthRef.current === items.length) return;
    nearEndLengthRef.current = items.length;
    onNearEnd();
  }, [asset, index, items.length, onNearEnd]);

  useEffect(() => {
    if (!asset) {
      setFolderPath("");
      return;
    }
    setFolderPath("");
    if (classifications === undefined) return;
    const getAssetClassifications = library?.gateway?.getAssetClassifications;
    if (typeof getAssetClassifications !== "function") return;
    let active = true;
    void getAssetClassifications(asset.id).then((ids) => {
      if (!active) return;
      const first = ids.map((id) => classifications.find((entry) => entry.id === id)).find((entry): entry is ClassificationEntry => Boolean(entry));
      setFolderPath(first ? breadcrumbPath(first, classifications) : "");
    }, () => {
      if (active) setFolderPath("");
    });
    return () => { active = false; };
  }, [asset?.id, classifications, library?.gateway]);

  useEffect(() => {
    if (!asset) {
      openedAssetIds.current.clear();
      return;
    }
    if (openedAssetIds.current.has(asset.id)) return;
    openedAssetIds.current.add(asset.id);
    try {
      void Promise.resolve(onAssetOpened?.(asset)).catch(() => undefined);
    } catch {
      // Activity telemetry must never disrupt the viewer.
    }
  }, [asset, onAssetOpened]);

  if (!asset) return null;

  const previous = items[index - 1];
  const next = items[index + 1];
  const move = (target: AssetSummary | undefined) => { if (target) onActiveIdChange(target.id); };
  const seekable = asset.media.kind === "video" && !privacyMode;
  const filmstripVisible = showFilmstrip && !videoPlaying && (zones.bottom || seekable);
  const artistLabel = getArtistLabel(asset, artist);
  const dateLabel = [displayDate(asset.collectedAt), displayTime(asset.collectedAt)].filter(Boolean).join(" ");
  const metaLabel = [folderPath, dateLabel].filter(Boolean).join(" · ");
  const handleDialogClose = () => {
    if (notesRef.current?.dismissCard()) return;
    if (infoOpen) { setInfoOpen(false); return; }
    motion.close();
  };
  const overlayHover = (zone: "top" | "left" | "right") => ({
    onPointerEnter: () => { pointerOverRef.current[zone] = true; refreshZones(); },
    onPointerLeave: () => { pointerOverRef.current[zone] = false; revealChrome(); },
  });
  const albumItems = albums?.map((album) => ({ id: album.id, label: album.name, onSelect: () => onAddToAlbum?.(asset, album.id) })) ?? [];
  const folderItems = folders?.map((folder) => ({ id: folder.id, label: breadcrumbPath(folder, folders), onSelect: () => onMoveToFolder?.(asset, folder.id) })) ?? [];
  const closeCharacterPicker = () => setCharacterOpen(false);
  // Mouse wheel pages through the assets: down = next, up = previous. A notched wheel steps once per
  // notch; a trackpad's small deltas accumulate, and a short cooldown keeps one flick to one step.
  const zoomable = asset.media.kind === "image" && !privacyMode && !imageFailed;
  wheelHandlerRef.current = (event) => {
    if (event.target instanceof HTMLElement && event.target.closest(".asset-viewer__character-popover, .ui-menu")) return;
    if (event.ctrlKey) {
      event.preventDefault();
      if (!zoomable || !stageRef.current) return;
      const bounds = stageRef.current.getBoundingClientRect();
      const px = event.clientX - (bounds.left + bounds.width / 2);
      const py = event.clientY - (bounds.top + bounds.height / 2);
      holdTextLayout();
      setZoom((current) => {
        const scale = Math.min(VIEWER_MAX_ZOOM, Math.max(1, current.scale * Math.exp(-event.deltaY * 0.002)));
        if (scale === 1) return { scale: 1, x: 0, y: 0 };
        const ratio = scale / current.scale;
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
      });
      return;
    }
    handleWheel(event);
  };
  const handleWheel = (event: globalThis.WheelEvent) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const state = wheelRef.current;
    const now = performance.now();
    if (Math.sign(event.deltaY) !== Math.sign(state.accumulated)) state.accumulated = 0;
    state.accumulated += event.deltaY;
    if (Math.abs(state.accumulated) < WHEEL_STEP_DELTA || now - state.lastStepAt < WHEEL_STEP_COOLDOWN_MS) return;
    const forward = state.accumulated > 0;
    state.accumulated = 0;
    state.lastStepAt = now;
    move(forward ? next : previous);
  };

  return <Dialog
    open
    variant="fullscreen"
    title={asset.title || asset.originalName}
    onClose={handleDialogClose}
    onKeyUp={(event) => {
      // Buttons activate on Space keyup; the keydown above already handled it.
      if (seekable && isSpace(event) && !typesText(event.target)) event.preventDefault();
    }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && notesRef.current?.dismissCard()) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === "Escape" && infoOpen) {
        event.preventDefault();
        event.stopPropagation();
        setInfoOpen(false);
        return;
      }
      // Typing in a field inside the viewer (the character picker search) must not trigger viewer shortcuts.
      if (typesText(event.target)) return;
      if (event.key.toLowerCase() === "t" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && !event.defaultPrevented && hasText && textCurrent) {
        event.preventDefault(); toggleText(); revealChrome(); return;
      }
      const arrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
      // A video owns Left/Right for seeking; previous/next stays on the on-screen arrows.
      if (arrow && seekable && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        videoPlayerRef.current?.seekBy(event.key === "ArrowLeft" ? -VIDEO_SEEK_STEP_SECONDS : VIDEO_SEEK_STEP_SECONDS);
        return;
      }
      // Space plays/pauses a video; it must never activate a focused viewer button such as "next".
      if (seekable && isSpace(event) && !event.defaultPrevented && !typesText(event.target)) {
        event.preventDefault();
        videoPlayerRef.current?.togglePlayback();
        return;
      }
      if (event.key === "Tab") keyboardFocusRef.current = true;
      revealChrome();
      if (event.key === "ArrowLeft") { event.preventDefault(); move(previous); }
      if (event.key === "ArrowRight") { event.preventDefault(); move(next); }
      if ((event.ctrlKey || event.metaKey) && event.key === "0") { event.preventDefault(); setZoom({ scale: 1, x: 0, y: 0 }); return; }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); if (onToggleFavorite) { if (favoriteButtonRef.current) popToggle(favoriteButtonRef.current, !asset.favorite); onToggleFavorite(asset); } }
      if (event.key.toLowerCase() === "i" && renderInfo) { event.preventDefault(); setInfoOpen((open) => !open); }
      if (event.key === "Delete") { event.preventDefault(); onTrash?.(asset); }
    }}
  >
    <div
      ref={motion.bind}
      className={`asset-viewer${infoOpen ? " asset-viewer--docked" : ""}${videoPlaying ? " asset-viewer--playing" : ""}`}
      data-top-visible={zones.top}
      data-left-visible={zones.left}
      data-right-visible={zones.right}
      data-filmstrip-visible={filmstripVisible}
      style={{"--viewer-controls-offset": `${filmstripControlsOffset(124, stripGrown, filmstripVisible)}px`} as CSSProperties}
      onPointerMove={(event) => {
        const rect = stageRef.current?.getBoundingClientRect();
        const at = rect ? viewerZonesAt(event.clientX, event.clientY, rect) : NO_VIEWER_ZONES;
        pointerZonesRef.current = at;
        keyboardFocusRef.current = false; revealChrome();
        if (stripActive.current) return;
        if (at.bottom) { clearTimeout(stripGrowTimer.current); stripGrowTimer.current = undefined; setStripGrown(true); }
        else if (!stripGrowTimer.current) stripGrowTimer.current = setTimeout(() => { stripGrowTimer.current = undefined; setStripGrown(false); }, 220);
      }}
      onPointerDown={() => { keyboardFocusRef.current = false; }}
      onPointerLeave={() => { pointerZonesRef.current = NO_VIEWER_ZONES; refreshZones(); }}
    >
      <div data-viewer-backdrop className="asset-viewer__backdrop" />
      <div className={`asset-viewer__stage${showFilmstrip ? " asset-viewer__stage--filmstrip" : ""}${seekable ? " asset-viewer__stage--video" : ""}`} ref={attachStage}
        onPointerDown={(event) => {
          if (zoom.scale === 1 || event.button !== 0 || (event.target instanceof HTMLElement && event.target.closest("button, a, input, .ui-menu, .asset-viewer__character-popover"))) return;
          setTextGesture(true);
          panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const pan = panRef.current;
          if (!pan || pan.pointerId !== event.pointerId) return;
          const dx = event.clientX - pan.x; const dy = event.clientY - pan.y;
          panRef.current = { pointerId: pan.pointerId, x: event.clientX, y: event.clientY };
          setZoom((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
        }}
        onPointerUp={() => { panRef.current = null; setTextGesture(false); }}
        onPointerCancel={() => { panRef.current = null; setTextGesture(false); }}
        data-zoomed={zoom.scale > 1 ? "true" : undefined}>
        <div ref={chromeRef} className="asset-viewer__chrome" onFocusCapture={revealChrome} onBlurCapture={revealChrome}>
          <div className="asset-viewer__topbar" {...overlayHover("top")}>
            <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="뒤로" onClick={motion.close}><ArrowLeftIcon aria-hidden="true" /></Button>
            <span className="asset-viewer__position"><b>{index + 1}</b> / {total.toLocaleString("ko-KR")}</span>
            <span className="asset-viewer__title">
              <strong>{artistLabel}</strong>
              {metaLabel && <small>{metaLabel}</small>}
            </span>
            <span className="asset-viewer__spacer" />
            {hasText && textCurrent && <Button className={`asset-viewer__vbtn asset-viewer__vbtn--text${textOpen ? " asset-viewer__vbtn--on" : ""}`} variant="ghost" aria-label="번역" aria-pressed={textOpen} onClick={toggleText}><LanguageIcon aria-hidden="true" /><span>번역</span></Button>}
            {renderCharacterPicker && <span className="asset-viewer__action-anchor">
              <Button className="asset-viewer__vbtn asset-viewer__vbtn--text" variant="ghost" aria-label="캐릭터" aria-expanded={characterOpen} aria-haspopup="dialog" onClick={() => setCharacterOpen((open) => !open)}><UserIcon aria-hidden="true" /><span>캐릭터</span></Button>
              {characterOpen && <div className="asset-viewer__character-popover" onPointerDown={(event) => event.stopPropagation()}>{renderCharacterPicker(asset, closeCharacterPicker)}</div>}
            </span>}
            {renderExtraActions?.(asset)}
            {albums && onAddToAlbum && <Menu label="앨범" triggerClassName="asset-viewer__vbtn asset-viewer__vbtn--text" disabled={albums.length === 0} trigger={<><RectangleStackIcon aria-hidden="true" /><span>앨범</span></>} items={albumItems} />}
            {asset.sourceUrl && <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="출처 열기" onClick={() => void openUrl(asset.sourceUrl!).catch(() => undefined)}><ArrowTopRightOnSquareIcon aria-hidden="true" /></Button>}
            {onToggleFavorite && <IconButton className="asset-viewer__vbtn asset-viewer__favorite" tone="heart" pop label="좋아요" icon={HeartIcon} activeIcon={HeartSolidIcon} active={asset.favorite} data-toggle-key={asset.id} ref={favoriteButtonRef} onClick={() => onToggleFavorite(asset)} />}
            {folders && onMoveToFolder && <Menu label="이동" triggerClassName="asset-viewer__vbtn" trigger={<FolderArrowDownIcon aria-hidden="true" />} items={folderItems} />}
            {onExport && <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="내보내기" aria-description="PC 폴더로 내보내기" onClick={() => onExport(asset)}><ArrowDownTrayIcon aria-hidden="true" /></Button>}
            {onTrash && <Button className="asset-viewer__vbtn" size="icon" variant="danger" aria-label="휴지통으로" onClick={() => onTrash(asset)}><TrashIcon aria-hidden="true" /></Button>}
            {renderInfo && <Button className={`asset-viewer__vbtn${infoOpen ? " asset-viewer__vbtn--on" : ""}`} size="icon" variant="ghost" aria-label="정보" aria-pressed={infoOpen} onClick={() => setInfoOpen((open) => !open)}><InformationCircleIcon aria-hidden="true" /></Button>}
            <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="감상 화면 닫기" aria-description="감상 화면 닫기" onClick={motion.close}><XMarkIcon aria-hidden="true" /></Button>
          </div>
          {previous && <button className="asset-viewer__edge asset-viewer__edge--left" type="button" aria-label="이전 자산" onClick={() => move(previous)} {...overlayHover("left")}><ChevronLeftIcon aria-hidden="true" /></button>}
          {next && <button className="asset-viewer__edge asset-viewer__edge--right" type="button" aria-label="다음 자산" onClick={() => move(next)} {...overlayHover("right")}><ChevronRightIcon aria-hidden="true" /></button>}
          {showFilmstrip && <CenteredFilmstrip items={items} index={index} height={124} grown={stripGrown} className="asset-viewer__filmstrip" onIndex={i => onActiveIdChange(items[i].id)} onInteract={revealChrome} onInteractionChange={active => { stripActive.current = active; if (active) setStripGrown(true); revealChrome(); }} renderThumbnail={(_, i) => masked(items[i], requestedPrivacy) ? <span className="centered-filmstrip__placeholder" /> : <img src={mediaSource === "vault" ? vaultThumbnailUrl(items[i].id, items[i].thumbnailRevision ?? undefined) : assetThumbnailUrl(items[i])} alt="" loading="lazy" decoding="async" draggable={false} />} />}
        </div>
        <ViewerMediaContextMenu enabled={Boolean(onSetVideoThumbnail) && asset.media.kind === "video" && !privacyMode}
          onSetThumbnail={() => onSetVideoThumbnail?.(asset, videoPlayerRef.current?.currentTimeMs() ?? 0)}>
        <div data-viewer-media className="asset-viewer__media-surface">
        {privacyMode
          ? <Skeleton className="privacy-mask asset-viewer__media-mask" label="비공개 모드" />
          : asset.media.kind === "video"
            ? <VideoPlayer ref={videoPlayerRef} key={asset.id} source={mediaSource} poster={mediaSource === "vault" ? vaultThumbnailUrl(asset.id, asset.thumbnailRevision ?? undefined) : assetThumbnailUrl(asset)} loop mediaEvents={{onDurationChange: (event) => { const seconds = event.currentTarget.duration; if (Number.isFinite(seconds) && seconds > 0) onVideoDurationKnown?.(asset, Math.round(seconds * 1_000)); }, onPlay: () => setVideoPlaying(true), onPause: () => { setVideoPlaying(false); revealChrome(); }, onEnded: () => { setVideoPlaying(false); revealChrome(); }}} asset={asset as AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> }} />
            : imageFailed
              ? <EmptyState title="이미지를 불러오지 못했습니다">다른 자산으로 이동하면 자동으로 다시 시도합니다.</EmptyState>
              : <StableImage key={String(nsfwFilter)} perfName="viewer" prefetchSrc={mediaSource === "library" && next?.media.kind === "image" && !masked(next, requestedPrivacy) ? assetUrl(next.id) : undefined} className={`asset-viewer__media${textPanning ? " asset-viewer__media--panning" : ""}`} style={zoom.scale > 1 ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` } : undefined} src={mediaSource === "vault" ? vaultAssetUrl(asset.id) : assetUrl(asset.id)} alt={asset.title || asset.originalName} draggable={false} onError={() => setImageFailed(true)} onPreloadError={() => setReplacementFailed(true)} />}
        </div>
        </ViewerMediaContextMenu>
        {hasText && displayed && <ImageTextNotes ref={notesRef} key={displayed.src} lines={lines} selected={selectedLine} open={textOpen} interactive={textCurrent} onSelect={selectText} rect={displayed.rect} zoom={zoom} panning={textPanning || textGesture} animatePan={textPanning} />}
        {replacementFailed && <div className="asset-viewer__load-error" role="status">이미지를 불러오지 못했습니다. 다른 자산으로 이동하면 다시 시도합니다.</div>}
      </div>
      {infoOpen && renderInfo && <aside className="asset-viewer__dock" role="complementary" aria-label="자산 정보">
        <header className="asset-viewer__dock-header"><span>정보</span><Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="정보 닫기" onClick={() => setInfoOpen(false)}><XMarkIcon aria-hidden="true" /></Button></header>
        <div className="asset-viewer__dock-body" data-image-text-scroll>
          <ImageTextContext value={textEligible && displayedAsset && (hasText || textBusyVisible) ? { assetId: displayedAsset.id, lines, selected: selectedLine, open: textOpen, onToggle: () => setTextOpen(open => !open), onSelect: selectTextRow, busy: textBusyVisible } : null}>
            <div inert={!textCurrent && textEligible}>{renderInfo(asset)}</div>
          </ImageTextContext>
        </div>
      </aside>}
    </div>
  </Dialog>;
}

export function getArtistLabel(asset: AssetSummary, artist?: Pick<ArtistSummary, "label"> | null): string {
  if (artist) return artist.label;
  const key = asset.creatorHandle?.replace(/^@+/, "") || asset.creatorUrl;
  return key ? artistHandle({ keys: [key] }) || asset.creatorName || asset.title || asset.originalName : asset.creatorName || asset.title || asset.originalName;
}

function isSpace(event: { key: string; code: string }) {
  return event.key === " " || event.code === "Space";
}

function typesText(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest("input:not([type=range]),select,textarea,[contenteditable=true]"));
}
