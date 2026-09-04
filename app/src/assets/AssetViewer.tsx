import { ChevronLeftIcon, ChevronRightIcon, StarIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import type { AssetSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { StableImage } from "../shared/ui/StableImage";
import { VideoPlayer } from "../video/VideoPlayer";
import { assetUrl } from "./mediaUrl";

export function AssetViewer({ items, activeId, onActiveIdChange, onClose, onAssetOpened, onToggleFavorite, onTrash, privacyMode = false }: { items: AssetSummary[]; activeId: string | null; onActiveIdChange: (id: string) => void; onClose: () => void; onAssetOpened?: (asset: AssetSummary) => void | Promise<void>; onToggleFavorite?: (asset: AssetSummary) => void; onTrash?: (asset: AssetSummary) => void; privacyMode?: boolean }) {
  const index = items.findIndex((item) => item.id === activeId);
  const asset = items[index];
  const [imageFailed, setImageFailed] = useState(false);
  const openedAssetIds = useRef(new Set<string>());
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

  return <Dialog
    open
    variant="fullscreen"
    title={asset.title || asset.originalName}
    onClose={onClose}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); move(previous); }
      if (event.key === "ArrowRight") { event.preventDefault(); move(next); }
      if (event.key.toLowerCase() === "f") { event.preventDefault(); onToggleFavorite?.(asset); }
      if (event.key === "Delete") { event.preventDefault(); onTrash?.(asset); }
    }}
  >
    <div className="asset-viewer">
      <div className="asset-viewer__controls">
        <Button size="icon" variant="ghost" aria-label="이전 자산" title="이전 자산" disabled={!previous} onClick={() => move(previous)}><ChevronLeftIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="다음 자산" title="다음 자산" disabled={!next} onClick={() => move(next)}><ChevronRightIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label={asset.favorite ? "즐겨찾기 끄기" : "즐겨찾기 켜기"} aria-pressed={asset.favorite} onClick={() => onToggleFavorite?.(asset)}><StarIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="휴지통으로 이동" onClick={() => onTrash?.(asset)}><TrashIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" aria-label="감상 화면 닫기" title="감상 화면 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </div>
      {privacyMode
        ? <Skeleton className="privacy-mask asset-gallery__media-mask" label="비공개 모드" />
        : asset.media.kind === "video"
          ? <VideoPlayer key={asset.id} asset={asset as AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> }} />
          : imageFailed
            ? <EmptyState title="이미지를 불러오지 못했습니다">다른 자산으로 이동하면 자동으로 다시 시도합니다.</EmptyState>
            : <StableImage className="asset-viewer__media" src={assetUrl(asset.id)} alt={asset.title || asset.originalName} draggable={false} onError={() => setImageFailed(true)} onPreloadError={() => setImageFailed(true)} />}
    </div>
  </Dialog>;
}
