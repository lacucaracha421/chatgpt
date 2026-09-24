import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, localDate, sourceLabel } from "../assets/assetMetadata";
import { assetUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import type { ImageSimilarityScan, LibraryGateway, SimilarityDecision, SimilarityReviewAsset, SimilarityReviewSummary } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { usePrivacy } from "../privacy/PrivacyContext";
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
  const [totalCount, setTotalCount] = useState(0);
  const [initialTotal, setInitialTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [scan, setScan] = useState<ImageSimilarityScan | null | undefined>(undefined);
  const [scanRunning, setScanRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setMessage(null);
    try {
      const page = await gateway.listSimilarityReviews({ after: null, limit: 1 });
      if (generation !== generationRef.current) return;
      setReview(page.items[0] ?? null);
      setTotalCount(page.totalCount);
      setInitialTotal((current) => Math.max(current, page.totalCount));
      onCountChange(page.totalCount);
    } catch (error) {
      if (generation === generationRef.current) {
        setMessage(commandErrorMessage(error, "유사 검토 목록을 불러오지 못했습니다."));
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
    setScanRunning(true);
    setMessage(null);
    try {
      let current = scan && !scan.completed ? scan : await gateway.startImageSimilarityScan();
      if (!mountedRef.current) return;
      setScan(current);
      while (mountedRef.current && !current.completed) {
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
  const recommendation = review ? reviewRecommendation(review) : "";
  return <section className="similarity-review" aria-label="유사 검토" onKeyDown={(event) => event.stopPropagation()}>
    <ViewToolbar
      title="유사 검토"
      chrome={{ status: review && initialTotal > 0 ? <span>{current} / {initialTotal}</span> : undefined }}
    />
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    {gateway.startImageSimilarityScan && gateway.runImageSimilarityScanBatch && <HistoricalScanStatus
      scan={scan}
      running={scanRunning}
      onRun={() => void runHistoricalScan()}
    />}
    {loading ? <Skeleton className="similarity-review__skeleton" label="유사 이미지를 불러오는 중" /> : !review ? (
      <EmptyState title="검토할 유사 이미지가 없습니다">새 이미지가 들어오면 여기에 표시됩니다.</EmptyState>
    ) : <>
      <p className="similarity-review__difference">
        {recommendation && <><span>{recommendation}</span> · </>}
        {comparisonSummary(review)}
      </p>
      <div className="similarity-review__comparison">
        <ReviewAssetPanel side={review.historical ? "이미지 A" : "기존 이미지"} reviewAsset={review.existing} />
        <ReviewAssetPanel side={review.historical ? "이미지 B" : "새 이미지"} reviewAsset={review.candidate} />
      </div>
      <footer className="similarity-review__actions">
        <p className="similarity-review__action-hint">{review.historical
          ? "유지하지 않은 이미지는 휴지통으로 이동합니다. 결정 전에는 원본을 변경하지 않습니다."
          : "기존 이미지 유지 시 새 이미지는 영구 삭제됩니다. 교체 시 기존 이미지는 휴지통으로 이동합니다."}</p>
        <Button disabled={pending} onClick={() => void decide("keep_existing")}>{review.historical ? "이미지 A 유지" : "기존 이미지 유지"}</Button>
        <Button disabled={pending} onClick={() => void decide("replace_existing")}>{review.historical ? "이미지 B 유지" : "새 이미지로 교체"}</Button>
        <Button variant="secondary" disabled={pending} onClick={() => void decide("keep_both")}>둘 다 보관</Button>
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
    ? "검사 상태 확인 중"
    : scan === null
      ? "저장된 이미지끼리 비교해 기존 유사 항목을 찾습니다."
      : scan.completed
        ? `검사 완료 · 검토 ${scan.reviewsCreated.toLocaleString()}건 발견`
        : `${running ? "검사 중" : "일시 중지"} · ${scan.comparedPairs.toLocaleString()} / ${scan.totalPairs.toLocaleString()}쌍`;
  const action = scan && !scan.completed ? "검사 이어가기" : scan?.completed ? "다시 검사" : "기존 보관함 검사";
  return <section className="similarity-review__scan" aria-label="기존 보관함 유사 이미지 검사">
    <div>
      <strong>{detail}</strong>
      {scan && <span>{scan.totalAssets.toLocaleString()}개 대상 · 해시 미준비 {scan.skippedAssets.toLocaleString()}개</span>}
      {scan && scan.totalPairs > 0 && <progress value={scan.comparedPairs} max={scan.totalPairs} aria-label="기존 보관함 검사 진행률" />}
    </div>
    <Button variant="secondary" disabled={running || scan === undefined} onClick={onRun}>{running ? "검사 중" : action}</Button>
  </section>;
}

function ReviewAssetPanel({ side, reviewAsset }: { side: string; reviewAsset: SimilarityReviewAsset }) {
  const { privacyMode } = usePrivacy();
  const { asset, format, classifications } = reviewAsset;
  return <section className="similarity-review__asset" aria-label={side}>
    <h3 className="similarity-review__side">{side}</h3>
    <div className="similarity-review__preview">{privacyMode ? <Skeleton className="privacy-mask similarity-review__preview-mask" label="비공개 모드" /> : <img src={assetUrl(asset.id)} alt={side} />}</div>
    <p className="similarity-review__filename">{asset.title || asset.originalName}</p>
    <dl>
      <div><dt>해상도</dt><dd>{asset.width} × {asset.height}</dd></div>
      <div><dt>파일 크기</dt><dd>{formatBytes(asset.byteSize)}</dd></div>
      <div><dt>형식</dt><dd>{format}</dd></div>
      <div><dt>출처</dt><dd>{sourceLabel(asset.sourceUrl)}</dd></div>
      <div><dt>가져온 날짜</dt><dd>{localDate(asset.collectedAt)}</dd></div>
      <div><dt>분류</dt><dd>{classifications.map((entry) => entry.name).join(", ") || "미분류"}</dd></div>
    </dl>
  </section>;
}

function reviewRecommendation(review: SimilarityReviewSummary): string {
  if (!review.historical || !review.recommendedAssetId) return "";
  const side = review.recommendedAssetId === review.existing.asset.id ? "이미지 A" : "이미지 B";
  return `출처 정보가 더 충분한 ${side}를 권장합니다.`;
}

function comparisonSummary(review: SimilarityReviewSummary): string {
  const previous = review.existing.asset;
  const next = review.candidate.asset;
  const resolution = previous.width === next.width && previous.height === next.height
    ? "해상도 동일"
    : `해상도 ${previous.width} × ${previous.height} → ${next.width} × ${next.height}`;
  const bytes = next.byteSize - previous.byteSize;
  const size = bytes === 0 ? "파일 크기 동일" : `새 이미지가 ${formatBytes(Math.abs(bytes))} 더 ${bytes > 0 ? "큼" : "작음"}`;
  return `${resolution} · ${size}`;
}
