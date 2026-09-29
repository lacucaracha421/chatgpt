import type {Asset} from './types';
import {prepareAssets} from './media';

/**
 * No flash on change: before a replaced list is shown, fetch and decode the thumbnails of its
 * first screen so the new tiles appear with their pictures instead of as blank cells. Bounded by
 * `budgetMs`; whatever is not ready by then loads as usual. Never throws.
 */
export async function readyFirstScreen(items: Asset[], signal: AbortSignal, limit = 24, budgetMs = 700): Promise<Asset[]> {
  const head = items.slice(0, limit).filter(asset => !asset.preview && !asset.pending && asset.thumbnail_available !== false);
  // Only on the device: without the native bridge (tests, browser demo) there is nothing to warm.
  if (!head.length || !window.LakomicsNative) return items;
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), budgetMs));
  const work = prepareAssets(head, signal).then(async prepared => {
    await Promise.all(prepared.map(asset => asset.preview ? decodeUrl(asset.preview) : undefined));
    return prepared;
  }).catch(() => null);
  const prepared = await Promise.race([work, timeout]);
  if (!prepared) return items;
  const byId = new Map(prepared.filter(asset => asset.preview).map(asset => [asset.id, asset.preview!]));
  return items.map(asset => byId.has(asset.id) ? {...asset, preview: byId.get(asset.id)} : asset);
}
function decodeUrl(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  return typeof image.decode === 'function' ? image.decode().catch(() => undefined) : Promise.resolve();
}
