import {useEffect, useState} from 'react';
import {RectangleStackIcon, TrashIcon} from '@heroicons/react/24/outline';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {KIND_LABEL} from '../src/collections/collectionFormat';
import {BottomSheet} from './BottomSheet';
import {Button, EmptyState} from './ui';
import {isLifecycle, lifecycleInFlight, sameAuthority, type AuthorityIdentity, type CommandIntent} from './collectionCommandOutbox';
import type {CollectionKind} from './collectionModel';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {outboxConnection} from './outboxConnection';
import {api, errorText} from './transport';
import './collectionBindings.css';
import './collectionAuthority.css';

type Authority = ReturnType<typeof useCollectionAuthority>;
export const TRASH_PATH = '/v1/collections/authority/trash';
export type TrashItem = {workId: string; type: CollectionKind; name: string; trashedAt: string; purgeAt: string; entityRevision: number};
const DAY_MS = 86_400_000;

/**
 * Each work's newest delete or restore that is still queued or was confirmed this session. A
 * conflict no longer stands: the work stays where the server has it until the row is resolved.
 */
export function lifecycleIntents(authority: Authority) {
  const latest = new Map<string, CommandIntent>();
  [...authority.acknowledgements, ...authority.rows].filter(row => isLifecycle(row.command) && row.state !== 'conflict')
    .sort((a, b) => a.createdAt - b.createdAt).forEach(row => latest.set(row.command.workId, row));
  return latest;
}

const validItem = (value: Partial<TrashItem>): value is TrashItem => typeof value?.workId === 'string' && typeof value.name === 'string'
  && ['game', 'manga', 'movie', 'av'].includes(value.type as string) && typeof value.purgeAt === 'string' && Number.isSafeInteger(value.entityRevision);

/**
 * The Collections 휴지통: trashed works newest first, read while Collections is shown (its count
 * sits on the shortcut). `available` stays false until the server answers, so an older server
 * or APK simply shows no shortcut.
 */
export function useCollectionTrash(authority: Authority, active: boolean, refreshKey: unknown) {
  const identity = authority.identity, connection = outboxConnection();
  const [reply, setReply] = useState<{identity: AuthorityIdentity; connection: string | null; items: TrashItem[]; readAt: number} | null>(null);
  const [failure, setFailure] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active || !identity || !connection) return;
    const controller = new AbortController(), readAt = Date.now();
    const params = new URLSearchParams({libraryId: identity.libraryId, epoch: String(identity.epoch)});
    void api<AuthorityIdentity & {items: Partial<TrashItem>[]}>(`${TRASH_PATH}?${params}`, controller.signal, undefined, 'GET', false, connection).then(value => {
      if (controller.signal.aborted || !sameAuthority({...value, contractVersion: 1}, identity) || !Array.isArray(value.items)) return;
      setReply({identity, connection, items: value.items.filter(validItem), readAt}); setFailure('');
    }, reason => { if (!controller.signal.aborted) setFailure(errorText(reason)); });
    return () => controller.abort();
  }, [active, identity?.libraryId, identity?.epoch, connection, refreshKey, retry]);
  const current = reply && identity && sameAuthority(reply.identity, identity) && reply.connection === connection ? reply : null;
  const intents = lifecycleIntents(authority);
  // A restore leaves the list while on its way; a later read (after it is confirmed) is the
  // server's word, and a restore that could not be sent comes back with its 대기 row.
  const items = current?.items.filter(item => {
    const intent = intents.get(item.workId);
    return !(intent?.command.commandType === 'restoreWork' && (lifecycleInFlight(intent) || intent.state === 'accepted' && (intent.acceptedAt ?? 0) > current.readAt));
  }) ?? [];
  return {available: !!current, items, failure, retry: () => setRetry(value => value + 1)};
}
export type CollectionTrashState = ReturnType<typeof useCollectionTrash>;

function purgeLabel(purgeAt: string, now: number) {
  const days = Math.ceil((Date.parse(purgeAt) - now) / DAY_MS);
  return days > 0 ? `${days}일 후 영구 삭제` : '곧 영구 삭제';
}

export function CollectionTrashSheet({trash, authority, privacy, onClose}: {trash: CollectionTrashState; authority: Authority; privacy: boolean; onClose(): void}) {
  const [failure, setFailure] = useState('');
  // AV stays out of sight in privacy mode, as its tab does.
  const items = trash.items.filter(item => !privacy || item.type !== 'av'), now = Date.now();
  const restore = (item: TrashItem) => {
    try { authority.enqueue({commandType: 'restoreWork', workId: item.workId, expectedRevision: item.entityRevision}, item.name); setFailure(''); }
    catch (reason) { setFailure(errorText(reason)); }
  };
  return <BottomSheet title="휴지통" onClose={onClose}>
    {(failure || trash.failure) && <p role="alert" className="collection-manage-failure">{failure || trash.failure}{!failure && <Button variant="ghost" onClick={trash.retry}>다시 시도</Button>}</p>}
    {!trash.available ? <BusyLabel busy={!trash.failure} idle=""><p className="hint" role="status">휴지통을 불러오는 중…</p></BusyLabel>
      : !items.length ? <EmptyState icon={TrashIcon} title="휴지통이 비어 있어요" inline/>
      : <ul className="collection-trash" aria-label="휴지통 작품">{items.map(item => <li key={item.workId} className="collection-trash-row">
        <span className="bind-thumb collection-trash-thumb"><span className="bind-thumb-placeholder"><RectangleStackIcon aria-hidden="true"/></span></span>
        <span className="collection-trash-text"><strong>{item.name}</strong><small>{KIND_LABEL[item.type]} · <span className="numeric">{purgeLabel(item.purgeAt, now)}</span></small></span>
        <Button aria-label={`${item.name} 되살리기`} onClick={() => restore(item)}>되살리기</Button>
      </li>)}</ul>}
  </BottomSheet>;
}
