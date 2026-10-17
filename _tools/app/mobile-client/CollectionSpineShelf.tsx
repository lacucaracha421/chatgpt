import {useCallback, useContext, useMemo, type RefObject} from 'react';
import {SpineShelf, type SpineArt, type SpineWork} from '../src/collections/SpineShelf';
import {shelfGroups, type CollectionViewSettings} from '../src/collections/CollectionList';
import {workCasePlatform} from '../src/collections/case/CollectionCase';
import {spineScale, type SpineSize} from '../src/collections/case/caseDimensions';
import {markSpineWarm} from '../src/collections/spineShelfWarm';
import {ArtworkMemoryContext, artworkSource, useCoverUrl, useFaceUrl} from './collectionArtwork';
import {collectionCardCredit, collectionCover, type CollectionSummary} from './collectionModel';

type TabletSpineWork = SpineWork & {item: CollectionSummary};

/** A tablet work's case: the platform comes with the summary, so every spine has its final size at once. */
export function spineWork(item: CollectionSummary): TabletSpineWork {
  return {item, id: item.id, title: item.name, credit: collectionCardCredit(item), developer: item.developer ?? null,
    platform: workCasePlatform(item.type, item.platforms, item.ownedPlatform), front: null, spine: null, pending: false};
}

/**
 * Images come as tickets, one per spine in the mounted rows and one for the case pulled out. A shelved spine is the server's medium copy
 * where there is one (the thumbnail otherwise); the pulled-out case swaps its front, spine and back to the originals once decoded.
 */
function ticketArt(revision: string, active: boolean): SpineArt<TabletSpineWork> {
  const spineOf = (item: CollectionSummary) => item.type === 'manga' ? null : item.spineArtworkId ?? null;
  return {
    useSpine(work, host: RefObject<Element | null>) {
      const id = spineOf(work.item);
      const url = useCoverUrl(work.item, id, revision, active && !!id, host, {medium: true});
      return {url: id ? url : null, pending: !!id && !url};
    },
    usePulled(work, host: RefObject<Element | null>) {
      const {item} = work, spineId = spineOf(item), backId = item.type === 'av' ? item.backArtworkId ?? null : null;
      const front = useFaceUrl(item, collectionCover(item), revision, active, host);
      const spine = useFaceUrl(item, spineId, revision, active && !!spineId, host, true);
      const back = useFaceUrl(item, backId, revision, active && !!backId, host);
      return {front, spine: spineId ? spine : null, back: backId ? back : null, pending: !!spineId && !spine};
    },
  };
}

/**
 * 책장 for games and AV on the tablet: the shared spine shelf at the tablet's scale. A tap in a row, on a spine's width,
 * turns that case to its front (empty shelf beside the spines is not a case); a tap on the turned case opens the work.
 */
export function TabletSpineShelf({items, grouping, size, label, revision, active, privacy, picked, onPick, onOpen, onActions}: {
  items: CollectionSummary[]; grouping: CollectionViewSettings['grouping']; size: SpineSize; label: string; revision: string; active: boolean; privacy: boolean;
  picked: string | null; onPick(id: string | null): void; onOpen(id: string): void;
  /** Long press on a spine (or the spine at that x in its row) opens the work's action sheet. */onActions?(id: string): void;
}) {
  const groups = useMemo(() => shelfGroups(items, grouping).map(group => ({label: group.label, works: group.items.map(spineWork)})), [items, grouping]);
  const art = useMemo(() => ticketArt(revision, active && !privacy), [revision, active, privacy]);
  const memory = useContext(ArtworkMemoryContext);
  const byId = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);
  // A changed list keeps the old shelf until the spines on its first screen are requested and decoded.
  const prepare = useCallback((_ids: string[], visible: string[], signal: AbortSignal) => {
    const wanted: {item: CollectionSummary; artworkId: string}[] = [];
    for (const id of visible) {
      const item = byId.get(id), artworkId = item && item.type !== 'manga' ? item.spineArtworkId : undefined;
      if (!item || !artworkId) continue;
      const known = memory?.get(artworkSource(item, artworkId, revision, false, true));
      if (known) markSpineWarm(known); else wanted.push({item, artworkId});
    }
    if (!memory || !wanted.length) return;
    return Promise.all(wanted.map(({item, artworkId}) => memory.request(item, artworkId, revision, false, signal, true).then(ticket => {markSpineWarm(ticket.url);}, () => undefined))).then(() => undefined);
  }, [byId, memory, revision]);
  const hold = active && !privacy && !!memory;
  return <SpineShelf groups={groups} scale={spineScale('tablet', items[0]?.type ?? 'game', size)} label={label} pickedId={picked} onPick={onPick} onOpen={onOpen} onLongPress={onActions} privacy={privacy} touchTargets art={art} prepare={hold ? prepare : undefined}/>;
}
