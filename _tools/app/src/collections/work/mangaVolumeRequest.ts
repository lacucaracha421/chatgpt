/**
 * The volume a list shelf asked the manga work screen to open on. The PC's collection view
 * carries only the work id, so the shelf leaves the volume here; the work screen reads it when its
 * volumes arrive and forgets it once applied (a StrictMode re-run still finds it).
 */
const requested = new Map<string, string>();

export function requestMangaVolume(collectionId: string, volumeId: string) { requested.set(collectionId, volumeId); }
export function requestedMangaVolume(collectionId: string): string | null { return requested.get(collectionId) ?? null; }
export function forgetMangaVolume(collectionId: string) { requested.delete(collectionId); }
