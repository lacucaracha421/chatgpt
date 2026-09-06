import { useLayoutEffect, useRef, useState } from "react";
import { drawGameCase } from "./drawGameCase";

export function GameCase({ src, alt, onError }: { src: string; alt: string; onError?: () => void }) {
  const root = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [readySource, setReadySource] = useState<string | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    setVisible(bounds.bottom >= -240 && bounds.top <= window.innerHeight + 240);
    if (!window.IntersectionObserver) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = root.current, surface = canvas.current;
    if (!visible || !element || !surface) { setReadySource(null); return; }
    let cancelled = false;
    const image = new Image();
    const draw = () => {
      if (cancelled) return;
      const artwork = image.naturalWidth ? image : null;
      try { if (drawGameCase(surface, artwork, element.getBoundingClientRect().width || 154)) setReadySource(artwork ? src : null); }
      catch { setReadySource(null); }
    };
    draw();
    image.onload = draw;
    image.src = src;
    if (image.complete && image.naturalWidth) draw();
    const observer = window.ResizeObserver ? new ResizeObserver(draw) : null;
    observer?.observe(element);
    window.addEventListener("resize", draw);
    return () => {
      cancelled = true; image.onload = null; observer?.disconnect();
      window.removeEventListener("resize", draw);
      surface.width = surface.height = 0;
    };
  }, [src, visible]);
  return <span ref={root} className="game-case" data-ready={readySource === src}>
    <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} onError={onError} />
    <canvas ref={canvas} aria-hidden="true" />
  </span>;
}
