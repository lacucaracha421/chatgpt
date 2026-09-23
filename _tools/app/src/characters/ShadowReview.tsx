import { useCallback, useEffect, useRef, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "../shared/ui/Button";
import { Dialog } from "../shared/ui/Dialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { assetUrl, thumbnailUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import { characterApi, type CharacterApi, type DecisionKind } from "./api";
import { emptyShadowSummary, nativeOutcomeLabel, shadowItemKey, shadowReviewApi, verdictLabel, type ShadowBackfillStatus, type ShadowReviewApi, type ShadowReviewItem, type ShadowReviewSummary } from "./shadowReviewApi";
import "./ShadowReview.css";

const PAGE_SIZE = 40;
const REFILL_BELOW = 5;

type Props = {
  onClose: () => void;
  /** Called after a judgment is stored so galleries can refresh. */
  onChanged?: () => void;
  privacyMode?: boolean;
  api?: ShadowReviewApi;
  decisions?: Pick<CharacterApi, "decide">;
};

type Judgment = { item: ShadowReviewItem; decision: Extract<DecisionKind, "accepted" | "rejected"> };

function adjust(summary: ShadowReviewSummary, item: ShadowReviewItem, decision: Judgment["decision"], direction: 1 | -1): ShadowReviewSummary {
  const counts = { ...summary[item.verdict] };
  counts.pending -= direction;
  counts[decision] += direction;
  const originCounts = { ...summary.byOrigin[item.origin][item.verdict] };
  originCounts.pending -= direction;
  originCounts[decision] += direction;
  return { ...summary, [item.verdict]: counts, byOrigin: { ...summary.byOrigin,
    [item.origin]: { ...summary.byOrigin[item.origin], [item.verdict]: originCounts } } };
}

/**
 * One shadow candidate at a time. Every judgment is an ordinary manual decision
 * through `record_character_decisions`; history scoring is explicit and cancellable.
 */
export function ShadowReview({ onClose, onChanged, privacyMode = false, api = shadowReviewApi, decisions = characterApi }: Props) {
  const [queue, setQueue] = useState<ShadowReviewItem[]>([]);
  const [summary, setSummary] = useState<ShadowReviewSummary>(emptyShadowSummary);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [last, setLast] = useState<Judgment | null>(null);
  const [reload, setReload] = useState(0);
  const [backfill, setBackfill] = useState<ShadowBackfillStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const wasRunning = useRef(false);
  const skipped = useRef(new Set<string>());
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const loadingRef = useRef(false);
  const reloadQueued = useRef(false);

  const load = useCallback(async (reset: boolean) => {
    if (loadingRef.current) { reloadQueued.current ||= reset; return; }
    loadingRef.current = true;
    setLoading(true); setError(null);
    try {
      const offset = reset ? 0 : queueRef.current.length + skipped.current.size;
      const page = await api.page({ offset, limit: PAGE_SIZE });
      const known = new Set((reset ? [] : queueRef.current).map(shadowItemKey));
      const fresh = page.items.filter(item => { const key = shadowItemKey(item); return !skipped.current.has(key) && !known.has(key); });
      setQueue(previous => reset ? fresh : [...previous, ...fresh]);
      setSummary(page.summary);
      // A page with nothing new means the order shifted under us; stop refilling until a reload.
      setHasMore(page.nextOffset !== null && fresh.length > 0);
    } catch (e) {
      setError(commandErrorMessage(e, "S36 확인 목록을 불러오지 못했습니다."));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      if (reloadQueued.current) { reloadQueued.current = false; setReload(value => value + 1); }
    }
  }, [api]);

  useEffect(() => { void load(true); }, [load, reload]);
  useEffect(() => {
    if (!loading && hasMore && queue.length < REFILL_BELOW) void load(false);
  }, [hasMore, load, loading, queue.length]);

  const updateBackfill = useCallback((status: ShadowBackfillStatus) => {
    setBackfill(status);
    if (wasRunning.current && !status.running) setReload(value => value + 1);
    wasRunning.current = status.running;
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const status = await api.status();
        if (!disposed) updateBackfill(status);
      } catch (e) {
        if (!disposed) setBackfillError(commandErrorMessage(e, "채점 상태를 불러오지 못했습니다."));
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 1000);
      }
    }
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [api, updateBackfill]);

  async function startBackfill() {
    if (starting || backfill?.running) return;
    setStarting(true); setBackfillError(null);
    wasRunning.current = true;
    try { updateBackfill(await api.start()); }
    catch (e) { setBackfillError(commandErrorMessage(e, "기존 이미지 채점을 시작하지 못했습니다.")); }
    finally { setStarting(false); }
  }
  async function cancelBackfill() {
    try { updateBackfill(await api.cancel()); }
    catch (e) { setBackfillError(commandErrorMessage(e, "채점을 취소하지 못했습니다.")); }
  }
  function originStats(tier: "automatic" | "recommended") {
    const old = summary.byOrigin.backfill[tier], live = summary.byOrigin.live[tier];
    return <small> · 기존 {old.accepted}/{old.accepted + old.rejected} · 신규 {live.accepted}/{live.accepted + live.rejected}</small>;
  }
  const backfillButton = <Button size="sm" disabled={starting || backfill?.running} onClick={() => void startBackfill()}>기존 이미지 채점</Button>;

  const current = queue[0];
  const next = queue[1];
  useEffect(() => {
    if (!next || privacyMode) return;
    const image = new Image();
    image.src = assetUrl(next.assetId);
  }, [next, privacyMode]);

  async function judge(decision: Judgment["decision"]) {
    if (!current || busy) return;
    setBusy(true); setDecisionError(null);
    try {
      await decisions.decide({ targetId: current.targetId, expectedFingerprint: current.targetFingerprint, assetIds: [current.assetId], decision, baselineFingerprint: null, scanId: null });
      setQueue(previous => previous.filter(item => item !== current));
      setSummary(previous => adjust(previous, current, decision, 1));
      setLast({ item: current, decision });
      onChanged?.();
    } catch (e) {
      setDecisionError(commandErrorMessage(e, "판단을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    if (!last || busy) return;
    setBusy(true); setDecisionError(null);
    try {
      await decisions.decide({ targetId: last.item.targetId, expectedFingerprint: last.item.targetFingerprint, assetIds: [last.item.assetId], decision: "cleared", baselineFingerprint: null, scanId: null });
      setQueue(previous => [last.item, ...previous.filter(item => shadowItemKey(item) !== shadowItemKey(last.item))]);
      setSummary(previous => adjust(previous, last.item, last.decision, -1));
      setLast(null);
      onChanged?.();
    } catch (e) {
      setDecisionError(commandErrorMessage(e, "판단을 되돌리지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }
  function skip() {
    if (!current || busy) return;
    skipped.current.add(shadowItemKey(current));
    setDecisionError(null);
    setQueue(previous => previous.filter(item => item !== current));
  }
  function restoreSkipped() {
    skipped.current.clear();
    setReload(value => value + 1);
  }

  const remaining = summary.automatic.pending + summary.recommended.pending;
  const automaticJudged = summary.automatic.accepted + summary.automatic.rejected;
  const recommendedJudged = summary.recommended.accepted + summary.recommended.rejected;

  return <Dialog open variant="fullscreen" title="S36 확인" onClose={onClose}
    onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "arrowright" || key === "d") { event.preventDefault(); void judge("accepted"); }
      else if (key === "arrowleft" || key === "a") { event.preventDefault(); void judge("rejected"); }
      else if (key === "arrowdown" || key === "s") { event.preventDefault(); skip(); }
      else if (key === "z") { event.preventDefault(); void undo(); }
    }}>
    <section className="shadow-review" aria-label="S36 확인">
      <header className="shadow-review__header">
        <h2>S36 확인</h2>
        <dl className="shadow-review__stats" aria-label="진행 상황">
          <div><dt>남은 항목</dt><dd>{remaining.toLocaleString()}</dd></div>
          <div><dt>자동 후보 정확도</dt><dd>{summary.automatic.accepted}/{automaticJudged}{originStats("automatic")}</dd></div>
          <div><dt>추천 수락</dt><dd>{summary.recommended.accepted}/{recommendedJudged}{originStats("recommended")}</dd></div>
        </dl>
        {backfillButton}
        <Button size="icon" variant="ghost" aria-label="S36 확인 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>
      </header>
      {(starting || backfill?.running || (backfill?.total ?? 0) > 0 || backfill?.cancelled) && <div className="shadow-review__backfill" role="status">
        {starting || backfill?.preparing ? "기존 이미지 확인 중…" : `기존 이미지 채점 ${backfill?.scored ?? 0} / ${backfill?.total ?? 0} · 건너뜀 ${backfill?.skipped ?? 0}`}
        {backfill?.cancelled && " · 취소됨"}
        {backfill?.running && <Button size="sm" variant="ghost" onClick={() => void cancelBackfill()}>채점 취소</Button>}
      </div>}
      {(backfillError || backfill?.error) && <p className="character-message shadow-review__notice" role="alert">{backfillError || backfill?.error}</p>}
      {error
        ? <p className="character-message shadow-review__notice" role="alert">{error}<Button size="sm" onClick={() => setReload(value => value + 1)}>다시 시도</Button></p>
        : current
          ? <div className="shadow-review__body">
            <ReviewImage key={shadowItemKey(current)} item={current} privacyMode={privacyMode} />
            <aside className="shadow-review__panel" aria-label="후보 정보">
              <div className="shadow-review__verdict">
                <span className={`shadow-review__badge shadow-review__badge--${current.verdict}`}>{verdictLabel(current.verdict)}</span>
                <small>knn3 {current.knn3 === null ? "—" : current.knn3.toFixed(4)}</small>
              </div>
              <h3 className="shadow-review__character">{current.targetName}</h3>
              {current.referenceAssetIds.length > 0 && <ul className="shadow-review__references" aria-label={`${current.targetName} 레퍼런스`}>
                {current.referenceAssetIds.map(id => <li key={id}><img src={thumbnailUrl(id)} alt="" className={privacyMode ? "character-private" : undefined} loading="lazy" /></li>)}
              </ul>}
              <p className="shadow-review__meta">기존 판정 {nativeOutcomeLabel(current.nativeOutcome)}<span aria-hidden="true"> · </span>{current.originalName}</p>
              <div className="shadow-review__actions">
                <Button variant="primary" disabled={busy} onClick={() => void judge("accepted")}>맞음 <kbd>→</kbd><kbd>D</kbd></Button>
                <Button disabled={busy} onClick={() => void judge("rejected")}>아님 <kbd>←</kbd><kbd>A</kbd></Button>
                <Button variant="ghost" disabled={busy} onClick={skip}>건너뛰기 <kbd>↓</kbd><kbd>S</kbd></Button>
              </div>
              {last && <Button className="shadow-review__undo" size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>되돌리기: {last.item.targetName} {last.decision === "accepted" ? "맞음" : "아님"} <kbd>Z</kbd></Button>}
              {decisionError && <p className="character-message" role="alert">{decisionError}</p>}
            </aside>
          </div>
          : loading
            ? <p className="character-message shadow-review__notice" role="status">불러오는 중…</p>
            : skipped.current.size > 0
              ? <EmptyState title="건너뛴 항목만 남았습니다"><Button size="sm" onClick={restoreSkipped}>건너뛴 항목 다시 보기</Button></EmptyState>
              : <EmptyState title="확인할 항목이 없습니다">
                <p className="shadow-review__empty-copy">새 이미지가 채점되면 여기에 나타납니다. 설정 → 일반의 S36 시험 채점이 켜져 있어야 합니다.</p>
                {last && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>되돌리기: {last.item.targetName} {last.decision === "accepted" ? "맞음" : "아님"} <kbd>Z</kbd></Button>}
                {decisionError && <p className="character-message" role="alert">{decisionError}</p>}
                {backfillButton}
                <Button size="sm" onClick={() => setReload(value => value + 1)}>다시 불러오기</Button>
              </EmptyState>}
    </section>
  </Dialog>;
}

/** Thumbnail first, original once it has loaded; a failed original keeps the thumbnail. */
function ReviewImage({ item, privacyMode }: { item: ShadowReviewItem; privacyMode: boolean }) {
  const [original, setOriginal] = useState<"loading" | "ready" | "failed">("loading");
  const alt = `${item.originalName} — ${item.targetName} 후보`;
  return <figure className="shadow-review__figure">
    {original !== "ready" && <img className={`shadow-review__image${privacyMode ? " character-private" : ""}`} src={thumbnailUrl(item.assetId)} alt={alt} draggable={false} />}
    {original !== "failed" && <img className={`shadow-review__image${original === "ready" ? "" : " shadow-review__image--pending"}${privacyMode ? " character-private" : ""}`}
      src={assetUrl(item.assetId)} alt={original === "ready" ? alt : ""} draggable={false}
      onLoad={() => setOriginal("ready")} onError={() => setOriginal("failed")} />}
    {original === "failed" && <figcaption className="shadow-review__image-note" role="status">원본을 불러오지 못해 축소 이미지를 표시합니다.</figcaption>}
  </figure>;
}
