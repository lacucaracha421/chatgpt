import { useEffect, useState, type ImgHTMLAttributes } from "react";

type StableImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  src: string;
  alt: string;
  onPreloadError?: () => void;
};

export function StableImage({ src, alt, onPreloadError, ...props }: StableImageProps) {
  const [displayed, setDisplayed] = useState({ src, alt });

  useEffect(() => {
    if (displayed.src === src) {
      if (displayed.alt !== alt) setDisplayed({ src, alt });
      return;
    }
    let active = true;
    const image = new Image();
    const reveal = () => { if (active) setDisplayed({ src, alt }); };
    const fail = () => { if (active) onPreloadError?.(); };
    image.onload = reveal;
    image.onerror = fail;
    image.src = src;
    if (typeof image.decode === "function") {
      void image.decode().then(reveal, () => {
        // A rejected decode with no usable image is a failed preload, not a
        // reason to keep the previous asset on screen indefinitely.
        if (image.complete && image.naturalWidth > 0) reveal();
        else fail();
      });
    } else {
      reveal();
    }
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [alt, displayed.alt, displayed.src, onPreloadError, src]);

  return <img {...props} src={displayed.src} alt={displayed.alt} />;
}
