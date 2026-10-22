/**
 * Synchronized zoom/pan and wipe rules for comparing two images of a similarity pair, shared by
 * the PC review screen and the tablet review overlay. Points are in CSS pixels relative to the
 * centre of the compare box; views are in normalized image coordinates (0..1), so two images of
 * different resolutions show the same spot at the same place.
 */

/** Zoom and pan shared by both images, in normalized image coordinates (0..1). */
export type CompareView = {scale: number; x: number; y: number};
export type CompareSize = {width: number; height: number};
export type ComparePoint = {x: number; y: number};
/** 나란히 (two panes), 깜빡임 (one pane, swap A/B) or 와이프 (one pane, B right of a divider). */
export type CompareMode = "side" | "flicker" | "wipe";

export const FIT: CompareView = {scale: 1, x: 0.5, y: 0.5};
export const COMPARE_MAX_SCALE = 16;
/** One automatic flicker phase. */
export const FLICKER_MS = 500;
const KEY_ZOOM = 1.5;
const KEY_PAN = 0.1;

const within = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The displayed (contain-fitted, unzoomed) size of an image inside a box. */
export function fitted(box: CompareSize, image: CompareSize): CompareSize {
  if (!box.width || !box.height || !image.width || !image.height) return {width: box.width, height: box.height};
  const f = Math.min(box.width / image.width, box.height / image.height);
  return {width: image.width * f, height: image.height * f};
}

/**
 * The CSS transform that puts the normalized point (x, y) of an image at the box centre at the
 * given scale. Both images use the same view, so the same spot lines up even when their
 * resolutions differ.
 */
export function transformFor(view: CompareView, box: CompareSize, image: CompareSize) {
  const shown = fitted(box, image);
  const tx = -(view.x - 0.5) * shown.width * view.scale, ty = -(view.y - 0.5) * shown.height * view.scale;
  return `translate(${tx}px, ${ty}px) scale(${view.scale})`;
}

/** Zoom to `scale` while the image point under `point` stays where it is. Scale 1 is the fit. */
export function zoomAt(view: CompareView, point: ComparePoint, scale: number, shown: CompareSize): CompareView {
  const next = within(scale, 1, COMPARE_MAX_SCALE);
  if (next === 1 || !shown.width || !shown.height) return next === 1 ? FIT : view;
  const u = view.x + point.x / (shown.width * view.scale), v = view.y + point.y / (shown.height * view.scale);
  return {scale: next, x: within(u - point.x / (shown.width * next), 0, 1), y: within(v - point.y / (shown.height * next), 0, 1)};
}

/** Move the image with the pointer by (dx, dy) CSS pixels; only a zoomed view pans. */
export function panBy(view: CompareView, dx: number, dy: number, shown: CompareSize): CompareView {
  if (view.scale <= 1 || !shown.width || !shown.height) return view;
  return {...view, x: within(view.x - dx / (shown.width * view.scale), 0, 1), y: within(view.y - dy / (shown.height * view.scale), 0, 1)};
}

/**
 * Double tap / double click: back to the fit when zoomed; otherwise 1:1 (one image pixel per
 * CSS pixel, at least 2×) centred on the tapped point.
 */
export function toggleActualSize(view: CompareView, point: ComparePoint, naturalWidth: number, shown: CompareSize): CompareView {
  if (view.scale > 1) return FIT;
  const scale = within(naturalWidth && shown.width ? naturalWidth / shown.width : 2, 2, COMPARE_MAX_SCALE);
  return {scale, x: within(view.x + (shown.width ? point.x / shown.width : 0), 0, 1), y: within(view.y + (shown.height ? point.y / shown.height : 0), 0, 1)};
}

/** Keyboard zoom and pan on a focused compare surface; null when the key is not one of ours. */
export function compareViewForKey(view: CompareView, key: string): CompareView | null {
  if (key === "+" || key === "=") return zoomAt(view, {x: 0, y: 0}, view.scale * KEY_ZOOM, {width: 1, height: 1});
  if (key === "-" || key === "_") return view.scale > 1 ? zoomAt(view, {x: 0, y: 0}, view.scale / KEY_ZOOM, {width: 1, height: 1}) : null;
  if (key === "0") return view.scale > 1 ? FIT : null;
  if (view.scale <= 1) return null;
  const step = KEY_PAN / view.scale;
  if (key === "ArrowLeft") return {...view, x: within(view.x - step, 0, 1)};
  if (key === "ArrowRight") return {...view, x: within(view.x + step, 0, 1)};
  if (key === "ArrowUp") return {...view, y: within(view.y - step, 0, 1)};
  if (key === "ArrowDown") return {...view, y: within(view.y + step, 0, 1)};
  return null;
}

/** The wipe divider position (0..100 % from the left) under a pointer at `clientX`. */
export function wipeAt(clientX: number, rect: {left: number; width: number}) {
  if (!rect.width) return 50;
  return Math.round(within((clientX - rect.left) / rect.width * 100, 0, 100) * 10) / 10;
}

/** Keyboard steps of the wipe divider (slider semantics); null when the key is not one of ours. */
export function stepWipe(wipe: number, key: string, fine = false): number | null {
  const step = fine ? 1 : 5;
  if (key === "ArrowLeft" || key === "ArrowDown") return within(wipe - step, 0, 100);
  if (key === "ArrowRight" || key === "ArrowUp") return within(wipe + step, 0, 100);
  if (key === "PageDown") return within(wipe - 25, 0, 100);
  if (key === "PageUp") return within(wipe + 25, 0, 100);
  if (key === "Home") return 0;
  if (key === "End") return 100;
  return null;
}

/** Which image a flicker stage shows: B while held, or on the automatic swap's B phase. */
export const flickerShowsB = (held: boolean, auto: boolean, phase: boolean) => held || (auto && phase);
