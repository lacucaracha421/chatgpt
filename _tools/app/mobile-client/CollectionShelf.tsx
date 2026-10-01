import {useCallback, useRef, useState, type ReactNode} from 'react';
import {LightCase} from '../src/collections/case/LightCase';
import {workCasePlatform, type CaseData} from '../src/collections/case/CollectionCase';
import {PerRowControl} from '../src/shared/ui/PerRowControl';
// The shared shelf geometry (rows, planks, the picked case's title) is the PC list's stylesheet.
import '../src/collections/CollectionBrowser.css';
import {BottomSheet} from './BottomSheet';
import {SegmentedControl} from './ui';
import {useCoverUrl} from './collectionArtwork';
import {collectionCover, type CollectionKind, type CollectionSummary} from './collectionModel';
import './collectionShelf.css';

export type ShelfLayout = 'grid' | 'shelf';
export type ShelfView = {layout: ShelfLayout; perRow: number};
/** Covers or cases per row. The PC offers 5–12; a portrait tablet is about half as wide. */
export const SHELF_PER_ROW = {min: 3, max: 8, fallback: 4} as const;
const viewKey = (type: CollectionKind) => `lakomics.mobile.collectionView.${type}.v1`;
/** Manga starts on the cover grid, as on the PC; its 선반 is the bookcase rows (CollectionMangaShelf). */
const fallbackView = (type: CollectionKind): ShelfView => ({layout: type === 'manga' ? 'grid' : 'shelf', perRow: SHELF_PER_ROW.fallback});

function readView(type: CollectionKind): ShelfView {
  const fallback = fallbackView(type);
  try {
    const value = JSON.parse(localStorage.getItem(viewKey(type)) ?? 'null') as Partial<ShelfView> | null;
    if (!value) return fallback;
    return {
      layout: value.layout === 'grid' || value.layout === 'shelf' ? value.layout : fallback.layout,
      perRow: Number.isInteger(value.perRow) ? Math.max(SHELF_PER_ROW.min, Math.min(SHELF_PER_ROW.max, value.perRow!)) : fallback.perRow,
    };
  } catch { return fallback; }
}

/** The 보기 choice per Collection type, kept on this device. */
export function useShelfViews(): [(type: CollectionKind) => ShelfView, (type: CollectionKind, patch: Partial<ShelfView>) => void] {
  const [views, setViews] = useState(() => Object.fromEntries((['game', 'manga', 'movie', 'av'] as const).map(type => [type, readView(type)])) as Record<CollectionKind, ShelfView>);
  const update = useCallback((type: CollectionKind, patch: Partial<ShelfView>) => setViews(current => {
    const next = {...current[type], ...patch};
    try { localStorage.setItem(viewKey(type), JSON.stringify(next)); } catch { /* The session keeps the view. */ }
    return {...current, [type]: next};
  }), []);
  return [type => views[type], update];
}

/** A work's case for the shared shelf and work case: a game's case follows its owned 기기 first. Without a spine image the case prints its title. */
export function workCaseData(item: CollectionSummary, urls: {front?: string | null; spine?: string | null; back?: string | null}, privacy: boolean): CaseData {
  return {title: item.name, publisher: item.publisher ?? null, platform: workCasePlatform(item.type, item.platforms, item.ownedPlatform), front: urls.front ?? null, spine: urls.spine ?? null, back: urls.back ?? null, privacy};
}

/**
 * One work on the shelf: the shared light case with its title under the plank. A first tap
 * turns the case to the front (picks it); a tap on the picked case opens the work.
 */
export function ShelfTile({item, revision, active, privacy, picked, extra, onTap}: {item: CollectionSummary; revision: string; active: boolean; privacy: boolean; picked: boolean;
  /** More meta under the title (the performer page's date and 이 작품). */extra?: ReactNode; onTap(id: string): void}) {
  const host = useRef<HTMLButtonElement>(null);
  const cover = collectionCover(item);
  const front = useCoverUrl(item, cover, revision, active && !privacy, host);
  // The real spine (an upgraded server publishes `spineArtworkId`) waits for the front, so the
  // visible covers keep the ticket queue first; until it decodes the case prints its title.
  const spine = useCoverUrl(item, item.spineArtworkId, revision, active && !privacy && !!item.spineArtworkId && (front !== null || (!cover && !item.coverAssetId)), host);
  return <button ref={host} type="button" className="collection-card" data-collection-id={item.id} aria-selected={picked} aria-label={item.name} onClick={() => onTap(item.id)}>
    <span className="collection-card__light"><LightCase data={workCaseData(item, {front, spine: item.spineArtworkId ? spine : null}, privacy)} selected={picked}/></span>
    <span className="collection-card__meta"><span className="collection-card__name">{item.name}</span>{extra && <span className="collection-card__extra">{extra}</span>}</span>
  </button>;
}

/** 보기: the same choices as the PC menu (배치, 한 줄에 N개), as a bottom sheet. */
export function ShelfViewSheet({view, onChange, onClose}: {type: CollectionKind; view: ShelfView; onChange(patch: Partial<ShelfView>): void; onClose(): void}) {
  const options: {value: ShelfLayout; label: string}[] = [{value: 'grid', label: '격자'}, {value: 'shelf', label: '선반'}];
  return <BottomSheet title="보기" onClose={onClose}><div className="ui-view-options__content shelf-view-sheet">
    <section className="ui-view-options__section"><span className="ui-view-options__label">배치</span>
      <SegmentedControl label="배치" options={options} value={view.layout} onChange={layout => onChange({layout})} fullWidth/>
    </section>
    <PerRowControl value={view.perRow} min={SHELF_PER_ROW.min} max={SHELF_PER_ROW.max} onChange={perRow => onChange({perRow})}/>
  </div></BottomSheet>;
}
