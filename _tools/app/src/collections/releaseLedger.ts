import type { CollectionSummary, ReleaseBoardEntry, ReleaseInboxItem } from "../library/types";
import { displayDDay, displayDate, displayCount } from "../shared/displayDate";
import { japanReleases, koreanReleases, type KoreanVolume } from "./releaseCaption";

export type ReleaseLedgerChip = { volumeNumber: number; kind: "new" | "plain" | "upcoming"; date: string | null; released: boolean; label: string };
export type ReleaseLedgerRow = {
  work: CollectionSummary;
  owned: number | null;
  chips: ReleaseLedgerChip[];
  date: string | null;
  status: string;
  ahead: string | null;
  items: ReleaseInboxItem[];
};

function ledgerRow(work: CollectionSummary, owned: number | null, volumes: KoreanVolume[], items: ReleaseInboxItem[], today: string, ahead: number | null = null): ReleaseLedgerRow {
  const now = new Date(`${today}T12:00:00`);
  const upcoming = volumes.filter(volume => volume.upcoming && volume.date).map(volume => volume.date!).sort()[0];
  const latest = volumes.filter(volume => volume.released && volume.date).map(volume => volume.date!).sort().reverse()[0];
  const chips = volumes.map((volume): ReleaseLedgerChip => ({
    volumeNumber: volume.volumeNumber,
    kind: volume.upcoming ? "upcoming" : volume.released && volume.fresh ? "new" : "plain",
    date: volume.date,
    released: volume.released,
    label: `${displayCount(volume.volumeNumber, "권")}${volume.upcoming ? ` ${volume.date ? displayDate(volume.date, now) : "미정"}` : ""}`,
  }));
  return {
    work, owned, chips, date: upcoming ?? latest ?? null, items,
    status: items.length ? "NEW" : upcoming ? displayDDay(upcoming, now)! : volumes.some(volume => volume.upcoming) ? "발매 예정" : !volumes.some(volume => volume.released) && volumes.length ? "발매일 미정" : `미보유 ${displayCount(volumes.filter(volume => volume.released).length)}`,
    ahead: ahead ? `한국보다 ${displayCount(ahead, "권")} 앞섬` : null,
  };
}

/** The chosen ledger order: unread first, released/unowned next, upcoming last; date then title. */
function orderRows(rows: ReleaseLedgerRow[]): ReleaseLedgerRow[] {
  const group = (row: ReleaseLedgerRow) => row.items.length ? 0 : row.chips.some(chip => chip.released) ? 1 : 2;
  return rows.sort((a, b) => group(a) - group(b)
    || (a.date && b.date ? group(a) === 2 ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date) : Number(!a.date) - Number(!b.date))
    || a.work.name.localeCompare(b.work.name, "ko"));
}

export function koreanReleaseLedger(works: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>, today: string): ReleaseLedgerRow[] {
  return orderRows(koreanReleases(works, board, inbox, today).map(row => ledgerRow(row.work, row.owned, row.volumes, inbox.get(row.work.id) ?? [], today)));
}

/** MangaDex supplies volume/edition identity, but no release date; never invent one from check time. */
export function japanReleaseLedger(works: CollectionSummary[], board: Map<string, ReleaseBoardEntry>, inbox: Map<string, ReleaseInboxItem[]>, today: string): ReleaseLedgerRow[] {
  return orderRows(japanReleases(works, board, inbox).map(row => {
    const entry = board.get(row.work.id)!;
    const schedule = entry.releaseSchedule.mangadex!;
    const latestEdition = [...schedule.volumes].sort((a, b) => b.volumeNumber - a.volumeNumber).find(volume => volume.editionIndex !== null)?.editionIndex;
    const ownedFor = (editionIndex: number | null | undefined) => entry.ownedVolumes.find(owned => owned.editionIndex === editionIndex)?.count ?? null;
    const owned = ownedFor(latestEdition);
    const items = inbox.get(row.work.id) ?? [];
    const fresh = new Set(items.filter(item => item.provider === "mangadex").map(item => item.event.volumeNumber));
    const numbers = new Set([...schedule.volumes.map(volume => volume.volumeNumber), ...row.aheadVolumes.map(volume => volume.volumeNumber), row.latest]);
    const volumes = [...numbers].filter(volumeNumber => {
      const edition = schedule.volumes.find(volume => volume.volumeNumber === volumeNumber)?.editionIndex ?? latestEdition;
      return Number.isInteger(volumeNumber) && volumeNumber > (ownedFor(edition) ?? 0);
    }).sort((a, b) => a - b).map(volumeNumber => ({ volumeNumber, date: null, released: true, upcoming: false, fresh: fresh.has(volumeNumber) }));
    return ledgerRow(row.work, owned, volumes, items, today, row.ahead);
  }));
}

/** Counts are volumes, not works; a released new volume belongs to only the first count. */
export function releaseLedgerCounts(rows: ReleaseLedgerRow[]) {
  const chips = rows.flatMap(row => row.chips);
  return {
    fresh: chips.filter(chip => chip.kind === "new").length,
    unowned: chips.filter(chip => chip.kind === "plain" && chip.released).length,
    upcoming: chips.filter(chip => chip.kind === "upcoming").length,
  };
}
