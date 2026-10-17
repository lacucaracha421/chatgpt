/**
 * Plain rules of the AV candidate review (PC dialog and tablet sheet): the surfaces of a jacket, where the
 * cut lines may go, and when a spine is borrowed or looks wrong. No React and no client data access.
 */
export type Surface = "front" | "spine" | "back";
export type SurfaceChoice = "candidate" | "keep" | "clear";
export type Split = { x1: number; x2: number };
/** The server's own estimate of the cut lines. */
export type AutoSplit = Split & { isWrap: boolean; useSpine: boolean };

/** One term set everywhere (the single letters 뒤/옆/앞 are retired). */
export const SURFACE_NAMES: Record<Surface, string> = { back: "뒤표지", spine: "책등", front: "앞표지" };
export const SURFACE_ORDER: readonly Surface[] = ["back", "spine", "front"];

/** Below this share of the width the jacket has no spine of its own (the server's SPINE_MIN_SHARE). */
export const SPINE_MIN_SHARE = 0.01;
export const SPINE_MAX_SHARE = 0.12;

export function clampSplit(x1: number, x2: number, width: number): Split {
  if (width < 3) return { x1: 0, x2: width };
  const first = Math.max(1, Math.min(width - 2, Math.round(x1)));
  return { x1: first, x2: Math.max(first + 1, Math.min(width - 1, Math.round(x2))) };
}

/** The lines the review starts with: the server estimate, or none for a portrait jacket. */
export function initialSplit(auto: AutoSplit, width: number): Split {
  return auto.isWrap ? clampSplit(auto.x1, auto.x2, width) : { x1: 0, x2: 0 };
}

export function sameSplit(left: Split, right: Split) {
  return left.x1 === right.x1 && left.x2 === right.x2;
}

export function surfaceBounds(surface: Surface, split: Split, width: number, isWrap: boolean): { x: number; width: number } {
  if (!isWrap) return { x: 0, width };
  if (surface === "back") return { x: 0, width: split.x1 };
  if (surface === "spine") return { x: split.x1, width: split.x2 - split.x1 };
  return { x: split.x2, width: width - split.x2 };
}

/** useSpine on a wrap whose lines enclose nothing: the spine exists, but in another image (the DVD cover). */
export function spineIsBorrowedByDefault(auto: AutoSplit) {
  return auto.isWrap && auto.useSpine && auto.x1 === auto.x2;
}

/** The server cuts the spine from the DVD cover for as long as the lines leave less than 1% between them. */
export function spineIsBorrowed(auto: AutoSplit, split: Split, width: number) {
  return spineIsBorrowedByDefault(auto) && (split.x2 - split.x1) / width < SPINE_MIN_SHARE;
}

export function spineWarning(auto: AutoSplit, split: Split, width: number): "narrow" | "wide" | null {
  if (!auto.isWrap || spineIsBorrowed(auto, split, width)) return null;
  const share = (split.x2 - split.x1) / width;
  return share < SPINE_MIN_SHARE ? "narrow" : share > SPINE_MAX_SHARE ? "wide" : null;
}

/**
 * Moves one cut line to jacket pixel x. A borrowed spine shows as one joined line: pulling a half outward
 * separates the lines (cutting a spine from this jacket), pulling it inward moves the joined pair.
 */
export function placeLine(split: Split, line: "x1" | "x2", x: number, width: number, joined: boolean): Split {
  const target = Math.round(x);
  if (line === "x1") {
    if (joined && target >= split.x2) {
      const first = Math.max(1, Math.min(width - 2, target));
      return { x1: first, x2: first + 1 };
    }
    return { x1: Math.max(1, Math.min(split.x2 - 1, target)), x2: split.x2 };
  }
  if (joined && target <= split.x1) {
    const second = Math.max(2, Math.min(width - 1, target));
    return { x1: second - 1, x2: second };
  }
  return { x1: split.x1, x2: Math.min(width - 1, Math.max(split.x1 + 1, target)) };
}

export function moveLine(split: Split, line: "x1" | "x2", delta: number, width: number, joined: boolean): Split {
  return placeLine(split, line, (line === "x1" ? split.x1 : split.x2) + delta, width, joined);
}

/**
 * Whether the jacket can give this surface. A portrait jacket only has a front; a spine needs a borrowed
 * strip or a gap of at least 1% between the lines (the 1px gap the lines keep otherwise is no spine).
 */
export function candidateAvailable(auto: AutoSplit, split: Split, width: number, surface: Surface): boolean {
  if (surface === "front") return true;
  if (!auto.isWrap) return false;
  if (surface === "back") return split.x1 >= 1;
  return spineIsBorrowed(auto, split, width) || (split.x2 - split.x1) / width >= SPINE_MIN_SHARE;
}

/** The choices as they will be applied: a candidate the jacket cannot give falls back to the current image, or none. */
export function resolveChoices(choices: Record<Surface, SurfaceChoice>, auto: AutoSplit, split: Split, width: number, hasCurrent: Record<Surface, boolean>): Record<Surface, SurfaceChoice> {
  const resolved = { ...choices };
  for (const surface of ["front", "spine", "back"] as const) {
    if (resolved[surface] === "candidate" && !candidateAvailable(auto, split, width, surface)) resolved[surface] = hasCurrent[surface] ? "keep" : "clear";
  }
  return resolved;
}

/** A choice that leaves the destination's image as it is: no change to count. */
export function coversChanged(choices: Record<Surface, SurfaceChoice>, hasCurrent: Record<Surface, boolean>) {
  return (["front", "spine", "back"] as const).filter(surface => choices[surface] === "candidate" || choices[surface] === "clear" && hasCurrent[surface]).length;
}
