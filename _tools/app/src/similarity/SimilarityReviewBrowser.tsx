import { BusyLabel } from "../shared/ui/BusyLabel";
import { AssetImage } from "../privacy/AssetImage";
import { useCallback, useEffect, useRef, useState } from "react";
import { SimilarityClues } from "./SimilarityClues";
import { assetClueSide, choiceLabel, EMPTY_CLUES, reasonSentence, sideNames, SIMILARITY_CHOICES } from "./clues";
import { Badge } from "../shared/ui/Badge";
import { assetUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import type { ImageSimilarityScan, LibraryGateway, SimilarityDecision, SimilarityReviewAsset, SimilarityReviewSummary } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useAssetMask, usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { VideoSimilarityPanel } from "./video/VideoSimilarityPanel";
import { SIMILARITY_REVIEW_CHANGED_EVENT } from "./useSimilarityReviewInbound";

type Props = {
  gateway: LibraryGateway;
  onCountChange(count: number): void;
  onClose(): void;
  videoAssetIds?: string[];
};

const NO_VIDEO_SELECTION: string[] = [];

export function SimilarityReviewBrowser({ videoAssetIds = NO_VIDEO_SELECTION, ...props }: Props) {
  const [mode, setMode] = useState<"image" | "video">(videoAssetIds.length >= 2 ? "video" : "image");
  return <div className="similarity-review-workspace">
    <nav className="similarity-review-workspace__tabs" aria-label="검토 미디어">
      <Button variant={mode === "image" ? "secondary" : "ghost"} aria-pressed={mode === "image"} onClick={() => setMode("image")}>이미지</Button>
      <Button variant={mode === "video" ? "secondary" : "ghost"} aria-pressed={mode === "video"} onClick={() => setMode("video")}>영상</Button>
    </nav>
    {mode === "video" ? <VideoSimilarityPanel assetIds={videoAssetIds} onClose={props.onClose} /> : <ImageSimilarityReviewBrowser {...props} />}
  </div>;
}

function ImageSimilarityReviewBrowser({ gateway, onCountChange, onClose }: Props) {
  const [review, setReview] = useState<SimilarityReviewSummary | null>(null);
  const reviewRef = useRef<SimilarityReviewSummary | null>(null);
  const [staged, setStaged] = useState<{review: SimilarityReviewSummary; count: number; generation: number} | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [initialTotal, setInitialTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [scan, setScan] = useState<ImageSimilarityScan | null | undefined>(undefined);
  const [scanRunning, setScanRunning] = useState(false);
  const scanCancelled = useRef(false);
  useEffect(() => {
    const cancel = () => { scanCancelled.current = true; };
    window.addEventListener("lakomics:cancel-user-scans", cancel);
    return () => window.removeEventListener("lakomics:cancel-user-scans", cancel);
  }, []);
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setStaged(null);
    setMessage(null);
    try {
      const page = await gateway.listSimilarityReviews({ after: null, limit: 1 });
      if (generation !== generationRef.current) return;
      const next = page.items[0] ?? null;
      if (reviewRef.current && next && next.id !== reviewRef.current.id) {
        setStaged({ review: next, count: page.totalCount, generation });
        return;
      }
      setStaged(null);
      setReview(next);
      reviewRef.current = next;
      setTotalCount(page.totalCount);
      setInitialTotal((current) => Math.max(current, page.totalCount));
      onCountChange(page.totalCount);
    } catch (error) {
      if (generation === generationRef.current) {
        setMessage(commandErrorMessage(error, "유사 이미지 검토 목록을 불러오지 못했습니다."));
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [gateway, onCountChange]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; generationRef.current += 1; };
  }, [load]);

  // Decisions made on a phone and applied here resolve pairs underneath this screen.
  const pendingRef = useRef(false);
  pendingRef.current = pending;
  useEffect(() => {
    const reload = () => { if (!pendingRef.current) void load(); };
    window.addEventListener(SIMILARITY_REVIEW_CHANGED_EVENT, reload);
    return () => window.removeEventListener(SIMILARITY_REVIEW_CHANGED_EVENT, reload);
  }, [load]);

  useEffect(() => {
    let active = true;
    if (!gateway.getImageSimilarityScan) {
      setScan(null);
      return () => { active = false; };
    }
    void gateway.getImageSimilarityScan()
      .then((value) => { if (active) setScan(value); })
      .catch((error) => {
        if (!active) return;
        setScan(null);
        setMessage(commandErrorMessage(error, "기존 보관함 검사 상태를 불러오지 못했습니다."));
      });
    return () => { active = false; };
  }, [gateway]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, pending]);

  async function decide(decision: SimilarityDecision) {
    if (!review || pending) return;
    setPending(true);
    setMessage(null);
    try {
      await gateway.decideSimilarityReview({ reviewId: review.id, decision });
      if (!mountedRef.current) return;
      await load();
    } catch (error) {
      if (mountedRef.current) setMessage(commandErrorMessage(error, "선택을 저장하지 못했습니다. 다시 시도해 주세요."));
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  async function runHistoricalScan() {
    if (scanRunning || !gateway.startImageSimilarityScan || !gateway.runImageSimilarityScanBatch) return;
    scanCancelled.current = false;
    setScanRunning(true);
    setMessage(null);
    try {
      let current = scan && !scan.completed ? scan : await gateway.startImageSimilarityScan();
      if (!mountedRef.current) return;
      setScan(current);
      while (mountedRef.current && !scanCancelled.current && !current.completed) {
        current = await gateway.runImageSimilarityScanBatch(current.id);
        if (!mountedRef.current) return;
        setScan(current);
      }
      if (mountedRef.current) await load();
    } catch (error) {
      if (mountedRef.current) {
        setMessage(commandErrorMessage(error, "기존 보관함 유사 이미지 검사를 이어가지 못했습니다."));
      }
    } finally {
      if (mountedRef.current) setScanRunning(false);
    }
  }

  const current = initialTotal > 0 ? initialTotal - totalCount + 1 : 0;
  const names = sideNames(review?.historical ?? false);
  const sides = review ? [assetClueSide(review.existing.asset, review.existing.accountRole, review.existing.format), assetClueSide(review.candidate.asset, review.candidate.accountRole, review.candidate.format)] as const : null;
  const recommended = review?.recommendedAssetId === review?.existing.asset.id ? "a" : review?.recommendedAssetId === review?.candidate.asset.id ? "b" : null;
  const promote = () => {
    if (!staged || staged.generation !== generationRef.current) return;
    reviewRef.current = staged.review;
    setReview(staged.review); setTotalCount(staged.count); onCountChange(staged.count); setStaged(null);
  };
  return <section className="similarity-review" aria-label="유사 이미지 검토" onKeyDown={(event) => event.stopPropagation()}>
    <ViewToolbar
      title="유사 이미지 검토"
      chrome={{ status: review && initialTotal > 0 ? <span>{current} / {initialTotal}</span> : undefined }}
    />
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    {gateway.startImageSimilarityScan && gateway.runImageSimilarityScanBatch && <HistoricalScanStatus
      scan={scan}
      running={scanRunning}
      onRun={() => void runHistoricalScan()}
    />}
    {loading && !review ? <Skeleton className="similarity-review__skeleton" label="유사 이미지를 불러오는 중" /> : !review ? (
      <EmptyState title="검토할 유사 이미지가 없습니다">새 이미지가 들어오면 여기에 표시됩니다.</EmptyState>
    ) : <>
      <div className="similarity-review__pairs">
        {[review, ...(staged ? [staged.review] : [])].map(pair => <ReviewPair key={pair.id} review={pair} visible={pair.id === review.id} onReady={pair.id === staged?.review.id ? promote : undefined} />)}
      </div>
      <footer className="similarity-review__actions">
        {review.clues !== undefined && sides && <p className="similarity-review__reason" data-none={!review.reason || undefined}>{reasonSentence(review.reason ?? null, review.clues ?? EMPTY_CLUES, names, [...sides])}</p>}
        <p className="similarity-review__action-hint">{review.historical
          ? "유지하지 않은 이미지는 휴지통으로 이동합니다. 결정 전에는 원본을 변경하지 않습니다."
          : "기존 이미지 유지 시 새 이미지는 영구 삭제됩니다. 교체 시 기존 이미지는 휴지통으로 이동합니다."}</p>
        <div className="similarity-review__buttons">{SIMILARITY_CHOICES.map(choice => {
          const primary = (choice.decision === "keep_existing" && recommended === "a") || (choice.decision === "replace_existing" && recommended === "b");
          return <Button key={choice.decision} variant={primary ? "primary" : "secondary"} aria-description={primary ? "권장" : undefined} disabled={pending || loading || !!staged} onClick={() => void decide(choice.decision)}>{choiceLabel(choice.decision, review.historical)}</Button>;
        })}</div>
      </footer>
    </>}
  </section>;
}

function HistoricalScanStatus({ scan, running, onRun }: {
  scan: ImageSimilarityScan | null | undefined;
  running: boolean;
  onRun(): void;
}) {
  const detail = scan === undefined
    ? ""
    : scan === null
      ? "저장된 이미지끼리 비교해 기존 유사 항목을 찾습니다."
      : scan.completed
        ? `검사 완료 · 검토 ${scan.reviewsCreated.toLocaleString()}건 발견`
        : `${running ? "검사 중" : "일시 중지"} · ${scan.comparedPairs.toLocaleString()} / ${scan.totalPairs.toLocaleString()}쌍`;
  const action = scan && !scan.completed ? "검사 이어가기" : scan?.completed ? "다시 검사" : "기존 보관함 검사";
  return <section className="similarity-review__scan" aria-label="기존 보관함 유사 이미지 검사">
    <div>
      <strong><BusyLabel busy={scan === undefined} idle={detail}>검사 상태 확인 중</BusyLabel></strong>
      {scan && <span>{scan.totalAssets.toLocaleString()}개 대상 · 해시 미준비 {scan.skippedAssets.toLocaleString()}개</span>}
      {scan && scan.totalPairs > 0 && <progress value={scan.comparedPairs} max={scan.totalPairs} aria-label="기존 보관함 검사 진행률" />}
    </div>
    <Button variant="secondary" disabled={running || scan === undefined} onClick={onRun}><BusyLabel busy={!!(running)} idle={action}>검사 중</BusyLabel></Button>
  </section>;
}

function ReviewPair({review, visible, onReady}: {review: SimilarityReviewSummary; visible: boolean; onReady?: () => void}) {
  const loaded = useRef(new Set<string>());
  const names = sideNames(review.historical);
  useEffect(() => { if (loaded.current.size === 2) onReady?.(); }, [onReady]);
  const ready = (id: string) => { loaded.current.add(id); if (loaded.current.size === 2) onReady?.(); };
  return <div className="similarity-review__comparison" data-staged={!visible || undefined} aria-hidden={!visible || undefined}>
    <ReviewAssetPanel side={names[0]} position="a" reviewAsset={review.existing} onReady={() => ready(review.existing.asset.id)} />
    <ReviewAssetPanel side={names[1]} position="b" reviewAsset={review.candidate} onReady={() => ready(review.candidate.asset.id)} />
    <SimilarityClues names={names} sides={[assetClueSide(review.existing.asset, review.existing.accountRole, review.existing.format), assetClueSide(review.candidate.asset, review.candidate.accountRole, review.candidate.format)]} clues={review.clues} reason={review.reason} recommended={review.recommendedAssetId === review.existing.asset.id ? "a" : review.recommendedAssetId === review.candidate.asset.id ? "b" : null} />
  </div>;
}

function ReviewAssetPanel({ side, position, reviewAsset, onReady }: { side: string; position: "a" | "b"; reviewAsset: SimilarityReviewAsset; onReady(): void }) {
  const { privacyMode } = usePrivacy();
  const masked = useAssetMask(reviewAsset.asset);
  useEffect(() => { if (privacyMode || masked) onReady(); }, [privacyMode, masked, onReady]);
  const { asset } = reviewAsset;
  return <section className={`similarity-review__preview similarity-review__preview--${position}`} aria-label={side}>
    {privacyMode ? <Skeleton className="privacy-mask similarity-review__preview-mask" label="비공개 모드" /> : <AssetImage asset={asset} src={assetUrl(asset.id)} alt={side} onLoad={event => {
      const image = event.currentTarget;
      if (typeof image.decode === "function") void image.decode().catch(() => {}).then(onReady);
      else onReady();
    }} onError={onReady} />}
    <Badge variant="scrim">{side}</Badge>
  </section>;
}
