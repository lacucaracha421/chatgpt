import { useLayoutEffect, useRef, useState } from "react";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Skeleton } from "../shared/ui/Skeleton";
import { nativeMediaUrl } from "../assets/mediaUrl";

type CatalogThumbnailProps = {
  src: string | null;
  title: string;
  pageCount: number;
  className?: string;
  onSettled?: (ready: boolean) => void;
  deferUntilNear?: boolean;
};

export function CatalogThumbnail({ src, title, pageCount, className, onSettled, deferUntilNear = false }: CatalogThumbnailProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const failed = Boolean(src && failedSrc === src);
  const { privacyMode } = usePrivacy();
  const [near, setNear] = useState(() => !deferUntilNear || typeof IntersectionObserver === "undefined");
  const canRequest = !deferUntilNear || near;

  useLayoutEffect(() => {
    if (canRequest || privacyMode || !src || failed) return;
    const image = imageRef.current;
    if (!image) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { root: image.closest(".online-catalog__content"), rootMargin: "120px" });
    observer.observe(image);
    return () => observer.disconnect();
  }, [canRequest, privacyMode, src, failed]);

  useLayoutEffect(() => { setFailedSrc(null); setLoadedSrc(null); }, [src]);

  const settledCallback = useRef(onSettled);
  settledCallback.current = onSettled;
  const preparing = Boolean(onSettled);
  useLayoutEffect(() => {
    if (!preparing) return;
    settledCallback.current?.(false);
    if (privacyMode || !src || failed) { settledCallback.current?.(true); return; }
    if (!canRequest) return;
    const image = imageRef.current;
    if (!image || (!image.complete && loadedSrc !== src)) return;
    if (image.complete && image.naturalWidth === 0) { setFailedSrc(src); return; }
    let current = true;
    if (typeof image.decode === "function") {
      void image.decode().then(() => { if (current) settledCallback.current?.(true); }, () => {
        if (current) setFailedSrc(src);
      });
    } else settledCallback.current?.(true);
    return () => { current = false; };
  }, [src, failed, loadedSrc, privacyMode, preparing, canRequest]);

  if (privacyMode) {
    return <Skeleton className={className} label="비공개 모드" />;
  }

  if (!src || failed) {
    return <span className={`${className ?? ""} catalog-thumbnail__fallback`.trim()}>
      <strong>{pageCount}페이지</strong>
    </span>;
  }

  return <img
    ref={imageRef}
    className={className}
    src={canRequest ? nativeMediaUrl(src) : undefined}
    alt={`${title} 표지`}
    referrerPolicy="no-referrer"
    draggable={false}
    onLoad={() => setLoadedSrc(src)}
    onError={() => setFailedSrc(src)}
  />;
}
