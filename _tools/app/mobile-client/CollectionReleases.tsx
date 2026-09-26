import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {BellIcon, RectangleStackIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription} from './ui';
import {usePullToRefresh} from './usePullToRefresh';
import {errorText} from './transport';
import type {CollectionSummary} from './collectionModel';
import {
  acknowledgeReleases, allMangaWorks, allUnreadReleases, groupReleases, japanReleases, koreanReleases, koreanVolumeLine, localToday, releaseLine,
  type MangaShelf, type ReleaseCounts, type ReleaseEvent,
} from './collectionReleases';

type Region = 'kr' | 'jp';
/**
 * What the 신간 screen last read, kept by the parent across closing and reopening (the parent
 * is remounted per endpoint, so this is scoped to it). The shelf is valid for the parent's
 * `refresh` it was read under; the events for that `refresh` and the release list revision
 * they came from. A null key means "read again" (never read, or pulled).
 */
export type ReleaseStore = {
  shelf: MangaShelf | null; shelfRefresh: number | null;
  events: ReleaseEvent[]; eventsRefresh: number | null; eventsRevision: number | null;
  loaded: boolean;
};
export const emptyReleaseStore = (): ReleaseStore => ({shelf: null, shelfRefresh: null, events: [], eventsRefresh: null, eventsRevision: null, loaded: false});
/** Volumes ahead of the Korean edition shown as chips before the rest fold into "외 N권". */
const AHEAD_CHIPS = 12;
export const SCHEDULE_ABSENT_NOTE = 'PC 앱을 업데이트하면 권별 발매 정보가 보여요';

/**
 * The 신간 screen: release information for the manga whose 신간 알림 is on, in two tabs.
 * 한국 정발 lists each work's Kakao volumes beyond the owned count (released or pre-registered);
 * 일본 shows the latest MangaDex volume and how far it is ahead of the Korean edition.
 * Unread release events only highlight what they concern ("NEW"); 확인 marks them read on the
 * server (the PC follows) and the information stays. Owned counts come from `ownedOf`, which
 * includes queued tracking edits, so a change shows here at once.
 */
export function CollectionReleases({active, store, counts, refresh, revision: listRevision, onCounts, onRevision, onOpen, cover, ownedOf, watching}: {
  active: boolean;
  /** The last read, reused on reopen while `refresh` and `revision` still match it. */
  store: {current: ReleaseStore};
  counts: ReleaseCounts;
  /** Bumped by the parent when the publication or a personal edit changed; re-reads on next show. */
  refresh: number;
  /** The release list revision the parent last saw (it moves when the PC publishes or anything is confirmed). */
  revision: number | null;
  /** The screen learned newer counts (a read, or a confirmed 확인). */
  onCounts(counts: ReleaseCounts): void;
  /** The screen learned a newer release list revision (a read, or its own 확인). */
  onRevision(revision: number | null): void;
  onOpen(collectionId: string): void;
  cover(work: CollectionSummary | undefined, revision: string, name: string): ReactNode;
  /** The visible owned count of one edition (a queued edit included), or null when untracked. */
  ownedOf(work: CollectionSummary, edition: number): number | null;
  /** 신간 알림 is on (a queued edit included). */
  watching(work: CollectionSummary): boolean;
}) {
  const [region, setRegion] = useState<Region>('kr');
  const [data, setData] = useState<ReleaseStore>(() => store.current);
  const [status, setStatus] = useState({busy: false, error: ''});
  const [nonce, setNonce] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const [ackError, setAckError] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const latest = useRef(data); latest.current = data;
  const countsRef = useRef(counts); countsRef.current = counts;
  const report = useRef(onCounts); report.current = onCounts;
  const reportRevision = useRef(onRevision); reportRevision.current = onRevision;
  const commit = (next: ReleaseStore) => { store.current = next; setData(next); };

  // Only what is out of date is read: the whole manga shelf when the publication (or a personal
  // edit) moved, the unread events when that or the release list revision moved.
  useEffect(() => {
    if (!active) return;
    const current = store.current;
    const wantShelf = current.shelfRefresh !== refresh;
    const wantEvents = current.eventsRefresh !== refresh || current.eventsRevision !== listRevision;
    if (!wantShelf && !wantEvents) return;
    const controller = new AbortController();
    setStatus({busy: true, error: ''});
    void Promise.all([wantShelf ? allMangaWorks(controller.signal) : null, wantEvents ? allUnreadReleases(controller.signal) : null]).then(([shelf, releases]) => {
      if (controller.signal.aborted) return;
      const next = {...store.current, loaded: true};
      if (shelf) Object.assign(next, {shelf, shelfRefresh: refresh});
      if (releases) Object.assign(next, {events: releases.items, eventsRefresh: refresh, eventsRevision: releases.revision});
      commit(next);
      setStatus({busy: false, error: ''});
      if (releases) { report.current(releases.counts); reportRevision.current(releases.revision); }
    }).catch(reason => {
      if (!controller.signal.aborted) setStatus({busy: false, error: errorText(reason) || '신간 정보를 불러오지 못했습니다.'});
    });
    return () => controller.abort();
  }, [active, refresh, listRevision, nonce]);

  /** A pull (or 다시 시도) reads everything again. */
  const reload = useCallback(() => {
    store.current = {...store.current, shelfRefresh: null, eventsRefresh: null};
    setNonce(n => n + 1);
  }, [store]);
  const pull = usePullToRefresh(scroller, reload, status.busy, !active);

  /**
   * Drop confirmed Collections' events here, in the kept copy and from the counts; the
   * information stays. A 확인 that moved the list revision by exactly its own step keeps the
   * copy current; any other step means something else changed too, so the next show re-reads.
   */
  const settle = (collectionId: string, after?: number) => {
    const current = store.current;
    const own = typeof after === 'number' && current.eventsRevision !== null && (after === current.eventsRevision || after === current.eventsRevision + 1);
    commit({...current, events: current.events.filter(event => event.collectionId !== collectionId), eventsRevision: own ? after : current.eventsRevision});
    if (own) reportRevision.current(after);
    const byCollection = {...countsRef.current.byCollection};
    delete byCollection[collectionId];
    const next = {unread: Object.values(byCollection).reduce((sum, n) => sum + n, 0), byCollection};
    countsRef.current = next;
    report.current(next);
  };

  const acknowledgeWork = async (collectionId: string) => {
    setWorking(collectionId); setAckError('');
    try { settle(collectionId, (await acknowledgeReleases({collectionId})).revision); }
    catch (reason) { setAckError(errorText(reason) || '확인하지 못했습니다.'); }
    finally { setWorking(null); }
  };

  /** 모두 확인: the per-Collection form for every Collection with unread events, one by one. */
  const acknowledgeAll = async () => {
    setConfirmAll(false); setWorking('all'); setAckError('');
    const ids = [...new Set([...Object.keys(countsRef.current.byCollection), ...latest.current.events.map(event => event.collectionId)])];
    try {
      for (const id of ids) settle(id, (await acknowledgeReleases({collectionId: id})).revision);
    } catch (reason) {
      setAckError(errorText(reason) || '확인하지 못했습니다.');
    } finally { setWorking(null); }
  };

  const today = localToday();
  const shelf = data.shelf;
  const works = shelf?.works ?? [];
  const watched = works.filter(watching);
  // An older PC publishes no `releaseSchedule` at all; one upgraded PC key anywhere means it is live.
  const absent = !!shelf && works.length > 0 && !works.some(work => work.releaseSchedule !== undefined);
  const korean = koreanReleases(watched, ownedOf, data.events, today);
  const japan = japanReleases(watched, data.events);
  // A work either tab lists keeps its notifications there; the rest are listed plainly below.
  const shown = new Set([...korean, ...japan].map(row => row.work.id));
  const news = {kr: korean.filter(row => row.volumes.some(volume => volume.fresh)).length, jp: japan.filter(row => row.aheadVolumes.some(volume => volume.fresh)).length};
  const others = groupReleases(data.events.filter(event => !shown.has(event.collectionId)));
  const unread = Math.max(counts.unread, data.events.length);
  const busy = working !== null;
  const revision = shelf?.revision ?? '';
  const workOf = (id: string) => works.find(work => work.id === id);

  const confirmButton = (id: string, name: string) => <Button variant="ghost" className="collection-release-action" disabled={busy} aria-label={`${name} 확인`} onClick={() => void acknowledgeWork(id)}>{working === id ? '확인 중…' : '확인'}</Button>;
  const head = (work: CollectionSummary, lines: ReactNode, fresh: number) => <div className="collection-release-group__head">
    <button className="collection-release-group__open" onClick={() => onOpen(work.id)}>
      <span className="collection-release-group__cover">{cover(work, revision, work.name)}</span>
      <span className="collection-release-group__title"><strong>{work.name}</strong>{lines}</span>
      {fresh > 0 && <span className="collection-release-new numeric" aria-label={`새 알림 ${fresh}개`}>NEW {fresh}</span>}
    </button>
    {fresh > 0 && confirmButton(work.id, work.name)}
  </div>;

  return <div ref={scroller} className="collection-list collection-releases" style={{display: active ? undefined : 'none'}}>
    {pull}
    <div className="library-segments collection-segments" role="tablist" aria-label="신간 지역">
      {(['kr', 'jp'] as const).map(value => <button key={value} role="tab" aria-selected={region === value} aria-description={news[value] ? `새 소식 ${news[value]}개` : undefined} onClick={() => setRegion(value)}>
        {value === 'kr' ? '한국 정발' : '일본'}{news[value] > 0 && <span className="collection-release-count numeric" aria-hidden="true">{news[value]}</span>}
      </button>)}
    </div>
    {status.error && <div className="inline-error" role="alert"><span>{status.error}</span><Button variant="ghost" onClick={reload}>다시 시도</Button></div>}
    {ackError && <div className="inline-error" role="alert"><span>{ackError}</span></div>}
    {status.busy && !data.loaded && <p className="hint collection-more-status" role="status">신간 정보를 불러오는 중…</p>}
    {data.loaded && shelf && !shelf.ready && <div className="empty-state"><RectangleStackIcon/><h2>컬렉션이 아직 공유되지 않았습니다</h2><p>PC의 설정에서 컬렉션을 클라우드에 게시하면 여기에 표시됩니다.</p></div>}
    {absent && <p className="collection-tracking-reason collection-release-note" role="note">{SCHEDULE_ABSENT_NOTE}</p>}
    {unread > 0 && data.loaded && <div className="collection-releases-head">
      <p className="hint">새 알림 <span className="numeric">{unread.toLocaleString()}</span>개 · 확인하면 PC에서도 읽음으로 바뀝니다.</p>
      <Button variant="ghost" className="collection-releases-all" disabled={busy} onClick={() => setConfirmAll(true)}>모두 확인</Button>
    </div>}
    {data.loaded && shelf?.ready && !absent && !watched.length && <div className="empty-state"><BellIcon/><h2>신간 알림을 켠 만화가 없습니다</h2><p>작품 상세의 내 기록에서 신간 알림을 켜면 여기에 모입니다.</p></div>}
    {data.loaded && !absent && watched.length > 0 && region === 'kr' && !korean.length && <div className="empty-state"><BellIcon/><h2>소장하지 않은 정발 권이 없습니다</h2><p>한국에 나온 권을 모두 소장했거나 아직 발매 정보가 없습니다.</p></div>}
    {data.loaded && !absent && watched.length > 0 && region === 'jp' && !japan.length && <div className="empty-state"><BellIcon/><h2>일본 발매 정보가 없습니다</h2><p>MangaDex에서 찾은 권이 있으면 여기에 표시됩니다.</p></div>}

    {region === 'kr' && korean.map(row => <section key={row.work.id} className={`collection-release-group${row.fresh ? ' is-new' : ''}`} aria-label={row.work.name}>
      {head(row.work, <small className="numeric">{row.owned === null ? '소장 기록 없음' : `${row.owned}권까지 소장`}</small>, row.fresh)}
      <ul className="collection-release-volumes">{row.volumes.map(volume => <li key={volume.volumeNumber} className={volume.fresh ? 'is-new' : undefined}>
        <span className={`numeric${volume.upcoming ? ' is-upcoming' : ''}`}>{koreanVolumeLine(volume, today)}</span>
        <span className="collection-release-tag">미보유</span>
        {volume.fresh && <span className="collection-release-new">NEW</span>}
      </li>)}</ul>
    </section>)}

    {region === 'jp' && japan.map(row => <section key={row.work.id} className={`collection-release-group${row.fresh ? ' is-new' : ''}`} aria-label={row.work.name}>
      {head(row.work, <><small className="numeric">일본 최신 {row.latest}권</small>{row.ahead ? <small className="numeric is-ahead">한국 정발보다 {row.ahead}권 앞섬</small> : null}</>, row.fresh)}
      {row.aheadVolumes.length > 0 && <ul className="collection-release-chips" aria-label={`${row.work.name} 일본 권`}>
        {row.aheadVolumes.slice(0, AHEAD_CHIPS).map(volume => <li key={volume.volumeNumber} className={volume.fresh ? 'is-new' : undefined}><span className="numeric">{volume.volumeNumber}권</span>{volume.fresh && <span className="collection-release-new">NEW</span>}</li>)}
        {row.aheadVolumes.length > AHEAD_CHIPS && <li className="is-more"><span className="numeric">외 {row.aheadVolumes.length - AHEAD_CHIPS}권</span></li>}
      </ul>}
    </section>)}

    {data.loaded && others.length > 0 && <>
      <h2 className="collection-release-others">{shown.size ? '그 밖의 새 알림' : '새 알림'}</h2>
      {others.map(group => <section key={group.collectionId} className="collection-release-group is-new" aria-label={group.name}>
        <div className="collection-release-group__head">
          <button className="collection-release-group__open" onClick={() => onOpen(group.collectionId)}>
            <span className="collection-release-group__cover">{cover(workOf(group.collectionId), revision, group.name)}</span>
            <span className="collection-release-group__title"><strong>{group.name}</strong></span>
            <span className="collection-release-new numeric" aria-label={`새 알림 ${group.events.length}개`}>NEW {group.events.length}</span>
          </button>
          {confirmButton(group.collectionId, group.name)}
        </div>
        <ul className="collection-release-volumes">{group.events.map(event => <li key={event.eventId}><span className="numeric">{releaseLine(event)}</span></li>)}</ul>
      </section>)}
    </>}

    {confirmAll && <Dialog open title="모두 확인할까요?" onClose={() => setConfirmAll(false)}><DialogDescription className="collection-sheet-label">새 알림 {unread.toLocaleString()}개를 읽음으로 바꿉니다. 발매 정보는 그대로 남고, PC에서도 읽음으로 바뀝니다.</DialogDescription>
      <div className="library-sheet collection-memo-choice">
        <Button variant="primary" onClick={() => void acknowledgeAll()}>모두 확인</Button>
        <Button variant="ghost" onClick={() => setConfirmAll(false)}>취소</Button>
      </div>
    </Dialog>}
  </div>;
}
