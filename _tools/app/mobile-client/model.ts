import type {Asset, AssetFiltersValue, Page, PageWire, View} from './types';
import {EMPTY_FILTERS, filterKey, filterVersionOf, withFilters} from './assetFilters';
export const PAGE_SIZE = 40;
export const DENSITIES = ['크게', '균형', '촘촘하게'] as const;
export function rowHeight(density: number, width: number) { return Math.min([290, 220, 150][density] ?? 220, width * .78); }
/**
 * The navigation identity of one view, including its filters.
 *
 * Filters belong to the committed query, not to a decoration on top of it, so two
 * filter sets are two different views. Leaving them out of this key would let a
 * restored position or a cached page from one filter set be reused for another.
 */
export function viewKey(view: View, filters: AssetFiltersValue = EMPTY_FILTERS) {
  const base = `${view.tab}:${view.root?'root':''}:${view.characters?`characters:${view.characterNode??''}`:''}:${view.classification ?? ''}:${view.revisit ?? ''}`;
  const scope = view.album ? `${base}:album:${JSON.stringify(view.album)}` : base;
  const key = filterKey(filters);
  return key ? `${scope}:${key}` : scope;
}
export function pagePath(view: View, cursor: string | null, filters: AssetFiltersValue = EMPTY_FILTERS, limit = PAGE_SIZE) {
  const params = new URLSearchParams({limit: String(limit)});
  if (cursor) params.set('cursor', cursor);
  if (view.album) {
    params.set('libraryId',view.album.libraryId);params.set('epoch',String(view.album.epoch));params.set('albumId',view.album.id);
    return withFilters(`/v1/albums/assets?${params}`,filters);
  }
  if (view.classification) params.set('classification_id', view.classification);
  const path = view.revisit === 'date' ? '/v1/library/revisit/date' : view.revisit
    ? `/v1/library/revisit/creator/${encodeURIComponent(view.revisit)}/assets` : '/v1/library/assets';
  // Revisit views are a different question from a filtered gallery, so the controls are
  // not offered there and the filters are not sent. Passing them anyway would silently
  // narrow a Revisit list the user did not ask to filter.
  const query = `${path}?${params}`;
  return path === '/v1/library/assets' ? withFilters(query, filters) : query;
}
export function ratio(asset: Asset) {
  const r = asset.ratio ?? (Number(asset.width) / Number(asset.height));
  return Number.isFinite(r) && r > 0 ? r : 1;
}
export interface Row { items: {asset: Asset; width: number; index: number}[]; height: number }
export function justifiedRows(assets: Asset[], width: number, target: number, gap = 10): Row[] {
  if (!(width > 0) || !(target > 0)) return [];
  const rows: Row[] = [];
  let current: {asset: Asset; index: number}[] = [], sum = 0;
  const flush = (last: boolean) => {
    const height = Math.max(1, Math.min(last ? target : Infinity, (width - gap * (current.length - 1)) / sum));
    rows.push({height, items: current.map(item => ({...item, width: ratio(item.asset) * height}))});
    current = []; sum = 0;
  };
  assets.forEach((asset, index) => {
    current.push({asset, index}); sum += ratio(asset);
    if (sum * target + gap * (current.length - 1) >= width) flush(false);
  });
  if (current.length) flush(true);
  return rows;
}
/** Only the current generation may publish, including after failures or cancellation. */
export class RequestGate {
  private generation = 0;
  private controller?: AbortController;
  begin() { this.controller?.abort(); this.controller = new AbortController(); return {id: ++this.generation, signal: this.controller.signal}; }
  current(id: number) { return id === this.generation && !this.controller?.signal.aborted; }
  cancel() { this.generation++; this.controller?.abort(); }
}
export function normalizePage(page: PageWire): Page {
  const seen = new Set<string>();
  const declared = filterVersionOf(page);
  return {items: (Array.isArray(page.items) ? page.items : []).filter(item => item?.id && !seen.has(item.id) && !!seen.add(item.id)),
    has_more: !!page.has_more && typeof page.next_cursor === 'string' && !!page.next_cursor,
    next_cursor: typeof page.next_cursor === 'string' ? page.next_cursor : null,
    // Normalized from the single agreed wire name, and left absent when the server declared
    // nothing so the guards can refuse it rather than treat it as satisfied.
    ...(declared === null ? {} : {filter_version: declared})};
}
export async function mapBounded<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const index = next++; results[index] = await work(items[index]);
    }
  }));
  return results;
}
export function imageNeighbours(items: Asset[], index: number) { return [items[index - 1], items[index + 1]].filter((a): a is Asset => !!a && a.kind !== 'video' && !a.pending); }
export function fitTransform(scale: number, x: number, y: number, width: number, height: number, aspect: number) {
  const fitW = Math.min(width,height * aspect), fitH = Math.min(height,width / aspect);
  const boundX = Math.max(0,(fitW * scale - width)/2), boundY = Math.max(0,(fitH * scale - height)/2);
  return {scale,x:Math.max(-boundX,Math.min(boundX,x)),y:Math.max(-boundY,Math.min(boundY,y))};
}
export function dateLabel(asset: Asset) {
  const value = asset.collected_at ?? asset.created_at;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString('ko-KR', {year:'numeric', month:'2-digit',day:'2-digit'}) : '날짜 없음';
}
/**
 * A video's playtime as `m:ss` / `h:mm:ss`, or an empty string when the server did
 * not send a usable duration. Zero is a legal duration and is rendered as `0:00`
 * rather than treated as missing.
 */
export function durationLabel(asset: Asset) {
  const value = asset.duration_ms;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  const total = Math.round(value / 1000);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  const minuteText = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${minuteText}:${String(seconds).padStart(2, '0')}`;
}
