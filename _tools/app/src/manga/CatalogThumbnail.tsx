import { useEffect, useState } from "react";
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
  const [failed, setFailed] = useState(false);
  const { privacyMode } = usePrivacy();

  useEffect(() => setFailed(false), [src]);

  if (privacyMode) {
    return <Skeleton className={className} label="비공개 모드" />;
  }

  if (!src || failed) {
    return <span className={`${className ?? ""} catalog-thumbnail__fallback`.trim()}>
      <strong>{pageCount}페이지</strong>
    </span>;
  }

  return <img
    className={className}
    src={nativeMediaUrl(src)}
    alt={`${title} 표지`}
    referrerPolicy="no-referrer"
    draggable={false}
    onError={() => setFailed(true)}
  />;
}
