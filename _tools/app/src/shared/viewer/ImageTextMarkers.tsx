import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ImageTextLine } from "../../library/types";
import "./image-text.css";

export type ImageRect = { left: number; top: number; width: number; height: number };
export type ImageZoom = { scale: number; x: number; y: number };

/** Centres are in unscaled image pixels; the visible badge always keeps its token size. */
export function imageTextMarkerPositions(lines: ImageTextLine[], width: number, height: number, zoom = 1, size = 20) {
  const half = size / zoom / 2;
  const clamp = (value: number, length: number) => Math.max(Math.min(half, length / 2), Math.min(length - half, value));
  const placed: { index: number; x: number; y: number }[] = [];
  lines.forEach((line, index) => {
    if (!line.box) return;
    const x = clamp(line.box.x0 / 1000 * width + half, width);
    let y = clamp(line.box.y0 / 1000 * height + half, height);
    for (const previous of placed) {
      if (Math.hypot(x - previous.x, y - previous.y) < size / zoom) y = clamp(y + (size + 4) / zoom, height);
    }
    placed.push({ index, x, y });
  });
  return placed;
}

export function ImageTextMarkers({ lines, selected, open, onSelect, rect, zoom, size, panning = false, interactive = true, surfaceTap = false }: {
  lines: ImageTextLine[]; selected: number | null; open: boolean; onSelect: (index: number) => void;
  rect: ImageRect; zoom: ImageZoom; size?: number; panning?: boolean; interactive?: boolean; surfaceTap?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [tokenSize, setTokenSize] = useState(20);
  useLayoutEffect(() => {
    if (root.current && size === undefined) setTokenSize(parseFloat(getComputedStyle(root.current).getPropertyValue("--badge-height")) || 20);
  }, [size, rect.width, rect.height]);
  const positions = imageTextMarkerPositions(lines, rect.width, rect.height, zoom.scale, size ?? tokenSize);
  return <div ref={root} className="image-text-markers" data-open={open} data-sized={rect.width > 0 && rect.height > 0} data-panning={panning} data-surface-tap={surfaceTap} aria-hidden={!open} inert={!open || !interactive}
    style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, ...(size === undefined ? {} : { "--image-text-marker-size": `${size}px` }) } as CSSProperties}>
    {positions.map(({ index, x, y }) => <button key={index} type="button" className="image-text-marker" aria-label={`${index + 1}번 대사`} aria-pressed={selected === index}
      data-muted={selected !== null && selected !== index} onClick={event => { if (!surfaceTap || event.detail === 0) onSelect(index); }}
      style={{ left: x, top: y, transform: `translate(-50%, -50%) scale(${1 / zoom.scale})` }}>{index + 1}</button>)}
  </div>;
}
