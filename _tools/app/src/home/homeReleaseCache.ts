import type { ReleaseCalendar, ReleaseCalendarSource, ReleaseWishlistItem } from "../library/types";

/**
 * The last server-owned wishlist and calendar source status Home read, per library. Home shows
 * this at once and revalidates in the background, so the server round trips never gate it.
 * Storage can be unavailable; every read then reports "no cache" and every write is dropped.
 */
const WISHLIST_KEY = "lakomics.home.wishlist.v1:";
const CALENDAR_SOURCES_KEY = "lakomics.home.calendar-sources.v1:";

export function readWishlistCache(root: string): ReleaseWishlistItem[] | null {
  if (!root) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(WISHLIST_KEY + root) ?? "null");
    if (!Array.isArray(saved)) return null;
    return saved.every(item => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.kind === "string")
      ? saved as ReleaseWishlistItem[] : null;
  } catch { return null; }
}

export function writeWishlistCache(root: string, items: ReleaseWishlistItem[]) {
  if (!root) return;
  try { localStorage.setItem(WISHLIST_KEY + root, JSON.stringify(items)); } catch { /* Storage can be disabled. */ }
}

/** The calendar as far as Home uses it: the provider status rows, with no entries. */
export function readCalendarSourcesCache(root: string): ReleaseCalendar | null {
  if (!root) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(CALENDAR_SOURCES_KEY + root) ?? "null");
    if (!Array.isArray(saved) || !saved.every(source => source && typeof source.provider === "string")) return null;
    return { rangeStart: "", rangeEnd: "", entries: [], sources: saved as ReleaseCalendarSource[] };
  } catch { return null; }
}

export function writeCalendarSourcesCache(root: string, calendar: ReleaseCalendar) {
  if (!root) return;
  try { localStorage.setItem(CALENDAR_SOURCES_KEY + root, JSON.stringify(calendar.sources ?? [])); } catch { /* Storage can be disabled. */ }
}
