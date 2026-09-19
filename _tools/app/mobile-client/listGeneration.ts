/** Only Asset-visible server changes participate; Notes/catalog changes do not. */
export function listGeneration(value: unknown): string | null {
  const generation = value && typeof value === 'object' ? (value as {generation?:unknown}).generation : null;
  return typeof generation === 'string' && /^[a-f0-9]{64}$/.test(generation) ? generation : null;
}
export const ASSET_LIST_CHANGED_EVENT = 'lakomics-asset-list-changed';
