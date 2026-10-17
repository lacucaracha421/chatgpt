import type {CollectionSummary} from '../collectionModel';
import {koreanReleases} from '../collectionReleasesModel';
import type {UpcomingHomeEntry, UpcomingRow} from '../homeDashboard';
import type {ReleaseKind} from '../../src/home/homeModel';

/**
 * Releases of the tablet Home month grid that are not NEW: the dated Korean volumes of watched manga, wishlist
 * titles with an exact date and local works with a release date, past ones included. The shaping reads only
 * what Home already holds (the cover shelf, the upcoming reply), so paging a month costs no request.
 */
export type TabletReleaseTarget = {kind: 'work'; id: string} | {kind: 'title'; entry: UpcomingHomeEntry};
export type TabletPlainRelease = {key: string; kind: ReleaseKind; date: string; name: string; detail: string; target: TabletReleaseTarget};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ownedOf = (work: CollectionSummary, edition: number) => work.ownedVolumes?.find(entry => entry.editionIndex === edition)?.count ?? null;

export function plainReleaseRows({works, mangaUpcoming, titles, today, start, end}: {
  works: CollectionSummary[]; mangaUpcoming: UpcomingRow[];
  /** Wishlist titles the user follows (muted ones are skipped here). */
  titles: (UpcomingHomeEntry & {muted?: boolean})[];
  today: string; start: string; end: string;
}): TabletPlainRelease[] {
  const inRange = (date: string | null | undefined): date is string => !!date && DATE.test(date) && date >= start && date <= end;
  const rows = new Map<string, TabletPlainRelease>();
  const manga = (id: string, name: string, date: string, volume: number) => {
    const key = `manga:${id}:${volume}`;
    if (!rows.has(key)) rows.set(key, {key, kind: 'manga', date, name, detail: `${volume}권`, target: {kind: 'work', id}});
  };
  // Volumes of the shelf (released or still ahead); before the shelf is read, the upcoming reply stands in for the ahead ones.
  for (const row of koreanReleases(works.filter(work => work.type === 'manga' && work.releaseWatch?.enabled), ownedOf, [], today))
    for (const volume of row.volumes) if (inRange(volume.date)) manga(row.work.id, row.work.name, volume.date, volume.volumeNumber);
  for (const row of mangaUpcoming) if (inRange(row.date)) manga(row.id, row.name, row.date, row.volumeNumber);
  for (const entry of titles) {
    if (entry.muted || entry.precision !== 'exact' || !inRange(entry.date)) continue;
    rows.set(`title:${entry.id}`, {key: `title:${entry.id}`, kind: entry.kind, date: entry.date, name: entry.title, detail: '', target: {kind: 'title', entry}});
  }
  const all = [...rows.values()];
  for (const work of works) {
    if (work.type === 'av' || work.type === 'manga' || !inRange(work.releaseDate)) continue;
    if (all.some(row => row.name === work.name && row.date === work.releaseDate)) continue;
    rows.set(`work:${work.id}`, {key: `work:${work.id}`, kind: work.type, date: work.releaseDate, name: work.name, detail: '', target: {kind: 'work', id: work.id}});
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'ko'));
}
