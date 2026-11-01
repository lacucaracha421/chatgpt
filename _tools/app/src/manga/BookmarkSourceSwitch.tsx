import { SegmentedControl } from "../shared/ui/SegmentedControl";

export type BookmarkSource = "catalog" | "somi";
const KEY = "lakomics.mangaBookmarkSource.v1";
export function readBookmarkSource(): BookmarkSource {
  try { return localStorage.getItem(KEY) === "somi" ? "somi" : "catalog"; }
  catch { return "catalog"; }
}
export function writeBookmarkSource(value: BookmarkSource): void {
  try { localStorage.setItem(KEY, value); } catch { /* Retain the session choice. */ }
}
export function BookmarkSourceSwitch({ value, onChange, fullWidth = false }: {
  value: BookmarkSource; onChange(value: BookmarkSource): void; fullWidth?: boolean;
}) {
  return <SegmentedControl label="북마크 출처" value={value} onChange={onChange} fullWidth={fullWidth}
    options={[{ value: "catalog", label: "카탈로그" }, { value: "somi", label: "소미" }]} />;
}
