import type { AlbumEntry, ClassificationEntry } from "../library/types";
import type { ContextMenuItem } from "../shared/ui/ContextMenu";

function destinationLabel(entry: ClassificationEntry | AlbumEntry, entries: (ClassificationEntry | AlbumEntry)[]) {
  const names = [entry.name], seen = new Set([entry.id]);
  let parent = entries.find(item => item.id === entry.parentId);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id); names.unshift(parent.name);
    const parentId = parent.parentId;
    parent = entries.find(item => item.id === parentId);
  }
  return names.join(" / ");
}

/** Ordinary asset actions use the same menu in folder and character galleries. */
export function libraryContextItems({ count, busy, classifications, albums, onFavorite, onMove, onAlbum }: {
  count: number; busy: boolean; classifications: ClassificationEntry[]; albums: AlbumEntry[];
  onFavorite: (favorite: boolean) => void; onMove: (id: string | null) => void; onAlbum: (id: string) => void;
}): ContextMenuItem[] {
  const disabled = busy || count === 0;
  return [
    { id: "count", label: `${count}개 선택`, disabled: true, onSelect: () => undefined },
    { id: "favorite", label: "좋아요 켜기", disabled, onSelect: () => onFavorite(true) },
    { id: "unfavorite", label: "좋아요 끄기", disabled, onSelect: () => onFavorite(false) },
    { id: "move", label: "폴더로 이동", disabled, onSelect: () => undefined, children: [
      { id: "unsorted", label: "미분류", onSelect: () => onMove(null) },
      ...classifications.map(entry => ({ id: entry.id, label: destinationLabel(entry, classifications), onSelect: () => onMove(entry.id) })),
    ] },
    { id: "album", label: "앨범에 추가", disabled: disabled || !albums.length, onSelect: () => undefined,
      children: albums.map(entry => ({ id: entry.id, label: destinationLabel(entry, albums), onSelect: () => onAlbum(entry.id) })) },
  ];
}
