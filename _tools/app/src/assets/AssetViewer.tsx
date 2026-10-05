import { useAssetMasks, usePrivacy } from "../privacy/PrivacyContext";
import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderArrowDownIcon,
  InformationCircleIcon,
  RectangleStackIcon,
  HeartIcon,
  TrashIcon,
  UserIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { openUrl } from "@tauri-apps/plugin-opener";
import { HeartIcon as HeartSolidIcon } from "@heroicons/react/24/solid";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CenteredFilmstrip, filmstripControlsOffset } from "../shared/viewer/CenteredFilmstrip";
import { useViewerMotion, type TileRect } from "../shared/viewer/useViewerMotion";
import { artistHandle } from "../artists/format";
import { useAssetArtist } from "../artists/artistStore";
import type { ArtistSummary } from "../artists/types";
import { useOptionalLibrary } from "../library/LibraryContext";
import type { AlbumEntry, AssetSummary, ClassificationEntry } from "../library/types";
import { breadcrumbPath } from "../shared/breadcrumb";
import { displayDate, displayTime } from "../shared/displayDate";
import { Button } from "../shared/ui/Button";
import { IconButton } from "../shared/ui/IconButton";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Menu } from "../shared/ui/Menu";
import { Skeleton } from "../shared/ui/Skeleton";
import { StableImage } from "../shared/ui/StableImage";
import { popToggle } from "../shared/motion/togglePop";
import { VIDEO_SEEK_STEP_SECONDS, VideoPlayer, type VideoPlayerHandle } from "../video/VideoPlayer";
import { assetThumbnailUrl, assetUrl, vaultAssetUrl, vaultThumbnailUrl } from "./mediaUrl";

/** Title, navigation arrows and actions fade out after this much pointer/keyboard idle time. */
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
  onNearEnd?: () => void;
};

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
  const openedAssetIds = useRef(new Set<string>());
  const nearEndLengthRef = useRef<number | null>(null);
  const wheelRef = useRef({ accumulated: 0, lastStepAt: 0 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const detachWheelRef = useRef<(() => void) | null>(null);
  // A native, non-passive listener so Ctrl+wheel can stop the WebView's own page zoom. Attached when the
  // stage mounts (the dialog content mounts after this component's effects run).
  const attachStage = useCallback((stage: HTMLDivElement | null) => {
    detachWheelRef.current?.();
    detachWheelRef.current = null;
    stageRef.current = stage;
    if (!stage) return;
    const listener = (event: globalThis.WheelEvent) => wheelHandlerRef.current(event);
    stage.addEventListener("wheel", listener, { passive: false });
    detachWheelRef.current = () => stage.removeEventListener("wheel", listener);
  }, []);
  const wheelHandlerRef = useRef<(event: globalThis.WheelEvent) => void>(() => undefined);
  const panRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // Ctrl+wheel zoom for images: scale around the pointer, drag to pan while zoomed; resets per asset.
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const videoPlayerRef = useRef<VideoPlayerHandle>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const favoriteButtonRef = useRef<HTMLButtonElement>(null);
  const chromeTimerRef = useRef<number | null>(null);
  const pointerOverChromeRef = useRef(false);
  const keyboardFocusRef = useRef(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const viewerOpen = Boolean(asset);
  const total = totalCount != null && Number.isFinite(totalCount) && totalCount >= items.length ? totalCount : items.length;
  const showFilmstrip = Boolean(asset && items.length > 1);

  const revealChrome = useCallback(() => {
    setChromeVisible(true);
    if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = window.setTimeout(() => {
      chromeTimerRef.current = null;
      // Stay visible while the pointer rests on a control or a Tab-focused control shows its focus ring.
      if (pointerOverChromeRef.current || stripActive.current) return;
      if (keyboardFocusRef.current && chromeRef.current?.contains(document.activeElement)) return;
      setChromeVisible(false);
    }, VIEWER_CHROME_IDLE_MS);
  }, []);

  useEffect(() => () => clearTimeout(stripGrowTimer.current), []);

  useEffect(() => {
    if (!viewerOpen) {
      setInfoOpen(false);
      setCharacterOpen(false);
      openedAssetIds.current.clear();
      nearEndLengthRef.current = null;
      return;
    }
    revealChrome();
    return () => {
      if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current);
      chromeTimerRef.current = null;
    };
  }, [revealChrome, viewerOpen]);

  useEffect(() => {
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
  const filmstripVisible = showFilmstrip && !videoPlaying && (chromeVisible || seekable);
  const artistLabel = getArtistLabel(asset, artist);
  const dateLabel = [displayDate(asset.collectedAt), displayTime(asset.collectedAt)].filter(Boolean).join(" ");
  const metaLabel = [folderPath, dateLabel].filter(Boolean).join(" · ");
  const handleDialogClose = () => {
    if (infoOpen) { setInfoOpen(false); return; }
    motion.close();
  };
  const chromeHover = {
    onPointerEnter: () => { pointerOverChromeRef.current = true; setChromeVisible(true); },
    onPointerLeave: () => { pointerOverChromeRef.current = false; revealChrome(); },
  };
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
      if (event.key === "Escape" && infoOpen) {
        event.preventDefault();
        event.stopPropagation();
        setInfoOpen(false);
        return;
      }
      // Typing in a field inside the viewer (the character picker search) must not trigger viewer shortcuts.
      if (typesText(event.target)) return;
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
      className={`asset-viewer${chromeVisible ? "" : " asset-viewer--chrome-hidden"}${infoOpen ? " asset-viewer--docked" : ""}${videoPlaying ? " asset-viewer--playing" : ""}`}
      data-chrome-visible={chromeVisible}
      data-filmstrip-visible={filmstripVisible}
      style={{"--viewer-controls-offset": `${filmstripControlsOffset(124, stripGrown, filmstripVisible)}px`} as CSSProperties}
      onPointerMove={(event) => {
        keyboardFocusRef.current = false; revealChrome();
        if (stripActive.current) return;
        if (event.clientY > event.currentTarget.getBoundingClientRect().bottom - 210) { clearTimeout(stripGrowTimer.current); stripGrowTimer.current = undefined; setStripGrown(true); }
        else if (!stripGrowTimer.current) stripGrowTimer.current = setTimeout(() => { stripGrowTimer.current = undefined; setStripGrown(false); }, 220);
      }}
      onPointerDown={() => { keyboardFocusRef.current = false; }}
    >
      <div data-viewer-backdrop className="asset-viewer__backdrop" />
      <div className={`asset-viewer__stage${showFilmstrip ? " asset-viewer__stage--filmstrip" : ""}${seekable ? " asset-viewer__stage--video" : ""}`} ref={attachStage}
        onPointerDown={(event) => {
          if (zoom.scale === 1 || event.button !== 0 || (event.target instanceof HTMLElement && event.target.closest("button, a, input, .ui-menu, .asset-viewer__character-popover"))) return;
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
        onPointerUp={() => { panRef.current = null; }}
        onPointerCancel={() => { panRef.current = null; }}
        data-zoomed={zoom.scale > 1 ? "true" : undefined}>
        <div ref={chromeRef} className="asset-viewer__chrome" onFocusCapture={revealChrome} onBlurCapture={revealChrome}>
          <div className="asset-viewer__topbar" {...chromeHover}>
            <Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="뒤로" onClick={motion.close}><ArrowLeftIcon aria-hidden="true" /></Button>
            <span className="asset-viewer__position"><b>{index + 1}</b> / {total.toLocaleString("ko-KR")}</span>
            <span className="asset-viewer__title">
              <strong>{artistLabel}</strong>
              {metaLabel && <small>{metaLabel}</small>}
            </span>
            <span className="asset-viewer__spacer" />
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
          {previous && <button className="asset-viewer__edge asset-viewer__edge--left" type="button" aria-label="이전 자산" onClick={() => move(previous)} {...chromeHover}><ChevronLeftIcon aria-hidden="true" /></button>}
          {next && <button className="asset-viewer__edge asset-viewer__edge--right" type="button" aria-label="다음 자산" onClick={() => move(next)} {...chromeHover}><ChevronRightIcon aria-hidden="true" /></button>}
          {showFilmstrip && <CenteredFilmstrip items={items} index={index} height={124} grown={stripGrown} className="asset-viewer__filmstrip" onIndex={i => onActiveIdChange(items[i].id)} onInteract={revealChrome} onInteractionChange={active => { stripActive.current = active; if (active) setStripGrown(true); revealChrome(); }} renderThumbnail={(_, i) => masked(items[i], requestedPrivacy) ? <span className="centered-filmstrip__placeholder" /> : <img src={mediaSource === "vault" ? vaultThumbnailUrl(items[i].id) : assetThumbnailUrl(items[i])} alt="" loading="lazy" decoding="async" draggable={false} />} />}
        </div>
        <div data-viewer-media className="asset-viewer__media-surface">
        {privacyMode
          ? <Skeleton className="privacy-mask asset-viewer__media-mask" label="비공개 모드" />
          : asset.media.kind === "video"
            ? <VideoPlayer ref={videoPlayerRef} key={asset.id} source={mediaSource} mediaEvents={{onPlay: () => setVideoPlaying(true), onPause: () => { setVideoPlaying(false); revealChrome(); }, onEnded: () => { setVideoPlaying(false); revealChrome(); }}} asset={asset as AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> }} />
            : imageFailed
              ? <EmptyState title="이미지를 불러오지 못했습니다">다른 자산으로 이동하면 자동으로 다시 시도합니다.</EmptyState>
              : <StableImage key={String(nsfwFilter)} perfName="viewer" prefetchSrc={mediaSource === "library" && next?.media.kind === "image" && !masked(next, requestedPrivacy) ? assetUrl(next.id) : undefined} className="asset-viewer__media" style={zoom.scale > 1 ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` } : undefined} src={mediaSource === "vault" ? vaultAssetUrl(asset.id) : assetUrl(asset.id)} alt={asset.title || asset.originalName} draggable={false} onError={() => setImageFailed(true)} onPreloadError={() => setReplacementFailed(true)} />}
        </div>
        {replacementFailed && <div className="asset-viewer__load-error" role="status">이미지를 불러오지 못했습니다. 다른 자산으로 이동하면 다시 시도합니다.</div>}
      </div>
      {infoOpen && renderInfo && <aside className="asset-viewer__dock" role="complementary" aria-label="자산 정보">
        <header className="asset-viewer__dock-header"><span>정보</span><Button className="asset-viewer__vbtn" size="icon" variant="ghost" aria-label="정보 닫기" onClick={() => setInfoOpen(false)}><XMarkIcon aria-hidden="true" /></Button></header>
        <div className="asset-viewer__dock-body">{renderInfo(asset)}</div>
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
