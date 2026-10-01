import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { CollectionCoverFocus, CollectionSummary, CollectionVolume, LibraryGateway, ReleaseBoardEntry } from "../library/types";
import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import { usePrivacy } from "../privacy/PrivacyContext";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { MangaShelfRow, mangaShelfData, shelfEditionVolumes, type MangaShelfPick } from "./MangaShelfRow";
type ShelfVolumes = { key: string; volumes: CollectionVolume[]; focuses: CollectionCoverFocus[] };

// Rows read their volumes (and stored head focus) two at a time. The last read of each work is
// kept, so a row that mounts again (scrolling back, switching 보기 or returning from the work)
// shows it at once and then reads again once, in case the work screen changed its volumes.
const loaded = new Map<string, ShelfVolumes>();
const waiting: (() => void)[] = [];
let running = 0;
function queued<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => { running++; void run().then(resolve, reject).finally(() => { running--; waiting.shift()?.(); }); };
    if (running < 2) start(); else waiting.push(start);
  });
}
/** Test seam: forget the loaded shelves between tests. */
export function resetMangaShelvesForTests() { loaded.clear(); waiting.length = 0; running = 0; }

/**
 * A work's shelf volumes, read only once `near` (its row is close to the visible list). The stored
 * cover focus is read as is; the detector runs only on the work screen, so a row without a stored
 * head cuts its spines at the centre.
 */
function useShelfVolumes(gateway: LibraryGateway, scope: string, collection: CollectionSummary, near: boolean): ShelfVolumes | null {
  const key = JSON.stringify([scope, collection.id]);
  const [shown, setShown] = useState<ShelfVolumes | null>(() => loaded.get(key) ?? null);
  useEffect(() => {
    if (!near) return;
    let active = true;
    // The shown shelf stays until the new read arrives.
    void queued(async () => {
      if (!active) return null;
      const [volumes, focuses] = await Promise.all([
        gateway.listCollectionVolumes(collection.id),
        gateway.listCollectionCoverFocus ? gateway.listCollectionCoverFocus(collection.id).catch(() => [] as CollectionCoverFocus[]) : Promise.resolve([] as CollectionCoverFocus[]),
      ]);
      const value = { key, volumes: shelfEditionVolumes(volumes), focuses };
      loaded.set(key, value);
      return value;
    }).then(value => { if (active && value) setShown(value); },
      () => { if (active) setShown(current => current?.key === key ? current : { key, volumes: [], focuses: [] }); });
    return () => { active = false; };
  }, [gateway, key, near, collection.id, collection.updatedAt]);
  return shown?.key === key ? shown : null;
}

function PcMangaRow({ collection, owned, pick, privacy, menu, onPick, onOpen }: {
  collection: CollectionSummary; owned(edition: number): number | null; pick: MangaShelfPick; privacy: boolean; menu: ContextMenuItem[];
  onPick(pick: MangaShelfPick): void; onOpen(collection: CollectionSummary, volumeId: string | null): void;
}) {
  const { gateway, library } = useLibrary();
  const [near, setNear] = useState(false);
  const shelf = useShelfVolumes(gateway, library?.root ?? "", collection, near);
  const edition = shelf?.volumes[0]?.editionIndex ?? 0;
  const count = owned(edition);
  const manga = shelf ? mangaShelfData(shelf.volumes, shelf.focuses, count, pick?.id === collection.id ? pick.volumeId : null) : null;
  return <ContextMenu items={menu}><div className="manga-shelf-list__item">
    <MangaShelfRow id={collection.id} title={collection.name} owned={count} manga={manga} privacy={privacy} coverUrl={workArtworkThumbnailUrl}
      onNear={() => setNear(true)} onPick={volumeId => onPick({ id: collection.id, volumeId })}
      onOpen={volumeId => onOpen(collection, volumeId)} onEnlarge={volumeId => onOpen(collection, volumeId)} />
  </div></ContextMenu>;
}

/**
 * The PC 만화 list as shelves: one row per work, in list order. Rows mount their covers only once
 * they come near the visible list. One spine is picked across the list (a click); a double-click
 * or Enter on the picked spine opens the work at that volume.
 */
export function MangaShelfList({ items, label, board, pick, onPick, menu, onOpen }: {
  items: CollectionSummary[]; label: string;
  /** The 신간 board: owned counts per edition. */board: Map<string, ReleaseBoardEntry> | undefined;
  pick: MangaShelfPick; onPick(pick: MangaShelfPick): void;
  menu(collection: CollectionSummary): ContextMenuItem[];
  onOpen(collection: CollectionSummary, volumeId: string | null): void;
}) {
  const { privacyMode } = usePrivacy();
  return <div className="manga-shelf-list" role="group" aria-label={label}>
    {items.map(collection => <PcMangaRow key={collection.id} collection={collection} pick={pick} privacy={privacyMode} menu={menu(collection)} onPick={onPick} onOpen={onOpen}
      owned={edition => board?.get(collection.id)?.ownedVolumes.find(entry => entry.editionIndex === edition)?.count ?? null} />)}
  </div>;
}
