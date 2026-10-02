/** Geometry is sampled only at a layout boundary, never on animation frames. */
export type TilePosition = { asset: { id: string }; top: number; height: number };
export type TileRects = Map<string, DOMRect>;
export function captureVisibleTileRects(scroller: HTMLElement, previousWidth?: number): TileRects {
  const viewport = scroller.getBoundingClientRect();
  const result: TileRects = new Map();
  const space = scroller.querySelector<HTMLElement>(".asset-gallery__virtual-space")?.getBoundingClientRect();
  const viewportRight = previousWidth === undefined ? viewport.right : viewport.left + previousWidth;
  scroller.querySelectorAll<HTMLElement>('[data-gallery-cell]').forEach(cell => {
    const id = cell.querySelector<HTMLElement>('[data-asset-id]')?.dataset.assetId;
    // Absolute layout coordinates reject overscan cells before any per-tile DOM measurement.
    if (space) {
      const left = space.left + Number.parseFloat(cell.style.left), top = space.top + Number.parseFloat(cell.style.top);
      const width = Number.parseFloat(cell.style.width), height = Number.parseFloat(cell.style.height);
      if (Number.isFinite(left + top + width + height) && (top + height <= viewport.top || top >= viewport.bottom || left + width <= viewport.left || left >= viewportRight)) return;
    }
    const rect = cell.getBoundingClientRect();
    if (id && rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewportRight) result.set(id, rect);
  });
  return result;
}
export function anchorScrollTop(previous: TilePosition[], next: TilePosition[], scrollTop: number): number {
  const anchor = previous.find(tile => tile.top + tile.height > scrollTop);
  const replacement = anchor && next.find(tile => tile.asset.id === anchor.asset.id);
  return replacement && anchor ? Math.max(0, scrollTop + replacement.top - anchor.top) : scrollTop;
}
export function animateVisibleTiles(scroller: HTMLElement, first: TileRects, reducedMotion: boolean): Animation[] {
  if (reducedMotion || first.size === 0) return [];
  const last = captureVisibleTileRects(scroller);
  const easing = getComputedStyle(scroller).getPropertyValue('--ease-standard').trim() || 'cubic-bezier(0.2, 0, 0, 1)';
  const animations: Animation[] = [];
  // Batch all reads before animation writes. New and off-screen cells stay in place.
  const cells = [...scroller.querySelectorAll<HTMLElement>('[data-gallery-cell]')];
  for (const cell of cells) {
    const id = cell.querySelector<HTMLElement>('[data-asset-id]')?.dataset.assetId;
    const before = id && first.get(id), after = id && last.get(id);
    if (!before || !after || typeof cell.animate !== 'function') continue;
    const x = before.left - after.left, y = before.top - after.top;
    if (Math.abs(x) < .5 && Math.abs(y) < .5) continue;
    animations.push(cell.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration: 200, easing }));
  }
  return animations;
}
