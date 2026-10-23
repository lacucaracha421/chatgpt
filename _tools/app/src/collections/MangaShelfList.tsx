import { useEffect, useState } from "react";
import { spineScale, type SpineSize } from "./case/caseDimensions";
import { useLibrary } from "../library/LibraryContext";
import type { CollectionCoverFocus, CollectionSummary, CollectionVolume, LibraryGateway, ReleaseBoardEntry } from "../library/types";
import { workArtworkThumbnailUrl } from "../assets/mediaUrl";
import { usePrivacy } from "../privacy/PrivacyContext";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { MangaShelfRow, mangaShelfData, shelfEditionVolumes, type MangaShelfPick } from "./MangaShelfRow";
import { useMangaScanRevision } from "./mangaScanUpdates";
import { PackedMangaShelves } from "./PackedMangaShelves";
import type { MangaShelfRun } from "./mangaShelfLayout";
type ShelfVolumes = { key: string; volumes: CollectionVolume[]; focuses: CollectionCoverFocus[] };

// Two work reads at a time, reused across continued runs and visits. An updated work or scan
// invalidates its read without discarding the already painted shelf.
const loaded = new Map<string, ShelfVolumes>();
const pending = new Map<string, Promise<ShelfVolumes>>();
const shelfKey = (scope: string, work: CollectionSummary) => JSON.stringify([scope, work.id, work.updatedAt]);
function readShelf(gateway: LibraryGateway, key: string, id: string, refresh = false): Promise<ShelfVolumes> {
  const hit = loaded.get(key);
  if (hit && !refresh) return Promise.resolve(hit);
  const running = pending.get(key);
  if (running) return running;
  const request = queued(async () => {
    const [volumes, focuses] = await Promise.all([
      gateway.listCollectionVolumes(id),
      gateway.listCollectionCoverFocus ? gateway.listCollectionCoverFocus(id).catch(() => [] as CollectionCoverFocus[]) : Promise.resolve([] as CollectionCoverFocus[]),
    ]);
    const value = { key, volumes: shelfEditionVolumes(volumes), focuses };
    loaded.set(key, value);
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
const waiting: (() => void)[] = [];
let running = 0;
function queued<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => { running++; void run().then(resolve, reject).finally(() => { running--; waiting.shift()?.(); }); };
    if (running < 2) start(); else waiting.push(start);
  });
}
/** Test seam: forget the loaded shelves between tests. */
export function resetMangaShelvesForTests() { loaded.clear(); pending.clear(); waiting.length = 0; running = 0; }

/**
 * A work's shelf volumes, read only once `near` (its row is close to the visible list). The stored
 * cover focus is read as is; the detector runs only on the work screen, so a row without a stored
 * head cuts its spines at the centre.
 */
function useShelfVolumes(gateway: LibraryGateway, scope: string, collection: CollectionSummary, near: boolean): ShelfVolumes | null {
  const key = shelfKey(scope, collection);
  const [shown, setShown] = useState<ShelfVolumes | null>(() => loaded.get(key) ?? null);
  const scanRevision = useMangaScanRevision(gateway, near && shown?.key === key ? shown.volumes : null);
  useEffect(() => {
    if (!near) return;
    let active = true;
    // The shown shelf stays until the new read arrives.
    if (scanRevision) loaded.delete(key);
    void readShelf(gateway, key, collection.id).then(value => { if (active) setShown(value); },
      () => { if (active) setShown(current => current?.key === key ? current : { key, volumes: [], focuses: [] }); });
    return () => { active = false; };
  }, [gateway, key, near, collection.id, collection.updatedAt, scanRevision]);
  return loaded.get(key) ?? (shown?.key === key ? shown : null);
}

function PcMangaRow({ collection, run, near, owned, pick, privacy, menu, onPick, onOpen }: {
  run: MangaShelfRun<CollectionSummary>; near: boolean;
  collection: CollectionSummary; owned(edition: number): number | null; pick: MangaShelfPick; privacy: boolean; menu: ContextMenuItem[];
  onPick(pick: MangaShelfPick): void; onOpen(collection: CollectionSummary, volumeId: string | null): void;
}) {
  const { gateway, library } = useLibrary();
  const shelf = useShelfVolumes(gateway, library?.root ?? "", collection, near);
  const edition = shelf?.volumes[0]?.editionIndex ?? 0;
  const count = owned(edition);
  const inkSource = shelf?.volumes.find(volume => volume.spineScan?.side)?.spineScan?.side
    ?? shelf?.volumes.find(volume => count === null || volume.volumeNumber <= count)?.coverArtworkId;
  const manga = shelf ? mangaShelfData(shelf.volumes, shelf.focuses, count, pick?.id === collection.id ? pick.volumeId : null) : null;
  return <ContextMenu items={menu}><div className="manga-shelf-list__item">
    <MangaShelfRow seriesKey={JSON.stringify([collection.id, inkSource])} start={run.start} count={run.count} id={collection.id} title={collection.name} author={collection.author} publisher={collection.publisher} owned={count} manga={manga} privacy={privacy} coverUrl={workArtworkThumbnailUrl}
      onPick={volumeId => onPick({ id: collection.id, volumeId })}
      onOpen={volumeId => onOpen(collection, volumeId)} onEnlarge={volumeId => onOpen(collection, volumeId)} />
  </div></ContextMenu>;
}

/**
 * The PC 만화 list packs work runs onto shared shelves in list order. Rows mount their covers only once
 * they come near the visible list. One spine is picked across the list (a click); a double-click
 * or Enter on the picked spine opens the work at that volume.
 */
export function MangaShelfList({ items, label, size = "normal", board, pick, onPick, menu, onOpen }: {
  items: CollectionSummary[]; label: string; size?: SpineSize;
  /** The 신간 board: owned counts per edition. */board: Map<string, ReleaseBoardEntry> | undefined;
  pick: MangaShelfPick; onPick(pick: MangaShelfPick): void;
  menu(collection: CollectionSummary): ContextMenuItem[];
  onOpen(collection: CollectionSummary, volumeId: string | null): void;
}) {
  const { privacyMode } = usePrivacy();
  const { gateway, library } = useLibrary();
  const scope = library?.root ?? "";
  return <PackedMangaShelves items={items} identity={JSON.stringify([scope, items.map(work => [work.id, work.updatedAt])])} label={label} scale={spineScale("pc", "manga", size)}
    cachedCount={work => loaded.get(shelfKey(scope, work))?.volumes.length}
    estimate={work => {
      const entry = board?.get(work.id);
      return Math.max(1, entry?.releaseSchedule.kakao?.volumes.length ?? entry?.releaseSchedule.mangadex?.volumes.length ?? entry?.ownedVolumes[0]?.count ?? 1);
    }}
    prepare={async work => {
      const key = shelfKey(scope, work);
      return (await readShelf(gateway, key, work.id)).volumes.length;
    }}
    renderRun={(run, near) => <PcMangaRow collection={run.work} run={run} near={near} pick={pick} privacy={privacyMode} menu={menu(run.work)} onPick={onPick} onOpen={onOpen}
      owned={edition => board?.get(run.work.id)?.ownedVolumes.find(entry => entry.editionIndex === edition)?.count ?? null} />} />;
}
