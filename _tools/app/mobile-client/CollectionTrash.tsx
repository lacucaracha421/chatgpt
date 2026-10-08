import {useEffect, useState} from 'react';
import {RectangleStackIcon} from '@heroicons/react/24/outline';
import {trashExpiry, TRASH_EMPTY} from '../src/safety/trashSections';
import {KIND_LABEL} from '../src/collections/collectionFormat';
import {Button, EmptyState, Skeleton} from './ui';
import {setTabletTrashCount} from './trashCounts';
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

/**
 * Each work's newest delete or restore that is still queued or was confirmed this session. A
 * conflict no longer stands: the work stays where the server has it until the row is resolved.
 */
export function lifecycleIntents(authority: Authority) {
  const latest = new Map<string, CommandIntent>();
  [...authority.acknowledgements, ...authority.rows].filter(row => isLifecycle(row.command) && row.state !== 'conflict')
    .sort((a, b) => a.createdAt - b.createdAt).forEach(row => latest.set(row.command.workId!, row));
  return latest;
}

const validItem = (value: Partial<TrashItem>): value is TrashItem => typeof value?.workId === 'string' && typeof value.name === 'string'
  && ['game', 'manga', 'movie', 'av'].includes(value.type as string) && typeof value.purgeAt === 'string' && Number.isSafeInteger(value.entityRevision);

/**
 * Trashed works newest first. Retain the last read during refreshes and publish only known
 * counts for More; data reads remain owned by the tablet's authority connection.
 */
export function useCollectionTrash(authority: Authority, active: boolean, refreshKey: unknown) {
  const identity = authority.identity, connection = outboxConnection();
  const [reply, setReply] = useState<{identity: AuthorityIdentity; connection: string | null; items: TrashItem[]; hasMore: boolean; readAt: number} | null>(null);
  const [failure, setFailure] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active || !identity || !connection) return;
    const controller = new AbortController(), readAt = Date.now();
    const params = new URLSearchParams({libraryId: identity.libraryId, epoch: String(identity.epoch)});
    void api<AuthorityIdentity & {items: Partial<TrashItem>[]; hasMore?: boolean}>(`${TRASH_PATH}?${params}`, controller.signal, undefined, 'GET', false, connection).then(value => {
      if (controller.signal.aborted) return;
      if (!sameAuthority({...value, contractVersion: 1}, identity) || !Array.isArray(value.items)) throw new Error('컬렉션 휴지통을 불러오지 못했습니다.');
      setReply({identity, connection, items: value.items.filter(validItem), hasMore: !!value.hasMore, readAt}); setFailure('');
    }).catch(reason => { if (!controller.signal.aborted) setFailure(errorText(reason)); });
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
  useEffect(() => { if (current && connection) setTabletTrashCount(connection, 'collections', current.hasMore ? 0 : items.length); }, [current, connection, items.length]);
  return {available: !!current, items, hasMore: current?.hasMore ?? false, failure, retry: () => setRetry(value => value + 1)};
}
export type CollectionTrashState = ReturnType<typeof useCollectionTrash>;

export function CollectionTrashContent({trash, authority, privacy}: {trash: CollectionTrashState; authority: Authority; privacy: boolean}) {
  const [failure, setFailure] = useState('');
  // AV stays out of sight in privacy mode, as its tab does.
  const items = trash.items.filter(item => !privacy || item.type !== 'av');
  const restore = (item: TrashItem) => {
    try { authority.enqueue({commandType: 'restoreWork', workId: item.workId, expectedRevision: item.entityRevision}, item.name); setFailure(''); }
    catch (reason) { setFailure(errorText(reason)); }
  };
  return <>
    {(failure || trash.failure) && <p role="alert" className="collection-manage-failure">{failure || trash.failure}<Button variant="ghost" onClick={() => {setFailure(''); trash.retry();}}>다시 시도</Button></p>}
    {!trash.available ? !trash.failure && <div className="collection-trash" aria-label="휴지통을 불러오는 중">{[0,1,2].map(index => <Skeleton className="collection-trash-row" key={index} label={null}/>)}</div>
      : !items.length ? <EmptyState title={TRASH_EMPTY} inline/>
      : <ul className="collection-trash" aria-label="휴지통 작품">{items.map(item => <li key={item.workId} className="collection-trash-row">
        <span className="bind-thumb collection-trash-thumb"><span className="bind-thumb-placeholder"><RectangleStackIcon aria-hidden="true"/></span></span>
        <span className="collection-trash-text"><strong>{item.name}</strong><small>{KIND_LABEL[item.type]} · <span className="numeric">{trashExpiry(item.purgeAt)}</span></small></span>
        <Button aria-label={`${item.name} 되살리기`} onClick={() => restore(item)}>되살리기</Button>
      </li>)}</ul>}
  </>;
}
