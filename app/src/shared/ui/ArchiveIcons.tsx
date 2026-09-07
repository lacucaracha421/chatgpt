import type { SVGProps } from "react";

// Small, squared navigation glyphs. Keep symbols legible without decorative HUD detail.
export const archivePaths = {
  folder: "M3 6h7l2 3h9v11H3zM3 12h18M6 16h4",
  assets: "M5 3h14v18H5zM8 7h8M8 11h8M8 15h4M2 6v12M22 6v12",
  book: "M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3zM12 6v15M6 8h3M15 8h3",
  photo: "M3 3h18v18H3zM3 16l6-6 5 5 3-3 4 4M16 6h2v2h-2z",
  inbox: "M5 4h14l3 12v5H2v-5zM2 16h6l2 2h4l2-2h6M8 8h8",
  history: "M5 3h14v18H5zM2 6h6M2 18h6M12 7v6h4",
  trash: "M4 6h16M8 3h8v3M6 6v15h12V6M10 10v7M14 10v7",
  settings: "M3 6h18M3 12h18M3 18h18M7 4h3v4H7zM15 10h3v4h-3zM7 16h3v4H7z",
  more: "M3 10h4v4H3zM10 10h4v4h-4zM17 10h4v4h-4z",
  search: "M4 3h10l3 3v8l-3 3H6l-3-3V6zM16 16l6 6",
  plus: "M12 4v16M4 12h16",
  rocket: "M8 7l8-4h5v5l-4 8-5 1-5-5zM8 7H4l-2 6 5-1M17 16v4l-6 2 1-5M5 17l-3 5 5-3M15 6h3v3h-3z",
  sparkles: "M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3zM19 2v4M17 4h4",
  star: "M12 2l3 7h7l-6 5 2 8-6-4-6 4 2-8-6-5h7z",
  film: "M3 3h18v18H3zM7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4",
  calendar: "M3 5h18v16H3zM7 2v6M17 2v6M3 10h18M7 14h3v3H7z",
  archive: "M3 3h18v5H3zM5 8v13h14V8M9 12h6",
  bookmark: "M6 3h12v18l-6-4-6 4z",
  note: "M4 3h16v18H4zM8 7h8M8 11h8M8 15h5",
} as const;
type Props = SVGProps<SVGSVGElement>;
function Glyph({ kind, ...props }: Props & { kind: keyof typeof archivePaths }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="square" strokeLinejoin="miter" {...props}><path d={archivePaths[kind]} /></svg>;
}
export const FolderIcon = (props: Props) => <Glyph kind="folder" {...props} />;
export const RectangleStackIcon = (props: Props) => <Glyph kind="assets" {...props} />;
export const BookOpenIcon = (props: Props) => <Glyph kind="book" {...props} />;
export const PhotoIcon = (props: Props) => <Glyph kind="photo" {...props} />;
export const InboxIcon = (props: Props) => <Glyph kind="inbox" {...props} />;
export const CalendarIcon = (props: Props) => <Glyph kind="history" {...props} />;
export const TrashIcon = (props: Props) => <Glyph kind="trash" {...props} />;
export const Cog6ToothIcon = (props: Props) => <Glyph kind="settings" {...props} />;
export const AdjustmentsHorizontalIcon = Cog6ToothIcon;
export const EllipsisHorizontalIcon = (props: Props) => <Glyph kind="more" {...props} />;
export const MagnifyingGlassIcon = (props: Props) => <Glyph kind="search" {...props} />;
export const PlusIcon = (props: Props) => <Glyph kind="plus" {...props} />;
export const BookmarkIcon = (props: Props) => <Glyph kind="bookmark" {...props} />;
export const NoteIcon = (props: Props) => <Glyph kind="note" {...props} />;
