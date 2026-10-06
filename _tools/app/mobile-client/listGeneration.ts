import {api, ApiError} from './transport';
import {filterVersionOf} from './assetFilters';
import {outboxConnection} from './outboxConnection';

const GENERATION_PATTERN = /^[a-f0-9]{64}$/;

type Read = {controller: AbortController; promise: Promise<unknown>; users: number};
const reads = new Map<string | null, Read>();

/** Generation and filter support are fields of the same read, never a cached snapshot. */
function readGeneration(signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
  const scope = outboxConnection();
  let entry = reads.get(scope);
  if (!entry) {
    const controller = new AbortController();
    const promise = api<unknown>('/v1/library/list-generation', controller.signal, undefined, 'GET', false, scope ?? undefined);
    entry = {controller, promise, users: 0};
    reads.set(scope, entry);
    const created = entry;
    const clear = () => {if (reads.get(scope) === created) reads.delete(scope);};
    void promise.then(clear, clear);
  }
  const shared = entry;
  shared.users++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const leave = (cancelled = false) => {
      settled = true; signal?.removeEventListener('abort', abort); shared.users--;
      if (!shared.users) {
        if (reads.get(scope) === shared) reads.delete(scope);
        if (cancelled) shared.controller.abort();
      }
    };
    const abort = () => {if (!settled) {leave(true); reject(new DOMException('Cancelled', 'AbortError'));}};
    signal?.addEventListener('abort', abort, {once: true});
    void shared.promise.then(value => {if (!settled) {leave(); resolve(value);}}, reason => {if (!settled) {leave(); reject(reason);}});
  });
}

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
    reply = await readGeneration(signal);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) return null;
    throw reason;
  }
  if (typeof reply !== 'object' || reply === null || !('generation' in reply)) return null;
  const {generation} = reply;
  return typeof generation === 'string' && GENERATION_PATTERN.test(generation) ? generation : null;
}

/**
 * The list generation a page response carries about its own rows, or `null` when the
 * server predates that field (the caller then brackets the fetch with the endpoint).
 * The server reads it in the same snapshot as the rows, so it binds the page exactly.
 */
export function pageGenerationOf(reply: unknown): string | null {
  if (typeof reply !== 'object' || reply === null || !('listGeneration' in reply)) return null;
  const {listGeneration} = reply;
  return typeof listGeneration === 'string' && GENERATION_PATTERN.test(listGeneration) ? listGeneration : null;
}

/** Local signal that a mutation changed Asset visibility, so an open view must refetch. */
export const ASSET_LIST_CHANGED_EVENT = 'lakomics-asset-list-changed';
/** An edit made from the open viewer (like, classification): refresh lists, but keep the viewer open. */
export const viewerEditEvent = () => new CustomEvent(ASSET_LIST_CHANGED_EVENT, {detail: {keepViewer: true}});

/**
 * The Asset filter contract version this client requires, or `null` when the server
 * cannot promise it.
 *
 * The list-generation endpoint is the existing "does this server know about X" probe,
 * and it is the same call every gallery already makes before a page fetch. A server
 * that predates filtering answers without the field, and the caller must then refuse
to present an unfiltered list as a filtered one. Returning `null` for a missing field
and for an unreachable endpoint is deliberate: neither can support the query.
 */
export async function fetchAssetFilterVersion(signal?: AbortSignal): Promise<number | null> {
  let reply: unknown;
  try {
    reply = await readGeneration(signal);
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 404) return null;
    throw reason;
  }
  return filterVersionOf(reply);
}
