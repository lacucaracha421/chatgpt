import { BookmarkIcon } from "@heroicons/react/24/outline";
import { BookmarkIcon as BookmarkSolidIcon } from "@heroicons/react/24/solid";
import type { ComponentProps } from "react";
import { IconButton } from "./IconButton";

type BookmarkToggleProps = Omit<ComponentProps<typeof IconButton>, "icon" | "activeIcon" | "active" | "tone" | "pop"> & {
  bookmarked: boolean;
  /**
   * `corner`: an icon only on a cover's top-right corner, white outline with a soft shadow and
   * the accent fill when on, no button face (DESIGN.md, release calendars). The cover is the
   * positioning parent. `inline`: a ghost icon button in a toolbar or action row.
   */
  form?: "corner" | "inline";
};

/** The one bookmark / 관심 toggle for PC and tablet. */
export function BookmarkToggle({ bookmarked, form = "inline", className, ...props }: BookmarkToggleProps) {
  return <IconButton {...props} icon={BookmarkIcon} activeIcon={BookmarkSolidIcon} active={bookmarked} pop
    className={[form === "corner" ? "ui-bookmark-corner" : "", className].filter(Boolean).join(" ") || undefined} />;
}
