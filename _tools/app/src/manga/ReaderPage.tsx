import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Skeleton } from "../shared/ui/Skeleton";

/** Width / height of a typical manga page, used until a real page of the work has loaded. */
export const DEFAULT_PAGE_RATIO = 0.7;

/** A page-shaped box in the reader spread; its width follows the page's aspect ratio. */
export function ReaderPageBox({ ratio, children }: { ratio: number; children: ReactNode }) {
  return <span className="manga-reader__page" style={{ "--reader-page-ratio": String(ratio) } as CSSProperties}>{children}</span>;
}

type ReaderPageProps = {
  src: string;
  alt: string;
  ratio: number;
  onRatio: (ratio: number) => void;
  onError: () => void;
};

/**
 * One reader page. Until its image has loaded it shows a page-shaped placeholder instead of an
 * empty box; the image stays mounted (invisible) so the spread can wait for it to decode.
 */
export function ReaderPage({ src, alt, ratio, onRatio, onError }: ReaderPageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  const markLoaded = (image: HTMLImageElement) => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) onRatio(image.naturalWidth / image.naturalHeight);
    setLoaded(true);
  };
  useLayoutEffect(() => {
    const image = imageRef.current;
    // A cached image can be complete before React sees its load event.
    if (image?.complete && image.naturalWidth > 0) markLoaded(image);
  }, []);
  return <ReaderPageBox ratio={ratio}>
    {!loaded && <span className="manga-reader__placeholder">
      <Skeleton className="manga-reader__placeholder-fill" label="불러오는 중" />
      <span className="manga-reader__placeholder-text" aria-hidden="true">불러오는 중</span>
    </span>}
    <img
      ref={imageRef}
      className="manga-reader__image"
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      draggable={false}
      style={loaded ? undefined : { opacity: 0 }}
      onLoad={(event) => markLoaded(event.currentTarget)}
      onError={onError}
    />
  </ReaderPageBox>;
}
