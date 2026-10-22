import {LoadingLine} from './TopBar';
import {useTabletAssetMask} from './assetMask';
import {usePrivacyMode} from './privacyMode';
import {SimilarityClues} from '../src/similarity/SimilarityClues';
import {sourceHost, reasonSentence, SIMILARITY_CHOICES as CHOICES, type ClueSideData} from '../src/similarity/clues';
import {CompareTools, ImageCompare, useImageCompare, type CompareImage} from '../src/similarity/compare/ImageCompare';
import {FIT} from '../src/similarity/compare/compareView';
import {useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject} from 'react';
import {ArrowLeftIcon, ArrowUturnLeftIcon, ChevronRightIcon, PhotoIcon, Square2StackIcon} from '@heroicons/react/24/outline';
import {Button, EmptyState, IconButton} from './ui';
import {ApiError, api, errorText} from './transport';
import {decodeImage, loadThumbnail, mediaTicket, warmThumbnail} from './media';
import {commitSimilarityDecision, intentKey, queuedSimilarity, readSimilarityIntents, trashedBy, undoSimilarityDecision,
  SIMILARITY_REVIEW_EVENT, SIMILARITY_SERVER_APPLY, type SimilarityChoice, type SimilarityIntent} from './similarityReviewOutbox';
import {flushSimilarityReview, isSimilarityInFlight, similarityPath, type SimilarityCounts, type SimilarityFeed,
  type SimilarityItem, type SimilaritySide} from './similarityReviewDelivery';
import {useSimilarityReviewCount} from './useSimilarityReview';
import './characterReview.css';
import './similarityReview.css';
import '../src/similarity/similarity-clues.css';

const UNDO_DEPTH = 5;
const PAGE = 20;

type Undo = {item: SimilarityItem; intent: SimilarityIntent; hidden: SimilarityItem[]};
type State =
  | {phase: 'loading'}
  | {phase: 'error'; message: string; offline: boolean}
  | {phase: 'ready'; ready: boolean};

/** The thumbnail at once; the original once `original` is set (on zoom) and it decodes. */
function PairImage({side, original, style, label, className}: {side: SimilaritySide; original: boolean; style: CSSProperties; label: string; className: string}) {
  const privacy = useTabletAssetMask(side.asset);
  const asset = side.asset;
  const [src, setSrc] = useState<{id: string; url?: string; full?: boolean}>({id: asset.id, url: asset.preview});
  const shown = src.id === asset.id ? src.url : asset.preview;
  useEffect(() => {
    if (privacy) return;
    const controller = new AbortController();
    setSrc({id: asset.id, url: asset.preview});
    void loadThumbnail(asset, controller.signal).then(loaded => {
      if (!controller.signal.aborted && loaded.preview) setSrc(current => current.id === asset.id && current.full ? current : {id: asset.id, url: loaded.preview});
    }, () => {});
    return () => controller.abort();
  }, [asset, privacy]);
  const full = src.id === asset.id && !!src.full;
  useEffect(() => {
    if (privacy || !original || full || asset.kind === 'video') return;
    const controller = new AbortController();
    void mediaTicket(asset, 'original', controller.signal).then(async ticket => {
      await decodeImage(ticket.url, controller.signal);
      if (!controller.signal.aborted) setSrc({id: asset.id, url: ticket.url, full: true});
    }).catch(() => {});
    return () => controller.abort();
  }, [asset, original, full, privacy]);
  if (privacy) return <span className={`${className} privacy-mask`} style={style} aria-label="비공개 모드"/>;
  return shown
    ? <img className={className} src={shown} alt={label} draggable={false} style={style} data-original={full ? 'true' : undefined}/>
    : <span className={`${className} image-compare__missing`} style={style}><PhotoIcon aria-hidden="true"/></span>;
}

const dims = (side: SimilaritySide) => ({width: side.width ?? side.asset.width ?? 0, height: side.height ?? side.asset.height ?? 0});
const NAMES = ['A', 'B'] as const;
const compareImage = (side: SimilaritySide, name: 'A' | 'B'): CompareImage => ({name, label: `${name} 이미지`, size: dims(side),
  render: ({className, style, original}) => <PairImage side={side} original={original} label={`${name} 이미지`} className={className} style={style}/>});

function clueSide(side: SimilaritySide): ClueSideData {
  return {handle: side.accountHandle ?? null, host: side.sourceHost ?? sourceHost(side.sourceLabel ? `https://${side.sourceLabel}` : null), role: side.accountRole ?? 'unknown', postedAt: side.sourcePublishedAt ?? null, width: side.width, height: side.height, byteSize: side.byteSize, format: side.format};
}

/**
 * Full-screen similarity review: one historical pair at a time. By default the PC applies
 * every decision; until then the original files and galleries are unchanged, and the image
 * that is not kept goes to Library Trash only when the PC applies the decision. When the
 * server advertises `similarityServerApply` it moves the image to Library Trash itself right
 * after the 5 s undo window: the undo button then exists only inside that window, and a sent
 * decision is restored from Library Trash.
 */
export function SimilarityReview({onClose, backRef}: {onClose(): void; backRef: MutableRefObject<(() => boolean) | null>}) {
  const [privacy] = usePrivacyMode();
  const [state, setState] = useState<State>({phase: 'loading'});
  const [queue, setQueue] = useState<SimilarityItem[]>([]);
  const [counts, setCounts] = useState<SimilarityCounts | null>(null);
  const [serverApply, setServerApply] = useState(false);
  const [library, setLibrary] = useState<{id: string; revision: string} | null>(null);
  const [total, setTotal] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const [undo, setUndo] = useState<Undo[]>([]);
  const [notice, setNotice] = useState('');
  const [queued, setQueued] = useState(() => queuedSimilarity().reviews.size);
  const current = queue[0];
  const compare = useImageCompare(current?.reviewId);
  const cursor = useRef<string | null>(null);
  const more = useRef(false);
  const done = useRef(new Set<string>());
  const alive = useRef(true);
  const latest = useRef({compare, onClose});
  latest.current = {compare, onClose};

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    backRef.current = () => {
      if (latest.current.compare.view.scale > 1) { latest.current.compare.setView(FIT); return true; }
      latest.current.onClose();
      return true;
    };
    return () => { backRef.current = null; };
  }, [backRef]);
  useEffect(() => {
    const read = () => setQueued(queuedSimilarity().reviews.size);
    window.addEventListener(SIMILARITY_REVIEW_EVENT, read);
    return () => window.removeEventListener(SIMILARITY_REVIEW_EVENT, read);
  }, []);
  /** Pairs this device already decided, or that hold an image a queued decision will trash. */
  const fresh = useCallback((items: SimilarityItem[]) => {
    const {reviews, trashed} = queuedSimilarity();
    return items.filter(item => !reviews.has(item.reviewId) && !done.current.has(item.reviewId)
      && !trashed.has(item.a.assetId) && !trashed.has(item.b.assetId));
  }, []);

  const load = useCallback(async (restart: boolean) => {
    if (more.current) return;
    more.current = true;
    try {
      const feed = await api<SimilarityFeed>(similarityPath({cursor: restart ? null : cursor.current, limit: PAGE}));
      if (!alive.current) return;
      if (feed?.version !== 1 || !Array.isArray(feed.items)) throw new Error('유사 이미지 검토 응답을 확인할 수 없습니다.');
      cursor.current = feed.hasMore ? feed.nextCursor : null;
      setCounts(feed.counts);
      setServerApply(Array.isArray(feed.features) && feed.features.includes(SIMILARITY_SERVER_APPLY));
      if (feed.libraryId && feed.revision) setLibrary({id: feed.libraryId, revision: feed.revision});
      if (restart) setTotal(feed.counts.open);
      setQueue(current => {
        const seen = new Set(current.map(item => item.reviewId));
        return restart ? fresh(feed.items) : [...current, ...fresh(feed.items).filter(item => !seen.has(item.reviewId))];
      });
      setState({phase: 'ready', ready: feed.ready});
    } catch (reason) {
      if (!alive.current) return;
      const code = (reason as ApiError)?.details as {detail?: {code?: string}} | undefined;
      if (!restart && code?.detail?.code === 'similarityReviewChanged') {
        more.current = false; cursor.current = null;
        return await load(true);
      }
      const missing = (reason as ApiError)?.status === 404;
      const offline = reason instanceof ApiError ? reason.status === null : !(reason instanceof DOMException);
      if (restart) setState({phase: 'error', message: missing ? '서버에 유사 이미지 검토 업데이트가 필요합니다.' : errorText(reason), offline: offline && !missing});
      else setNotice(errorText(reason));
    } finally {
      more.current = false;
    }
  }, [fresh]);

  useEffect(() => { void load(true); }, [load]);
  // Keep a few pairs ahead, and warm the next two pairs' thumbnails.
  useEffect(() => {
    if (state.phase === 'ready' && queue.length < 5 && cursor.current) void load(false);
    const controller = new AbortController();
    if (!privacy) for (const item of queue.slice(1, 3)) for (const side of [item.a, item.b]) void warmThumbnail(side.asset, controller.signal);
    return () => controller.abort();
  }, [queue, state.phase, load, privacy]);

  const act = useCallback((decision: SimilarityChoice) => {
    const item = queue[0];
    if (!item || !library) return;
    let intent: SimilarityIntent;
    try {
      intent = commitSimilarityDecision({libraryId: library.id, reviewId: item.reviewId, decision,
        basis: {feedRevision: library.revision, aSha256: item.a.sha256, bSha256: item.b.sha256},
        aAssetId: item.a.assetId, bAssetId: item.b.assetId});
    } catch (reason) { setNotice(errorText(reason)); return; }
    done.current.add(item.reviewId);
    const trash = trashedBy(decision, item.a.assetId, item.b.assetId);
    const hidden = trash ? queue.slice(1).filter(row => row.a.assetId === trash || row.b.assetId === trash) : [];
    setReviewed(value => value + 1);
    setNotice('');
    setUndo(stack => [...stack, {item, intent, hidden}].slice(-UNDO_DEPTH));
    setQueue(rest => rest.filter(row => row.reviewId !== item.reviewId && !hidden.includes(row)));
  }, [queue, library]);

  // Server apply: undo exists only while the decision has not been sent. It stays through the 5 s
  // window and while a send is deferred or offline (the intent is still in the queue), and goes as
  // soon as the server settled it (the queue changed and no longer holds that intent).
  useEffect(() => {
    if (!serverApply) return;
    const prune = () => {
      const queuedNow = readSimilarityIntents();
      setUndo(stack => {
        const kept = stack.filter(step => queuedNow[intentKey(step.intent.reviewId, step.intent.decision)]?.operationId === step.intent.operationId);
        return kept.length === stack.length ? stack : kept;
      });
    };
    prune();
    window.addEventListener(SIMILARITY_REVIEW_EVENT, prune);
    return () => window.removeEventListener(SIMILARITY_REVIEW_EVENT, prune);
  }, [serverApply, undo]);

  const revert = useCallback(() => {
    const last = undo[undo.length - 1];
    if (!last) return;
    try {
      const outcome = undoSimilarityDecision(last.intent, isSimilarityInFlight, undefined, undefined, serverApply);
      if (outcome === 'sent') {
        setNotice('이미 전송되어 되돌릴 수 없습니다. 휴지통에서 복원해 주세요.');
        setUndo(stack => stack.slice(0, -1));
        return;
      }
      if (outcome === 'withdrawn') void flushSimilarityReview().catch(() => {});
    } catch (reason) { setNotice(errorText(reason)); return; }
    done.current.delete(last.item.reviewId);
    setReviewed(value => Math.max(0, value - 1));
    setUndo(stack => stack.slice(0, -1));
    setQueue(rest => {
      const back = [last.item, ...last.hidden];
      const ids = new Set(back.map(item => item.reviewId));
      return [...back, ...rest.filter(row => !ids.has(row.reviewId))];
    });
  }, [undo, serverApply]);

  const pending = (counts?.pendingPc ?? 0) + queued;
  const waitingText = serverApply
    ? `${queued > 0 ? ` · 전송 대기 ${queued}` : ''}${(counts?.pendingPc ?? 0) > 0 ? ` · PC 반영 대기 ${counts!.pendingPc}` : ''}`
    : pending > 0 ? ` · PC 반영 대기 ${pending}` : '';
  const lastUndo = undo[undo.length - 1];
  const ready = state.phase === 'ready' && state.ready;
  return <div className="similarity-overlay" role="dialog" aria-modal="true" aria-label="유사 이미지 검토">
    <header className="review-bar">
      <IconButton label="검토 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
      <div className="review-title"><h1>유사 이미지 검토</h1>
        {ready && <p className="numeric" aria-live="polite">{reviewed} / {total}{waitingText}{(counts?.skipped ?? 0) > 0 && ` · 반영 안 된 결정 ${counts!.skipped}`}</p>}
      </div>
    </header>
    {notice && <p className="error-message review-notice" role="alert">{notice}</p>}
    <LoadingLine label={(state.phase === 'loading')&&'검토 목록 불러오는 중'}/>
    {state.phase === 'error' && <EmptyState className="review-empty" title={state.offline ? '오프라인입니다' : '검토 목록을 불러오지 못했습니다'} hint={state.offline ? (queued ? `저장된 결정 ${queued}개는 연결되면 PC로 전송됩니다.` : '연결을 확인한 뒤 다시 시도해 주세요.') : state.message}>
      <Button onClick={() => { setState({phase: 'loading'}); void load(true); }}>다시 시도</Button>
    </EmptyState>}
    {state.phase === 'ready' && !state.ready && <EmptyState className="review-empty" title="PC 업데이트가 필요합니다" hint="PC 앱이 아직 유사 이미지 목록을 보내지 않았습니다. PC 앱을 업데이트하고 실행해 두면 여기에서 검토할 수 있습니다."/>}
    {ready && !current && <EmptyState className="review-empty" title="모두 검토했습니다" hint={pending > 0 ? (serverApply ? `전송 대기 ${pending}개 · 전송되면 바로 반영되고 버린 이미지는 휴지통으로 갑니다.` : `PC 반영 대기 ${pending}개 · PC가 반영하면 버린 이미지가 휴지통으로 갑니다.`) : 'PC가 새 유사 이미지를 찾으면 여기에 나타납니다.'}/>}
    {ready && current && <div className="similarity-body">
      <CompareTools className="similarity-compare-tools" state={compare} names={NAMES}/>
      <div className="similarity-panes" data-mode={compare.mode}>
        <ImageCompare state={compare} images={[compareImage(current.a, 'A'), compareImage(current.b, 'B')]}/>
      </div>
      <SimilarityClues names={['A','B']} sides={[clueSide(current.a),clueSide(current.b)]} clues={current.clues} reason={current.reason} recommended={current.recommendedAssetId === current.a.assetId ? 'a' : current.recommendedAssetId === current.b.assetId ? 'b' : null}/>
    </div>}
    {ready && current && <footer className="similarity-actions">
      {current?.clues && <p className="similarity-reason" data-none={!current.reason || undefined}>{reasonSentence(current.reason ?? null, current.clues, ['A','B'], [clueSide(current.a),clueSide(current.b)])}</p>}
      <div className="similarity-buttons">
        {CHOICES.map(choice => <Button key={choice.decision} variant={current?.recommendation === choice.decision ? 'primary' : 'secondary'} aria-description={current?.recommendation === choice.decision ? '권장' : undefined} onClick={() => act(choice.decision)}>
          {choice.label}
        </Button>)}
      </div>
      <p className="hint">{serverApply ? '선택한 결정은 5초 뒤 바로 반영됩니다. 버린 이미지는 휴지통에서 복원할 수 있습니다.' : 'PC가 반영하기 전까지 원본은 바뀌지 않습니다. 버린 이미지는 휴지통으로 갑니다.'}</p>
    </footer>}
    {lastUndo && <div className="review-snackbar similarity-snackbar" role="status">
      <span>{serverApply ? CHOICES.find(choice => choice.decision === lastUndo.intent.decision)?.moved : CHOICES.find(choice => choice.decision === lastUndo.intent.decision)?.saved}</span>
      <Button variant="ghost" onClick={revert}><ArrowUturnLeftIcon aria-hidden="true"/>되돌리기</Button>
    </div>}
  </div>;
}

/** Asset Library entry row: "유사 이미지 검토 N", shown only with the capability and N > 0. */
export function SimilarityReviewEntry({enabled, refreshKey, onOpen}: {enabled: boolean; refreshKey: unknown; onOpen(): void}) {
  const count = useSimilarityReviewCount(enabled, refreshKey);
  if (!count) return null;
  return <button className="review-entry" onClick={onOpen} aria-label={`유사 이미지 검토 ${count}개`}>
    <Square2StackIcon aria-hidden="true"/><strong>유사 이미지 검토</strong><span className="numeric muted">{count}</span><ChevronRightIcon aria-hidden="true"/>
  </button>;
}
