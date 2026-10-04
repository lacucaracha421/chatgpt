import {api} from './transport';
import {connectionOutbox, outboxConnection, outboxKey} from './outboxConnection';
import {normalizeArtist, type LibraryArtist, type LibraryArtistsReply} from './artistsModel';

export type ArtistEditAction = 'rename' | 'hide' | 'unhide' | 'pin' | 'unpin';
export type ArtistEditIntent = {
  operationId: string;
  artistId: string;
  action: ArtistEditAction;
  displayName: string | null;
};
export type PendingArtistEdit = ArtistEditIntent & {sequence: number};
export type QueuedArtistEdit = ArtistEditIntent & {
  artist: LibraryArtist;
  receipt?: {sequence: number; revision: number};
};

const KEY = connectionOutbox('lakomics.artists.edits.outbox.v1');
export const ARTIST_EDITS_CHANGED = 'lakomics-artist-edits-changed';

export function readArtistEdits(endpoint: string | null = outboxConnection()): QueuedArtistEdit[] {
  const key = outboxKey(KEY, endpoint);
  if (!key) return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (!Array.isArray(value)) throw new Error();
    return value.map(row => {
      const artist = normalizeArtist(row?.artist);
      if (!artist || typeof row.operationId !== 'string' || !row.operationId
        || typeof row.artistId !== 'string' || !row.artistId
        || !['rename', 'hide', 'unhide', 'pin', 'unpin'].includes(row.action)
        || !(row.displayName === null || typeof row.displayName === 'string')
        || (row.receipt && (!Number.isSafeInteger(row.receipt.sequence) || row.receipt.sequence < 1
          || !Number.isSafeInteger(row.receipt.revision) || row.receipt.revision < 1))) throw new Error();
      return {...row, artist} as QueuedArtistEdit;
    });
  } catch { throw new Error('작가 변경 대기열을 읽을 수 없습니다. 저장 공간을 확인해 주세요.'); }
}

function write(endpoint: string, intents: QueuedArtistEdit[]) {
  try { localStorage.setItem(outboxKey(KEY, endpoint)!, JSON.stringify(intents)); }
  catch { throw new Error('작가 변경을 보관하지 못했습니다. 저장 공간을 확인해 주세요.'); }
}

export function commitArtistEdit(endpoint: string, artist: LibraryArtist, action: ArtistEditAction,
  displayName: string | null = null, operationId: () => string = () => crypto.randomUUID()): QueuedArtistEdit {
  if (!endpoint) throw new Error('서버 연결을 확인해 주세요.');
  const name = displayName?.trim() || null;
  if (action !== 'rename' && name !== null) throw new Error('이름 변경 요청을 확인해 주세요.');
  if (name !== null && (Array.from(name).length > 120 || /[\r\n\x00]/.test(name))) {
    throw new Error('작가 이름은 한 줄, 120자 이내로 입력해 주세요.');
  }
  const intent: QueuedArtistEdit = {artistId: artist.id, artist, action, displayName: name, operationId: operationId()};
  // Never replace an in-flight request: its receipt may have been lost after acceptance.
  write(endpoint, [...readArtistEdits(endpoint), intent]);
  window.dispatchEvent(new Event(ARTIST_EDITS_CHANGED));
  return intent;
}

/** A later served revision includes the receipt, or a later accepted edit that wins. */
export function reconcileArtistEdits(endpoint: string, reply: LibraryArtistsReply): void {
  const pending = new Set(reply.pending?.map(intent => intent.operationId));
  const all = readArtistEdits(endpoint);
  const remaining = all.filter(intent => !pending.has(intent.operationId)
    && !(intent.receipt && Number(reply.revision) >= intent.receipt.revision));
  if (remaining.length !== all.length) write(endpoint, remaining);
}

export function resolveArtist(artists: LibraryArtist[], previous: LibraryArtist): LibraryArtist | undefined {
  return artists.find(artist => artist.id === previous.id)
    ?? artists.find(artist => artist.keys.includes(previous.id) || artist.keys.some(key => previous.keys.includes(key)));
}

/** Only local, unobserved operations overlay the already overlaid server snapshot. */
export function overlayArtistEdits(artists: LibraryArtist[], intents: QueuedArtistEdit[]): LibraryArtist[] {
  const result = artists.map(artist => ({...artist}));
  for (const intent of intents) {
    let artist = resolveArtist(result, intent.artist);
    if (!artist) { artist = {...intent.artist}; result.push(artist); }
    if (intent.action === 'rename') {
      artist.displayName = intent.displayName;
      artist.label = intent.displayName ?? artist.sourceName ?? intent.artist.label;
    } else if (intent.action === 'hide' || intent.action === 'unhide') artist.hidden = intent.action === 'hide';
    else artist.pinned = intent.action === 'pin';
  }
  return result;
}

const sending = new Map<string, Promise<boolean>>();
/** One ordered pass per connection. Stop at an uncertain response so retries cannot reorder edits. */
export function flushArtistEdits(endpoint: string, signal: AbortSignal, artists: LibraryArtist[] = []): Promise<boolean> {
  const running = sending.get(endpoint);
  if (running) return running;
  const pass = async () => {
    let sent = false;
    for (let intent of readArtistEdits(endpoint)) {
      if (signal.aborted) break;
      if (intent.receipt) continue;
      const send = (row: QueuedArtistEdit) => {
        const {operationId, artistId, action, displayName} = row;
        return api<{operationId: string; sequence: number; revision: number}>(
          '/v1/library/artists/intents', signal, {version: 1, operationId, artistId, action, displayName}, 'POST', false, endpoint);
      };
      const receipt = await send(intent).catch(async reason => {
        const error = reason as {status?: number; details?: {code?: string; detail?: {code?: string}}};
        const code = error?.details?.detail?.code ?? error?.details?.code;
        const target = resolveArtist(artists, intent.artist);
        if (signal.aborted || error?.status !== 409 || code !== 'artistUnknown' || !target || target.id === intent.artistId) throw reason;
        // The old id was explicitly rejected, not ambiguously accepted. The PC
        // materialized it while this device was offline; use a new operation id.
        const replacement = {...intent, artistId: target.id, artist: target, operationId: crypto.randomUUID()};
        write(endpoint, readArtistEdits(endpoint).map(row => row.operationId === intent.operationId ? replacement : row));
        intent = replacement;
        return send(intent);
      });
      if (receipt.operationId !== intent.operationId || !Number.isSafeInteger(receipt.sequence)
        || receipt.sequence < 1 || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) {
        throw new Error('작가 변경 응답을 확인할 수 없습니다. 다시 시도해 주세요.');
      }
      // Read again: another edit may have been queued or reconciled during the request.
      write(endpoint, readArtistEdits(endpoint).map(row => row.operationId === intent.operationId
        ? {...row, receipt: {sequence: receipt.sequence, revision: receipt.revision}} : row));
      sent = true;
    }
    return sent;
  };
  const promise = pass().finally(() => { if (sending.get(endpoint) === promise) sending.delete(endpoint); });
  sending.set(endpoint, promise);
  return promise;
}
