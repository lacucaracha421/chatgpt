import { BusyLabel } from "../shared/ui/BusyLabel";
import { useAssetMask } from "../privacy/PrivacyContext";
import { AssetImage } from "../privacy/AssetImage";
import { workloadPollDelay, getWorkloadProfile } from "../app/workloadProfile";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type SyntheticEvent } from "react";
import { ArrowUturnLeftIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/ui/Button";
import { Badge } from "../shared/ui/Badge";
import { Dialog } from "../shared/ui/Dialog";
import { useBackHandler } from "../shared/navigation/BackNavigation";
import { assetPreviewUrl, assetUrl, thumbnailUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import type { ClassificationEntry } from "../library/types";
import type { CharacterTarget } from "./api";
import { confirmSources, getConfirmOverviewRead, readConfirmItems, type ConfirmRead, type ConfirmScope, type ConfirmSources } from "./confirmClient";
import { CONFIRM_KINDS, confirmCounts, confirmGroups, confirmKindLabel, groupByCharacter, keyRange, needsSingleLook, reasonBadges, tallyConfirm, type ConfirmItem, type ConfirmKind } from "./confirmModel";
import { ConfirmGrid } from "./ConfirmGrid";
import { BATCH_MAX, decisionRequest, saveJudgments, type Decision, type Judgment } from "./confirmSave";
import { classificationIsInSeries, taggerDecisionApi, type TaggerDecisionApi } from "./taggerReviewClient";
import "./ConfirmList.css";

export { reasonBadges };

const REFILL_STRIP = 12;
const PRELOAD_AHEAD = 3;
const PREFETCH_MAX_AGE = 5000;
const scopeKey = (scope: ConfirmScope) => JSON.stringify([scope.series?.id, scope.target?.id]);
type Prefetched = { promise: Promise<ConfirmRead | null>; read?: ConfirmRead; at: number; inbound: number | null };
/** Review copies come in a few sizes so every preloaded image of a stage size shares one cache entry. */
const PREVIEW_EDGES = [1280, 1600, 2048] as const;
const DEFAULT_PREVIEW_EDGE = 1600;

/** The smallest size that fills the stage on this screen; larger screens stop at the biggest (speed over sharpness). */
export function previewEdge(stageLongEdge: number, pixelRatio: number): number {
  const needed = stageLongEdge * (pixelRatio > 0 ? pixelRatio : 1);
  return PREVIEW_EDGES.find(edge => edge >= needed) ?? PREVIEW_EDGES[PREVIEW_EDGES.length - 1]!;
}

type Props = {
  scope?: ConfirmScope;
  targets: readonly CharacterTarget[];
  /** Folder tree, to tell whether a tag-listed image already sits in its character's series. */
  classifications: readonly ClassificationEntry[];
  privacyMode?: boolean;
  onClose: () => void;
  /** Called after a judgment is stored so galleries can refresh. */
  onChanged?: () => void;
  sources?: ConfirmSources;
  decisions?: TaggerDecisionApi;
};

type Folder = { key: string; state: "inside" | "outside" };
/** What the grid is about to apply: 아님 for the marked, 맞음 for the rest of what is shown. */
type BulkAsk = { accept: ConfirmItem[]; reject: ConfirmItem[]; single: number };
/** One bulk run: how many were stored per decision, and which ones could not be (they stay in the grid). */
type BulkResult = { accepted: number; rejected: number; failed: { item: ConfirmItem; message: string }[] };
const LOOKUP_AT_ONCE = 8;
/**
 * One-at-a-time judgments advance at once and are stored in the background: a flush starts when this many wait, or after
 * this long without a new judgment, and always before the screen closes or moves on. If the app is killed mid-review, at
 * most the judgments of the last flush window (under FLUSH_AT queued plus one batch in flight, about a second of work)
 * are lost; nothing else is kept on disk.
 */
const FLUSH_AT = 5;
const FLUSH_IDLE_MS = 1000;
const decisionText = (decision: Decision) => decision === "rejected" ? "아님" : decision === "accepted" ? "맞음" : "맞음 · 위치 틀림";

/**
 * 확인 opens one candidate at a time. In 모아 보기, a click marks one 아님; the apply button stores 아님 for
 * the marked and 맞음 for the rest. A tile opens alone in the one-at-a-time view (맞음 / 아님 / 맞음 · 위치 틀림).
 * The three kinds (태그 추천, 인식 추천, 다시 확인) only differ in their reason badges.
 */
export function ConfirmList({ scope, targets, classifications, privacyMode = false, onClose, onChanged, sources = confirmSources, decisions = taggerDecisionApi }: Props) {
  const [activeScope, setActiveScope] = useState(scope);
  const [switchTo, setSwitchTo] = useState<ConfirmScope | null>(null);
  const [overview] = useState(() => getConfirmOverviewRead(sources));
  const [items, setItems] = useState<ConfirmItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<ConfirmKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [last, setLast] = useState<Judgment | null>(null);
  const [kind, setKind] = useState<ConfirmKind | "all">("all");
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set());
  const [zoomKey, setZoomKey] = useState<string | null>(null);
  const [gridMode, setGridMode] = useState(false);
  const [reload, setReload] = useState(0);
  const [bulkAsk, setBulkAsk] = useState<BulkAsk | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [folder, setFolder] = useState<Folder | null>(null);
  /** The image whose full original was asked for (click or F); the review copy is shown until then. */
  const [originalKey, setOriginalKey] = useState<string | null>(null);
  const [edge, setEdge] = useState(DEFAULT_PREVIEW_EDGE);
  const stageRef = useRef<HTMLDivElement>(null);
  const judged = useRef(new Map<string, Judgment>());
  const pending = useRef(false);
  /** Judgments made but not yet sent, those being sent, and the background sends in order. */
  const queue = useRef<Judgment[]>([]);
  const inflight = useRef(new Set<Judgment>());
  const chain = useRef<Promise<void>>(Promise.resolve());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failures = useRef(0);
  /** Keys of judgments that came back after a failed save; the error line stays until they are all stored. */
  const retryKeys = useRef(new Set<string>());
  const waitingForSave = useRef(false);
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const classificationsRef = useRef(classifications);
  classificationsRef.current = classifications;
  const anchor = useRef<string | null>(null);
  const gridScroll = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  const gridSeen = useRef(false);
  const seriesId = activeScope?.series?.id;
  const targetId = activeScope?.target?.id;
  const requestedScope = switchTo ?? activeScope;
  const prefetches = useMemo(() => new Map<string, Prefetched>(), [sources]);
  const [, setPrefetchVersion] = useState(0);
  const inboundCounter = useRef<number | null>(null);
  const activatedCache = useRef<Prefetched | null>(null);

  function activateScope(nextScope: ConfirmScope, read: ConfirmRead) {
    setItems(read.items.filter(item => !judged.current.has(item.key)));
    setActiveScope(nextScope);
    setSwitchTo(null);
    setKind("all");
    setGridMode(false);
    setZoomKey(null);
    setMarked(new Set());
    setBulkResult(null);
    setFailed(read.failed);
    setLoaded(true);
    savedScroll.current = 0;
  }

  const readScope = useMemo<ConfirmScope>(() => ({
    ...(requestedScope?.series ? { series: requestedScope.series } : {}),
    ...(requestedScope?.target ? { target: requestedScope.target } : {}),
  }), [requestedScope?.series?.id, requestedScope?.target?.id, requestedScope?.series?.name, requestedScope?.target?.name]);

  // Old content stays until the new read lands; marks and the open image keep their place across a reload.
  useEffect(() => {
    let live = true;
    const cached = activatedCache.current;
    activatedCache.current = null;
    if (cached && Date.now() - cached.at <= PREFETCH_MAX_AGE && cached.inbound === inboundCounter.current) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const prefetched = switchTo ? prefetches.get(scopeKey(readScope)) : undefined;
    const reading = prefetched && !prefetched.read ? prefetched.promise : readConfirmItems(sources, readScope, targetsRef.current, () => live);
    void reading.then(read => {
      if (!live || !read) return;
      if (cached && read.failed.length > 0) return;
      if (switchTo && read.failed.length > 0) {
        setDecisionError("다음 확인 목록을 읽지 못했습니다. 다시 시도해 주세요.");
        prefetches.delete(scopeKey(readScope));
        setSwitchTo(null);
        return;
      }
      setItems(read.items.filter(item => !judged.current.has(item.key)));
      if (switchTo) {
        activateScope(switchTo, read);
      }
      setFailed(read.failed);
      setLoaded(true);
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [sources, readScope, reload]);

  const counts = useMemo(() => confirmCounts(items), [items]);
  const activeKind = kind !== "all" && counts[kind] > 0 ? kind : "all";
  const shown = useMemo(() => items.filter(item => activeKind === "all" || item.kind === activeKind), [items, activeKind]);
  const groups = useMemo(() => groupByCharacter(shown), [shown]);
  /** The visual order of the grid; the one-at-a-time view walks the same order. */
  const ordered = useMemo(() => groups.flatMap(group => group.items), [groups]);
  const eligible = useMemo(() => ordered.filter(item => !needsSingleLook(item)), [ordered]);
  const eligibleKeys = useRef<string[]>([]);
  eligibleKeys.current = eligible.map(item => item.key);
  const markedShown = useMemo(() => eligible.filter(item => marked.has(item.key)), [eligible, marked]);
  const restCount = eligible.length - markedShown.length;
  const singleCount = ordered.length - eligible.length;

  const selectedIndex = zoomKey ? ordered.findIndex(item => item.key === zoomKey) : -1;
  const currentIndex = gridMode ? -1 : Math.max(0, selectedIndex);
  const current = currentIndex >= 0 ? ordered[currentIndex] : undefined;
  // Persist the fallback selection so a later refresh keeps the image now on screen.
  useEffect(() => { if (current) setZoomKey(current.key); }, [current?.key]);
  const zooming = current !== undefined;
  const next = zooming && ordered.length > 1 ? ordered[(currentIndex + 1) % ordered.length] : undefined;
  // Keep the actual decoded elements, as the main viewer does: native media protocols
  // do not reliably reuse a detached Image's bitmap when a fresh element mounts.
  const prepared = zooming ? Array.from({ length: Math.min(PRELOAD_AHEAD + 1, ordered.length) },
    (_, offset) => ordered[(currentIndex + offset) % ordered.length]!) : [];
  // The review copy follows the stage size, in a few buckets so a resize rarely refetches.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      if (stage.clientWidth > 0 && stage.clientHeight > 0) setEdge(previewEdge(Math.max(stage.clientWidth, stage.clientHeight), window.devicePixelRatio));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [zooming]);
  // Back from one image to the grid, as Escape and the back button do.
  useBackHandler(() => { setGridMode(true); }, 110, zooming && !bulkAsk);
  // The grid returns where it was.
  useLayoutEffect(() => {
    if (!zooming && gridScroll.current) gridScroll.current.scrollTop = savedScroll.current;
  }, [zooming]);

  // Mobile judgments applied in the background move the list; read again when the counter moves.
  useEffect(() => {
    const inboundStatus = sources.shadow.inboundStatus;
    if (!inboundStatus) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let inbound: number | null = null;
    async function poll() {
      try {
        if (getWorkloadProfile().hidden) return;
        const { applied } = await inboundStatus!();
        if (!disposed) inboundCounter.current = applied;
        if (!disposed && inbound !== null && applied !== inbound) setReload(value => value + 1);
        inbound = applied;
      } catch { /* The list itself reports read failures. */ }
      finally { if (!disposed) timer = setTimeout(() => void poll(), workloadPollDelay(1000)); }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sources]);
  // Returning to the window may follow judgments made elsewhere (another window, mobile).
  useEffect(() => {
    const onFocus = () => setReload(value => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Where the image sits now: a tag-listed image outside its series is moved in when judged 맞음.
  useEffect(() => {
    if (!current?.fromTags) { setFolder(null); return; }
    let live = true;
    const { key, assetId, fromTags } = current;
    void decisions.classifications(assetId).then(ids => {
      if (live) setFolder({ key, state: classificationIsInSeries(ids, fromTags.seriesId, classificationsRef.current) ? "inside" : "outside" });
    }, () => { if (live) setFolder(null); });
    return () => { live = false; };
  }, [current?.key, decisions]);

  const toggle = useCallback((item: ConfirmItem, event: MouseEvent) => {
    if (pending.current) return;
    const keys = event.shiftKey ? keyRange(eligibleKeys.current, anchor.current, item.key) : [item.key];
    anchor.current = item.key;
    setBulkResult(null);
    setMarked(previous => {
      const turnOn = !previous.has(item.key);
      const rest = new Set(previous);
      for (const key of keys) { if (turnOn) rest.add(key); else rest.delete(key); }
      return rest;
    });
  }, []);
  const openZoom = useCallback((item: ConfirmItem) => {
    if (pending.current) return;
    savedScroll.current = gridScroll.current?.scrollTop ?? savedScroll.current;
    setDecisionError(null);
    setZoomKey(item.key);
    setGridMode(false);
  }, []);
  const clearMarks = () => { setMarked(new Set()); anchor.current = null; };
  const chooseKind = (tab: ConfirmKind | "all") => { setKind(tab); setGridMode(false); };

  /** The queued judgments go out now, in order behind any send already running. Never throws; failures come back into the list. */
  function flushNow(): Promise<void> {
    clearTimeout(flushTimer.current);
    if (queue.current.length === 0) return chain.current;
    const batch = queue.current.splice(0);
    for (const judgment of batch) inflight.current.add(judgment);
    chain.current = chain.current.then(async () => {
      const { saved, failed } = await saveJudgments(decisionsRef.current, batch, classificationsRef.current);
      for (const judgment of batch) inflight.current.delete(judgment);
      if (saved.length > 0) {
        const hadRetries = retryKeys.current.size > 0;
        for (const judgment of saved) retryKeys.current.delete(judgment.item.key);
        if (hadRetries && retryKeys.current.size === 0) setDecisionError(null);
        // A move cannot be taken back, so its 되돌리기 goes away once the move is stored.
        setLast(previous => previous?.moved ? null : previous);
        onChangedRef.current?.();
      }
      if (failed.length > 0) {
        failures.current += failed.length;
        const back = new Set(failed.map(row => row.judgment.item.key));
        for (const key of back) { judged.current.delete(key); retryKeys.current.add(key); }
        setItems(previous => [...failed.map(row => row.judgment.item), ...previous.filter(row => !back.has(row.key))]);
        setLast(previous => previous && back.has(previous.item.key) ? null : previous);
        setDecisionError(`${failed[0]!.message} ${failed.length.toLocaleString()}장은 저장하지 못해 목록에 남겼습니다.`);
      }
    });
    return chain.current;
  }
  const scheduleFlush = () => {
    clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => void flushNow(), FLUSH_IDLE_MS);
  };
  /** Runs `action` once every judgment is stored; if a save failed it is not run, and the failed images are back in the list. */
  function afterSaved(action: () => void) {
    if (queue.current.length === 0 && inflight.current.size === 0) { action(); return; }
    if (waitingForSave.current) return;
    waitingForSave.current = true;
    const failuresBefore = failures.current;
    void flushNow().then(() => { if (failures.current === failuresBefore) action(); }).finally(() => { waitingForSave.current = false; });
  }
  const close = () => afterSaved(onClose);
  // Leaving without onClose (the parent unmounts the screen) still sends what is queued.
  useEffect(() => () => { void flushNow(); }, []);

  /** Advances at once; the judgment is stored in the background (see FLUSH_AT). */
  function judge(decision: Decision) {
    if (!current || pending.current || judged.current.has(current.key)) return;
    if (decision === "accepted_wrong_region" && !current.crop) return;
    const item = current;
    const judgment: Judgment = { item, decision, moved: false };
    judged.current.set(item.key, judgment);
    queue.current.push(judgment);
    setBulkResult(null);
    setItems(previous => previous.filter(row => row.key !== item.key));
    setMarked(previous => { if (!previous.has(item.key)) return previous; const rest = new Set(previous); rest.delete(item.key); return rest; });
    setZoomKey(next?.key ?? null);
    setLast(judgment);
    // Nothing left to look at: store now so the finished block does not wait on the idle timer.
    if (!next || queue.current.length >= FLUSH_AT) void flushNow(); else scheduleFlush();
  }
  /** Puts a judged image back in the list and opens it alone. */
  function restore(judgment: Judgment) {
    judged.current.delete(judgment.item.key);
    const restoreScope = Boolean((targetId && judgment.item.targetId !== targetId) || (seriesId && judgment.item.seriesId !== seriesId));
    setItems(previous => [judgment.item, ...previous.filter(row => row.key !== judgment.item.key && (!restoreScope || row.targetId === judgment.item.targetId))]);
    setZoomKey(judgment.item.key);
    setKind("all");
    setGridMode(false);
    if (restoreScope) {
      const restoredSeries = judgment.item.seriesId && classificationsRef.current.find(entry => entry.id === judgment.item.seriesId);
      setActiveScope({ ...(restoredSeries ? { series: { id: restoredSeries.id, name: restoredSeries.name } } : {}),
        target: { id: judgment.item.targetId, name: judgment.item.targetName } });
    }
    setLast(null);
  }
  /** A judgment still waiting in the queue is simply taken out of it; a stored one is cleared on the server. */
  async function undo() {
    if (!last || pending.current) return;
    const judgment = last;
    const queuedAt = queue.current.indexOf(judgment);
    if (queuedAt >= 0) {
      queue.current.splice(queuedAt, 1);
      setDecisionError(null);
      restore(judgment);
      return;
    }
    pending.current = true;
    setBusy(true); setDecisionError(null);
    try {
      if (inflight.current.has(judgment)) {
        await chain.current;
        // It failed (and is back in the list) or was a move: there is nothing to take back.
        if (judged.current.get(judgment.item.key) !== judgment || judgment.moved) { setLast(null); return; }
      }
      await decisions.decide(decisionRequest(judgment.item, "cleared"));
      restore(judgment);
      onChanged?.();
    } catch (e) {
      setDecisionError(commandErrorMessage(e, "판단을 되돌리지 못했습니다."));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  /**
   * 아님 for the marked, 맞음 for the rest. A tag-listed image outside its series that is judged 맞음 is moved in one by one;
   * every other judgment is stored in batches, and a refused batch is retried item by item to find which ones failed.
   */
  async function applyBulk({ accept, reject }: BulkAsk) {
    if (accept.length + reject.length === 0 || pending.current) return;
    pending.current = true;
    setBusy(true); setBulkRunning(true); setDecisionError(null); setBulkResult(null);
    const done: Judgment[] = [];
    const failedRows: BulkResult["failed"] = [];
    const fail = (item: ConfirmItem, e: unknown) => failedRows.push({ item, message: commandErrorMessage(e, "판단을 저장하지 못했습니다.") });
    try {
      const plain: { item: ConfirmItem; decision: "accepted" | "rejected" }[] = [];
      const lookups = accept.filter(item => item.fromTags);
      const outside = new Set<string>();
      for (let start = 0; start < lookups.length; start += LOOKUP_AT_ONCE) {
        await Promise.all(lookups.slice(start, start + LOOKUP_AT_ONCE).map(async item => {
          try {
            const ids = await decisions.classifications(item.assetId);
            if (!classificationIsInSeries(ids, item.fromTags!.seriesId, classificationsRef.current)) outside.add(item.key);
          } catch (e) { fail(item, e); }
        }));
      }
      const lookedUpFailed = new Set(failedRows.map(row => row.item.key));
      for (const item of accept) {
        if (lookedUpFailed.has(item.key)) continue;
        if (!outside.has(item.key)) { plain.push({ item, decision: "accepted" }); continue; }
        try {
          await decisions.move(item.targetId, item.targetFingerprint, [item.assetId], true);
          done.push({ item, decision: "accepted", moved: true });
        } catch (e) { fail(item, e); }
      }
      for (const item of reject) plain.push({ item, decision: "rejected" });
      for (let start = 0; start < plain.length; start += BATCH_MAX) {
        const chunk = plain.slice(start, start + BATCH_MAX);
        try {
          await decisions.decideBatch(chunk.map(row => decisionRequest(row.item, row.decision)));
          done.push(...chunk.map(row => ({ item: row.item, decision: row.decision, moved: false })));
        } catch {
          for (const row of chunk) {
            try { await decisions.decide(decisionRequest(row.item, row.decision)); done.push({ item: row.item, decision: row.decision, moved: false }); }
            catch (e) { fail(row.item, e); }
          }
        }
      }
    } finally {
      for (const judgment of done) judged.current.set(judgment.item.key, judgment);
      const gone = new Set(done.map(judgment => judgment.item.key));
      if (gone.size > 0) {
        setItems(previous => previous.filter(row => !gone.has(row.key)));
        setMarked(previous => { const rest = new Set(previous); for (const key of gone) rest.delete(key); return rest; });
        setLast(null);
        onChanged?.();
      }
      setBulkResult({ accepted: done.filter(j => j.decision === "accepted").length, rejected: done.filter(j => j.decision === "rejected").length, failed: failedRows });
      setBulkAsk(null);
      pending.current = false;
      setBulkRunning(false);
      setBusy(false);
    }
  }
  function askBulk() {
    if (pending.current || eligible.length === 0) return;
    setBulkAsk({ accept: eligible.filter(item => !marked.has(item.key)), reject: markedShown, single: singleCount });
  }
  /** One at a time: on to the next image without deciding this one. */
  function skip() {
    if (!current || busy || !next) return;
    setDecisionError(null);
    setZoomKey(next.key);
  }
  const retry = () => setReload(value => value + 1);

  // Another character already judged on this same image in this window.
  const sameImage = current ? [...judged.current.values()].filter(j => j.item.assetId === current.assetId && j.item.targetId !== current.targetId) : [];
  const scopeName = [activeScope?.series?.name, activeScope?.target?.name].filter(Boolean).join(" › ");
  const session = [...judged.current.values()];
  const scopedJudgments = session.filter(({ item }) => targetId ? item.targetId === targetId : seriesId ? item.seriesId === seriesId : false);
  const done = loaded && items.length === 0 && failed.length === 0 && scopedJudgments.length > 0;
  const accepted = scopedJudgments.filter(judgment => judgment.decision !== "rejected").length;
  const rejected = scopedJudgments.length - accepted;
  const overviewGroups = useMemo(() => overview ? confirmGroups(tallyConfirm(overview.items), targets,
    id => classifications.find(entry => entry.id === id)?.name) : [], [overview, targets, classifications]);
  const pendingCounts = new Map<string, number>();
  for (const item of overview?.items ?? []) {
    if (!judged.current.has(item.key)) pendingCounts.set(item.targetId, (pendingCounts.get(item.targetId) ?? 0) + 1);
  }
  const prioritySeries = seriesId ?? targets.find(target => target.id === targetId)?.seriesClassificationId;
  const nextCharacter = [...overviewGroups.filter(group => group.seriesId === prioritySeries), ...overviewGroups.filter(group => group.seriesId !== prioritySeries)]
    .flatMap(group => group.characters.map(character => ({ group, character,
      count: pendingCounts.get(character.targetId) ?? 0 })))
    .find(row => row.character.targetId !== targetId && row.count > 0);
  const nextScope = useMemo<ConfirmScope | null>(() => nextCharacter ? {
    ...(nextCharacter.group.seriesId ? { series: { id: nextCharacter.group.seriesId, name: nextCharacter.group.seriesName } } : {}),
    target: { id: nextCharacter.character.targetId, name: nextCharacter.character.name },
  } : null, [nextCharacter?.group.seriesId, nextCharacter?.group.seriesName, nextCharacter?.character.targetId, nextCharacter?.character.name]);
  useEffect(() => {
    if (!loaded || items.length > PRELOAD_AHEAD || !nextScope) return;
    const key = scopeKey(nextScope);
    if (prefetches.has(key)) return;
    let live = true;
    const entry: Prefetched = { promise: readConfirmItems(sources, nextScope, targetsRef.current), at: 0, inbound: inboundCounter.current };
    prefetches.set(key, entry);
    void entry.promise.then(read => {
      if (!read) return;
      entry.read = read;
      entry.at = Date.now();
      if (live) setPrefetchVersion(value => value + 1);
    });
    return () => { live = false; };
  }, [loaded, items.length <= PRELOAD_AHEAD, nextScope, sources, prefetches]);
  // Keep these very same elements mounted through the done block and into the next stage.
  const nextRead = nextScope && prefetches.get(scopeKey(nextScope))?.read;
  const nextPrepared = nextRead && nextRead.failed.length === 0
    ? groupByCharacter(nextRead.items.filter(item => !judged.current.has(item.key))).flatMap(group => group.items).slice(0, PRELOAD_AHEAD) : [];
  const stageItems = [...prepared, ...nextPrepared.filter(item => !prepared.some(row => row.key === item.key))];
  function continueReview() {
    if (busy || loading || switchTo) return;
    if (!nextCharacter) { close(); return; }
    setDecisionError(null);
    if (!nextScope) return;
    // Everything judged here is stored before the next character opens (at once when nothing waits).
    afterSaved(() => {
      const cached = prefetches.get(scopeKey(nextScope));
      if (cached?.read && cached.read.failed.length === 0) {
        activatedCache.current = cached;
        activateScope(nextScope, cached.read);
      } else setSwitchTo(nextScope);
    });
  }
  const tabs: (ConfirmKind | "all")[] = ["all", ...CONFIRM_KINDS.filter(candidate => counts[candidate] > 0)];
  const allFailed = failed.length === CONFIRM_KINDS.length;
  const markedCount = markedShown.length;
  const applyLabel = markedCount === 0 ? "모두 맞음" : restCount === 0 ? `아님 ${markedCount.toLocaleString()}장 처리` : `아님 ${markedCount.toLocaleString()}장 빼고 나머지 맞음`;
  const intro = !gridSeen.current;
  useEffect(() => { if (!zooming && ordered.length > 0) gridSeen.current = true; }, [zooming, ordered.length]);

  return <Dialog open variant="fullscreen" title="확인" onClose={close}
    onKeyDown={event => {
      if (bulkAsk || switchTo || event.nativeEvent.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "z" && last) { event.preventDefault(); void undo(); return; }
      if (done && key === "enter") {
        // Let the focused secondary/undo button retain its native Enter action.
        if (event.target instanceof HTMLElement && event.target.closest(".confirm-list__empty-block button:not([data-confirm-continue])")) return;
        event.preventDefault();
        if (!event.repeat) continueReview();
        return;
      }
      if (!zooming) return;
      if (key === "arrowright" || key === "d") { event.preventDefault(); void judge("accepted"); }
      else if (key === "arrowleft" || key === "a") { event.preventDefault(); void judge("rejected"); }
      else if (key === "w") { event.preventDefault(); void judge("accepted_wrong_region"); }
      else if (key === "arrowdown" || key === "s") { event.preventDefault(); skip(); }
      else if (key === "f" && current) { event.preventDefault(); setOriginalKey(current.key); }
    }}>
    <section className="confirm-list" aria-label="확인">
      <header className="confirm-list__header">
        <h2>확인</h2>
        {scopeName && <small className="confirm-list__scope">{scopeName}</small>}
        <div className="confirm-list__tabs" role="tablist" aria-label="확인 종류">
          {tabs.map(tab => <button key={tab} type="button" role="tab" aria-selected={activeKind === tab} disabled={busy} onClick={() => chooseKind(tab)}>
            {tab === "all" ? "전체" : confirmKindLabel[tab]} <span className="numeric">{counts[tab === "all" ? "total" : tab].toLocaleString()}</span>
          </button>)}
        </div>
        <span className="confirm-list__remaining" aria-live="polite">남은 항목 <b className="numeric">{(activeKind === "all" ? counts.total : counts[activeKind]).toLocaleString()}</b></span>
        <Button size="icon" variant="ghost" aria-label="확인 닫기" onClick={close}><XMarkIcon aria-hidden="true" /></Button>
      </header>
      <BusyLabel busy={loading && !loaded}><p className="character-message confirm-list__notice" role="status">불러오는 중…</p></BusyLabel>
      {loaded && failed.length > 0 && !allFailed && <p className="character-message confirm-list__notice" role="status">
        {failed.map(item => confirmKindLabel[item]).join(" · ")} 목록을 읽지 못했습니다. <Button size="sm" onClick={retry}>다시 시도</Button>
      </p>}
      {bulkResult && !done && <p className="character-message confirm-list__notice" role="status">
        {bulkResultText(bulkResult)}
        {bulkResult.failed.length > 0 && ` ${bulkResult.failed.length.toLocaleString()}장은 저장하지 못해 목록에 남겼습니다: ${failedNames(bulkResult.failed)}. ${bulkResult.failed[0]!.message}`}
      </p>}
      <div className="confirm-list__body" style={{ display: current && !allFailed ? undefined : "none" }}>
        <div className="confirm-list__stage" ref={stageRef}>
          {stageItems.map(item => <ConfirmImage key={item.key} item={item} privacyMode={privacyMode} active={item.key === current?.key} edge={edge}
            showOriginal={originalKey === item.key} onShowOriginal={() => setOriginalKey(item.key)} />)}
        </div>
        {current && <aside className="confirm-list__panel" aria-label="확인 정보">
          <Button className="confirm-list__back" size="sm" variant="ghost" disabled={busy} onClick={() => setGridMode(true)}><ArrowUturnLeftIcon aria-hidden="true" />모아 보기 <kbd>Esc</kbd></Button>
          <div className="confirm-list__badges">{reasonBadges(current).map(text => <Badge key={text}>{text}</Badge>)}</div>
          <h3 className="confirm-list__character">{current.targetName}?</h3>
          {current.referenceAssetIds.length > 0 && <ul className="confirm-list__references" aria-label={`${current.targetName} 레퍼런스`}>
            {current.referenceAssetIds.map(id => <li key={id}><AssetImage src={thumbnailUrl(id)} alt="" className={privacyMode ? "character-private" : undefined} loading="lazy" /></li>)}
          </ul>}
          {reasonNote(current) && <p className="confirm-list__note" role="note">{reasonNote(current)}</p>}
          {folder?.key === current.key && folder.state === "outside" && <p className="confirm-list__note" role="note">폴더 밖 · 맞음을 누르면 {current.targetName}의 시리즈로 옮깁니다.</p>}
          {sameImage.length > 0 && <p className="confirm-list__note" role="note">같은 이미지의 다른 캐릭터 후보입니다. 앞에서 {sameImage.map(j => `${j.item.targetName} ${decisionText(j.decision)}`).join(", ")}(으)로 판단했습니다. 이 캐릭터도 그림에 있으면 맞음을 누르세요.</p>}
          <p className="confirm-list__meta">{current.originalName}</p>
          {originalKey !== current.key && <p className="confirm-list__meta">빠르게 보도록 화질을 낮춰 표시합니다. 이미지를 누르거나 <kbd>F</kbd>를 누르면 원본을 봅니다.</p>}
          <div className="confirm-list__actions">
            <Button variant="primary" disabled={busy} onClick={() => void judge("accepted")}>맞음 <kbd>→</kbd><kbd>D</kbd></Button>
            <Button disabled={busy} onClick={() => void judge("rejected")}>아님 <kbd>←</kbd><kbd>A</kbd></Button>
            {current.crop && <Button disabled={busy} onClick={() => void judge("accepted_wrong_region")}>맞음 · 위치 틀림 <kbd>W</kbd></Button>}
            <Button variant="ghost" disabled={busy || !next} onClick={skip}>건너뛰기 <kbd>↓</kbd><kbd>S</kbd></Button>
          </div>
          <p className="confirm-list__meta">아님 = {current.targetName}에서 빼고 다시 넣지 않음</p>
          {last && <Button className="confirm-list__undo" size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>되돌리기: {last.item.targetName} {decisionText(last.decision)} <kbd>Z</kbd></Button>}
          {decisionError && <p className="character-message" role="alert">{decisionError}</p>}
        </aside>}
      </div>
      {allFailed
        ? <p className="character-message confirm-list__notice" role="alert">확인 목록을 불러오지 못했습니다. <Button size="sm" onClick={retry}>다시 시도</Button></p>
        : current
          ? <>
            <ul className="confirm-list__strip" aria-label="다음 이미지">
              {Array.from({ length: Math.min(REFILL_STRIP, ordered.length) }, (_, offset) => ordered[(currentIndex + offset) % ordered.length]!).map((item, index) => <li key={item.key}>
                <button type="button" aria-label={`${item.targetName} · ${item.originalName}`} aria-current={index === 0 ? "true" : undefined} disabled={busy} onClick={() => openZoom(item)}>
                  <AssetImage src={thumbnailUrl(item.assetId)} alt="" className={privacyMode ? "character-private" : undefined} loading="lazy" draggable={false} />
                </button>
              </li>)}
            </ul>
          </>
          : ordered.length > 0
            ? <>
              <div className="confirm-list__marks">
                <span className="confirm-list__marks-count" aria-live="polite">아님 <b className="numeric">{markedCount.toLocaleString()}</b>장 표시됨</span>
                <Button size="sm" variant="quiet" disabled={busy || markedCount === 0} onClick={clearMarks}>표시 모두 지우기</Button>
                {singleCount > 0 && <span className="confirm-list__marks-single">한 장씩 보기 필요 <b className="numeric">{singleCount.toLocaleString()}</b>장</span>}
              </div>
              <ConfirmGrid groups={groups} grouped={groups.length > 1} marked={marked} privacyMode={privacyMode} intro={intro} scrollRef={gridScroll} onToggle={toggle} onZoom={openZoom} />
              <footer className="confirm-list__apply">
                <span className="confirm-list__apply-sum">맞음 <b className="numeric">{restCount.toLocaleString()}</b>장 · 아님 <b className="numeric">{markedCount.toLocaleString()}</b>장</span>
                {decisionError && <span className="character-message" role="alert">{decisionError}</span>}
                {last && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>되돌리기: {last.item.targetName} {decisionText(last.decision)}</Button>}
                <Button variant="primary" disabled={busy || eligible.length === 0} onClick={askBulk}>{applyLabel}</Button>
              </footer>
            </>
            : loading && !loaded
              ? null
              : <div className="confirm-list__empty">
                <div className="confirm-list__empty-block" aria-busy={switchTo !== null || undefined}>
                  <h3>{done ? `${activeScope?.target?.name ?? activeScope?.series?.name} 확인 끝` : "확인할 항목이 없습니다"}</h3>
                  {done ? <>
                    <p className="confirm-list__meta numeric">맞음 {accepted.toLocaleString()} · 아님 {rejected.toLocaleString()}</p>
                    {!nextCharacter && <p className="confirm-list__empty-copy">{overview && overview.failed.length === 0 ? "모두 확인했습니다" : "이 범위의 확인을 마쳤습니다"}</p>}
                    <div className="confirm-list__empty-actions">
                      <Button data-confirm-continue variant="primary" disabled={busy || loading || switchTo !== null} onClick={continueReview}>
                        {nextCharacter ? `다음: ${nextCharacter.character.name} · ${nextCharacter.count.toLocaleString()}장` : "닫기"} <kbd>Enter</kbd>
                      </Button>
                      {nextCharacter && <Button disabled={busy} onClick={close}>닫기 <kbd>Esc</kbd></Button>}
                    </div>
                  </> : <>
                    <p className="confirm-list__empty-copy">새 이미지를 분석하면 여기에 나타납니다.</p>
                    <Button size="sm" disabled={loading} onClick={retry}>새로고침</Button>
                  </>}
                  {last && <Button size="sm" variant="ghost" disabled={busy || switchTo !== null} onClick={() => void undo()}>되돌리기: {last.item.targetName} {decisionText(last.decision)} <kbd>Z</kbd></Button>}
                  {decisionError && <p className="character-message" role="alert">{decisionError}</p>}
                </div>
              </div>}
    </section>
    {bulkAsk && <Dialog open title={applyLabel} onClose={() => { if (!bulkRunning) setBulkAsk(null); }}>
      <div className="confirm-list__bulk">
        <p>{bulkAsk.reject.length === 0
          ? `${bulkAsk.accept.length.toLocaleString()}장을 모두 맞음으로 처리할까요?`
          : `맞음 ${bulkAsk.accept.length.toLocaleString()}장, 아님 ${bulkAsk.reject.length.toLocaleString()}장을 저장할까요?`}</p>
        {bulkAsk.single > 0 && <p className="confirm-list__meta">한 장씩 보기 필요 {bulkAsk.single.toLocaleString()}장은 그대로 둡니다.</p>}
        <p className="confirm-list__meta">한 번에 되돌릴 수는 없습니다.</p>
        <div className="ui-dialog__actions">
          <Button disabled={bulkRunning} onClick={() => setBulkAsk(null)}>취소</Button>
          <Button variant="primary" disabled={bulkRunning} onClick={() => void applyBulk(bulkAsk)}>
            <BusyLabel busy={bulkRunning} idle="적용" delay={400}>처리 중…</BusyLabel>
          </Button>
        </div>
      </div>
    </Dialog>}
  </Dialog>;
}

function bulkResultText({ accepted, rejected }: BulkResult): string {
  if (accepted === 0 && rejected === 0) return "";
  const stored = rejected === 0 ? `${accepted.toLocaleString()}장을 맞음으로 처리했습니다.`
    : accepted === 0 ? `${rejected.toLocaleString()}장을 아님으로 처리했습니다.`
      : `맞음 ${accepted.toLocaleString()}장, 아님 ${rejected.toLocaleString()}장을 처리했습니다.`;
  return `${stored} 한 번에 되돌릴 수는 없습니다.`;
}

function failedNames(failed: BulkResult["failed"]): string {
  const names = failed.slice(0, 3).map(({ item }) => `${item.targetName} · ${item.originalName}`).join(", ");
  return failed.length > 3 ? `${names} 외 ${(failed.length - 3).toLocaleString()}장` : names;
}

function reasonNote(item: ConfirmItem): string | null {
  if (item.kind === "recheck") {
    return item.recognition?.doubtful
      ? `이미 ${item.targetName}(으)로 자동으로 넣은 이미지인데, 학습 인식이 지지하지 않습니다. 틀렸으면 아님을 눌러 주세요.`
      : `이미 ${item.targetName}(으)로 자동으로 넣은 이미지인데, 자동 태그가 이 이름을 읽지 않았습니다. 틀렸으면 아님을 눌러 주세요.`;
  }
  if (item.recognition?.placed) return `인식이 이미 ${item.targetName}(으)로 넣은 이미지입니다. 다른 추천을 다 본 뒤에 나오며, 틀렸으면 아님을 눌러 주세요.`;
  return null;
}

type Layer = "loading" | "ready" | "failed";

/**
 * Thumbnail first, then a screen-size review copy once it has loaded and decoded (a refused copy falls back to the
 * original); the full original only on request. A failed layer keeps what is below it. The person box rides on the image.
 */
function ConfirmImage({ item, privacyMode, active, edge, showOriginal, onShowOriginal }: {
  item: ConfirmItem; privacyMode: boolean; active: boolean; edge: number; showOriginal: boolean; onShowOriginal: () => void;
}) {
  const [copy, setCopy] = useState<Layer>("loading");
  const [fallback, setFallback] = useState(false);
  const [full, setFull] = useState<Layer>("loading");
  const masked = useAssetMask(item.assetId, privacyMode);
  const alt = `${item.originalName} — ${item.targetName} 후보`;
  const ratio = item.width > 0 && item.height > 0 ? item.width / item.height : 1;
  const box = item.crop?.box;
  const privateClass = privacyMode ? " character-private" : "";
  const decoded = (set: (state: Layer) => void) => (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const done = typeof image.decode === "function" ? image.decode() : Promise.resolve();
    void done.then(() => { if (image.isConnected) set("ready"); }, () => { if (image.isConnected) set("failed"); });
  };
  const copyFailed = () => {
    if (fallback) setCopy("failed");
    else { setFallback(true); setCopy("loading"); }
  };
  const askOriginal = active && !showOriginal && !masked ? onShowOriginal : undefined;
  return <figure className={`confirm-list__figure${active ? "" : " confirm-list__figure--preload"}`} aria-hidden={!active || undefined}>
    <div className={`confirm-list__frame${askOriginal ? " confirm-list__frame--zoomable" : ""}`} style={{ aspectRatio: ratio, "--confirm-ratio": ratio } as CSSProperties} onClick={askOriginal}>
      <AssetImage className={`confirm-list__image${privateClass}`} src={thumbnailUrl(item.assetId)} alt={copy === "ready" && !masked ? "" : alt} draggable={false} />
      {!masked && copy !== "failed" && <img className={`confirm-list__image${copy === "ready" ? "" : " confirm-list__image--pending"}${privateClass}`}
        src={fallback ? assetUrl(item.assetId) : assetPreviewUrl(item.assetId, edge)} alt={copy === "ready" ? alt : ""} draggable={false}
        decoding="async" onLoad={decoded(setCopy)} onError={copyFailed} />}
      {!masked && showOriginal && full !== "failed" && <img className={`confirm-list__image${full === "ready" ? "" : " confirm-list__image--pending"}${privateClass}`}
        src={assetUrl(item.assetId)} alt="" draggable={false}
        decoding="async" onLoad={decoded(setFull)} onError={() => setFull("failed")} />}
      {box && !masked && <span className="confirm-list__crop" role="img" aria-label={`${item.targetName} 감지 영역`} style={{
        left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%`,
      }} />}
    </div>
    {copy === "failed" && <figcaption className="confirm-list__image-note" role="status">원본을 불러오지 못해 축소 이미지를 표시합니다.</figcaption>}
    {copy !== "failed" && showOriginal && full === "failed" && <figcaption className="confirm-list__image-note" role="status">원본을 불러오지 못해 낮춘 화질로 표시합니다.</figcaption>}
  </figure>;
}
