import {useEffect, useState} from 'react';
import {MangaShelfRow, mangaShelfData, shelfEditionVolumes, type MangaShelfPick} from '../src/collections/MangaShelfRow';
import {localDay} from '../src/shared/displayDate';
import {api} from './transport';
import {useArtworkSet} from './collectionArtwork';
import {coverFocuses, type CollectionDetail, type CollectionSummary} from './collectionModel';
import {sharedVolume} from './CollectionWork';

type Loaded = {key: string; revision: string; item: CollectionDetail};
// List summaries carry no volumes: a row reads its work once it comes near the visible list,
// two works at a time, and keeps the read for the list's publication revision.
const details = new Map<string, Loaded>();
const waiting: (() => void)[] = [];
let running = 0;
function queued<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { const index = waiting.indexOf(start); if (index >= 0) waiting.splice(index, 1); reject(new DOMException('Cancelled', 'AbortError')); };
    const start = () => {
      signal.removeEventListener('abort', cancel);
      if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); waiting.shift()?.(); return; }
      running++; void run().then(resolve, reject).finally(() => { running--; waiting.shift()?.(); });
    };
    signal.addEventListener('abort', cancel, {once: true});
    if (running < 2) start(); else waiting.push(start);
  });
}
/** Test seam: forget the read works between tests. */
export function resetMangaShelfDetails() { details.clear(); waiting.length = 0; running = 0; }

function TabletMangaRow({work, revision, active, privacy, owned, pick, onPick, onOpen}: {
  work: CollectionSummary; revision: string; active: boolean; privacy: boolean; owned(edition: number): number | null;
  pick: MangaShelfPick; onPick(pick: MangaShelfPick): void; onOpen(id: string, at: {volumeId: string; edition: number} | null): void;
}) {
  const [near, setNear] = useState(false);
  const key = JSON.stringify([work.id, revision]);
  const [shown, setShown] = useState<Loaded | null>(() => details.get(key) ?? null);
  useEffect(() => {
    if (!near || !active || shown?.key === key) return;
    const hit = details.get(key);
    if (hit) { setShown(hit); return; }
    // A newer publication keeps the shown shelf until the work is read again.
    const controller = new AbortController();
    void queued(() => api<{revision: string; item: CollectionDetail}>(`/v1/collections/${encodeURIComponent(work.id)}`, controller.signal), controller.signal).then(result => {
      const value = {key, revision: result.revision, item: result.item};
      details.set(key, value);
      if (!controller.signal.aborted) setShown(value);
    }, () => undefined);
    return () => controller.abort();
  }, [near, active, key, shown?.key, work.id]);
  const today = localDay();
  const volumes = shown ? shelfEditionVolumes(shown.item.volumes).map(volume => sharedVolume(volume, today)) : [];
  const spines = useArtworkSet(shown?.item ?? null, privacy ? {} : Object.fromEntries(volumes.flatMap(volume => volume.coverArtworkId ? [[volume.coverArtworkId, {id: volume.coverArtworkId, original: false}]] : [])), shown?.revision ?? '', active && near, false);
  const edition = volumes[0]?.editionIndex ?? 0;
  const count = owned(edition);
  const picked = pick?.id === work.id ? pick.volumeId : null;
  const manga = shown ? mangaShelfData(volumes, coverFocuses(shown.item.volumes), count, picked) : null;
  // A first tap picks the volume (its cover turns forward); a tap on the picked volume opens the work there.
  return <MangaShelfRow id={work.id} title={work.name} owned={count} manga={manga} privacy={privacy} coverUrl={id => spines.urls[id] ?? null}
    onNear={() => setNear(true)} onPick={volumeId => volumeId === picked ? onOpen(work.id, {volumeId, edition}) : onPick({id: work.id, volumeId})}
    onOpen={volumeId => onOpen(work.id, volumeId ? {volumeId, edition} : null)}/>;
}

/** The tablet 만화 list as the PC's bookcase rows (shared `MangaShelfRow`), one per work in list order. */
export function TabletMangaShelf({items, label, revision, active, privacy, owned, pick, onPick, onOpen}: {
  items: CollectionSummary[]; label: string; revision: string; active: boolean; privacy: boolean;
  owned(work: CollectionSummary, edition: number): number | null;
  pick: MangaShelfPick; onPick(pick: MangaShelfPick): void;
  onOpen(id: string, at: {volumeId: string; edition: number} | null): void;
}) {
  return <div className="manga-shelf-list" role="group" aria-label={label}>
    {items.map(work => <TabletMangaRow key={work.id} work={work} revision={revision} active={active} privacy={privacy} owned={edition => owned(work, edition)} pick={pick} onPick={onPick} onOpen={onOpen}/>)}
  </div>;
}
