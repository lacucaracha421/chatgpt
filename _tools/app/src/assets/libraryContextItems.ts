import { commandErrorMessage } from "../library/errorMessage";
import type { AlbumEntry } from "../library/types";
import type { ContextMenuItem } from "../shared/ui/ContextMenu";

function destinationLabel(entry: AlbumEntry, entries: AlbumEntry[]) {
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
export function libraryContextItems({ count, busy, albums, sourceUrls, onMessage, onAlbum }: {
  count: number; busy: boolean; albums: AlbumEntry[];
  sourceUrls: (string | null)[]; onMessage: (message: string) => void;
  onAlbum: (id: string) => void;
}): ContextMenuItem[] {
  const disabled = busy || count === 0;
  const sources = [...new Set(sourceUrls.map(url => url?.trim()).filter((url): url is string => Boolean(url)))];
  return [
    { id: "count", label: `${count}개 선택`, disabled: true, onSelect: () => undefined },
    { id: "copy-source", label: "출처 복사", disabled: disabled || sources.length === 0, onSelect: async () => {
      if (disabled || !sources.length) return;
      try {
        await navigator.clipboard.writeText(sources.join("\n"));
        onMessage(sources.length === 1 ? "출처를 복사했습니다." : `출처 ${sources.length}개를 복사했습니다.`);
      } catch (error) {
        onMessage(commandErrorMessage(error, "출처를 복사하지 못했습니다."));
      }
    } },
    { id: "album", label: "앨범에 추가", disabled: disabled || !albums.length, onSelect: () => undefined,
      children: albums.map(entry => ({ id: entry.id, label: destinationLabel(entry, albums), onSelect: () => onAlbum(entry.id) })) },
  ];
}
