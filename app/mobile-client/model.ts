import type {Asset, Page, View} from './types';
export const PAGE_SIZE = 40;
export const DENSITIES = ['크게', '균형', '촘촘하게'] as const;
export function rowHeight(density: number, width: number) { return Math.min([290, 220, 150][density] ?? 220, width * .78); }
export function viewKey(view: View) { return `${view.tab}:${view.classification ?? ''}:${view.revisit ?? ''}`; }
export function pagePath(view: View, cursor: string | null) {
  const params = new URLSearchParams({limit: String(PAGE_SIZE)});
  if (cursor) params.set('cursor', cursor);
  if (view.classification) params.set('classification_id', view.classification);
  const path = view.revisit === 'date' ? '/v1/library/revisit/date' : view.revisit
    ? `/v1/library/revisit/creator/${encodeURIComponent(view.revisit)}/assets` : '/v1/library/assets';
  return `${path}?${params}`;
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
export function normalizePage(page: Page): Page {
  const seen = new Set<string>();
  return {items: (Array.isArray(page.items) ? page.items : []).filter(item => item?.id && !seen.has(item.id) && !!seen.add(item.id)),
    has_more: !!page.has_more && typeof page.next_cursor === 'string' && !!page.next_cursor,
    next_cursor: typeof page.next_cursor === 'string' ? page.next_cursor : null};
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
