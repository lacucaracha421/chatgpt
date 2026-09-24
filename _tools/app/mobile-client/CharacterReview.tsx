import {useCallback, useEffect, useRef, useState, type MutableRefObject} from 'react';
import {ArrowLeftIcon, ArrowUturnLeftIcon, CheckIcon, ChevronDoubleUpIcon, ChevronRightIcon, PhotoIcon, UserIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {Button, IconButton} from './ui';
import {ApiError, api, errorText} from './transport';
import {decodeImage, loadThumbnail, mediaTicket, warmThumbnail} from './media';
import type {Asset} from './types';
import {commitReviewDecision, queuedReviewPairs, readReviewIntents, reviewPairKey, undoReviewDecision, CHARACTER_REVIEW_EVENT} from './characterReviewOutbox';
import {flushCharacterReview, isReviewInFlight, reviewPath, type ReviewCounts, type ReviewFeed, type ReviewItem, type ReviewSource, type ReviewTarget} from './characterReviewDelivery';
import {useCharacterReviewCount} from './useCharacterReview';
import './characterReview.css';

const SOURCE_LABEL: Record<ReviewSource, string> = {s36: 'S36 추천', b36: 'B36 추천', doubtful: '다시 확인'};
const UNDO_DEPTH = 5;
const PAGE = 20;
/** Horizontal share of the card width that commits a swipe, and a fling speed in px/ms. */
const SWIPE_SHARE = 0.3, FLING = 0.6, FLING_MIN = 40, UP_SHARE = 0.25;

type Action = 'accepted' | 'rejected' | 'skipped';
type Undo = {action: Action; item: ReviewItem; operationId?: string};
type State =
  | {phase: 'loading'}
  | {phase: 'error'; message: string; offline: boolean}
  | {phase: 'ready'; ready: boolean};

/** An image shown from its thumbnail at once, then from the original when that decodes. */
function ReviewImage({asset, className, label}: {asset: Asset; className?: string; label: string}) {
  const [src, setSrc] = useState<{id: string; url?: string}>({id: asset.id, url: asset.preview});
  const shown = src.id === asset.id ? src.url : asset.preview;
  useEffect(() => {
    const controller = new AbortController();
    setSrc({id: asset.id, url: asset.preview});
    void loadThumbnail(asset, controller.signal).then(loaded => {
      if (!controller.signal.aborted && loaded.preview) setSrc(current => current.id === asset.id && current.url && current.url !== asset.preview ? current : {id: asset.id, url: loaded.preview});
    }, () => {});
    if (asset.kind !== 'video') {
      void mediaTicket(asset, 'original', controller.signal).then(async ticket => {
        await decodeImage(ticket.url, controller.signal);
        if (!controller.signal.aborted) setSrc({id: asset.id, url: ticket.url});
      }).catch(() => {});
    }
    return () => controller.abort();
  }, [asset]);
  return shown ? <img className={className} src={shown} alt={label} draggable={false}/> : <span className={`${className ?? ''} review-missing`}><PhotoIcon aria-hidden="true"/></span>;
}

/**
 * Full-screen character-candidate review: one candidate at a time, swiped right for "맞음",
 * left for "아님" and up for "건너뛰기" (local only). Decisions go through the durable
 * review outbox; the PC applies them later, so an accepted Asset joins the character's
 * gallery only after the PC's next publication.
 */
export function CharacterReview({libraryId, target, onClose, backRef}: {
  libraryId: string;
  target?: {id: string; name: string} | null;
  onClose(): void;
  backRef: MutableRefObject<(() => boolean) | null>;
}) {
  const [state, setState] = useState<State>({phase: 'loading'});
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [targets, setTargets] = useState<Record<string, ReviewTarget>>({});
  const [counts, setCounts] = useState<ReviewCounts | null>(null);
  const [total, setTotal] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const [undo, setUndo] = useState<Undo[]>([]);
  const [zoom, setZoom] = useState<Asset | null>(null);
  const [notice, setNotice] = useState('');
  const [queued, setQueued] = useState(() => Object.keys(readReviewIntents()).length);
  const [offset, setOffset] = useState({x: 0, y: 0});
  const cursor = useRef<string | null>(null);
  const more = useRef(false);
  const done = useRef(new Set<string>());
  const card = useRef<HTMLDivElement>(null);
  const drag = useRef<{id: number; x: number; y: number; t: number} | null>(null);
  const alive = useRef(true);
  const latest = useRef({zoom, onClose});
  latest.current = {zoom, onClose};

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    backRef.current = () => {
      if (latest.current.zoom) { setZoom(null); return true; }
      latest.current.onClose();
      return true;
    };
    return () => { backRef.current = null; };
  }, [backRef]);
  useEffect(() => {
    const read = () => setQueued(Object.keys(readReviewIntents()).length);
    window.addEventListener(CHARACTER_REVIEW_EVENT, read);
    return () => window.removeEventListener(CHARACTER_REVIEW_EVENT, read);
  }, []);

  /** Rows this device already handled (queued, decided or skipped this session) never reappear. */
  const fresh = useCallback((items: ReviewItem[]) => {
    const hidden = queuedReviewPairs();
    return items.filter(item => {
      const key = reviewPairKey(item.targetId, item.assetId);
      return !hidden.has(key) && !done.current.has(key);
    });
  }, []);

  const load = useCallback(async (restart: boolean) => {
    if (more.current) return;
    more.current = true;
    try {
      const feed = await api<ReviewFeed>(reviewPath({target: target?.id, cursor: restart ? null : cursor.current, limit: PAGE}));
      if (!alive.current) return;
      if (feed?.version !== 1 || !Array.isArray(feed.items)) throw new Error('캐릭터 검토 응답을 확인할 수 없습니다.');
      cursor.current = feed.hasMore ? feed.nextCursor : null;
      setCounts(feed.counts);
      setTargets(current => ({...current, ...feed.targets}));
      if (restart) setTotal(feed.counts.total);
      setQueue(current => {
        const seen = new Set(current.map(item => reviewPairKey(item.targetId, item.assetId)));
        const added = fresh(feed.items).filter(item => !seen.has(reviewPairKey(item.targetId, item.assetId)));
        return restart ? fresh(feed.items) : [...current, ...added];
      });
      setState({phase: 'ready', ready: feed.ready});
    } catch (reason) {
      if (!alive.current) return;
      const code = (reason as ApiError)?.details as {detail?: {code?: string}} | undefined;
      if (!restart && code?.detail?.code === 'characterReviewChanged') {
        // The PC republished: start the walk again, keeping this session's decisions hidden.
        more.current = false; cursor.current = null;
        return await load(true);
      }
      const offline = reason instanceof ApiError ? reason.status === null : !(reason instanceof DOMException);
      if (restart) setState({phase: 'error', message: (reason as ApiError)?.status === 404 ? '서버에 캐릭터 검토 업데이트가 필요합니다.' : errorText(reason), offline: offline && (reason as ApiError)?.status !== 404});
      else setNotice(errorText(reason));
    } finally {
      more.current = false;
    }
  }, [fresh, target?.id]);

  useEffect(() => { void load(true); }, [load]);
  // Keep a few candidates ahead, and warm the next three thumbnails.
  useEffect(() => {
    if (state.phase === 'ready' && queue.length < 5 && cursor.current) void load(false);
    const controller = new AbortController();
    for (const item of queue.slice(1, 4)) void warmThumbnail(item.asset, controller.signal);
    return () => controller.abort();
  }, [queue, state.phase, load]);

  const current = queue[0];
  const act = useCallback((action: Action) => {
    const item = queue[0];
    if (!item) return;
    const key = reviewPairKey(item.targetId, item.assetId);
    let operationId: string | undefined;
    if (action !== 'skipped') {
      try {
        operationId = commitReviewDecision({libraryId, targetId: item.targetId, assetId: item.assetId,
          decision: action, origin: 'feed', basis: item.basis}).operationId;
      } catch (reason) { setNotice(errorText(reason)); setOffset({x: 0, y: 0}); return; }
      setReviewed(value => value + 1);
      void flushCharacterReview().catch(() => {});
    }
    done.current.add(key);
    setNotice('');
    setOffset({x: 0, y: 0});
    setUndo(stack => [...stack, {action, item, operationId}].slice(-UNDO_DEPTH));
    setQueue(rest => rest.filter(row => reviewPairKey(row.targetId, row.assetId) !== key));
  }, [queue, libraryId]);

  const revert = useCallback(() => {
    const last = undo[undo.length - 1];
    if (!last) return;
    if (last.action !== 'skipped' && last.operationId) {
      try {
        const outcome = undoReviewDecision({libraryId, targetId: last.item.targetId, assetId: last.item.assetId,
          operationId: last.operationId, origin: 'feed'}, isReviewInFlight);
        if (outcome === 'cleared') void flushCharacterReview().catch(() => {});
      } catch (reason) { setNotice(errorText(reason)); return; }
      setReviewed(value => Math.max(0, value - 1));
    }
    done.current.delete(reviewPairKey(last.item.targetId, last.item.assetId));
    setUndo(stack => stack.slice(0, -1));
    setQueue(rest => [last.item, ...rest.filter(row => reviewPairKey(row.targetId, row.assetId) !== reviewPairKey(last.item.targetId, last.item.assetId))]);
  }, [undo, libraryId]);

  const size = () => ({width: card.current?.clientWidth || window.innerWidth || 360, height: card.current?.clientHeight || window.innerHeight || 640});
  const hint = (() => {
    const {width, height} = size();
    if (offset.y < -height * UP_SHARE && Math.abs(offset.y) > Math.abs(offset.x)) return 'skip';
    if (offset.x > width * SWIPE_SHARE * 0.5) return 'accept';
    if (offset.x < -width * SWIPE_SHARE * 0.5) return 'reject';
    return undefined;
  })();
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button > 0 || zoom || !current) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, t: performance.now()};
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    setOffset({x: event.clientX - start.x, y: event.clientY - start.y});
  };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    drag.current = null;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    const elapsed = Math.max(1, performance.now() - start.t);
    const {width, height} = size();
    const speed = dx / elapsed;
    if (dy < -height * UP_SHARE && Math.abs(dy) > Math.abs(dx)) act('skipped');
    else if (dx > width * SWIPE_SHARE || (speed > FLING && dx > FLING_MIN)) act('accepted');
    else if (dx < -width * SWIPE_SHARE || (speed < -FLING && dx < -FLING_MIN)) act('rejected');
    else setOffset({x: 0, y: 0});
  };

  const info = current ? targets[current.targetId] : undefined;
  const pending = (counts?.pendingPc ?? 0) + queued;
  const lastUndo = undo[undo.length - 1];
  // The confirmation shows briefly after each decision; afterwards undo stays in the top bar
  // so nothing lingers over the 아님 · 건너뛰기 · 맞음 buttons.
  const [snackVisible, setSnackVisible] = useState(false);
  useEffect(() => {
    if (!undo.length){ setSnackVisible(false); return; }
    setSnackVisible(true);
    const timer = setTimeout(() => setSnackVisible(false), 2500);
    return () => clearTimeout(timer);
  }, [undo.length, lastUndo]);
  const title = target ? `${target.name} 검토` : '캐릭터 검토';
  const {width} = size();
  return <div className="review-overlay" role="dialog" aria-modal="true" aria-label={title}>
    <header className="review-bar">
      <IconButton label="검토 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
      <div className="review-title"><h1>{title}</h1>
        {state.phase === 'ready' && state.ready && <p className="numeric" aria-live="polite">{reviewed} / {total}{pending > 0 && ` · PC 반영 대기 ${pending}`}{(counts?.skipped ?? 0) > 0 && ` · PC가 건너뜀 ${counts!.skipped}`}</p>}
      </div>
      {undo.length > 0 && !snackVisible && <IconButton label="마지막 판단 되돌리기" icon={ArrowUturnLeftIcon} onClick={revert}/>}
    </header>
    {notice && <p className="error-message review-notice" role="alert">{notice}</p>}
    {state.phase === 'loading' && <div className="loading-line" role="status" aria-label="검토 목록 불러오는 중"/>}
    {state.phase === 'error' && <div className="empty-state review-empty">
      <h2>{state.offline ? '오프라인입니다' : '검토 목록을 불러오지 못했습니다'}</h2>
      <p>{state.offline ? (queued ? `저장된 결정 ${queued}개는 연결되면 PC로 전송됩니다.` : '연결을 확인한 뒤 다시 시도해 주세요.') : state.message}</p>
      <Button onClick={() => { setState({phase: 'loading'}); void load(true); }}>다시 시도</Button>
    </div>}
    {state.phase === 'ready' && !state.ready && <div className="empty-state review-empty">
      <h2>PC 업데이트가 필요합니다</h2>
      <p>PC 앱이 아직 캐릭터 검토 목록을 보내지 않았습니다. PC 앱을 업데이트하고 실행해 두면 여기에서 검토할 수 있습니다.</p>
    </div>}
    {state.phase === 'ready' && state.ready && !current && <div className="empty-state review-empty">
      <h2>모두 검토했습니다</h2>
      <p>{pending > 0 ? `PC 반영 대기 ${pending}개 · PC가 반영하면 캐릭터 갤러리에 나타납니다.` : 'PC가 새 후보를 보내면 여기에 나타납니다.'}</p>
    </div>}
    {state.phase === 'ready' && state.ready && current && <div className="review-body">
      <div ref={card} className="review-card" data-hint={hint} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; setOffset({x: 0, y: 0}); }}
        style={{transform: `translate(${offset.x}px, ${Math.min(0, offset.y)}px) rotate(${(offset.x / width) * 12}deg)`}} aria-label="검토 후보">
        <ReviewImage asset={current.asset} className="review-candidate" label={`${info?.name ?? '캐릭터'} 후보`}/>
        <div className="review-caption">
          <strong>{info?.name ?? current.targetId}</strong>
          {info?.seriesName && <span className="muted">{info.seriesName}</span>}
          <span className="review-sources">{current.sources.map(source => <span key={source} className="review-chip" data-source={source}>{SOURCE_LABEL[source]}</span>)}</span>
        </div>
        {hint && <span className="review-stamp" data-hint={hint} aria-hidden="true">{hint === 'accept' ? '맞음' : hint === 'reject' ? '아님' : '건너뛰기'}</span>}
      </div>
      {!!info?.references.length && <div className="review-references" aria-label="기준 이미지">
        {info.references.slice(0, 4).map(reference => <button key={reference.id} className="review-reference" aria-label="기준 이미지 크게 보기" onClick={() => setZoom(reference)}>
          <ReviewImage asset={reference} label="기준 이미지"/>
        </button>)}
      </div>}
    </div>}
    {state.phase === 'ready' && state.ready && <footer className="review-actions">
      <Button variant="secondary" disabled={!current} onClick={() => act('rejected')}><XMarkIcon aria-hidden="true"/>아님</Button>
      <Button variant="ghost" disabled={!current} onClick={() => act('skipped')}><ChevronDoubleUpIcon aria-hidden="true"/>건너뛰기</Button>
      <Button variant="primary" disabled={!current} onClick={() => act('accepted')}><CheckIcon aria-hidden="true"/>맞음</Button>
    </footer>}
    {lastUndo && snackVisible && <div className="review-snackbar" role="status">
      <span>{lastUndo.action === 'accepted' ? '맞음으로 저장' : lastUndo.action === 'rejected' ? '아님으로 저장' : '건너뜀'}</span>
      <Button variant="ghost" onClick={revert}><ArrowUturnLeftIcon aria-hidden="true"/>되돌리기</Button>
    </div>}
    {zoom && <div className="review-zoom" role="dialog" aria-modal="true" aria-label="기준 이미지">
      <IconButton label="크게 보기 닫기" icon={XMarkIcon} onClick={() => setZoom(null)}/>
      <ReviewImage asset={zoom} label="기준 이미지"/>
    </div>}
  </div>;
}

/** Library → 분류 entry row: "캐릭터 검토 N", shown only with the capability and N > 0. */
export function CharacterReviewEntry({enabled, refreshKey, onOpen}: {enabled: boolean; refreshKey: unknown; onOpen(): void}) {
  const count = useCharacterReviewCount(enabled, null, refreshKey);
  if (!count) return null;
  return <button className="review-entry" onClick={onOpen} aria-label={`캐릭터 검토 ${count}개`}>
    <UserIcon aria-hidden="true"/><strong>캐릭터 검토</strong><span className="numeric muted">{count}</span><ChevronRightIcon aria-hidden="true"/>
  </button>;
}

/** Character page chip: "검토 N" opens the review filtered to this character. */
export function CharacterReviewChip({enabled, targetId, refreshKey, onOpen}: {enabled: boolean; targetId: string; refreshKey: unknown; onOpen(): void}) {
  const count = useCharacterReviewCount(enabled, targetId, refreshKey);
  if (!count) return null;
  return <div className="review-entry-chip"><Button size="sm" variant="secondary" onClick={onOpen} aria-label={`이 캐릭터 검토 ${count}개`}>검토 {count}</Button></div>;
}
