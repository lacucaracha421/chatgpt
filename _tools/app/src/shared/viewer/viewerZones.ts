/**
 * Pointer zones of the PC viewer (user, 2026-10-13): each overlay appears only while the pointer is in its own zone,
 * so moving the mouse around the middle keeps the asset alone on screen. Every size lives here.
 */
export const VIEWER_ZONE_SIZES = {
  /** Top bar: a fraction of the stage height, never less than `min` px (the bar and its scrim reach 96 px). */
  top: { fraction: 0.15, min: 96 },
  /** Film strip: the band in which it already grew (a grown strip is about 150 px tall). */
  bottom: { fraction: 0.15, min: 210 },
  /** Previous/next arrows: a fraction of the stage width, never less than `min` px (the arrows are 96 px wide). */
  side: { fraction: 0.12, min: 96 },
} as const;

export type ViewerZoneSet = { top: boolean; bottom: boolean; left: boolean; right: boolean };
export type ViewerZoneRect = { left: number; top: number; right: number; bottom: number };

export const NO_VIEWER_ZONES: ViewerZoneSet = { top: false, bottom: false, left: false, right: false };

const size = (rule: { fraction: number; min: number }, extent: number) => Math.max(rule.min, extent * rule.fraction);

/** Which overlay zones the pointer is in; outside the stage (the docked panel, off screen) it is in none. */
export function viewerZonesAt(x: number, y: number, rect: ViewerZoneRect): ViewerZoneSet {
  const width = rect.right - rect.left, height = rect.bottom - rect.top;
  if (!(width > 0 && height > 0) || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return NO_VIEWER_ZONES;
  const side = size(VIEWER_ZONE_SIZES.side, width);
  return {
    top: y - rect.top <= size(VIEWER_ZONE_SIZES.top, height),
    bottom: rect.bottom - y <= size(VIEWER_ZONE_SIZES.bottom, height),
    left: x - rect.left <= side,
    right: rect.right - x <= side,
  };
}

export function sameViewerZones(a: ViewerZoneSet, b: ViewerZoneSet) {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

/** What stays shown on top of the pointer's zones: pointer on the overlay, keyboard focus in it, an open menu or panel. */
export function viewerZonesShown(pointer: ViewerZoneSet, held: Partial<ViewerZoneSet>): ViewerZoneSet {
  return { top: pointer.top || Boolean(held.top), bottom: pointer.bottom || Boolean(held.bottom), left: pointer.left || Boolean(held.left), right: pointer.right || Boolean(held.right) };
}
