import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useState, type KeyboardEvent } from "react";
import { workArtworkUrl, workArtworkThumbnailUrl } from "../assets/mediaUrl";
import type { CollectionVolume } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Skeleton } from "../shared/ui/Skeleton";
import { PaperbackLive } from "./physical/PaperbackLive";
import "./physical/physicalCollections.css";

export type ViewableCollectionVolume = CollectionVolume & { coverArtworkId: string };
type MangaCoverViewerProps = {
  workTitle: string;
  volumes: ViewableCollectionVolume[];
  activeVolumeId: string;
  onActiveVolumeChange: (volumeId: string) => void;
  onClose: () => void;
  scope?: string;
  revision?: string;
};
export function MangaCoverViewer({ workTitle, volumes, activeVolumeId, onActiveVolumeChange, onClose, scope = "", revision = "" }: MangaCoverViewerProps) {
  const { privacyMode } = usePrivacy();
  const [flat, setFlat] = useState(false);
  const activeIndex = volumes.findIndex(volume => volume.id === activeVolumeId);
  const active = volumes[activeIndex];
  if (!active) return null;
  const first = Math.max(0, Math.min(volumes.length - 7, activeIndex - 3));
  function move(offset: -1 | 1) { const next = volumes[activeIndex + offset]; if (next) onActiveVolumeChange(next.id); }
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); move(event.key === "ArrowLeft" ? -1 : 1); }
  }
  return <RadixDialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="manga-cover-viewer__backdrop" aria-label="표지 감상 닫기" />
      <RadixDialog.Content className="manga-cover-viewer manga-cover-viewer--final" style={{ pointerEvents: "none" }} aria-describedby={undefined} onKeyDown={handleKeyDown}>
        <RadixDialog.Title className="manga-cover-viewer__title">{workTitle} {active.displayLabel}권 표지 감상</RadixDialog.Title>
        <RadixDialog.Close asChild><button type="button" className="manga-cover-viewer__control manga-cover-viewer__close" aria-label="표지 감상 닫기"><XMarkIcon aria-hidden="true" /></button></RadixDialog.Close>
        <button type="button" className="manga-cover-viewer__control manga-cover-viewer__previous" aria-label="이전 권" disabled={activeIndex === 0} onClick={() => move(-1)}><ChevronLeftIcon aria-hidden="true" /></button>
        <div className="manga-cover-viewer__cover-slot">
          {privacyMode ? <Skeleton className="privacy-mask manga-cover-viewer__cover-mask" label="비공개 모드" /> :
            <PaperbackLive src={workArtworkUrl(active.coverArtworkId)} alt={`${active.displayLabel}권 표지`} scope={scope} revision={revision} flat={flat} />}
        </div>
        <button type="button" className="manga-cover-viewer__control manga-cover-viewer__next" aria-label="다음 권" disabled={activeIndex === volumes.length - 1} onClick={() => move(1)}><ChevronRightIcon aria-hidden="true" /></button>
        <footer className="manga-cover-viewer__navigation">
          <div className="manga-cover-viewer__position" aria-live="polite"><span>{active.displayLabel}권</span><span>{activeIndex + 1} / {volumes.length}</span></div>
          <div className="manga-cover-viewer__strip" role="group" aria-label="같은 판본의 권 탐색">
            {volumes.slice(first, first + 7).map(volume => <button type="button" key={volume.id} aria-label={`${volume.displayLabel}권 보기`} aria-pressed={volume.id === activeVolumeId} onClick={() => onActiveVolumeChange(volume.id)}>
              {!privacyMode && <img src={workArtworkThumbnailUrl(volume.coverArtworkId)} alt="" decoding="async" draggable={false} />}
              <span>{volume.displayLabel}</span>
            </button>)}
          </div>
          <button type="button" className="manga-cover-viewer__mode" aria-pressed={flat} onClick={() => setFlat(value => !value)}>{flat ? "입체로 감상" : "원본 보기"}</button>
        </footer>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  </RadixDialog.Root>;
}
