import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import type { ImageRect } from "./imageTextNoteLayout";

type DisplayedImage = { src: string; image: HTMLImageElement; ready: boolean; rect: ImageRect };

/** Observe the painted StableImage slot, including an already decoded prefetched slot swap. */
export function useDisplayedImage(element: HTMLDivElement | null, selector = "[data-viewer-media] img.asset-viewer__media:not([data-stable-image-loading])") {
  const [displayed, setDisplayed] = useState<DisplayedImage | null>(null);
  useLayoutEffect(() => {
    if (!element) { setDisplayed(null); return; }
    const read = () => {
      const image = element.querySelector<HTMLImageElement>(selector);
      if (!image) { setDisplayed(null); return; }
      // Computed sizes exclude zoom/pan and retain fractional pixels. object-fit may letterbox
      // inside the img element itself; offset sizes are the fallback for layout-free tests.
      const style = getComputedStyle(image);
      const width = parseFloat(style.width) || image.offsetWidth;
      const height = parseFloat(style.height) || image.offsetHeight;
      const ratio = image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : width / height;
      const fittedWidth = Math.min(width, height * ratio) || 0;
      const fittedHeight = Math.min(height, width / ratio) || 0;
      const next = { src: image.getAttribute("src") ?? "", image, ready: image.complete && image.naturalWidth > 0 && image.naturalHeight > 0, rect: { left: (element.clientWidth - fittedWidth) / 2, top: (element.clientHeight - fittedHeight) / 2, width: fittedWidth, height: fittedHeight } };
      setDisplayed(previous => previous?.src === next.src && previous.image === image && previous.ready === next.ready && Object.keys(next.rect).every(key => previous.rect[key as keyof ImageRect] === next.rect[key as keyof ImageRect]) ? previous : next);
    };
    read();
    // React's slot commit has finished. Flush before the browser paints so rows/markers never
    // spend a frame attached to the outgoing bitmap. onLoad alone precedes decode and misses prefetch.
    const observer = new MutationObserver(records => {
      if (records.some(record => record.type === "childList" || record.target instanceof HTMLImageElement)) flushSync(read);
    });
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "style", "data-stable-image-loading"] });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => flushSync(read));
    resize?.observe(element);
    element.addEventListener("load", read, true);
    return () => { observer.disconnect(); resize?.disconnect(); element.removeEventListener("load", read, true); };
  }, [element, selector]);
  return displayed;
}
