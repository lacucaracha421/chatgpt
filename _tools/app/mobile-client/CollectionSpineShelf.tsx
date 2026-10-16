import {useMemo, type RefObject} from 'react';
import {SpineShelf, type SpineArt, type SpineWork} from '../src/collections/SpineShelf';
import {shelfGroups, type CollectionViewSettings} from '../src/collections/CollectionList';
import {workCasePlatform} from '../src/collections/case/CollectionCase';
import {SPINE_SCALE, type SpineSize} from '../src/collections/case/caseDimensions';
import {useCoverUrl} from './collectionArtwork';
import {collectionCardCredit, collectionCover, type CollectionSummary} from './collectionModel';

type TabletSpineWork = SpineWork & {item: CollectionSummary};

/** A tablet work's case: the platform comes with the summary, so every spine has its final size at once. */
export function spineWork(item: CollectionSummary): TabletSpineWork {
  return {item, id: item.id, title: item.name, credit: collectionCardCredit(item), developer: item.developer ?? null,
    platform: workCasePlatform(item.type, item.platforms, item.ownedPlatform), front: null, spine: null, pending: false};
}

/** Images come as tickets, one per spine in the mounted rows and one for the case pulled out. */
function ticketArt(revision: string, active: boolean): SpineArt<TabletSpineWork> {
  return {
    useSpine(work, host: RefObject<Element | null>) {
      const id = work.item.type === 'manga' ? null : work.item.spineArtworkId ?? null;
      const url = useCoverUrl(work.item, id, revision, active && !!id, host);
      return {url: id ? url : null, pending: !!id && !url};
    },
    useFront(work, host: RefObject<Element | null>) {
      return useCoverUrl(work.item, collectionCover(work.item), revision, active, host);
    },
  };
}

/**
 * 책장 for games and AV on the tablet: the shared spine shelf at the tablet's scale. A tap anywhere in a row
 * turns the nearest case to its front; a tap on the turned case opens the work.
 */
export function TabletSpineShelf({items, grouping, size, label, revision, active, privacy, picked, onPick, onOpen}: {
  items: CollectionSummary[]; grouping: CollectionViewSettings['grouping']; size: SpineSize; label: string; revision: string; active: boolean; privacy: boolean;
  picked: string | null; onPick(id: string | null): void; onOpen(id: string): void;
}) {
  const groups = useMemo(() => shelfGroups(items, grouping).map(group => ({label: group.label, works: group.items.map(spineWork)})), [items, grouping]);
  const art = useMemo(() => ticketArt(revision, active && !privacy), [revision, active, privacy]);
  return <SpineShelf groups={groups} scale={SPINE_SCALE.tablet[size]} label={label} pickedId={picked} onPick={onPick} onOpen={onOpen} privacy={privacy} touchTargets art={art}/>;
}
