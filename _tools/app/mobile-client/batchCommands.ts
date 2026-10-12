/** The server and the native bridge both take at most this many items per request. */
export const BATCH_LIMIT = 100;

/** Split a selection into requests of at most {@link BATCH_LIMIT}, keeping order. */
export function batches<T>(items: readonly T[], size = BATCH_LIMIT): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

/** One Asset's outcome from the native `albumMembershipSetMany` / `classificationAssignmentSetMany` bridge calls. */
export interface ManyResult {
  assetId: string;
  ok: boolean;
  pending: boolean;
  blocked: boolean;
  conflictCode: string | null;
  message: string;
}
export interface ManyReply {
  adopted: boolean;
  results: ManyResult[];
}

/** Per-Asset failure text for a bridge reply: null when the Asset was queued (or already matched). */
export function manyFailures(ids: readonly string[], reply: ManyReply | null | undefined, fallback: string): (string | null)[] {
  return ids.map(id => {
    if (!reply?.adopted) return fallback;
    const result = reply.results.find(item => item.assetId === id);
    if (!result) return fallback;
    return result.ok && !result.blocked ? null : result.message || fallback;
  });
}
