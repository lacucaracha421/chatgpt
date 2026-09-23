import { useState } from "react";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Skeleton } from "../shared/ui/Skeleton";
import { nativeMediaUrl } from "../assets/mediaUrl";

type CatalogThumbnailProps = {
  src: string | null;
  title: string;
  pageCount: number;
  className?: string;
};

export function CatalogThumbnail({ src, title, pageCount, className }: CatalogThumbnailProps) {
  const { privacyMode } = usePrivacy();

  if (privacyMode) {
    return <Skeleton className={className} label="비공개 모드" />;
  }

  return <CatalogImage key={src} src={src} title={title} pageCount={pageCount} className={className} />;
}

function CatalogImage({ src, title, pageCount, className }: CatalogThumbnailProps) {
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  if (!src || status === "failed") {
    return <span className={`${className ?? ""} catalog-thumbnail__fallback`.trim()}>
      <strong>{pageCount}페이지</strong>
    </span>;
  }

  return <span className={`${className ?? ""} catalog-thumbnail`.trim()} aria-busy={status === "loading"}>
    {status === "loading" && <span className="catalog-thumbnail__loading" role="img" aria-label="표지를 불러오는 중"><PhotoIcon aria-hidden="true" /></span>}
    <img
      className="catalog-thumbnail__image"
      style={{ visibility: status === "loaded" ? "visible" : "hidden" }}
      src={nativeMediaUrl(src)}
      alt={`${title} 표지`}
      referrerPolicy="no-referrer"
      draggable={false}
      onLoad={() => setStatus("loaded")}
      onError={() => setStatus("failed")}
    />
  </span>;
}
