import {LoadingLine} from './TopBar';
import {useTabletAssetMask} from './assetMask';
import {usePrivacyMode} from './privacyMode';
import {useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject} from 'react';
import {ArrowLeftIcon, ArrowUturnLeftIcon, CheckIcon, ChevronDoubleUpIcon, ChevronRightIcon, PhotoIcon, UserIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {Button, Dialog, DialogDescription, EmptyState, IconButton, Switch} from './ui';
import {BottomSheet} from './BottomSheet';
import {ApiError, api, errorText} from './transport';
import {decodeImage, loadThumbnail, mediaTicket, warmThumbnail} from './media';
import type {Asset} from './types';
import {commitReviewDecision, queuedReviewPairs, readReviewIntents, reviewPairKey, undoReviewDecision, CHARACTER_REVIEW_EVENT, REVIEW_OUTBOX_FULL} from './characterReviewOutbox';
import {flushCharacterReview, isReviewInFlight, reviewPath, type ReviewCounts, type ReviewFeed, type ReviewItem, type ReviewSource, type ReviewTarget} from './characterReviewDelivery';
import {useCharacterReviewCount, useCharacterReviewSeriesCount} from './useCharacterReview';
import {EASE_STANDARD, motionDefaults, motionTime, prefersReducedMotion} from '../src/shared/motion/curves';
import './characterReview.css';

const SKIPPED_KEY = 'lakomics.characters.review.skipped.v1';
const SKIPPED_LIMIT = 3000;
function readSkippedPairs(): Set<string> {
  try { const raw = JSON.parse(localStorage.getItem(SKIPPED_KEY) || '[]'); return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []); } catch { return new Set(); }
}
function writeSkippedPairs(keys: Set<string>) {
  try { localStorage.setItem(SKIPPED_KEY, JSON.stringify([...keys].slice(-SKIPPED_LIMIT))); } catch { /* per-device convenience only */ }
}
function rememberSkippedPair(key: string) { const keys = readSkippedPairs(); keys.delete(key); keys.add(key); writeSkippedPairs(keys); }
function forgetSkippedPair(key: string) { const keys = readSkippedPairs(); if (keys.delete(key)) writeSkippedPairs(keys); }

// The ones marked 아님 and not yet saved stay on this device, so leaving the screen never loses them.
const MARKED_KEY = 'lakomics.characters.review.marked.v1';
const MARKED_LIMIT = 3000;
function readMarkedPairs(): Set<string> {
  try { const raw = JSON.parse(localStorage.getItem(MARKED_KEY) || '[]'); return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []); } catch { return new Set(); }
}
function writeMarkedPairs(keys: Set<string>) {
  try { localStorage.setItem(MARKED_KEY, JSON.stringify([...keys].slice(-MARKED_LIMIT))); } catch { /* per-device convenience only */ }
}
/** 'mark': swipe left marks 아님, everything seen is saved at once. 'direct': every swipe decides at once. */
type Mode = 'mark' | 'direct';
const MODE_KEY = 'lakomics.characters.review.mode.v1';
function readMode(): Mode { try { return localStorage.getItem(MODE_KEY) === 'direct' ? 'direct' : 'mark'; } catch { return 'mark'; } }
function writeMode(mode: Mode) { try { localStorage.setItem(MODE_KEY, mode); } catch { /* per-device convenience only */ } }
const itemKey = (item: ReviewItem) => reviewPairKey(item.targetId, item.assetId);

const SOURCE_LABEL: Record<ReviewSource, string> = {s36: '인식 추천', b36: '인식 추천', doubtful: '다시 확인', tagger: '태그 추천'};
const UNDO_DEPTH = 5;
const PAGE = 20;
/** Horizontal share of the card width that commits a swipe, and a fling speed in px/ms. */
const SWIPE_SHARE = 0.3, FLING = 0.6, FLING_MIN = 40, UP_SHARE = 0.25;

type Action = 'accepted' | 'rejected' | 'skipped';

/**
 * A decided card leaves as an inert copy flying off in the decision's direction (right for 맞음,
 * left for 아님, up for 건너뛰기) from wherever the finger left it, fading as it goes; the real
 * card shows the next candidate underneath at once. Under reduced motion the copy only fades.
 */
export function flyOff(card: HTMLElement | null, action: Action) {
  const parent = card?.parentElement;
  if (!card || !parent || typeof card.animate !== 'function') return;
  const ghost = card.cloneNode(true) as HTMLElement;
  for (const element of [ghost, ...ghost.querySelectorAll('[id], [role], [aria-label], [aria-live]')]) {
    element.removeAttribute('id'); element.removeAttribute('role'); element.removeAttribute('aria-label'); element.removeAttribute('aria-live');
  }
  ghost.dataset.reviewGhost = '';
  ghost.inert = true;
  ghost.setAttribute('aria-hidden', 'true');
  const painted = getComputedStyle(card).transform;
  Object.assign(ghost.style, {left: `${card.offsetLeft}px`, top: `${card.offsetTop}px`, width: `${card.offsetWidth}px`, height: `${card.offsetHeight}px`, transition: 'none'});
  parent.append(ghost);
  const reduced = prefersReducedMotion();
  const width = card.offsetWidth || window.innerWidth, height = card.offsetHeight || window.innerHeight;
  const side = action === 'accepted' ? 1 : -1;
  const to = action === 'skipped' ? `translate(0px, ${-height}px) rotate(0deg)` : `translate(${side * width * 1.25}px, 0px) rotate(${side * 18}deg)`;
  const from = painted && painted !== 'none' ? painted : card.style.transform || 'none';
  const animation = ghost.animate(reduced ? [{opacity: 1}, {opacity: 0}] : [{transform: from, opacity: 1}, {transform: to, opacity: 0}],
    {duration: reduced ? motionTime('--motion-micro', motionDefaults.micro) : motionTime('--motion-small', motionDefaults.small), easing: EASE_STANDARD, fill: 'forwards'});
  animation.addEventListener?.('finish', () => ghost.remove());
  animation.addEventListener?.('cancel', () => ghost.remove());
}

/** The next card rises from behind the one that flew off: scale .96 to 1 while it fades in (opacity only under reduced motion). */
export function riseIn(card: HTMLElement | null) {
  if (!card) return;
  // The thrown offset resets to rest without travelling back across the screen.
  card.style.transition = 'none';
  void card.offsetWidth;
  card.style.transition = '';
  if (typeof card.animate !== 'function') return;
  const reduced = prefersReducedMotion();
  card.animate(reduced ? [{opacity: 0}, {opacity: 1}] : [{opacity: 0, scale: .96}, {opacity: 1, scale: 1}],
    {duration: reduced ? motionTime('--motion-micro', motionDefaults.micro) : motionTime('--motion-medium', motionDefaults.medium), easing: EASE_STANDARD});
}
type BatchOp = {item: ReviewItem; decision: 'accepted' | 'rejected'; operationId: string};
/** One step back: a single card (`local` when nothing was queued, as in the mark mode and for 건너뛰기), or a whole save. */
type Undo =
  | {kind: 'one'; action: Action; item: ReviewItem; operationId?: string; local: boolean; wasMarked?: boolean}
  | {kind: 'batch'; ops: BatchOp[]};
type State =
  | {phase: 'loading'}
  | {phase: 'error'; message: string; offline: boolean}
  | {phase: 'ready'; ready: boolean};

/** An image shown from its thumbnail at once, then from the original when that decodes. */
function ReviewImage({asset, className, label}: {asset: Asset; className?: string; label: string}) {
  const privacy = useTabletAssetMask(asset);
  const [src, setSrc] = useState<{id: string; url?: string}>({id: asset.id, url: asset.preview});
  const shown = src.id === asset.id ? src.url : asset.preview;
  useEffect(() => {
    if (privacy) return;
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
  }, [asset, privacy]);
  return privacy ? <span className={`${className ?? ""} privacy-mask`} aria-label="비공개 모드"/> : shown ? <img className={className} src={shown} alt={label} draggable={false}/> : <span className={`${className ?? ''} review-missing`}><PhotoIcon aria-hidden="true"/></span>;
}

/** A small thumbnail of a marked card (thumbnail only; the original is for the card itself). */
function MarkThumb({asset}: {asset: Asset}) {
  const privacy = useTabletAssetMask(asset);
  const [loaded, setLoaded] = useState<{id: string; url?: string}>();
  useEffect(() => {
    if (privacy) return;
    const controller = new AbortController();
    void loadThumbnail(asset, controller.signal).then(next => { if (!controller.signal.aborted) setLoaded({id: asset.id, url: next.preview}); }, () => {});
    return () => controller.abort();
  }, [asset, privacy]);
  const url = loaded?.id === asset.id ? loaded.url : asset.preview;
  return privacy ? <span className="privacy-mask" aria-label="비공개 모드"/> : url ? <img src={url} alt="" draggable={false}/> : <PhotoIcon aria-hidden="true"/>;
}

/**
 * What a review opens on: one character (`target`, filtered by the server) or one series. A series
 * is filtered by the server when it accepts `series=` (`serverSeries`, known from `countsByTarget`),
 * and here in any case.
 */
export type ReviewScope = {target?: {id: string; name: string} | null; series?: {id: string; name: string} | null; serverSeries?: boolean};

/**
 * Full-screen character-candidate review, one candidate at a time. Like the PC grid, the person
 * only marks the wrong ones: swiping left marks 아님 (shown on the card, undone from the list of
 * marks or 되돌리기), swiping right or 다음 just moves on, and up is 건너뛰기 (the card comes back
 * later, unseen). 아님 N장 빼고 나머지 맞음 then saves 아님 for the marked and 맞음 for everything
 * else seen in this session, after a confirmation; cards not seen yet are not touched. With
 * 한 장씩 바로 판단 every swipe decides at once (right 맞음, left 아님). Decisions go through the
 * durable review outbox; the PC applies them later, so an accepted Asset joins the character's
 * gallery only after the PC's next publication.
 */
export function CharacterReview({libraryId, target, series, serverSeries = false, onClose, backRef}: {
  libraryId: string;
  target?: {id: string; name: string} | null;
  /** Only this series' candidates: asked of the server when `serverSeries`, and filtered here in any case. */
  series?: {id: string; name: string} | null;
  serverSeries?: boolean;
  onClose(): void;
  backRef: MutableRefObject<(() => boolean) | null>;
}) {
  const [privacy] = usePrivacyMode();
  const [state, setState] = useState<State>({phase: 'loading'});
  const [queue, setQueue] = useState<ReviewItem[]>([]);
  const [targets, setTargets] = useState<Record<string, ReviewTarget>>({});
  const [counts, setCounts] = useState<ReviewCounts | null>(null);
  const [total, setTotal] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const [undo, setUndo] = useState<Undo[]>([]);
  const [mode, setMode] = useState<Mode>(readMode);
  // Cards moved past in the mark mode (not decided yet), and the pairs marked 아님 among them or restored from before.
  const [viewed, setViewed] = useState<ReviewItem[]>([]);
  const [marks, setMarks] = useState<Set<string>>(readMarkedPairs);
  const [confirming, setConfirming] = useState(false);
  const [marksOpen, setMarksOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState<Asset | null>(null);
  const [notice, setNotice] = useState('');
  const [queued, setQueued] = useState(() => Object.keys(readReviewIntents()).length);
  const [offset, setOffset] = useState({x: 0, y: 0});
  const cursor = useRef<string | null>(null);
  const more = useRef(false);
  const done = useRef(new Set<string>());
  // Skipped rows are remembered on this device and come back only after everything else.
  const deferred = useRef<ReviewItem[]>([]);
  const card = useRef<HTMLDivElement>(null);
  const drag = useRef<{id: number; x: number; y: number; t: number} | null>(null);
  const alive = useRef(true);
  const viewedRef = useRef<ReviewItem[]>([]);
  const marksRef = useRef(marks);
  const savingRef = useRef(false);
  const latest = useRef({zoom, onClose, confirming, marksOpen});
  latest.current = {zoom, onClose, confirming, marksOpen};
  const changeViewed = useCallback((next: ReviewItem[]) => { viewedRef.current = next; setViewed(next); }, []);
  const changeMarks = useCallback((edit: (next: Set<string>) => void) => {
    const next = new Set(marksRef.current);
    edit(next);
    marksRef.current = next;
    setMarks(next);
    writeMarkedPairs(next);
  }, []);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    backRef.current = () => {
      if (latest.current.zoom) { setZoom(null); return true; }
      if (latest.current.confirming) { setConfirming(false); return true; }
      if (latest.current.marksOpen) { setMarksOpen(false); return true; }
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

  /** Rows this device already handled (queued, decided or seen this session) never reappear; skipped rows go last. */
  const fresh = useCallback((items: ReviewItem[], described: Record<string, ReviewTarget>) => {
    const hidden = queuedReviewPairs();
    const looked = new Set(viewedRef.current.map(itemKey));
    return items.filter(item => {
      if (series && described[item.targetId]?.seriesId !== series.id) return false;
      const key = reviewPairKey(item.targetId, item.assetId);
      return !hidden.has(key) && !done.current.has(key) && !looked.has(key);
    });
  }, [series?.id]);

  const load = useCallback(async (restart: boolean) => {
    if (more.current) return;
    more.current = true;
    try {
      const feed = await api<ReviewFeed>(reviewPath({target: target?.id, series: serverSeries ? series?.id : null, cursor: restart ? null : cursor.current, limit: PAGE}));
      if (!alive.current) return;
      if (feed?.version !== 1 || !Array.isArray(feed.items)) throw new Error('확인 응답을 확인할 수 없습니다.');
      cursor.current = feed.hasMore ? feed.nextCursor : null;
      setCounts(feed.counts);
      setTargets(current => ({...current, ...feed.targets}));
      // A series count is exact from the per-character counts, else known only as far as the pages read.
      if (series && Array.isArray(feed.countsByTarget)) { if (restart) setTotal(feed.countsByTarget.filter(row => row.seriesId === series.id).reduce((sum, row) => sum + (Number.isSafeInteger(row.pending) ? row.pending : 0), 0)); }
      else if (series) setTotal(value => (restart ? 0 : value) + feed.items.filter(item => feed.targets?.[item.targetId]?.seriesId === series.id).length);
      else if (restart) setTotal(feed.counts.total);
      setQueue(current => {
        const seen = new Set(current.map(item => reviewPairKey(item.targetId, item.assetId)));
        const skipped = readSkippedPairs();
        const incoming = fresh(feed.items, feed.targets ?? {});
        if (restart) deferred.current = [];
        const later = new Set(deferred.current.map(item => reviewPairKey(item.targetId, item.assetId)));
        for (const item of incoming){ const key = reviewPairKey(item.targetId, item.assetId); if (skipped.has(key) && !later.has(key)){ deferred.current.push(item); later.add(key); } }
        const normal = incoming.filter(item => !skipped.has(reviewPairKey(item.targetId, item.assetId)));
        const added = normal.filter(item => !seen.has(reviewPairKey(item.targetId, item.assetId)));
        return restart ? normal : [...current, ...added];
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
      if (restart) setState({phase: 'error', message: (reason as ApiError)?.status === 404 ? '서버에 확인 업데이트가 필요합니다.' : errorText(reason), offline: offline && (reason as ApiError)?.status !== 404});
      else setNotice(errorText(reason));
    } finally {
      more.current = false;
    }
  }, [fresh, target?.id, series?.id, serverSeries]);

  useEffect(() => { void load(true); }, [load]);
  // Keep a few candidates ahead, and warm the next three thumbnails.
  useEffect(() => {
    if (state.phase === 'ready' && queue.length < 5 && cursor.current) void load(false);
    const controller = new AbortController();
    if (!privacy) for (const item of queue.slice(1, 4)) void warmThumbnail(item.asset, controller.signal);
    return () => controller.abort();
  }, [queue, state.phase, load, privacy]);

  // Skipped candidates wait until everything else is done; then the user can go through them again.
  const replaySkipped = () => {
    const back = deferred.current.filter(item => !done.current.has(reviewPairKey(item.targetId, item.assetId)));
    deferred.current = [];
    setQueue(back);
  };

  const current = queue[0];
  const currentKey = current ? reviewPairKey(current.targetId, current.assetId) : null;
  // Set by a decision: the card now showing the next candidate rises in once it commits.
  const rising = useRef(false);
  useLayoutEffect(() => {
    if (!rising.current) return;
    rising.current = false;
    riseIn(card.current);
  }, [currentKey]);
  /**
   * Right is 맞음 only in the direct mode; in the mark mode it just moves on and left marks 아님,
   * both without queueing anything until the whole session is saved (`save`).
   */
  const act = useCallback((action: Action) => {
    const item = queue[0];
    if (!item) return;
    const key = reviewPairKey(item.targetId, item.assetId);
    let operationId: string | undefined;
    let wasMarked = false;
    if (action === 'skipped') {
      rememberSkippedPair(key);
      deferred.current = [...deferred.current.filter(row => reviewPairKey(row.targetId, row.assetId) !== key), item];
    } else if (mode === 'direct') {
      try {
        operationId = commitReviewDecision({libraryId, targetId: item.targetId, assetId: item.assetId,
          decision: action, origin: 'feed', basis: item.basis}).operationId;
      } catch (reason) { setNotice(errorText(reason)); setOffset({x: 0, y: 0}); return; }
      setReviewed(value => value + 1);
      void flushCharacterReview().catch(() => {});
      forgetSkippedPair(key);
      done.current.add(key);
      // A mark left over from the mark mode is decided now.
      if (marksRef.current.has(key)) changeMarks(next => { next.delete(key); });
    } else {
      wasMarked = marksRef.current.has(key);
      changeViewed([...viewedRef.current.filter(row => itemKey(row) !== key), item]);
      if (action === 'rejected') changeMarks(next => { next.add(key); });
      forgetSkippedPair(key);
    }
    setNotice('');
    flyOff(card.current, action);
    rising.current = true;
    setOffset({x: 0, y: 0});
    setUndo(stack => [...stack, {kind: 'one' as const, action, item, operationId, local: action === 'skipped' || mode === 'mark', wasMarked}].slice(-UNDO_DEPTH));
    setQueue(rest => rest.filter(row => reviewPairKey(row.targetId, row.assetId) !== key));
  }, [queue, libraryId, mode, changeViewed, changeMarks]);

  /** Queues 아님 for the marked and 맞음 for the rest of what was seen; failures stay marked/seen and say why. */
  const save = useCallback(async () => {
    const items = viewedRef.current;
    if (!items.length || savingRef.current) return;
    savingRef.current = true;
    setSaving(true); setConfirming(false);
    const ops: BatchOp[] = [];
    let failure = '';
    for (const item of items) {
      const decision = marksRef.current.has(itemKey(item)) ? 'rejected' as const : 'accepted' as const;
      const intent = {libraryId, targetId: item.targetId, assetId: item.assetId, decision, origin: 'feed' as const, basis: item.basis};
      try {
        let operationId: string;
        // A full queue is emptied by a send pass once, then tried again.
        try { operationId = commitReviewDecision(intent).operationId; }
        catch (reason) {
          if ((reason as Error)?.message !== REVIEW_OUTBOX_FULL) throw reason;
          await flushCharacterReview().catch(() => {});
          operationId = commitReviewDecision(intent).operationId;
        }
        ops.push({item, decision, operationId});
      } catch (reason) { failure = errorText(reason); break; }
    }
    savingRef.current = false;
    setSaving(false);
    if (ops.length) {
      const saved = new Set(ops.map(op => itemKey(op.item)));
      for (const key of saved) { done.current.add(key); forgetSkippedPair(key); }
      changeViewed(viewedRef.current.filter(row => !saved.has(itemKey(row))));
      changeMarks(next => { for (const key of saved) next.delete(key); });
      setReviewed(value => value + ops.length);
      setUndo(stack => [...stack, {kind: 'batch' as const, ops}].slice(-UNDO_DEPTH));
      void flushCharacterReview().catch(() => {});
    }
    setNotice(failure ? `${failure} 나머지 ${items.length - ops.length}장은 그대로 남겨 두었습니다.` : '');
  }, [libraryId, changeViewed, changeMarks]);

  const revertBatch = useCallback((last: Extract<Undo, {kind: 'batch'}>) => {
    const undone: BatchOp[] = [];
    let failure = '';
    for (const op of [...last.ops].reverse()) {
      try {
        undoReviewDecision({libraryId, targetId: op.item.targetId, assetId: op.item.assetId, operationId: op.operationId, origin: 'feed'}, isReviewInFlight);
      } catch (reason) { failure = errorText(reason); break; }
      undone.push(op);
    }
    if (undone.length) {
      void flushCharacterReview().catch(() => {});
      const back = last.ops.filter(op => undone.includes(op));
      setReviewed(value => Math.max(0, value - back.length));
      for (const op of back) done.current.delete(itemKey(op.item));
      changeViewed([...back.map(op => op.item), ...viewedRef.current.filter(row => !back.some(op => itemKey(op.item) === itemKey(row)))]);
      changeMarks(next => { for (const op of back) if (op.decision === 'rejected') next.add(itemKey(op.item)); });
    }
    const left = last.ops.filter(op => !undone.includes(op));
    setUndo(stack => left.length ? [...stack.slice(0, -1), {kind: 'batch' as const, ops: left}] : stack.slice(0, -1));
    setNotice(failure);
  }, [libraryId, changeViewed, changeMarks]);

  const revert = useCallback(() => {
    const last = undo[undo.length - 1];
    if (!last) return;
    if (last.kind === 'batch') { revertBatch(last); return; }
    if (!last.local && last.action !== 'skipped' && last.operationId) {
      try {
        const outcome = undoReviewDecision({libraryId, targetId: last.item.targetId, assetId: last.item.assetId,
          operationId: last.operationId, origin: 'feed'}, isReviewInFlight);
        if (outcome === 'cleared') void flushCharacterReview().catch(() => {});
      } catch (reason) { setNotice(errorText(reason)); return; }
      setReviewed(value => Math.max(0, value - 1));
    }
    const lastKey = reviewPairKey(last.item.targetId, last.item.assetId);
    done.current.delete(lastKey);
    if (last.local && last.action !== 'skipped') {
      changeViewed(viewedRef.current.filter(row => itemKey(row) !== lastKey));
      if (last.action === 'rejected' && !last.wasMarked) changeMarks(next => { next.delete(lastKey); });
    }
    if (last.action === 'skipped'){ forgetSkippedPair(lastKey); deferred.current = deferred.current.filter(row => reviewPairKey(row.targetId, row.assetId) !== lastKey); }
    setUndo(stack => stack.slice(0, -1));
    setQueue(rest => [last.item, ...rest.filter(row => reviewPairKey(row.targetId, row.assetId) !== reviewPairKey(last.item.targetId, last.item.assetId))]);
  }, [undo, libraryId, revertBatch, changeViewed, changeMarks]);

  const changeMode = (direct: boolean) => { const next: Mode = direct ? 'direct' : 'mark'; setMode(next); writeMode(next); setNotice(''); };
  const unmark = (key: string) => changeMarks(next => { next.delete(key); });

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
  const markedViewed = viewed.filter(item => marks.has(itemKey(item)));
  const restViewed = viewed.length - markedViewed.length;
  const currentMarked = !!current && mode === 'mark' && marks.has(currentKey!);
  const saveLabel = markedViewed.length === 0 ? `본 ${viewed.length}장 모두 맞음` : restViewed === 0 ? `아님 ${markedViewed.length}장 저장` : `아님 ${markedViewed.length}장 빼고 나머지 맞음`;
  // Nothing marked is left to list: close the list.
  useEffect(() => { if (marksOpen && markedViewed.length === 0) setMarksOpen(false); }, [marksOpen, markedViewed.length]);
  // The confirmation shows briefly after each decision; afterwards undo stays in the top bar
  // so nothing lingers over the 아님 · 건너뛰기 · 맞음 buttons.
  const [snackVisible, setSnackVisible] = useState(false);
  useEffect(() => {
    if (!undo.length){ setSnackVisible(false); return; }
    setSnackVisible(true);
    const timer = setTimeout(() => setSnackVisible(false), 2500);
    return () => clearTimeout(timer);
  }, [undo.length, lastUndo]);
  const title = target ? `${target.name} 확인` : series ? `${series.name} 확인` : '확인';
  // A series walks pages that may hold none of its candidates: keep loading until the feed ends.
  const walking = !!series && !!cursor.current;
  const {width} = size();
  return <div className="review-overlay" role="dialog" aria-modal="true" aria-label={title}>
    <header className="review-bar">
      <IconButton label="확인 닫기" icon={ArrowLeftIcon} onClick={onClose}/>
      <div className="review-title"><h1>{title}</h1>
        {state.phase === 'ready' && state.ready && <p className="numeric" aria-live="polite">{reviewed} / {total}{mode === 'mark' && viewed.length > 0 && ` · 본 ${viewed.length}장${markedViewed.length > 0 ? ` · 아님 ${markedViewed.length}장` : ''}`}{pending > 0 && ` · PC 반영 대기 ${pending}`}{(counts?.skipped ?? 0) > 0 && ` · 반영 안 된 결정 ${counts!.skipped}`}</p>}
      </div>
      {undo.length > 0 && !snackVisible && <IconButton label="마지막 판단 되돌리기" icon={ArrowUturnLeftIcon} onClick={revert}/>}
    </header>
    {notice && <p className="error-message review-notice" role="alert">{notice}</p>}
    {state.phase === 'ready' && state.ready && <div className="review-tools">
      {mode === 'mark' ? <Button size="sm" variant="ghost" disabled={markedViewed.length === 0} onClick={() => setMarksOpen(true)}>표시한 {markedViewed.length}장</Button> : <span/>}
      <Switch label="한 장씩 바로 판단" checked={mode === 'direct'} disabled={saving} onChange={event => changeMode(event.currentTarget.checked)}/>
    </div>}
    <LoadingLine label={(state.phase === 'loading')&&'확인 목록 불러오는 중'}/>
    {state.phase === 'error' && <EmptyState className="review-empty" title={state.offline ? '오프라인입니다' : '확인 목록을 불러오지 못했습니다'} hint={state.offline ? (queued ? `저장된 결정 ${queued}개는 연결되면 PC로 전송됩니다.` : '연결을 확인한 뒤 다시 시도해 주세요.') : state.message}>
      <Button onClick={() => { setState({phase: 'loading'}); void load(true); }}>다시 시도</Button>
    </EmptyState>}
    {state.phase === 'ready' && !state.ready && <EmptyState className="review-empty" title="PC 업데이트가 필요합니다" hint="PC 앱이 아직 확인 목록을 보내지 않았습니다. PC 앱을 업데이트하고 실행해 두면 여기에서 확인할 수 있습니다."/>}
    <LoadingLine label={(state.phase === 'ready' && state.ready && !current && walking && !notice)&&'확인 목록 불러오는 중'}/>
    {state.phase === 'ready' && state.ready && !current && (!walking || !!notice) && <EmptyState className="review-empty" title={mode === 'mark' && viewed.length > 0 ? '끝까지 봤습니다' : '모두 확인했습니다'} hint={mode === 'mark' && viewed.length > 0 ? `본 ${viewed.length}장을 아래 버튼으로 저장해 주세요.` : pending > 0 ? `PC 반영 대기 ${pending}개 · PC가 반영하면 캐릭터 갤러리에 나타납니다.` : 'PC가 새 후보를 보내면 여기에 나타납니다.'}>
      {!cursor.current && deferred.current.length > 0 && <Button onClick={replaySkipped}>건너뛴 {deferred.current.length}개 다시 보기</Button>}
    </EmptyState>}
    {state.phase === 'ready' && state.ready && current && <div className="review-body">
      <div ref={card} className="review-card" data-hint={hint} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; setOffset({x: 0, y: 0}); }}
        style={{transform: `translate(${offset.x}px, ${Math.min(0, offset.y)}px) rotate(${(offset.x / width) * 12}deg)`}} aria-label="확인 후보">
        <ReviewImage asset={current.asset} className="review-candidate" label={`${info?.name ?? '캐릭터'} 후보`}/>
        <div className="review-caption">
          <strong>{info?.name ?? current.targetId}</strong>
          {info?.seriesName && <span className="muted">{info.seriesName}</span>}
          <span className="review-sources">{current.sources.map(source => <span key={source} className="review-chip" data-source={source}>{SOURCE_LABEL[source]}</span>)}</span>
          {currentMarked && <Button size="sm" variant="ghost" onClick={() => unmark(currentKey!)}>표시 해제</Button>}
        </div>
        {currentMarked && !hint && <span className="review-stamp" data-hint="reject" data-resting="" role="status">아님 표시</span>}
        {hint && <span className="review-stamp" data-hint={hint} aria-hidden="true">{hint === 'accept' ? (mode === 'mark' ? '다음' : '맞음') : hint === 'reject' ? '아님' : '건너뛰기'}</span>}
      </div>
      {!!info?.references.length && <div className="review-references" aria-label="레퍼런스">
        {info.references.slice(0, 4).map(reference => <button key={reference.id} className="review-reference" aria-label="레퍼런스 크게 보기" onClick={() => setZoom(reference)}>
          <ReviewImage asset={reference} label="레퍼런스"/>
        </button>)}
      </div>}
    </div>}
    {state.phase === 'ready' && state.ready && mode === 'mark' && viewed.length > 0 && <div className="review-save">
      <Button variant="primary" disabled={saving} onClick={() => setConfirming(true)}><CheckIcon aria-hidden="true"/>{saveLabel}</Button>
    </div>}
    {state.phase === 'ready' && state.ready && <footer className="review-actions">
      <Button variant="secondary" disabled={!current} onClick={() => act('rejected')}><XMarkIcon aria-hidden="true"/>아님</Button>
      <Button variant="ghost" disabled={!current} onClick={() => act('skipped')}><ChevronDoubleUpIcon aria-hidden="true"/>건너뛰기</Button>
      {mode === 'mark'
        ? <Button variant="secondary" disabled={!current} onClick={() => act('accepted')}><ChevronRightIcon aria-hidden="true"/>다음</Button>
        : <Button variant="primary" disabled={!current} onClick={() => act('accepted')}><CheckIcon aria-hidden="true"/>맞음</Button>}
    </footer>}
    {lastUndo && snackVisible && <div className="review-snackbar" role="status">
      <span>{lastUndo.kind === 'batch' ? `맞음 ${lastUndo.ops.filter(op => op.decision === 'accepted').length}장 · 아님 ${lastUndo.ops.filter(op => op.decision === 'rejected').length}장 저장`
        : lastUndo.action === 'skipped' ? '건너뜀'
        : lastUndo.local ? (lastUndo.action === 'rejected' ? '아님으로 표시' : '다음으로 넘김')
        : lastUndo.action === 'accepted' ? '맞음으로 저장' : '아님으로 저장'}</span>
      <Button variant="ghost" onClick={revert}><ArrowUturnLeftIcon aria-hidden="true"/>되돌리기</Button>
    </div>}
    {confirming && <Dialog open title="저장할까요?" onClose={() => setConfirming(false)}>
      <DialogDescription>본 {viewed.length}장 중 아님 {markedViewed.length}장, 맞음 {restViewed}장으로 저장합니다. 아직 보지 않은 후보는 그대로 남습니다.</DialogDescription>
      <div className="ui-dialog__actions"><Button onClick={() => setConfirming(false)}>취소</Button><Button variant="primary" onClick={() => void save()}>저장</Button></div>
    </Dialog>}
    {marksOpen && <BottomSheet title={`표시한 ${markedViewed.length}장`} tall onClose={() => setMarksOpen(false)}>
      <ul className="review-marked">
        {markedViewed.map(item => <li key={itemKey(item)}>
          <span className="review-marked-thumb"><MarkThumb asset={item.asset}/></span>
          <span className="review-marked-name"><strong>{targets[item.targetId]?.name ?? item.targetId}</strong>{targets[item.targetId]?.seriesName && <span className="muted">{targets[item.targetId]!.seriesName}</span>}</span>
          <Button variant="ghost" onClick={() => unmark(itemKey(item))}>표시 해제</Button>
        </li>)}
      </ul>
    </BottomSheet>}
    {zoom && <div className="review-zoom" role="dialog" aria-modal="true" aria-label="레퍼런스">
      <IconButton label="크게 보기 닫기" icon={XMarkIcon} onClick={() => setZoom(null)}/>
      <ReviewImage asset={zoom} label="레퍼런스"/>
    </div>}
  </div>;
}

/** Library → 분류 entry row: "확인 N", shown only with the capability and N > 0. */
export function CharacterReviewEntry({enabled, refreshKey, onOpen}: {enabled: boolean; refreshKey: unknown; onOpen(): void}) {
  const count = useCharacterReviewCount(enabled, null, refreshKey);
  if (!count) return null;
  return <button className="review-entry" onClick={onOpen} aria-label={`확인 ${count}개`}>
    <UserIcon aria-hidden="true"/><strong>확인</strong><span className="numeric muted">{count}</span><ChevronRightIcon aria-hidden="true"/>
  </button>;
}

/** Character page chip: "확인 N" opens the review filtered to this character. */
export function CharacterReviewChip({enabled, targetId, refreshKey, onOpen}: {enabled: boolean; targetId: string; refreshKey: unknown; onOpen(): void}) {
  const count = useCharacterReviewCount(enabled, targetId, refreshKey);
  if (!count) return null;
  return <div className="review-entry-chip"><Button size="sm" variant="secondary" onClick={onOpen} aria-label={`이 캐릭터 확인 ${count}개`}>확인 {count}</Button></div>;
}

/** Series page chip: "확인 N" opens the 확인 list filtered to this series (shown only when the server can count by series). */
export function CharacterReviewSeriesChip({enabled, series, refreshKey, onOpen}: {enabled: boolean; series: {id: string; name: string}; refreshKey: unknown; onOpen(): void}) {
  const count = useCharacterReviewSeriesCount(enabled, series.id, refreshKey);
  if (!count) return null;
  return <div className="review-entry-chip"><Button size="sm" variant="secondary" onClick={onOpen} aria-label={`${series.name} 확인 ${count}개`}>확인 {count}</Button></div>;
}
