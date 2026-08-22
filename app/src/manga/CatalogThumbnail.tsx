import { useEffect, useState } from "react";

type CatalogThumbnailProps = {
  src: string | null;
  title: string;
  pageCount: number;
  className?: string;
};

export function CatalogThumbnail({ src, title, pageCount, className }: CatalogThumbnailProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return <span className={`${className ?? ""} catalog-thumbnail__fallback`.trim()}>
      <strong>{pageCount}페이지</strong>
    </span>;
  }

  return <img
    className={className}
    src={src}
    alt={`${title} 표지`}
    referrerPolicy="no-referrer"
    draggable={false}
    onError={() => setFailed(true)}
  />;
}
