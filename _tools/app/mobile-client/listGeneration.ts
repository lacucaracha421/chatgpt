import {api, ApiError} from './transport';

const GENERATION_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The library's list generation, or `null` when the server has no generation endpoint.
 *
 * Generation-based invalidation is an optimization layered over the canonical page
 * fetch, so it must never be able to fail the fetch it protects. A server that
 * predates the endpoint answers 404, and the caller then falls back to always-fresh
 * reads rather than showing an empty library on an otherwise healthy connection.
 * Transport and auth failures still propagate, because those mean the list genuinely
 * could not be read and the caller must surface them.
 */
export async function fetchListGeneration(signal?: AbortSignal): Promise<string | null> {
  let reply: unknown;
  try {
    reply = await api<unknown>('/v1/library/list-generation', signal);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) return null;
    throw reason;
  }
  if (typeof reply !== 'object' || reply === null || !('generation' in reply)) return null;
  const {generation} = reply;
  return typeof generation === 'string' && GENERATION_PATTERN.test(generation) ? generation : null;
}

/** Local signal that a mutation changed Asset visibility, so an open view must refetch. */
export const ASSET_LIST_CHANGED_EVENT = 'lakomics-asset-list-changed';
