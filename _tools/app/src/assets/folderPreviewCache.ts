import type { SeriesFolder } from "../characters/hubApi";
import type { LibraryGateway } from "../library/types";

// Undefined means unresolved, null means a successful read confirmed no image.
// Gateway identity also isolates providers before a library has opened.
type FolderPreviewCache = {
  thumbnails: Map<string, string | null>;
  shelves: Map<string, SeriesFolder[]>;
};
const caches = new WeakMap<LibraryGateway, Map<string, FolderPreviewCache>>();

export function folderPreviewCache(gateway: LibraryGateway, root: string = ""): FolderPreviewCache {
  let libraries = caches.get(gateway);
  if (!libraries) { libraries = new Map(); caches.set(gateway, libraries); }
  let cache = libraries.get(root);
  if (!cache) { cache = { thumbnails: new Map(), shelves: new Map() }; }
  rememberFolderPreview(libraries, root, cache, 4);
  return cache;
}

export function rememberFolderPreview<T>(cache: Map<string, T>, id: string, value: T, limit = 256) {
  cache.delete(id);
  cache.set(id, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}
