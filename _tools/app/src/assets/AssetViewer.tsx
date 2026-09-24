import { ArrowDownTrayIcon, ChevronLeftIcon, ChevronRightIcon, StarIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { StableImage } from "../shared/ui/StableImage";
import { VIDEO_SEEK_STEP_SECONDS, VideoPlayer, type VideoPlayerHandle } from "../video/VideoPlayer";
import { assetUrl, vaultAssetUrl } from "./mediaUrl";

/** Title, navigation arrows and actions fade out after this much pointer/keyboard idle time. */
export const VIEWER_CHROME_IDLE_MS = 2_000;

export function AssetViewer({ items, activeId, onActiveIdChange, onClose, onAssetOpened, onToggleFavorite, onTrash, onExport, privacyMode = false, mediaSource = "library" }: { items: AssetSummary[]; activeId: string | null; onActiveIdChange: (id: string) => void; onClose: () => void; onAssetOpened?: (asset: AssetSummary) => void | Promise<void>; onToggleFavorite?: (asset: AssetSummary) => void; onTrash?: (asset: AssetSummary) => void; /** Saves a copy of the asset to a chosen PC folder (Private Vault). */ onExport?: (asset: AssetSummary) => void; privacyMode?: boolean; /** `vault`: encrypted Private Vault item routes. */ mediaSource?: "library" | "vault" }) {
  const index = items.findIndex((item) => item.id === activeId);
  const asset = items[index];
  const [imageFailed, setImageFailed] = useState(false);
  const openedAssetIds = useRef(new Set<string>());
  const videoPlayerRef = useRef<VideoPlayerHandle>(null);
  const chromeRef = useRef<HTMLDivElement>(null);
  const chromeTimerRef = useRef<number | null>(null);
  const pointerOverChromeRef = useRef(false);
  const keyboardFocusRef = useRef(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const revealChrome = useCallback(() => {
    setChromeVisible(true);
    if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current);
    chromeTimerRef.current = window.setTimeout(() => {
      chromeTimerRef.current = null;
      // Stay visible while the pointer rests on a control or a Tab-focused control shows its focus ring.
      if (pointerOverChromeRef.current) return;
      if (keyboardFocusRef.current && chromeRef.current?.contains(document.activeElement)) return;
      setChromeVisible(false);
    }, VIEWER_CHROME_IDLE_MS);
  }, []);
  const viewerOpen = Boolean(asset);
  useEffect(() => {
    if (!viewerOpen) return;
    revealChrome();
    return () => {
      if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current);
      chromeTimerRef.current = null;
    };
  }, [revealChrome, viewerOpen]);
  useEffect(() => {
    setImageFailed(false);
  }, [asset?.id]);
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
  const chromeHover = {
    onPointerEnter: () => { pointerOverChromeRef.current = true; setChromeVisible(true); },
    onPointerLeave: () => { pointerOverChromeRef.current = false; revealChrome(); },
  };

  return <Dialog
    open
    variant="fullscreen"
    title={asset.title || asset.originalName}
    onClose={onClose}
    onKeyDown={(event) => {
      const arrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
      // A video owns Left/Right for seeking; previous/next stays on the on-screen arrows.
      if (arrow && seekable && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        videoPlayerRef.current?.seekBy(event.key === "ArrowLeft" ? -VIDEO_SEEK_STEP_SECONDS : VIDEO_SEEK_STEP_SECONDS);
        return;
      }
      if (event.key === "Tab") keyboardFocusRef.current = true;
      revealChrome();
      if (event.key === "ArrowLeft") { event.preventDefault(); move(previous); }
      if (event.key === "ArrowRight") { event.preventDefault(); move(next); }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); onToggleFavorite?.(asset); }
      if (event.key === "Delete") { event.preventDefault(); onTrash?.(asset); }
    }}
  >
    <div
      className={`asset-viewer${chromeVisible ? "" : " asset-viewer--chrome-hidden"}`}
      data-chrome-visible={chromeVisible}
      onPointerMove={() => { keyboardFocusRef.current = false; revealChrome(); }}
      onPointerDown={() => { keyboardFocusRef.current = false; }}
    >
      <div className="asset-viewer__identity" role="status" aria-label="현재 자산">
        <strong>{asset.title || asset.originalName}</strong>
        <span>{index + 1} / {items.length}</span>
      </div>
      <div ref={chromeRef} className="asset-viewer__chrome" onFocusCapture={revealChrome} onBlurCapture={revealChrome}>
      <div className="asset-viewer__navigation" aria-label="자산 이동" {...chromeHover}>
        <Button size="icon" variant="ghost" aria-label="이전 자산" aria-description="이전 자산" disabled={!previous} onClick={() => move(previous)}><ChevronLeftIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="다음 자산" aria-description="다음 자산" disabled={!next} onClick={() => move(next)}><ChevronRightIcon aria-hidden="true" /></Button>
      </div>
      <div className="asset-viewer__controls" {...chromeHover}>
        {onToggleFavorite && <Button className="asset-viewer__favorite" size="icon" variant="ghost" aria-label={asset.favorite ? "즐겨찾기 끄기" : "즐겨찾기 켜기"} aria-pressed={asset.favorite} onClick={() => onToggleFavorite(asset)}><StarIcon aria-hidden="true" /></Button>}
        {onExport && <Button size="icon" variant="ghost" aria-label="내보내기" aria-description="PC 폴더로 내보내기" onClick={() => onExport(asset)}><ArrowDownTrayIcon aria-hidden="true" /></Button>}
        {onTrash && <Button size="icon" variant="danger" aria-label="휴지통으로 이동" onClick={() => onTrash(asset)}><TrashIcon aria-hidden="true" /></Button>}
        <Button size="icon" variant="ghost" aria-label="감상 화면 닫기" aria-description="감상 화면 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </div>
      </div>
      {privacyMode
        ? <Skeleton className="privacy-mask asset-gallery__media-mask" label="비공개 모드" />
        : asset.media.kind === "video"
          ? <VideoPlayer ref={videoPlayerRef} key={asset.id} source={mediaSource} asset={asset as AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> }} />
          : imageFailed
            ? <EmptyState title="이미지를 불러오지 못했습니다">다른 자산으로 이동하면 자동으로 다시 시도합니다.</EmptyState>
            : <StableImage className="asset-viewer__media" src={mediaSource === "vault" ? vaultAssetUrl(asset.id) : assetUrl(asset.id)} alt={asset.title || asset.originalName} draggable={false} onError={() => setImageFailed(true)} onPreloadError={() => setImageFailed(true)} />}
    </div>
  </Dialog>;
}
