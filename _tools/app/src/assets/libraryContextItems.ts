import { commandErrorMessage } from "../library/errorMessage";
import type { AlbumEntry } from "../library/types";
import { uniqueSources, type ActionHandlers } from "../shared/contextActions";
import { breadcrumbPath } from "../shared/breadcrumb";

function destinationLabel(entry: AlbumEntry, entries: AlbumEntry[]) {
  return breadcrumbPath(entry, entries);
}

/**
 * What the ordinary asset actions do in the folder and character galleries: 출처 복사 and 앨범에 추가.
 * The names, order and enabled conditions come from `imageActionDefs` (shared with the tablet).
 */
export function libraryContextHandlers({ disabled, albums, sourceUrls, onMessage, onAlbum }: {
  disabled: boolean; albums: AlbumEntry[];
  sourceUrls: (string | null)[]; onMessage: (message: string) => void;
  onAlbum: (id: string) => void;
}): ActionHandlers {
  const sources = uniqueSources(sourceUrls);
  return {
    "copy-source": async () => {
      if (disabled || !sources.length) return;
      try {
        await navigator.clipboard.writeText(sources.join("\n"));
        onMessage(sources.length === 1 ? "출처를 복사했습니다." : `출처 ${sources.length}개를 복사했습니다.`);
      } catch (error) {
        onMessage(commandErrorMessage(error, "출처를 복사하지 못했습니다."));
      }
    },
    album: { choices: albums.map(entry => ({ id: entry.id, label: destinationLabel(entry, albums), run: () => onAlbum(entry.id) })) },
  };
}
