import type { AssetSummary } from "../library/types";

function shallowEqual<T extends object>(previous: T, next: T): boolean {
  const keys = Object.keys(next) as (keyof T)[];
  return Object.keys(previous).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(previous, key)
      && Object.is(previous[key], next[key]));
}

/** Compare the IPC summary's scalar fields and its one nested media record at ingestion. */
function equalAsset(previous: AssetSummary, next: AssetSummary): boolean {
  if (previous === next) return true;
  const { media: previousMedia, ...previousFields } = previous;
  const { media: nextMedia, ...nextFields } = next;
  return shallowEqual(previousFields, nextFields) && shallowEqual(previousMedia, nextMedia);
}

/** Preserve equal assets by ID, and the array itself when order and content are unchanged. */
export function shareAssetSummaries(previous: AssetSummary[], next: AssetSummary[]): AssetSummary[] {
  if (previous === next) return previous;
  const byId = new Map(previous.map(asset => [asset.id, asset]));
  const shared = next.map(asset => {
    const existing = byId.get(asset.id);
    return existing && equalAsset(existing, asset) ? existing : asset;
  });
  return previous.length === shared.length && shared.every((asset, index) => asset === previous[index])
    ? previous : shared;
}
