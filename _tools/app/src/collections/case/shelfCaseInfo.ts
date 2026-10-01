import type { CollectionShelfCase, LibraryGateway } from "../../library/types";

/** What a shelf case prints beyond the list row: the owned device and the chosen spine artwork. */
export type ShelfInfo = Pick<CollectionShelfCase, "ownedPlatform" | "spineArtworkId">;
type Waiting = Map<string, { resolve(info: ShelfInfo): void; reject(error: unknown): void }[]>;
const NO_SHELF_INFO: ShelfInfo = { ownedPlatform: null, spineArtworkId: null };
const waiting = new WeakMap<LibraryGateway, Waiting>();
/** The last read per library and work: a case that mounts again (switching type, returning from a work) prints at once, then reads again. */
const remembered = new Map<string, ShelfInfo>();

export const shelfInfoKey = (root: string, collectionId: string) => `${root}\n${collectionId}`;
export const rememberedShelfInfo = (key: string) => remembered.get(key);
export const sameShelfInfo = (a: ShelfInfo | undefined, b: ShelfInfo) => a?.ownedPlatform === b.ownedPlatform && a.spineArtworkId === b.spineArtworkId;
/** Test seam: forget remembered shelf cases between tests. */
export function resetShelfCasesForTests() { remembered.clear(); }

/**
 * Cases that ask in the same task share one read for the whole list instead of two commands per
 * case: hundreds of single commands kept the PC window from drawing frames for most of a second.
 */
export function readShelfInfo(gateway: LibraryGateway, root: string, collectionId: string): Promise<ShelfInfo> {
  const read = gateway.listCollectionShelfCases;
  if (!read) return Promise.resolve(NO_SHELF_INFO);
  let batch = waiting.get(gateway);
  if (!batch) {
    const requests: Waiting = new Map();
    batch = requests;
    waiting.set(gateway, requests);
    queueMicrotask(() => {
      waiting.delete(gateway);
      read([...requests.keys()]).then(cases => {
        const found = new Map(cases.map(item => [item.collectionId, item]));
        for (const [id, callers] of requests) callers.forEach(caller => caller.resolve(found.get(id) ?? NO_SHELF_INFO));
      }, error => { for (const callers of requests.values()) callers.forEach(caller => caller.reject(error)); });
    });
  }
  const requests = batch;
  return new Promise<ShelfInfo>((resolve, reject) => { requests.set(collectionId, [...requests.get(collectionId) ?? [], { resolve, reject }]); })
    .then(info => { remembered.set(shelfInfoKey(root, collectionId), info); return info; });
}
