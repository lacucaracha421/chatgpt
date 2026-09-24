import {visibleInterval} from './useVisibleInterval';
import {useCallback, useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent} from 'react';
import {ArrowLeftIcon, ArrowUturnLeftIcon, ChevronRightIcon, PauseIcon, PhotoIcon, PlayIcon, Square2StackIcon} from '@heroicons/react/24/outline';
import {Button, IconButton} from './ui';
import {ApiError, api, errorText} from './transport';
import {decodeImage, loadThumbnail, mediaTicket, warmThumbnail} from './media';
import {sizeLabel} from './ViewerInfo';
import {commitSimilarityDecision, queuedSimilarity, trashedBy, undoSimilarityDecision,
  SIMILARITY_REVIEW_EVENT, type SimilarityChoice, type SimilarityIntent} from './similarityReviewOutbox';
import {flushSimilarityReview, isSimilarityInFlight, similarityPath, type SimilarityCounts, type SimilarityFeed,
  type SimilarityItem, type SimilaritySide} from './similarityReviewDelivery';
import {useSimilarityReviewCount} from './useSimilarityReview';
import './characterReview.css';
import './similarityReview.css';

const UNDO_DEPTH = 5;
const PAGE = 20;
const MAX_SCALE = 16;
const FLICKER_MS = 500;

/** Zoom and pan shared by both images, in normalized image coordinates (0..1). */
export type CompareView = {scale: number; x: number; y: number};
export const FIT: CompareView = {scale: 1, x: 0.5, y: 0.5};

const CHOICES: {decision: SimilarityChoice; label: string; saved: string}[] = [
  {decision: 'keep_existing', label: 'A 유지 · B 휴지통', saved: 'A 유지 · B 휴지통으로 저장'},
  {decision: 'replace_existing', label: 'B 유지 · A 휴지통', saved: 'B 유지 · A 휴지통으로 저장'},
  {decision: 'keep_both', label: '둘 다 보관', saved: '둘 다 보관으로 저장'},
];

type Undo = {item: SimilarityItem; intent: SimilarityIntent; hidden: SimilarityItem[]};
type State =
  | {phase: 'loading'}
  | {phase: 'error'; message: string; offline: boolean}
  | {phase: 'ready'; ready: boolean};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** The displayed (contain-fitted, unzoomed) size of an image inside a box. */
export function fitted(box: {width: number; height: number}, image: {width: number; height: number}) {
  if (!box.width || !box.height || !image.width || !image.height) return {width: box.width, height: box.height};
  const f = Math.min(box.width / image.width, box.height / image.height);
  return {width: image.width * f, height: image.height * f};
}

/**
 * The CSS transform that puts the normalized point (x, y) of an image at the box centre at
 * the given scale. Both images use the same view, so the same spot lines up even when their
 * resolutions differ.
 */
export function transformFor(view: CompareView, box: {width: number; height: number}, image: {width: number; height: number}) {
  const shown = fitted(box, image);
  const tx = -(view.x - 0.5) * shown.width * view.scale, ty = -(view.y - 0.5) * shown.height * view.scale;
  return `translate(${tx}px, ${ty}px) scale(${view.scale})`;
}

function useBox(ref: MutableRefObject<HTMLElement | null>) {
  const [box, setBox] = useState({width: 0, height: 0});
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => setBox({width: node.clientWidth, height: node.clientHeight});
    read();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', read); return () => window.removeEventListener('resize', read); }
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

/** The thumbnail at once; the original once `original` is set (on zoom) and it decodes. */
function PairImage({side, original, style, label}: {side: SimilaritySide; original: boolean; style?: React.CSSProperties; label: string}) {
  const asset = side.asset;
  const [src, setSrc] = useState<{id: string; url?: string; full?: boolean}>({id: asset.id, url: asset.preview});
  const shown = src.id === asset.id ? src.url : asset.preview;
  useEffect(() => {
    const controller = new AbortController();
    setSrc({id: asset.id, url: asset.preview});
    void loadThumbnail(asset, controller.signal).then(loaded => {
      if (!controller.signal.aborted && loaded.preview) setSrc(current => current.id === asset.id && current.full ? current : {id: asset.id, url: loaded.preview});
    }, () => {});
    return () => controller.abort();
  }, [asset]);
  const full = src.id === asset.id && !!src.full;
  useEffect(() => {
    if (!original || full || asset.kind === 'video') return;
    const controller = new AbortController();
    void mediaTicket(asset, 'original', controller.signal).then(async ticket => {
      await decodeImage(ticket.url, controller.signal);
      if (!controller.signal.aborted) setSrc({id: asset.id, url: ticket.url, full: true});
    }).catch(() => {});
    return () => controller.abort();
  }, [asset, original, full]);
  return shown
    ? <img className="similarity-image" src={shown} alt={label} draggable={false} style={style} data-original={full ? 'true' : undefined}/>
    : <span className="similarity-image similarity-missing" style={style}><PhotoIcon aria-hidden="true"/></span>;
}

const dims = (side: SimilaritySide) => ({width: side.width ?? side.asset.width ?? 0, height: side.height ?? side.asset.height ?? 0});

/**
 * One gesture surface: drag pans (when zoomed), two fingers pinch, double-tap toggles 1:1
 * around the tapped point. It reports a new shared view; it never owns one.
 */
function useCompareGestures(view: CompareView, onView: (view: CompareView) => void, box: {width: number; height: number}, image: {width: number; height: number}) {
  const pointers = useRef(new Map<number, {x: number; y: number}>());
  const start = useRef<{view: CompareView; distance: number; mid: {x: number; y: number}} | null>(null);
  const tap = useRef<{x: number; y: number; t: number; moved: boolean} | null>(null);
  const lastTap = useRef<{x: number; y: number; t: number} | null>(null);
  const latest = useRef({view, box, image});
  latest.current = {view, box, image};
  const local = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2};
  };
  const shown = () => fitted(latest.current.box, latest.current.image);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button > 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, local(event));
    tap.current = pointers.current.size === 1 ? {...local(event), t: performance.now(), moved: false} : null;
    if (pointers.current.size === 2) {
      const [p, q] = [...pointers.current.values()];
      start.current = {view: latest.current.view, distance: Math.hypot(p.x - q.x, p.y - q.y) || 1, mid: {x: (p.x + q.x) / 2, y: (p.y + q.y) / 2}};
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    const size = shown();
    if (tap.current && Math.hypot(point.x - tap.current.x, point.y - tap.current.y) > 10) tap.current.moved = true;
    if (pointers.current.size === 2 && start.current && size.width && size.height) {
      const [p, q] = [...pointers.current.values()];
      const from = start.current;
      const scale = clamp(from.view.scale * Math.hypot(p.x - q.x, p.y - q.y) / from.distance, 1, MAX_SCALE);
      // Keep the image point under the pinch midpoint where it was.
      const u = from.view.x + from.mid.x / (size.width * from.view.scale), v = from.view.y + from.mid.y / (size.height * from.view.scale);
      onView(scale === 1 ? FIT : {scale, x: clamp(u - from.mid.x / (size.width * scale), 0, 1), y: clamp(v - from.mid.y / (size.height * scale), 0, 1)});
    } else if (pointers.current.size === 1 && latest.current.view.scale > 1 && size.width && size.height) {
      const current = latest.current.view;
      onView({...current, x: clamp(current.x - (point.x - previous.x) / (size.width * current.scale), 0, 1),
        y: clamp(current.y - (point.y - previous.y) / (size.height * current.scale), 0, 1)});
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const point = pointers.current.get(event.pointerId);
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) start.current = null;
    const pressed = tap.current;
    tap.current = null;
    if (!point || !pressed || pressed.moved || performance.now() - pressed.t > 300) return;
    const now = performance.now(), last = lastTap.current;
    if (last && now - last.t < 350 && Math.hypot(point.x - last.x, point.y - last.y) < 40) {
      lastTap.current = null;
      const current = latest.current.view, size = shown();
      if (current.scale > 1) { onView(FIT); return; }
      // 1:1 — one image pixel per CSS pixel, at least a visible step, centred on the tap.
      const natural = latest.current.image.width;
      const scale = clamp(natural && size.width ? natural / size.width : 2, 2, MAX_SCALE);
      onView({scale, x: clamp(current.x + (size.width ? point.x / size.width : 0), 0, 1), y: clamp(current.y + (size.height ? point.y / size.height : 0), 0, 1)});
    } else lastTap.current = {...point, t: now};
  };
  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => { pointers.current.delete(event.pointerId); start.current = null; tap.current = null; };
  return {onPointerDown, onPointerMove, onPointerUp, onPointerCancel};
}

/** One image of the pair with its own gesture surface (side-by-side / stacked layout). */
function Pane({side, name, view, onView}: {side: SimilaritySide; name: 'A' | 'B'; view: CompareView; onView(view: CompareView): void}) {
  const host = useRef<HTMLDivElement | null>(null);
  const box = useBox(host);
  const image = dims(side);
  const gestures = useCompareGestures(view, onView, box, image);
  return <div ref={host} className="similarity-pane" aria-label={`${name} 이미지`} {...gestures}>
    <PairImage side={side} original={view.scale > 1} label={`${name} 이미지`} style={{transform: transformFor(view, box, image)}}/>
    <span className="similarity-pane-tag" aria-hidden="true">{name}</span>
  </div>;
}

/** Single-pane compare: B over A, either held/flickered or cut by a wipe divider. */
function CompareStage({item, view, onView, mode, showB, wipe}: {item: SimilarityItem; view: CompareView; onView(view: CompareView): void; mode: 'flicker' | 'wipe'; showB: boolean; wipe: number}) {
  const host = useRef<HTMLDivElement | null>(null);
  const box = useBox(host);
  const a = dims(item.a), b = dims(item.b);
  const gestures = useCompareGestures(view, onView, box, a);
  const top = mode === 'wipe' ? {clipPath: `inset(0 0 0 ${wipe}%)`} : {opacity: showB ? 1 : 0};
  return <div ref={host} className="similarity-pane similarity-stage" aria-label="비교 화면" data-showing={mode === 'flicker' ? (showB ? 'B' : 'A') : 'wipe'} {...gestures}>
    <PairImage side={item.a} original={view.scale > 1} label="A 이미지" style={{transform: transformFor(view, box, a)}}/>
    <div className="similarity-layer" style={top}>
      <PairImage side={item.b} original={view.scale > 1} label="B 이미지" style={{transform: transformFor(view, box, b)}}/>
    </div>
    {mode === 'wipe' && <span className="similarity-divider" style={{left: `${wipe}%`}} aria-hidden="true"/>}
    <span className="similarity-pane-tag" aria-hidden="true">{mode === 'wipe' ? 'A | B' : showB ? 'B' : 'A'}</span>
  </div>;
}

function dateText(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString('ko-KR', {year: 'numeric', month: '2-digit', day: '2-digit'}) : null;
}

/** Resolution, size, format, source, date and classifications; the larger resolution/file is accented. */
function MetaStrip({side, other, name, recommended}: {side: SimilaritySide; other: SimilaritySide; name: 'A' | 'B'; recommended: boolean}) {
  const pixels = (s: SimilaritySide) => (s.width ?? 0) * (s.height ?? 0);
  const bigger = pixels(side) > pixels(other);
  const heavier = (side.byteSize ?? -1) > (other.byteSize ?? -1);
  const collected = dateText(side.collectedAt);
  return <dl className="similarity-meta" aria-label={`${name} 정보`}>
    <div className="similarity-meta-head"><strong>{name}</strong>{recommended && <span className="similarity-badge">권장</span>}</div>
    {side.width && side.height ? <div data-accent={bigger || undefined}><dt>해상도</dt><dd className="numeric">{side.width.toLocaleString()} × {side.height.toLocaleString()}</dd></div> : null}
    {side.byteSize != null && <div data-accent={heavier || undefined}><dt>크기</dt><dd className="numeric">{sizeLabel(side.byteSize)}</dd></div>}
    <div><dt>형식</dt><dd>{side.format}</dd></div>
    {side.sourceLabel && <div><dt>출처</dt><dd>{side.sourceLabel}</dd></div>}
    {collected && <div><dt>수집일</dt><dd className="numeric">{collected}</dd></div>}
    {!!side.classifications.length && <div><dt>분류</dt><dd>{side.classifications.join(', ')}</dd></div>}
  </dl>;
}

/**
 * Full-screen similarity review: one historical pair at a time. The PC applies every
 * decision; until then the original files and galleries are unchanged, and the image that
 * is not kept goes to Library Trash only when the PC applies the decision.
 */
export function SimilarityReview({onClose, backRef}: {onClose(): void; backRef: MutableRefObject<(() => boolean) | null>}) {
  const [state, setState] = useState<State>({phase: 'loading'});
  const [queue, setQueue] = useState<SimilarityItem[]>([]);
  const [counts, setCounts] = useState<SimilarityCounts | null>(null);
  const [library, setLibrary] = useState<{id: string; revision: string} | null>(null);
  const [total, setTotal] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const [undo, setUndo] = useState<Undo[]>([]);
  const [notice, setNotice] = useState('');
  const [queued, setQueued] = useState(() => queuedSimilarity().reviews.size);
  const [view, setView] = useState<CompareView>(FIT);
  const [compare, setCompare] = useState<null | 'flicker' | 'wipe'>(null);
  const [held, setHeld] = useState(false);
  const [auto, setAuto] = useState(false);
  const [phase, setPhase] = useState(false);
  const [wipe, setWipe] = useState(50);
  const cursor = useRef<string | null>(null);
  const more = useRef(false);
  const done = useRef(new Set<string>());
  const alive = useRef(true);
  const latest = useRef({view, onClose});
  latest.current = {view, onClose};

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    backRef.current = () => {
      if (latest.current.view.scale > 1) { setView(FIT); return true; }
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
  useEffect(() => {
    if (!auto || compare !== 'flicker') return;
    const timer = visibleInterval(() => setPhase(value => !value), FLICKER_MS);
    return () => timer();
  }, [auto, compare]);

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
    for (const item of queue.slice(1, 3)) for (const side of [item.a, item.b]) void warmThumbnail(side.asset, controller.signal);
    return () => controller.abort();
  }, [queue, state.phase, load]);

  const current = queue[0];
  useEffect(() => { setView(FIT); setHeld(false); }, [current?.reviewId]);

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

  const revert = useCallback(() => {
    const last = undo[undo.length - 1];
    if (!last) return;
    try {
      const outcome = undoSimilarityDecision(last.intent, isSimilarityInFlight);
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
  }, [undo]);

  const pending = (counts?.pendingPc ?? 0) + queued;
  const lastUndo = undo[undo.length - 1];
  const showB = compare === 'flicker' && (held || (auto && phase));
  const ready = state.phase === 'ready' && state.ready;
  return <div className="similarity-overlay" role="dialog" aria-modal="true" aria-label="유사 이미지 검토">
    <header className="review-bar">
      <IconButton label="검토 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
      <div className="review-title"><h1>유사 이미지 검토</h1>
        {ready && <p className="numeric" aria-live="polite">{reviewed} / {total}{pending > 0 && ` · PC 반영 대기 ${pending}`}{(counts?.skipped ?? 0) > 0 && ` · 건너뜀 ${counts!.skipped}`}</p>}
      </div>
      {ready && current && <IconButton label={compare ? '나란히 보기' : '한 화면에서 비교'} icon={Square2StackIcon} active={!!compare} onClick={() => { setCompare(value => value ? null : 'flicker'); setAuto(false); setHeld(false); }}/>}
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
      <p>PC 앱이 아직 유사 이미지 목록을 보내지 않았습니다. PC 앱을 업데이트하고 실행해 두면 여기에서 검토할 수 있습니다.</p>
    </div>}
    {ready && !current && <div className="empty-state review-empty">
      <h2>모두 검토했습니다</h2>
      <p>{pending > 0 ? `PC 반영 대기 ${pending}개 · PC가 반영하면 버린 이미지가 휴지통으로 갑니다.` : 'PC가 새 유사 이미지를 찾으면 여기에 나타납니다.'}</p>
    </div>}
    {ready && current && <div className="similarity-body" data-mode={compare ? 'compare' : 'side'}>
      {compare
        ? <div className="similarity-compare">
          <CompareStage item={current} view={view} onView={setView} mode={compare} showB={showB} wipe={wipe}/>
          <div className="similarity-compare-tools">
            <div className="library-segments" role="tablist" aria-label="비교 방식">
              {(['flicker', 'wipe'] as const).map(mode => <button key={mode} role="tab" aria-selected={compare === mode} onClick={() => { setCompare(mode); setAuto(false); }}>{mode === 'flicker' ? '깜빡임' : '와이프'}</button>)}
            </div>
            {compare === 'flicker'
              ? <div className="similarity-flicker">
                <Button variant="secondary" aria-label="누르는 동안 B 보기" onPointerDown={() => setHeld(true)} onPointerUp={() => setHeld(false)} onPointerLeave={() => setHeld(false)} onPointerCancel={() => setHeld(false)}>누르는 동안 B</Button>
                <IconButton label={auto ? '자동 깜빡임 멈춤' : '자동 깜빡임'} icon={auto ? PauseIcon : PlayIcon} active={auto} onClick={() => setAuto(value => !value)}/>
              </div>
              : <label className="similarity-wipe">와이프 위치<input type="range" min={0} max={100} value={wipe} onChange={event => setWipe(Number(event.target.value))}/></label>}
          </div>
        </div>
        : <div className="similarity-panes">
          <Pane side={current.a} name="A" view={view} onView={setView}/>
          <Pane side={current.b} name="B" view={view} onView={setView}/>
        </div>}
      <div className="similarity-metas">
        <MetaStrip side={current.a} other={current.b} name="A" recommended={current.recommendedAssetId === current.a.assetId}/>
        <MetaStrip side={current.b} other={current.a} name="B" recommended={current.recommendedAssetId === current.b.assetId}/>
      </div>
    </div>}
    {ready && <footer className="similarity-actions">
      <div className="similarity-buttons">
        {CHOICES.map(choice => <Button key={choice.decision} variant={current?.recommendation === choice.decision ? 'primary' : 'secondary'} disabled={!current} onClick={() => act(choice.decision)}>
          {choice.label}{current?.recommendation === choice.decision && <span className="similarity-badge">권장</span>}
        </Button>)}
      </div>
      <p className="hint">PC가 반영하기 전까지 원본은 바뀌지 않습니다. 버린 이미지는 휴지통으로 갑니다.</p>
    </footer>}
    {lastUndo && <div className="review-snackbar similarity-snackbar" role="status">
      <span>{CHOICES.find(choice => choice.decision === lastUndo.intent.decision)?.saved}</span>
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
