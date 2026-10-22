import type { CSSProperties } from "react";
import type { PortraitRect } from "../avTypes";

/**
 * A performer portrait cropped from a cover, one rule on the PC and the tablet: the rect is a fraction of the
 * cover (0–1 on each axis), its frame is 3:4 on screen, and every portrait box shows the crop at 3:4 from its top
 * (a square or round box shows the upper part instead of stretching it).
 */
export const PORTRAIT_ASPECT = 3 / 4;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** The frame a newly chosen cover starts with: half its width (at most 80% of its height), centred, 3:4 on screen. */
export function initialPortraitRect(width?: number | null, height?: number | null): PortraitRect {
  if (!width || !height || width <= 0 || height <= 0) return { x: .25, y: .15, w: .5, h: .7 };
  const imageRatio = width / height;
  let w = .5;
  let h = w * imageRatio / PORTRAIT_ASPECT;
  if (h > .8) { h = .8; w = h * PORTRAIT_ASPECT / imageRatio; }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** 확대: the starting frame shrunk by `zoom`, kept around the current frame's centre so a dragged frame stays on the face. */
export function zoomPortraitRect(base: PortraitRect, zoom: number, current: PortraitRect): PortraitRect {
  const w = base.w / zoom, h = base.h / zoom;
  return { w, h, x: clamp(current.x + current.w / 2 - w / 2, 0, 1 - w), y: clamp(current.y + current.h / 2 - h / 2, 0, 1 - h) };
}

/** The frame dragged by a pointer moved `dx`, `dy` (fractions of the shown cover), kept inside the cover. */
export function movePortraitRect(start: PortraitRect, dx: number, dy: number): PortraitRect {
  return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
}

/** The background that shows `rect` of the cover at `url` in a 3:4 box. */
export function portraitCropStyle(url: string, rect: PortraitRect): CSSProperties {
  return {
    backgroundImage: `url("${url}")`,
    backgroundSize: `${100 / rect.w}% ${100 / rect.h}%`,
    backgroundPosition: `${rect.w >= 1 ? 0 : (rect.x / (1 - rect.w)) * 100}% ${rect.h >= 1 ? 0 : (rect.y / (1 - rect.h)) * 100}%`,
  };
}
