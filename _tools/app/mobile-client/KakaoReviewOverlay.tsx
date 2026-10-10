import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {EllipsisHorizontalIcon} from '@heroicons/react/24/outline';
import {Button, IconButton, SegmentedControl, Skeleton} from './ui';
import {Overlay} from './Overlay';
import {BottomSheet} from './BottomSheet';
import {BindSearchSheet} from './CollectionBindings';
import {BINDINGS_STATUS_PATH, BIND_REQUESTS_PATH, serverOwned, type BindRequest, type BindStatus, type RequestsReply} from './collectionBindingsModel';
import {collectionPath, type CollectionPage, type CollectionSummary, type CollectionDetail} from './collectionModel';
import {api, errorText} from './transport';
import {outboxConnection} from './outboxConnection';
import {useSyncSignal} from './syncSignals';
import {visibleInterval} from './useVisibleInterval';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {Toast} from '../src/shared/ui/Toast';
import {useAutoDismiss} from '../src/shared/ui/useAutoDismiss';
import {KakaoReviewIdentity, KakaoReviewVolumes} from '../src/collections/KakaoReviewIdentity';
import {QUERY_SOURCES, kakaoReviewSegment, type KakaoReviewSegment} from '../src/collections/kakaoReviewModel';
import {cancelSegmentSwap, swapSegment} from '../src/shared/motion/viewSwap';
import {prefersReducedMotion} from '../src/shared/ui/motionCurves';
import '../src/collections/kakaoReview.css';
import '../src/collections/book-connect.css';
import './kakaoReviewOverlay.css';

/** Read the complete manga queue, independent of shelf pagination, title/rating filters and Showcase. */
export function useKakaoReviewQueue(active: boolean, refreshKey: number) {
  const connection = outboxConnection();
  const [snapshot, setSnapshot] = useState<{connection: string | null; items: CollectionSummary[]; revision: string; readKey: string} | null>(null);
  const [requests, setRequests] = useState<BindRequest[]>([]), [status, setStatus] = useState<BindStatus | null>(null);
  const [error, setError] = useState(''), [nonce, setNonce] = useState(0);
  const justFiled = useRef<Map<number, {request: BindRequest; at: number}>>(new Map());
  const refresh = useCallback(() => setNonce(n => n + 1), []);
  useEffect(() => { justFiled.current.clear(); setRequests([]); setStatus(null); setError(''); }, [connection]);
  useSyncSignal('bindingRequests', refresh, active);
  useEffect(() => { if (!active) return; return visibleInterval(refresh, 60_000); }, [active, refresh]);
  useEffect(() => {
    if (!active) return;
    const readKey = JSON.stringify([refreshKey, nonce]);
    if (snapshot?.connection === connection && snapshot.readKey === readKey) return;
    const controller = new AbortController(), startedAt = Date.now();
    const read = async () => {
      const items: CollectionSummary[] = [], pending: BindRequest[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null, revision: string | null = null;
      do {
        const page: CollectionPage = await api<CollectionPage>(collectionPath('manga', '', false, cursor), controller.signal);
        if (!page.ready || !Array.isArray(page.items)) return;
        if (revision && revision !== page.revision) throw new Error('목록이 변경되었습니다. 다시 시도해 주세요.');
        revision = page.revision; items.push(...page.items); cursor = page.nextCursor;
        if (cursor) { if (seenCursors.has(cursor)) throw new Error('목록 페이지를 확인하지 못했습니다.'); seenCursors.add(cursor); }
      } while (cursor && !controller.signal.aborted);
      let before: number | null = null;
      do {
        const params = new URLSearchParams({state: 'all', limit: '50', paged: 'true'});
        if (before !== null) params.set('before', String(before));
        const page = await api<RequestsReply & {nextCursor?: number | null}>(`${BIND_REQUESTS_PATH}?${params}`, controller.signal);
        pending.push(...page.items.filter(request => request.provider === 'kakao'));
        const next = page.nextCursor ?? null;
        if (next !== null && (!Number.isSafeInteger(next) || next < 1 || (before !== null && next >= before))) throw new Error('연결 요청 페이지를 확인하지 못했습니다.');
        before = next;
      } while (before !== null && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      // A bind can complete between the work pages and the request pages. Keep the
      // displayed snapshot until both belong to an unchanged projection revision.
      const current = await api<CollectionPage>(collectionPath('manga', '', false, null), controller.signal);
      if (controller.signal.aborted) return;
      if (!current.ready || current.revision !== revision) { refresh(); return; }
      for (const [id, filed] of justFiled.current) {
        const observed = pending.find(request => request.collectionId === filed.request.collectionId && request.requestId >= id);
        if (!observed || (filed.at >= startedAt && observed.requestId === id && observed.state === 'pending')) {
          // Never let an in-flight read restore the request superseded by this choice.
          const older = pending.filter(request => request.collectionId === filed.request.collectionId);
          for (const request of older) pending.splice(pending.indexOf(request), 1);
          pending.push(filed.request);
        } else justFiled.current.delete(id);
      }
      setSnapshot({connection, items, revision: revision ?? '', readKey}); setRequests(pending); setError('');
    };
    void read().catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
    void api<BindStatus>(BINDINGS_STATUS_PATH, controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value); }, () => undefined);
    return () => controller.abort();
  }, [active, refreshKey, nonce, connection]);
  const filed = (request: BindRequest) => {
    justFiled.current.set(request.requestId, {request, at: Date.now()});
    setRequests(current => [...current.filter(r => r.collectionId !== request.collectionId), request]);
  };
  return {items: snapshot?.connection === connection ? snapshot.items : [], revision: snapshot?.revision ?? '', requests, status, error, refresh, filed, ready: snapshot?.connection === connection};
}

export function KakaoReviewOverlay({open, active, onClose, queue, authority, cover}: {
  open: boolean; active: boolean; onClose(): void; queue: ReturnType<typeof useKakaoReviewQueue>;
  authority: ReturnType<typeof useCollectionAuthority>; cover(work: CollectionSummary, revision: string): ReactNode;
}) {
  const [segment, setSegment] = useState<KakaoReviewSegment>('unlinked');
  const currentSegment = useRef(segment); currentSegment.current = segment;
  const [search, setSearch] = useState<CollectionSummary | null>(null), [menu, setMenu] = useState<CollectionSummary | null>(null);
  const [notice, setNotice] = useState<{text: string; undo?: () => void} | null>(null);
  const [held, setHeld] = useState<Record<string, CollectionSummary>>({});
  const [folding, setFolding] = useState<Record<string, boolean>>({});
  const [entering, setEntering] = useState<Record<string, boolean>>({});
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const motionGeneration = useRef<Record<string, number>>({});
  const dismissNotice = useCallback(() => setNotice(null), []);
  useAutoDismiss(notice?.text ?? null, dismissNotice);
  const list = useRef<HTMLDivElement>(null), swap = useRef({}).current;
  useEffect(() => () => { cancelSegmentSwap(swap); timers.current.forEach(clearTimeout); }, [swap]);
  useEffect(() => { if (!open) { setSearch(null); setMenu(null); } }, [open]);
  const items = queue.items.map(work => authority.work(work));
  const latest = new Map<string, BindRequest>();
  for (const request of queue.requests) {
    if (!latest.has(request.collectionId) || latest.get(request.collectionId)!.requestId < request.requestId) latest.set(request.collectionId, request);
  }
  const waiting = new Set([...latest.values()].filter(request => request.state === 'pending').map(request => request.collectionId));
  const segmentOf = (work: CollectionSummary) => {
    const natural = kakaoReviewSegment(work.kakaoReview!);
    return natural ?? (latest.get(work.id)?.state === 'failed' ? (work.kakaoReview!.bound ? 'partial' : 'unlinked') : null);
  };
  const eligible = items.filter(work => work.kakaoReview && !waiting.has(work.id));
  const count = (value: KakaoReviewSegment) => eligible.filter(work => segmentOf(work) === value).length;
  const rows = items.map(work => held[work.id] ?? work).filter(work => work.kakaoReview && (!waiting.has(work.id) || held[work.id]) && segmentOf(work) === segment);
  const rowIds = useRef<string[]>([]); rowIds.current = rows.map(work => work.id);
  const focus = (id?: string) => {
    const target = id ? list.current?.querySelector<HTMLButtonElement>(`[data-review-id="${CSS.escape(id)}"] button`) : null;
    (target ?? list.current)?.focus();
  };
  const fold = (work: CollectionSummary) => {
    const id = work.id, index = rowIds.current.indexOf(id), source = currentSegment.current;
    const next = rowIds.current[index + 1] ?? rowIds.current[index - 1];
    const generation = motionGeneration.current[id] = (motionGeneration.current[id] ?? 0) + 1;
    setHeld(current => ({...current, [id]: work}));
    setFolding(current => ({...current, [id]: true}));
    timers.current.push(setTimeout(() => {
      if (generation !== motionGeneration.current[id]) return;
      setHeld(current => { const value = {...current}; delete value[id]; return value; });
      setFolding(current => { const value = {...current}; delete value[id]; return value; });
      timers.current.push(setTimeout(() => { if (source === currentSegment.current) focus(next); }, 0));
    }, prefersReducedMotion() ? 0 : 220));
  };
  const exclude = (work: CollectionSummary, excluded: boolean) => {
    const review = work.kakaoReview!;
    if (!authority.features.includes('kakaoReview')) throw new Error('연결 점검 설정을 저장하려면 서버 업데이트가 필요합니다.');
    authority.enqueue(review.bound ? {commandType: 'setKakaoPartialDismissed', workId: work.id, dismissed: excluded, expectedVolumes: review.volumes}
      : {commandType: 'setVolumeRange', workId: work.id, minVolume: review.minVolume, maxVolume: review.maxVolume, hideConnectionPrompt: excluded,
        expectedRange: {minVolume: review.minVolume, maxVolume: review.maxVolume, hideConnectionPrompt: review.hideConnectionPrompt}, expectedRevision: null}, work.name);
  };
  const mark = async (work: CollectionSummary, excluded: boolean) => {
    exclude(work, excluded); fold(work); setMenu(null);
    setNotice({text: excluded ? (work.kakaoReview?.bound ? '이대로 두기로 옮겼습니다.' : '연결 안 함으로 옮겼습니다.') : '다시 점검합니다.', undo: () => {
      const current = {...work, kakaoReview: {...work.kakaoReview!, hideConnectionPrompt: excluded, partialDismissed: excluded}};
      exclude(current, !excluded);
      motionGeneration.current[work.id] = (motionGeneration.current[work.id] ?? 0) + 1;
      setHeld(current => { const value = {...current}; delete value[work.id]; return value; });
      setFolding(current => { const value = {...current}; delete value[work.id]; return value; });
      if (kakaoReviewSegment(current.kakaoReview) === currentSegment.current) fold(current);
      else {
        setEntering(current => ({...current, [work.id]: true}));
        timers.current.push(setTimeout(() => { setEntering(current => { const value = {...current}; delete value[work.id]; return value; }); focus(work.id); }, prefersReducedMotion() ? 0 : 220));
      }
      setNotice(null);
    }});
  };
  const change = (next: KakaoReviewSegment) => swapSegment(swap, {target: list.current, forward: ['unlinked','partial','excluded'].indexOf(next) > ['unlinked','partial','excluded'].indexOf(segment), commit: () => setSegment(next)});
  return <Overlay open={open} covered={!active} title="Kakao 연결 점검" onClose={onClose}>
    <div className="kakao-review-tablet">
      <div className="kakao-review__bar"><SegmentedControl fullWidth label="연결 상태" value={segment} onChange={change} options={[
        {value: 'unlinked', label: '미연결', count: count('unlinked')}, {value: 'partial', label: '일부 권', count: count('partial')}, {value: 'excluded', label: '제외', count: count('excluded')},
      ]}/></div>
      <div ref={list} tabIndex={-1} className="kakao-review-tablet__list">
        {!queue.ready && !queue.error && <Skeleton label="연결 점검"/>}
        {queue.error && <p role="alert">{queue.error}<Button onClick={queue.refresh}>다시 시도</Button></p>}
        {authority.failure && <p role="alert">{authority.failure}</p>}
        {queue.ready && rows.length === 0 && <p className="kakao-review__empty">{segment === 'excluded' ? '제외한 작품이 없습니다.' : '점검할 작품이 없습니다.'}</p>}
        {rows.map(work => {
          const review = work.kakaoReview!;
          const subtitle = [work.author, `보유 ${review.ownedCount}권`, !review.bound && review.query !== work.name ? `검색어 ${review.query}` : '', !review.bound ? QUERY_SOURCES[review.querySource] : ''].filter(Boolean).join(' · ');
          return <div key={work.id} data-review-id={work.id} className={`kakao-review-tablet__row${folding[work.id] ? ' is-folding' : ''}${entering[work.id] ? ' is-entering' : ''}`}>
            <button type="button" className="kakao-review-tablet__target" onClick={() => { if (segment === 'excluded') void mark(work, false).catch(reason => setNotice({text: errorText(reason)})); else setSearch(work); }} aria-label={`${work.name} ${segment === 'excluded' ? '다시 점검' : review.bound ? '다시 연결' : '찾기'}`}>
              <KakaoReviewIdentity name={work.name} subtitle={subtitle} cover={<span className="kakao-review__cover">{cover(work, queue.revision)}</span>}/>
              {latest.get(work.id)?.state === 'failed' && <span className="kakao-review-tablet__failure" title={latest.get(work.id)?.reason?.message}>연결 실패 · {latest.get(work.id)?.reason?.message || '다시 연결해 주세요.'}</span>}
              {review.bound && <span className="kakao-review-tablet__partial"><KakaoReviewVolumes review={review}/></span>}
            </button>
            {authority.features.includes('kakaoReview') && <IconButton label={`${work.name} 더보기`} icon={EllipsisHorizontalIcon} onClick={() => setMenu(work)}/>}
          </div>;
        })}
      </div>
      {[true, false].map(server => {
        const group = items.filter(work => waiting.has(work.id) && serverOwned(latest.get(work.id)!) === server);
        return group.length > 0 && <details key={String(server)} className="kakao-review-tablet__pending"><summary>{server ? '서버에서 연결 처리 중' : 'PC 적용 대기'} {group.length}</summary>{group.map(work => <p key={work.id}>{work.name}</p>)}</details>;
      })}
      {menu && <BottomSheet title={menu.name} onClose={() => setMenu(null)}><Button variant="ghost" onClick={() => void mark(menu, segment !== 'excluded').catch(reason => setNotice({text: errorText(reason)}))}>{segment === 'excluded' ? '다시 점검' : menu.kakaoReview?.bound ? '이대로 두기' : '연결 안 함'}</Button></BottomSheet>}
      {search && <BindSearchSheet key={search.id} item={{...search, volumes: search.volumes ?? [], artworks: []} as CollectionDetail} provider="kakao" status={queue.status} connection={search.kakaoReview?.bound ? 'connected' : 'unbound'}
        reviewQuery={search.kakaoReview!.query} workCover={<span className="kakao-review__cover">{cover(search, queue.revision)}</span>}
        onSkip={!search.kakaoReview?.bound && authority.features.includes('kakaoReview') ? () => mark(search, true) : undefined} onClose={() => setSearch(null)} onRequested={request => { fold(search); queue.filed(request); setSearch(null); }}/>}
      {notice && <Toast actionLabel={notice.undo ? '되돌리기' : undefined} onAction={() => { try { notice.undo?.(); } catch (reason) { setNotice({text: errorText(reason)}); } }} onDismiss={() => setNotice(null)}>{notice.text}</Toast>}
    </div>
  </Overlay>;
}
