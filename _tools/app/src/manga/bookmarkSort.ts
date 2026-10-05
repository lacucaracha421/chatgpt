/** Shared PC/tablet wording and device-local bookmark ordering. */
export type BookmarkSort = "latest" | "bookmarkAdded";
export const BOOKMARK_SORT_OPTIONS: { value: BookmarkSort; label: string }[] = [
  { value: "latest", label: "최신순" },
  { value: "bookmarkAdded", label: "최근 추가순" },
];
const KEY = "lakomics.catalogBookmarkSort.v1";
export function readBookmarkSort(): BookmarkSort {
  try { return localStorage.getItem(KEY) === "bookmarkAdded" ? "bookmarkAdded" : "latest"; }
  catch { return "latest"; }
}
export function writeBookmarkSort(value: BookmarkSort): void {
  try { localStorage.setItem(KEY, value); } catch { /* Keep the session choice if storage is unavailable. */ }
}
