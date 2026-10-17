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

/**
 * 책장 size (작게 / 보통 / 크게); the scale is pixels per millimetre. 크게 is about 1.36x 보통 (user, 2026-10-17: the old
 * 크게 was too close to 보통). At 1.45 px/mm a DVD spine is about 276px tall (user 2026-10-17: kept just under 1.5): the 360px spine thumbnails stay sharp up to a
 * display scale of about 1.25 and are resampled a little (about 1.2x) at 1.5; the drawn templates are sharp at any size.
 */
export type SpineSize = "small" | "normal" | "large" | "huge";
export const SPINE_SIZES: readonly SpineSize[] = ["small", "normal", "large"];
/** AV adds 아주 크게, for looking at each spine on its own. */
export const AV_SPINE_SIZES: readonly SpineSize[] = [...SPINE_SIZES, "huge"];
export const SPINE_SIZE_LABEL: Record<SpineSize, string> = { small: "작게", normal: "보통", large: "크게", huge: "아주 크게" };
/** Games have no 아주 크게: a size saved on the AV tab shows as 크게. */
export const SPINE_SCALE = {
  pc: { small: .9, normal: 1.1, large: 1.45, huge: 1.45 },
  tablet: { small: 1, normal: 1.25, large: 1.7, huge: 1.7 },
} as const satisfies Record<string, Record<SpineSize, number>>;
/**
 * AV 책장 (user, 2026-10-18: "AV 쪽만 크게크게"): AV cases stand larger than games at every size, 크게 most of all.
 * 아주 크게 (user, 2026-10-18: "하나하나 책등을 좀 감상가능하게") stands a DVD about 600px tall on the PC, 530px on the tablet.
 * Above the 360px thumbnails these spines are drawn from the stored artwork itself (`spineNeedsOriginal`).
 */
export const SPINE_SCALE_AV = {
  pc: { small: 1, normal: 1.3, large: 1.8, huge: 3.15 },
  tablet: { small: 1.15, normal: 1.5, large: 2.05, huge: 2.8 },
} as const satisfies Record<keyof typeof SPINE_SCALE, Record<SpineSize, number>>;
/** The 책장 scale for a client, a type tab and a 책등 크기. */
export function spineScale(client: keyof typeof SPINE_SCALE, type: string, size: SpineSize) {
  return (type === "av" ? SPINE_SCALE_AV : SPINE_SCALE)[client][size];
}
/** Stored spine thumbnails are this tall (WORK_ARTWORK_THUMBNAIL_BOUND in the library). */
export const SPINE_THUMBNAIL_PX = 360;
/** Whether a spine drawn at `scale` on a screen of this density needs more pixels than its thumbnail has. */
export function spineNeedsOriginal(platform: CasePlatform, scale: number, devicePixelRatio: number) {
  return casePixels(platform, scale).height * Math.max(1, devicePixelRatio || 1) > SPINE_THUMBNAIL_PX;
}
export const isSpineSize = (value: unknown): value is SpineSize => value === "small" || value === "normal" || value === "large" || value === "huge";

/** One case in whole pixels, so spines never blur: its height, spine thickness and front width. */
export function casePixels(platform: CasePlatform, scale: number): CaseSizeMm {
  const mm = CASE_MM[platform];
  return { height: Math.round(mm.height * scale), spine: Math.max(1, Math.round(mm.spine * scale)), width: Math.round(mm.width * scale) };
}
