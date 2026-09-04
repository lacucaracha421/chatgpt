import { useLayoutEffect, useRef } from "react";

export const GALLERY_SCROLLBAR_MIN_THUMB = 32;

type AssetGalleryScrollbarProps = {
  scrollRef: React.RefObject<HTMLElement | null>;
  totalHeight: number;
};

type ScrollbarMetrics = {
  trackHeight: number;
  thumbHeight: number;
  maxScroll: number;
};

/**
 * Visual-only overlay scrollbar for the asset gallery.
 *
 * The native scrollbar is hidden (its thumb length is engine-computed and
 * cannot be floored by CSS, so a huge virtual range shrinks it to an
 * ungrabbable sliver). This overlay draws a thumb with a real minimum
 * length while the native scroll container keeps owning all scrolling:
 * wheel, touchpad, keyboard, and programmatic scrolls all behave exactly
 * as before. Only thumb drags and track clicks write `scrollTop`.
 */
export function AssetGalleryScrollbar({ scrollRef, totalHeight }: AssetGalleryScrollbarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const metricsRef = useRef<ScrollbarMetrics>({ trackHeight: 0, thumbHeight: 0, maxScroll: 0 });
  const dragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number } | null>(null);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!element || !track || !thumb) return;

    const update = () => {
      const viewportHeight = element.clientHeight;
      const trackHeight = track.clientHeight;
      const maxScroll = totalHeight - viewportHeight;
      if (!(viewportHeight > 0) || !(trackHeight > 0) || !(maxScroll > 0)) {
        track.hidden = true;
        return;
      }
      track.hidden = false;
      const thumbHeight = Math.max(
        GALLERY_SCROLLBAR_MIN_THUMB,
        (viewportHeight / totalHeight) * trackHeight,
      );
      metricsRef.current = { trackHeight, thumbHeight, maxScroll };
      const travel = Math.max(0, trackHeight - thumbHeight);
      const ratio = Math.min(1, Math.max(0, element.scrollTop / maxScroll));
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${ratio * travel}px)`;
      track.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    };

    update();
    element.addEventListener("scroll", update, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof window.ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => update());
      observer.observe(element);
      observer.observe(track);
    }
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [scrollRef, totalHeight]);

  const beginThumbDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = scrollRef.current;
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    element.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: element.scrollTop,
    };
  };

  const moveThumbDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const element = scrollRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !element) return;
    const { trackHeight, thumbHeight, maxScroll } = metricsRef.current;
    const travel = trackHeight - thumbHeight;
    if (!(travel > 0) || !(maxScroll > 0)) return;
    element.scrollTop = drag.startScrollTop + ((event.clientY - drag.startY) * maxScroll) / travel;
  };

  const endThumbDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Releasing capture for an already-released pointer is harmless.
    }
  };

  const jumpTrack = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const element = scrollRef.current;
    if (!element) return;
    const { trackHeight, thumbHeight, maxScroll } = metricsRef.current;
    const travel = trackHeight - thumbHeight;
    if (!(travel > 0) || !(maxScroll > 0)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(
      1,
      Math.max(0, (event.clientY - rect.top - thumbHeight / 2) / travel),
    );
    element.scrollTop = ratio * maxScroll;
  };

  return <div
    ref={trackRef}
    className="asset-gallery__scrollbar"
    role="scrollbar"
    aria-orientation="vertical"
    aria-label="자산 목록 스크롤"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={0}
    onPointerDown={jumpTrack}
  >
    <div
      ref={thumbRef}
      className="asset-gallery__scrollbar-thumb"
      aria-hidden="true"
      onPointerDown={beginThumbDrag}
      onPointerMove={moveThumbDrag}
      onPointerUp={endThumbDrag}
      onPointerCancel={endThumbDrag}
    />
  </div>;
}
