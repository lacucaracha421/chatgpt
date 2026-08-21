import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import * as RadixDialog from "@radix-ui/react-dialog";
import type { KeyboardEvent, PointerEvent } from "react";
import { workArtworkUrl } from "../assets/mediaUrl";
import type { CollectionVolume } from "../library/types";

export type ViewableCollectionVolume = CollectionVolume & {
  coverArtworkId: string;
};

type MangaCoverViewerProps = {
  workTitle: string;
  volumes: ViewableCollectionVolume[];
  activeVolumeId: string;
  onActiveVolumeChange: (volumeId: string) => void;
  onClose: () => void;
};

export function MangaCoverViewer({
  workTitle,
  volumes,
  activeVolumeId,
  onActiveVolumeChange,
  onClose,
}: MangaCoverViewerProps) {
  const activeIndex = volumes.findIndex((volume) => volume.id === activeVolumeId);
  const active = volumes[activeIndex];
  if (!active) return null;

  function move(offset: -1 | 1) {
    const next = volumes[activeIndex + offset];
    if (next) onActiveVolumeChange(next.id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(-1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(1);
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(-0.5, Math.min(0.5, (event.clientX - bounds.left) / bounds.width - 0.5));
    const y = Math.max(-0.5, Math.min(0.5, (event.clientY - bounds.top) / bounds.height - 0.5));
    event.currentTarget.style.setProperty("--viewer-tilt-x", `${-y * 6}deg`);
    event.currentTarget.style.setProperty("--viewer-tilt-y", `${x * 6}deg`);
    event.currentTarget.style.setProperty("--viewer-shadow-x", `${-x * 12}px`);
    event.currentTarget.style.setProperty("--viewer-shadow-y", `${8 - y * 8}px`);
    event.currentTarget.classList.add("manga-cover-viewer__collectible--tilting");
  }

  function resetPointer(event: PointerEvent<HTMLDivElement>) {
    for (const property of ["--viewer-tilt-x", "--viewer-tilt-y", "--viewer-shadow-x", "--viewer-shadow-y"]) {
      event.currentTarget.style.removeProperty(property);
    }
    event.currentTarget.classList.remove("manga-cover-viewer__collectible--tilting");
  }

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="manga-cover-viewer__backdrop" aria-label="표지 감상 닫기" />
        <RadixDialog.Content
          className="manga-cover-viewer"
          style={{ pointerEvents: "none" }}
          aria-describedby={undefined}
          onKeyDown={handleKeyDown}
        >
          <RadixDialog.Title className="manga-cover-viewer__title">
            {workTitle} {active.displayLabel}권 표지 감상
          </RadixDialog.Title>
          <RadixDialog.Close asChild>
            <button type="button" className="manga-cover-viewer__control manga-cover-viewer__close" aria-label="표지 감상 닫기">
              <XMarkIcon aria-hidden="true" />
            </button>
          </RadixDialog.Close>
          <button
            type="button"
            className="manga-cover-viewer__control manga-cover-viewer__previous"
            aria-label="이전 권"
            disabled={activeIndex === 0}
            onClick={() => move(-1)}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </button>
          <div className="manga-cover-viewer__cover-slot">
            <div
              className="manga-cover-viewer__collectible"
              onPointerMove={handlePointerMove}
              onPointerLeave={resetPointer}
            >
              <img src={workArtworkUrl(active.coverArtworkId)} alt={`${active.displayLabel}권 표지`} draggable={false} />
              <span className="manga-cover-viewer__glare" aria-hidden="true" />
            </div>
          </div>
          <button
            type="button"
            className="manga-cover-viewer__control manga-cover-viewer__next"
            aria-label="다음 권"
            disabled={activeIndex === volumes.length - 1}
            onClick={() => move(1)}
          >
            <ChevronRightIcon aria-hidden="true" />
          </button>
          <div className="manga-cover-viewer__position" aria-live="polite">
            <span>{active.displayLabel}권</span>
            <span>{activeIndex + 1} / {volumes.length}</span>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
