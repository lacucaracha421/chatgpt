import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useState, type KeyboardEvent } from "react";
import { workArtworkThumbnailUrl, workArtworkUrl } from "../assets/mediaUrl";
import type { WorkArtworkSummary } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Skeleton } from "../shared/ui/Skeleton";

type WorkArtworkGalleryProps = {
  workTitle: string;
  artworks: WorkArtworkSummary[];
};

const KIND_LABEL: Record<string, string> = {
  cover: "표지",
  hero: "아트워크",
  backdrop: "배경",
  screenshot: "스크린샷",
  volume_cover: "권 표지",
};

// 레거시·원격으로 등록된 Work 아트워크를 한 화면에서 훑어보는 갤러리.
// 썸네일 줄과 확대 감상 다이얼로그로 구성된다.
export function WorkArtworkGallery({ workTitle, artworks }: WorkArtworkGalleryProps) {
  const { privacyMode } = usePrivacy();
  const [activeId, setActiveId] = useState<string | null>(null);
  if (artworks.length === 0) return null;

  const activeIndex = artworks.findIndex((artwork) => artwork.id === activeId);
  const active = activeIndex >= 0 ? artworks[activeIndex] : null;

  function moveTo(offset: -1 | 1, event?: KeyboardEvent<HTMLDivElement>) {
    event?.preventDefault();
    setActiveId(artworks[activeIndex + offset]?.id ?? activeId);
  }

  return (
    <section className="work-artwork-gallery" aria-label="스크린샷·아트웍">
      <h2 className="work-artwork-gallery__title">스크린샷 · 아트웍 {artworks.length}장</h2>
      <div className="work-artwork-gallery__strip">
        {artworks.map((artwork) => (
          <button
            key={artwork.id}
            type="button"
            className="work-artwork-gallery__thumb"
            aria-label={`${KIND_LABEL[artwork.kind] ?? "아트워크"} 크게 보기`}
            aria-pressed={artwork.id === activeId}
            onClick={() => setActiveId(artwork.id)}
          >
            {privacyMode ? (
              <Skeleton className="privacy-mask" label="비공개 모드" />
            ) : (
              <img src={workArtworkThumbnailUrl(artwork.id)} alt="" draggable={false} loading="lazy" />
            )}
          </button>
        ))}
      </div>
      {active && (
        <RadixDialog.Root open onOpenChange={(open) => { if (!open) setActiveId(null); }}>
          <RadixDialog.Portal>
            <RadixDialog.Overlay className="manga-cover-viewer__backdrop" aria-label="아트웍 감상 닫기" onClick={() => setActiveId(null)} />
            <RadixDialog.Content
              className="manga-cover-viewer manga-cover-viewer--flat"
              style={{ pointerEvents: "none" }}
              aria-describedby={undefined}
              onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                if (event.key === "ArrowLeft") moveTo(-1, event);
                if (event.key === "ArrowRight") moveTo(1, event);
              }}
            >
              <RadixDialog.Title className="manga-cover-viewer__title">
                {workTitle} {KIND_LABEL[active.kind] ?? "아트웍"} 감상
              </RadixDialog.Title>
              <RadixDialog.Close asChild>
                <button type="button" className="manga-cover-viewer__control manga-cover-viewer__close" aria-label="아트웍 감상 닫기">
                  <XMarkIcon aria-hidden="true" />
                </button>
              </RadixDialog.Close>
              <button
                type="button"
                className="manga-cover-viewer__control manga-cover-viewer__previous"
                aria-label="이전 아트웍"
                disabled={activeIndex === 0}
                onClick={() => moveTo(-1)}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </button>
              <div className="manga-cover-viewer__cover-slot">
                <div className="manga-cover-viewer__collectible manga-cover-viewer__collectible--flat">
                  {privacyMode ? (
                    <Skeleton className="privacy-mask manga-cover-viewer__cover-mask" label="비공개 모드" />
                  ) : (
                    <img src={workArtworkUrl(active.id)} alt={`${workTitle} ${KIND_LABEL[active.kind] ?? "아트웍"}`} draggable={false} />
                  )}
                </div>
              </div>
              <button
                type="button"
                className="manga-cover-viewer__control manga-cover-viewer__next"
                aria-label="다음 아트웍"
                disabled={activeIndex === artworks.length - 1}
                onClick={() => moveTo(1)}
              >
                <ChevronRightIcon aria-hidden="true" />
              </button>
              <div className="manga-cover-viewer__position" aria-live="polite">
                <span>{KIND_LABEL[active.kind] ?? "아트웍"}</span>
                <span>{activeIndex + 1} / {artworks.length}</span>
              </div>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>
      )}
    </section>
  );
}