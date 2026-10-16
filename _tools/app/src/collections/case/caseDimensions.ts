import type { CasePlatform } from "./CollectionCase";

/** Approximate retail package sizes in millimetres (the spine shelf draws cases at real proportions). */
export type CaseSizeMm = { height: number; spine: number; width: number };
const DVD: CaseSizeMm = { height: 190, spine: 14, width: 135 };
const PLAYSTATION: CaseSizeMm = { height: 172, spine: 13, width: 135 };
const SWITCH: CaseSizeMm = { height: 170, spine: 11, width: 105 };
export const CASE_MM: Record<CasePlatform, CaseSizeMm> = {
  pc: DVD, other: DVD, av: DVD, film: DVD, book: DVD,
  ps5: PLAYSTATION, ps4: PLAYSTATION,
  sw: SWITCH, sw2: SWITCH,
};

/** 책장 size (작게 / 보통 / 크게); the scale is pixels per millimetre. */
export type SpineSize = "small" | "normal" | "large";
export const SPINE_SIZES: readonly SpineSize[] = ["small", "normal", "large"];
export const SPINE_SIZE_LABEL: Record<SpineSize, string> = { small: "작게", normal: "보통", large: "크게" };
export const SPINE_SCALE = {
  pc: { small: .9, normal: 1.1, large: 1.35 },
  tablet: { small: 1, normal: 1.25, large: 1.5 },
} as const satisfies Record<string, Record<SpineSize, number>>;
export const isSpineSize = (value: unknown): value is SpineSize => value === "small" || value === "normal" || value === "large";

/** One case in whole pixels, so spines never blur: its height, spine thickness and front width. */
export function casePixels(platform: CasePlatform, scale: number): CaseSizeMm {
  const mm = CASE_MM[platform];
  return { height: Math.round(mm.height * scale), spine: Math.max(1, Math.round(mm.spine * scale)), width: Math.round(mm.width * scale) };
}
