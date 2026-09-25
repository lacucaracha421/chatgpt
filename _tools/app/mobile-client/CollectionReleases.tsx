import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {BellIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription} from './ui';
import {usePullToRefresh} from './usePullToRefresh';
import {errorText} from './transport';
import {acknowledgeReleases, groupReleases, releaseCounts, releaseLine, releasesPage, type ReleaseCounts, type ReleaseEvent} from './collectionReleases';

type Inbox = {items: ReleaseEvent[]; next: string | null; loaded: boolean; busy: boolean; more: boolean; error: string; moreError: string};
const EMPTY: Inbox = {items: [], next: null, loaded: false, busy: false, more: false, error: '', moreError: ''};
const nearEnd = (element: HTMLElement) => element.clientHeight > 0 && element.scrollHeight - element.scrollTop - element.clientHeight < element.clientHeight;

/**
 * The 신간 알림 inbox: the PC's unread release events grouped by Collection, newest first.
 * 확인 (one event) and 모두 확인 (one Collection, or every Collection one by one) mark them
 * read on the server, which the PC follows, so they clear there too. Nothing is removed until
 * the server confirms; offline, the list and a short reason stay.
 */
export function CollectionReleases({active, counts, onCounts, onOpen, cover}: {
  active: boolean;
  counts: ReleaseCounts;
  /** The inbox learned newer counts (a page read, or a confirmed 확인). */
  onCounts(counts: ReleaseCounts): void;
  onOpen(collectionId: string): void;
  cover(collectionId: string, name: string): ReactNode;
}) {
  const [inbox, setInbox] = useState<Inbox>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const [ackError, setAckError] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const latest = useRef(inbox); latest.current = inbox;
  const countsRef = useRef(counts); countsRef.current = counts;
  const report = useRef(onCounts); report.current = onCounts;
  /** The reload whose first page is shown; a hidden-then-shown inbox keeps it, a pull re-reads. */
  const committed = useRef(-1);

  useEffect(() => {
    if (!active || committed.current === nonce) return;
    const controller = new AbortController();
    setInbox(current => ({...current, busy: true, error: '', moreError: ''}));
    void releasesPage(null, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      committed.current = nonce;
      setInbox({items: page.items ?? [], next: page.hasMore ? page.nextCursor : null, loaded: true, busy: false, more: false, error: '', moreError: ''});
      report.current(releaseCounts(page));
    }).catch(reason => {
      if (!controller.signal.aborted) setInbox(current => ({...current, busy: false, error: errorText(reason) || '신간 알림을 불러오지 못했습니다.'}));
    });
    return () => controller.abort();
  }, [active, nonce]);

  const loadMore = useCallback(() => {
    const current = latest.current;
    if (!current.next || current.busy || current.more || current.moreError) return;
    setInbox(value => ({...value, more: true}));
    void releasesPage(current.next).then(page => {
      if (latest.current.next !== current.next) return;
      setInbox(value => {
        const seen = new Set(value.items.map(event => event.eventId));
        return {...value, items: [...value.items, ...(page.items ?? []).filter(event => !seen.has(event.eventId))], next: page.hasMore ? page.nextCursor : null, more: false};
      });
    }).catch(reason => setInbox(value => ({...value, more: false, moreError: errorText(reason) || '더 불러오지 못했습니다.'})));
  }, []);

  const reload = useCallback(() => setNonce(n => n + 1), []);
  const pull = usePullToRefresh(scroller, reload, inbox.busy, !active);

  /** Drop confirmed events here and from the counts, then let the parent re-read them. */
  const settle = (removed: (event: ReleaseEvent) => boolean, collections: Record<string, number | 'all'>) => {
    setInbox(value => ({...value, items: value.items.filter(event => !removed(event))}));
    const byCollection = {...countsRef.current.byCollection};
    for (const [id, amount] of Object.entries(collections)) {
      const left = amount === 'all' ? 0 : (byCollection[id] ?? 0) - amount;
      if (left > 0) byCollection[id] = left; else delete byCollection[id];
    }
    report.current({unread: Object.values(byCollection).reduce((sum, n) => sum + n, 0), byCollection});
  };

  const acknowledgeOne = async (event: ReleaseEvent) => {
    setWorking(event.eventId); setAckError('');
    try {
      const reply = await acknowledgeReleases({eventIds: [event.eventId]});
      const read = (reply?.acknowledged ?? []).includes(event.eventId) ? 1 : 0;
      settle(item => item.eventId === event.eventId, {[event.collectionId]: read});
      // Held nowhere any more (read and retired by the PC): refresh instead of guessing.
      if ((reply?.missing ?? []).length) reload();
    } catch (reason) {
      setAckError(errorText(reason) || '확인하지 못했습니다.');
    } finally { setWorking(null); }
  };

  const acknowledgeCollection = async (collectionId: string) => {
    await acknowledgeReleases({collectionId});
    settle(item => item.collectionId === collectionId, {[collectionId]: 'all'});
  };

  const acknowledgeGroup = async (collectionId: string) => {
    setWorking(`collection:${collectionId}`); setAckError('');
    try { await acknowledgeCollection(collectionId); }
    catch (reason) { setAckError(errorText(reason) || '확인하지 못했습니다.'); }
    finally { setWorking(null); }
  };

  /** 모두 확인: the per-Collection form for every Collection with unread events, one by one. */
  const acknowledgeAll = async () => {
    setConfirmAll(false); setWorking('all'); setAckError('');
    const ids = [...new Set([...Object.keys(countsRef.current.byCollection), ...latest.current.items.map(event => event.collectionId)])];
    try {
      for (const id of ids) await acknowledgeCollection(id);
    } catch (reason) {
      setAckError(errorText(reason) || '확인하지 못했습니다.');
    } finally { setWorking(null); }
  };

  const groups = groupReleases(inbox.items);
  const busy = working !== null;
  return <div ref={scroller} className="collection-list collection-releases" style={{display: active ? undefined : 'none'}} onScroll={event => { if (nearEnd(event.currentTarget)) loadMore(); }}>
    {pull}
    {inbox.error && <div className="inline-error" role="alert"><span>{inbox.error}</span><Button variant="ghost" onClick={reload}>다시 시도</Button></div>}
    {ackError && <div className="inline-error" role="alert"><span>{ackError}</span></div>}
    {inbox.busy && !inbox.loaded && <p className="hint collection-more-status" role="status">신간 알림을 불러오는 중…</p>}
    {inbox.loaded && !groups.length && !inbox.busy && <div className="empty-state"><BellIcon/><h2>새 신간 알림이 없습니다</h2><p>PC가 찾은 새 권과 발매일 변경이 여기에 표시됩니다.</p></div>}
    {groups.length > 0 && <div className="collection-releases-head">
      <p className="hint">확인하면 PC에서도 읽음으로 바뀝니다.</p>
      <Button variant="ghost" className="collection-releases-all" disabled={busy} onClick={() => setConfirmAll(true)}>모두 확인</Button>
    </div>}
    {groups.map(group => {
      const unread = Math.max(counts.byCollection[group.collectionId] ?? 0, group.events.length);
      return <section key={group.collectionId} className="collection-release-group" aria-label={group.name}>
        <div className="collection-release-group__head">
          <button className="collection-release-group__open" onClick={() => onOpen(group.collectionId)}>
            <span className="collection-release-group__cover">{cover(group.collectionId, group.name)}</span>
            <span className="collection-release-group__title"><strong>{group.name}</strong><small className="numeric">신간 {unread}</small></span>
          </button>
          <Button variant="ghost" className="collection-release-action" disabled={busy} aria-label={`${group.name} 모두 확인`} onClick={() => void acknowledgeGroup(group.collectionId)}>모두 확인</Button>
        </div>
        <ul className="collection-release-events">{group.events.map(event => <li key={event.eventId}>
          <button className="collection-release-event" onClick={() => onOpen(event.collectionId)}><span className="numeric">{releaseLine(event)}</span></button>
          <Button variant="ghost" className="collection-release-action" disabled={busy} aria-label={`${releaseLine(event)} 확인`} onClick={() => void acknowledgeOne(event)}>{working === event.eventId ? '확인 중…' : '확인'}</Button>
        </li>)}</ul>
      </section>;
    })}
    {inbox.more && <p className="hint collection-more-status" role="status">더 불러오는 중…</p>}
    {inbox.moreError && <div className="inline-error" role="alert"><span>{inbox.moreError}</span><Button variant="ghost" onClick={() => { setInbox(value => ({...value, moreError: ''})); window.setTimeout(loadMore); }}>다시 시도</Button></div>}
    {confirmAll && <Dialog open title="모두 확인할까요?" onClose={() => setConfirmAll(false)}><DialogDescription className="collection-sheet-label">신간 알림 {Math.max(counts.unread, inbox.items.length).toLocaleString()}개를 읽음으로 바꿉니다. PC에서도 읽음으로 바뀝니다.</DialogDescription>
      <div className="library-sheet collection-memo-choice">
        <Button variant="primary" onClick={() => void acknowledgeAll()}>모두 확인</Button>
        <Button variant="ghost" onClick={() => setConfirmAll(false)}>취소</Button>
      </div>
    </Dialog>}
  </div>;
}
