import {useEffect, useState} from 'react';
import {api, errorText} from './transport';
import {normalizeArtists, normalizeAssignments, type LibraryArtistsReply} from './artistsModel';
import {ARTIST_EDITS_CHANGED, flushArtistEdits, overlayArtistEdits, readArtistEdits, reconcileArtistEdits} from './artistEditOutbox';
import {outboxConnection} from './outboxConnection';
import {useSyncSignal} from './syncSignals';
import {visibleInterval} from './useVisibleInterval';

const SNAPSHOT_READY = 'lakomics-artist-snapshot-ready';

/** Keep the last served snapshot while refreshing, and overlay only this connection's queue. */
export function useLibraryArtists(active: boolean, revision: number, scope?: string) {
  const endpoint = scope ?? outboxConnection() ?? '';
  const [result, setResult] = useState<{endpoint: string; reply: LibraryArtistsReply}>();
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'empty'>('idle');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [, redraw] = useState(0);
  const live = useSyncSignal('artists', () => setRetry(value => value + 1), active);
  useEffect(() => {
    const acceptSnapshot = (event: Event) => {
      const next = (event as CustomEvent<{endpoint: string; reply: LibraryArtistsReply}>).detail;
      if (next.endpoint !== endpoint) return;
      setResult(previous => previous?.endpoint === endpoint && Number(previous.reply.revision) > Number(next.reply.revision)
        ? previous : next);
      setState(next.reply.artists?.length ? 'ready' : 'empty');
    };
    window.addEventListener(SNAPSHOT_READY, acceptSnapshot);
    return () => window.removeEventListener(SNAPSHOT_READY, acceptSnapshot);
  }, [endpoint]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let running = false, again = false;
    let latestArtists = normalizeArtists(result?.endpoint === endpoint ? result.reply : undefined, true);
    const read = async () => {
      const reply = await api<LibraryArtistsReply>('/v1/library/artists', controller.signal, undefined, undefined, false, endpoint || undefined);
      if (controller.signal.aborted) return;
      if (!Array.isArray(reply?.artists)) throw new Error('작가 목록을 확인할 수 없습니다.');
      reconcileArtistEdits(endpoint, reply);
      latestArtists = normalizeArtists(reply, true);
      // Search and the artist hub can both be mounted. Swap their snapshot in
      // the same turn that removes the shared optimistic queue.
      window.dispatchEvent(new CustomEvent(SNAPSHOT_READY, {detail: {endpoint, reply}}));
    };
    const refresh = async () => {
      if (running) { again = true; return; }
      running = true;
      setState(previous => previous === 'idle' ? 'loading' : previous);
      setError('');
      try {
        // Recover an accepted POST whose response was lost before retrying it.
        await read();
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(errorText(reason));
          setState(previous => previous === 'loading' ? 'empty' : previous);
        }
      }
      try {
        if (!controller.signal.aborted && endpoint && await flushArtistEdits(endpoint, controller.signal, latestArtists)) await read();
      } catch (reason) { if (!controller.signal.aborted) setError(errorText(reason)); }
      finally {
        running = false;
        if (again && !controller.signal.aborted) { again = false; void refresh(); }
      }
    };
    const changed = () => { redraw(value => value + 1); void refresh(); };
    window.addEventListener(ARTIST_EDITS_CHANGED, changed);
    window.addEventListener('online', changed);
    const stop = visibleInterval(() => { void refresh(); }, live ? 60_000 : 30_000, true);
    return () => {
      controller.abort(); stop();
      window.removeEventListener(ARTIST_EDITS_CHANGED, changed);
      window.removeEventListener('online', changed);
    };
  }, [active, revision, retry, endpoint, live]);
  const reply = result?.endpoint === endpoint ? result.reply : undefined;
  let queued: ReturnType<typeof readArtistEdits> = [];
  let storageError = '';
  try { queued = readArtistEdits(endpoint); } catch (reason) { storageError = errorText(reason); }
  const allArtists = overlayArtistEdits(normalizeArtists(reply, true), queued);
  return {artists: allArtists.filter(artist => !artist.hidden), allArtists,
    assignments: normalizeAssignments(reply), pending: queued.length,
    loaded: reply !== undefined, state: allArtists.length ? 'ready' as const : state,
    error: storageError || error, retry: () => setRetry(value => value + 1)};
}
