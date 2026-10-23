import {useAndroidBack} from "./cards/useAndroidBack";
import {mangaScanRequests, mangaScanVolumes} from './mangaScans';
import {useEffect, useState} from 'react';
import {spineScale, type SpineSize} from '../src/collections/case/caseDimensions';
import {MangaShelfRow, mangaShelfData, shelfEditionVolumes, type MangaShelfPick} from '../src/collections/MangaShelfRow';
import {localDay} from '../src/shared/displayDate';
import {api} from './transport';
import {useArtworkSet} from './collectionArtwork';
import {coverFocuses, type CollectionDetail, type CollectionSummary} from './collectionModel';
import {sharedVolume} from './CollectionWork';
import {PackedMangaShelves} from '../src/collections/PackedMangaShelves';
import type {MangaShelfRun} from '../src/collections/mangaShelfLayout';

type Loaded = {key: string; revision: string; item: CollectionDetail | null};
// List summaries carry no volumes: a row reads its work once it comes near the visible list,
// two works at a time, and keeps the read for the list's publication revision.
const details = new Map<string, Loaded>();
const pending = new Map<string, {signal: AbortSignal; request: Promise<Loaded>}>();
const detailKey = (work: CollectionSummary, revision: string) => JSON.stringify([work.id, revision, work.scanRevision]);
async function readDetail(work: CollectionSummary, revision: string, signal: AbortSignal): Promise<Loaded> {
  const key = detailKey(work, revision);
  const hit = details.get(key);
  if (hit) return hit;
  const shared = pending.get(key);
  if (shared) {
    try { return await shared.request; }
    catch (error) {
      // The run that queued this read left before it started; another continued run still needs it.
      if (!signal.aborted && pending.get(key) !== shared) return readDetail(work, revision, signal);
      throw error;
    }
  }
  const request = // A started read always finishes into the cache: re-packed or continued runs remount and must not read twice.
  queued(() => api<{revision: string; item?: CollectionDetail}>(`/v1/collections/${encodeURIComponent(work.id)}`), signal).then(result => {
    const value = {key, revision: result.revision, item: result.item ?? null};
    details.set(key, value);
    return value;
  }).finally(() => { if (pending.get(key)?.request === request) pending.delete(key); });
  pending.set(key, {signal, request});
  return request;
}
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
export function resetMangaShelfDetails() { details.clear(); pending.clear(); waiting.length = 0; running = 0; }

function TabletMangaRow({work, run, near, revision, active, privacy, owned, pick, onPick, onOpen, onActions}: {
  run: MangaShelfRun<CollectionSummary>; near: boolean;
  work: CollectionSummary; revision: string; active: boolean; privacy: boolean; owned(edition: number): number | null;
  pick: MangaShelfPick; onPick(pick: MangaShelfPick): void; onOpen(id: string, at: {volumeId: string; edition: number} | null): void;
  onActions?(work: CollectionSummary): void;
}) {
  const key = detailKey(work, revision);
  const [shown, setShown] = useState<Loaded | null>(() => details.get(key) ?? null);
  useEffect(() => {
    if (!near || !active || shown?.key === key) return;
    const hit = details.get(key);
    if (hit) { setShown(hit); return; }
    // A newer publication keeps the shown shelf until the work is read again.
    const controller = new AbortController();
    void readDetail(work, revision, controller.signal).then(value => {
      if (!controller.signal.aborted) setShown(value);
    }, () => undefined);
    return () => controller.abort();
  }, [near, active, key, shown?.key, work.id]);
  const today = localDay();
  const volumes = shown?.item ? shelfEditionVolumes(shown.item.volumes).map(volume => sharedVolume(volume, today)) : [];
  const visible = volumes.slice(run.start, run.start + run.count);
  const picked = pick?.id === work.id ? pick.volumeId : null;
  const spines = useArtworkSet(shown?.item ?? null, privacy ? {} : {...Object.fromEntries(visible.flatMap(volume => volume.coverArtworkId ? [[volume.coverArtworkId, {id: volume.coverArtworkId, original: false}]] : [])), ...mangaScanRequests(visible, picked)}, shown?.revision ?? '', active && near, false);
  const edition = volumes[0]?.editionIndex ?? 0;
  const count = owned(edition);
  const inkScan = shown?.item?.volumes.find(volume => volume.editionIndex === edition && volume.spineScan?.side)?.spineScan?.side;
  const inkSource = inkScan ?? volumes.find(volume => count === null || volume.volumeNumber <= count)?.coverArtworkId;
  const manga = shown ? mangaShelfData(mangaScanVolumes(volumes, spines.urls), shown.item ? coverFocuses(shown.item.volumes) : [], count, picked) : null;
  // The shared shelf pulls out on the first tap; the floating book opens the work.
  return <MangaShelfRow seriesScan={Boolean(inkScan)} seriesKey={JSON.stringify([work.id, inkSource])} start={run.start} count={run.count} pullPending={!spines.ready} useBack={useAndroidBack} id={work.id} title={work.name} author={shown?.item?.author ?? work.author} publisher={shown?.item?.publisher ?? work.publisher} owned={count} manga={manga} privacy={privacy} coverUrl={id => spines.urls[id] ?? null} touchTargets onLongPress={onActions ? () => onActions(work) : undefined}
    onPick={volumeId => onPick({id: work.id, volumeId})}
    onEnlarge={volumeId => onOpen(work.id, {volumeId, edition})} onOpen={volumeId => onOpen(work.id, volumeId ? {volumeId, edition} : null)}/>;
}

const estimateShelfCount = (work: CollectionSummary) => Math.max(1, work.volumes ? shelfEditionVolumes(work.volumes).length : work.releaseSchedule?.kakao?.volumes.length ?? work.releaseSchedule?.mangadex?.volumes.length ?? work.ownedVolumes?.[0]?.count ?? 1);

/** The tablet uses the PC's shared packing, with tablet scale and touch actions. */
export function TabletMangaShelf({items, label, size = 'normal', revision, active, privacy, owned, pick, onPick, onOpen, onActions}: {
  items: CollectionSummary[]; label: string; size?: SpineSize; revision: string; active: boolean; privacy: boolean;
  owned(work: CollectionSummary, edition: number): number | null;
  pick: MangaShelfPick; onPick(pick: MangaShelfPick): void;
  onOpen(id: string, at: {volumeId: string; edition: number} | null): void;
  /** Long press on a work's row opens its action sheet. */onActions?(work: CollectionSummary): void;
}) {
  return <PackedMangaShelves items={items} identity={JSON.stringify([revision, items.map(work => work.id)])} label={label} scale={spineScale('tablet', 'manga', size)} tablet active={active}
    cachedCount={work => { const hit = details.get(detailKey(work, revision)); return hit ? shelfEditionVolumes(hit.item?.volumes ?? []).length : undefined; }}
    estimate={estimateShelfCount}
    prepare={async (work, signal) => shelfEditionVolumes((await readDetail(work, revision, signal)).item?.volumes ?? []).length}
    renderRun={(run, near) => <TabletMangaRow work={run.work} run={run} near={near} revision={revision} active={active} privacy={privacy} owned={edition => owned(run.work, edition)} pick={pick} onPick={onPick} onOpen={onOpen} onActions={onActions}/>} />;
}
