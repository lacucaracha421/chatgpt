import {
  ArrowsRightLeftIcon, BookOpenIcon, Cog6ToothIcon, DocumentTextIcon, HomeIcon, LockClosedIcon, PhotoIcon, RectangleStackIcon, UserIcon,
} from "@heroicons/react/24/outline";
import type { IconGlyph } from "./IconButton";

/**
 * One icon per area for PC and tablet: the rail, the bottom navigation, 찾기 and 더보기 entries.
 * `manga` is 망가 on the PC and 카탈로그 on the tablet.
 */
export const AREA_ICONS = {
  home: HomeIcon,
  assets: PhotoIcon,
  collections: RectangleStackIcon,
  manga: BookOpenIcon,
  notes: DocumentTextIcon,
  private_vault: LockClosedIcon,
  exchange: ArrowsRightLeftIcon,
  artists: UserIcon,
  settings: Cog6ToothIcon,
} as const satisfies Record<string, IconGlyph>;

export type AreaIconKey = keyof typeof AREA_ICONS;
