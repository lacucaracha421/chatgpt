import { BusyLabel } from "../src/shared/ui/BusyLabel";
import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {BellIcon, RectangleStackIcon} from '@heroicons/react/24/outline';
import {japanReleaseLedger, koreanReleaseLedger, releaseLedgerCounts, type ReleaseLedgerRow} from '../src/collections/releaseLedger';
import {groupInbox, releaseLine} from '../src/collections/releaseCaption';
import {displayCount, displayDate, displayDateTime} from '../src/shared/displayDate';
import type {CollectionSummary as SharedSummary} from '../src/library/types';
// The PC ledger's stylesheet; `collectionShelf.css` sizes its rows and cover for the tablet.
import '../src/collections/collectionReleases.css';
import {Badge, Button, Dialog, DialogDescription, EmptyState, SegmentedControl, Skeleton} from './ui';
import {usePullToRefresh} from './usePullToRefresh';
import {useSegmentMotion} from './motion';
import {Scrubber} from './Scrubber';
import {errorText} from './transport';
import type {CollectionSummary} from './collectionModel';
import {commitReleases, invalidateReleases, loadShelf, releaseEpoch, releaseStore, type ReleaseStore} from './releaseStore';
import {acknowledgeReleases, allUnreadReleases, localToday, releaseBoardEntry, releaseInboxItem, type ReleaseCounts} from './collectionReleasesModel';

type Region = 'kr' | 'jp';
export const SCHEDULE_ABSENT_NOTE = 'PC 앱을 업데이트하면 권별 발매 정보가 보여요';

/**
 * The 신간 screen as the PC's dense ledger: one row per watched work (cover, 작품, 소장, the
 * volumes not owned, 날짜, 상태), with the volume counts above. The rows, their order, chips and
 * status words are the PC's shared rules (`releaseLedger.ts`), fed with the published release
 * schedule in the PC's board shape. 한국 정발 lists Kakao volumes beyond the owned count; 일본 the
 * MangaDex volumes ahead of it. 확인 marks a work's events read on the server (the PC follows) and
 * the information stays. Owned counts come from `ownedOf`, which includes queued tracking edits.
 */
export function CollectionReleases({active, counts, refresh, revision: listRevision, onCounts, onRevision, onOpen, cover, ownedOf, watching}: {
  active: boolean;
  counts: ReleaseCounts;
  /** Bumped by the parent after it invalidated the shared release store; re-checks what to read. */
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
  const [data, setData] = useState<ReleaseStore>(() => releaseStore.current);
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
  const commit = (next: ReleaseStore) => { commitReleases(next); setData(next); };

  // Only what is out of date is read (the store is shared with Home, which may already have
  // read the shelf): the whole manga shelf when the publication (or a personal edit) moved,
  // the unread events when that or the release list revision moved.
  useEffect(() => {
    if (!active) return;
    const current = releaseStore.current, at = releaseEpoch();
    const wantShelf = !current.shelf || current.shelfEpoch !== at;
    const wantEvents = current.eventsEpoch !== at || current.eventsRevision !== listRevision;
    if (!wantShelf && !wantEvents) { setData(current); return; }
    const controller = new AbortController();
    setStatus({busy: true, error: ''});
    void Promise.all([wantShelf ? loadShelf(controller.signal) : null, wantEvents ? allUnreadReleases(controller.signal) : null]).then(([shelf, releases]) => {
      if (controller.signal.aborted) return;
      const next = {...releaseStore.current, loaded: true};
      if (shelf) Object.assign(next, {shelf, shelfEpoch: at});
      if (releases) Object.assign(next, {events: releases.items, eventsEpoch: at, eventsRevision: releases.revision});
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
    invalidateReleases();
    setNonce(n => n + 1);
  }, []);
  const pull = usePullToRefresh(scroller, reload, status.busy, !active);
  // 한국 정발 → 일본 swaps what is under the region switch sideways; the switch itself stays still.
  useSegmentMotion(scroller, region, region === 'kr' ? 0 : 1, host => Array.from(host.children).filter((child): child is HTMLElement => child instanceof HTMLElement && !child.matches('.collection-segments,.pull-refresh')));

  /**
   * Drop confirmed Collections' events here, in the kept copy and from the counts; the
   * information stays. A 확인 that moved the list revision by exactly its own step keeps the
   * copy current; any other step means something else changed too, so the next show re-reads.
   */
  const settle = (collectionId: string, after?: number) => {
    const current = releaseStore.current;
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
  const works = (shelf?.works ?? []).filter(work => work.type === 'manga');
  const watched = works.filter(watching);
  // An older PC publishes no `releaseSchedule` at all; one upgraded PC key anywhere means it is live.
  const absent = !!shelf && works.length > 0 && !works.some(work => work.releaseSchedule !== undefined);
  // The shared ledger reads the PC's board and inbox; the rows carry the published work back.
  const board = new Map(works.map(work => [work.id, releaseBoardEntry(work, ownedOf, watching)]));
  const inbox = groupInbox(data.events.map(releaseInboxItem));
  const shared = works as unknown as SharedSummary[];
  const korean = koreanReleaseLedger(shared, board, inbox, today);
  const japan = japanReleaseLedger(shared, board, inbox, today);
  const rows = region === 'kr' ? korean : japan;
  const volumeCounts = releaseLedgerCounts(rows);
  // A work either tab lists keeps its notifications there; the rest are listed plainly below.
  const shown = new Set([...korean, ...japan].map(row => row.work.id));
  const others = [...groupInbox(data.events.filter(event => !shown.has(event.collectionId)).map(releaseInboxItem)).entries()];
  const unread = Math.max(counts.unread, data.events.length);
  const checkedAt = works.map(work => work.releaseSchedule?.[region === 'kr' ? 'kakao' : 'mangadex']?.checkedAt).filter((value): value is string => !!value).sort().reverse()[0];
  const scrubberSort=useMemo(()=>({kind:'date' as const,values:data.events.map(event=>event.detectedAt)}),[data.events]);
  const busy = working !== null;
  const revision = shelf?.revision ?? '';
  const workOf = (id: string) => works.find(work => work.id === id);

  const confirmButton = (id: string, name: string) => <Button variant="ghost" size="sm" className="collection-release-action" disabled={busy} aria-label={`${name} 확인`} onClick={event => { event.stopPropagation(); void acknowledgeWork(id); }}><BusyLabel busy={!!(working === id)} idle={'확인'}>확인 중…</BusyLabel></Button>;
  // The PC ledger's row (`src/collections/CollectionReleases.tsx`) with its stylesheet; the tablet sizes it.
  const row = (entry: ReleaseLedgerRow) => {
    const work = entry.work as unknown as CollectionSummary;
    const chips = entry.chips.slice(0, 2);
    const fresh = entry.chips.find(chip => chip.kind === 'new');
    if (fresh && !chips.includes(fresh)) chips[1] = fresh;
    return <tr key={work.id} aria-label={work.name} onClick={() => onOpen(work.id)}>
      <td><span className="collection-releases__cover">{cover(work, revision, work.name)}</span></td>
      <td className="collection-releases__name"><button type="button" onClick={event => { event.stopPropagation(); onOpen(work.id); }}><strong className="collection-releases__work-title">{work.name}</strong></button></td>
      <td className="collection-releases__owned">{entry.owned === null ? '기록 없음' : entry.owned === 0 ? '0권' : entry.owned === 1 ? '1권' : `1–${displayCount(entry.owned)} 권`}</td>
      <td><div className="collection-releases__chips" aria-label={`${work.name} ${region === 'jp' ? '일본' : '정발'} 권`}>
        {chips.map(chip => chip.kind === 'upcoming'
          ? <span key={chip.volumeNumber} className="collection-releases__upcoming" data-chip-kind={chip.kind}><span>{chip.label}</span></span>
          : <Badge key={chip.volumeNumber} variant={chip.kind === 'new' ? 'accent' : 'plain'} data-chip-kind={chip.kind}><span>{chip.label}</span></Badge>)}
        {entry.chips.length > 2 && <Badge aria-label={`추가 ${entry.chips.length - 2}권`}>+{entry.chips.length - 2}</Badge>}
        {!entry.chips.length && <span className="collection-releases__muted">—</span>}
      </div></td>
      <td className="collection-releases__date">{entry.date ? displayDate(entry.date) : '—'}</td>
      <td><div className="collection-releases__state"><div>
        {entry.status === 'NEW' ? <Badge variant="accent" aria-label={`새 알림 ${entry.items.length}개`}>NEW</Badge> : <span className={entry.status.startsWith('D-') || entry.status === '오늘' ? 'collection-releases__soon' : 'collection-releases__muted'}>{entry.status}</span>}
        {entry.ahead && <small>{entry.ahead}</small>}
      </div>{entry.items.length > 0 && confirmButton(work.id, work.name)}</div></td>
    </tr>;
  };

  return <div ref={scroller} className="collection-scroll collection-releases" style={{display: active ? undefined : 'none'}}>
    {pull}
    <div className="release-ledger__bar">
      <SegmentedControl<Region>
        className="collection-segments"
        label="신간 지역"
        options={[{value: 'kr', label: '한국 정발', count: korean.length}, {value: 'jp', label: '일본', count: japan.length}]}
        value={region}
        onChange={setRegion}
      />
      {checkedAt && <span className="collection-releases__checked">{displayDateTime(checkedAt)} 확인</span>}
      <Button variant="ghost" size="sm" className="collection-releases-all" disabled={busy || unread === 0} onClick={() => setConfirmAll(true)}>모두 확인</Button>
    </div>
    {status.error && <div className="inline-error" role="alert"><span>{status.error}</span><Button variant="ghost" onClick={reload}>다시 시도</Button></div>}
    {ackError && <div className="inline-error" role="alert"><span>{ackError}</span></div>}
    {status.busy && !data.loaded && <Skeleton className="collection-releases__skeleton-row" label="신간 정보를 불러오는 중" />}
    {data.loaded && shelf && !shelf.ready && <EmptyState icon={RectangleStackIcon} title="컬렉션이 아직 공유되지 않았습니다" />}
    {absent && <p className="collection-tracking-reason collection-release-note" role="note">{SCHEDULE_ABSENT_NOTE}</p>}
    {data.loaded && !absent && rows.length > 0 && <div className="collection-releases__counts" aria-label="권별 집계">
      <span><strong>{displayCount(volumeCounts.fresh)}</strong>새로 나옴</span>
      <span><strong>{displayCount(volumeCounts.unowned)}</strong>나왔지만 아직 없음</span>
      <span><strong>{displayCount(volumeCounts.upcoming)}</strong>발매 예정</span>
    </div>}
    {data.loaded && shelf?.ready && !absent && !watched.length && !others.length && <EmptyState icon={BellIcon} title="신간 알림을 켠 만화가 없습니다" />}
    {data.loaded && !absent && watched.length > 0 && !rows.length && <EmptyState icon={BellIcon} title={region === 'jp' ? '일본 발매 정보가 없습니다' : '소장하지 않은 정발 권이 없습니다'} />}
    {rows.length > 0 && <table className="collection-releases__ledger" aria-label={`${region === 'jp' ? '일본' : '한국 정발'} 신간`}>
      <colgroup><col className="collection-releases__cover-col"/><col className="collection-releases__title-col"/><col className="collection-releases__owned-col"/><col/><col className="collection-releases__date-col"/><col className="collection-releases__state-col"/></colgroup>
      <thead><tr><th aria-label="표지"/><th scope="col">작품</th><th scope="col">소장</th><th scope="col">안 가진 권</th><th scope="col">날짜</th><th scope="col">상태</th></tr></thead>
      <tbody>{rows.map(row)}</tbody>
    </table>}

    {data.loaded && others.length > 0 && <>
      <h3 className="collection-releases__others">{shown.size ? '그 밖의 새 알림' : '새 알림'}</h3>
      {others.map(([id, items]) => <div key={id} className="collection-releases__other" role="region" aria-label={items[0]!.collectionName}>
        <button type="button" onClick={() => onOpen(id)}><span className="collection-releases__cover">{cover(workOf(id), revision, items[0]!.collectionName)}</span>{items[0]!.collectionName}</button>
        <span className="numeric">{items.map(releaseLine).join(' · ')}</span>
        <Badge variant="accent" aria-label={`새 알림 ${items.length}개`}>NEW</Badge>
        {confirmButton(id, items[0]!.collectionName)}
      </div>)}
    </>}

    <Scrubber scrollRef={scroller} total={data.events.length} sort={scrubberSort} hidden={!active||!data.loaded||confirmAll}/>

    {confirmAll && <Dialog open title="모두 확인할까요?" onClose={() => setConfirmAll(false)}><DialogDescription className="collection-sheet-label">새 알림 {unread.toLocaleString()}개를 읽음으로 바꿉니다. 발매 정보는 그대로 남고, PC에서도 읽음으로 바뀝니다.</DialogDescription>
      <div className="library-sheet collection-memo-choice">
        <Button variant="primary" onClick={() => void acknowledgeAll()}>모두 확인</Button>
        <Button variant="ghost" onClick={() => setConfirmAll(false)}>취소</Button>
      </div>
    </Dialog>}
  </div>;
}
