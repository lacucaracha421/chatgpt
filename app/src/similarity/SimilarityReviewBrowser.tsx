import { XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, localDate, sourceLabel } from "../assets/assetMetadata";
import { assetUrl } from "../assets/mediaUrl";
import { commandErrorMessage } from "../library/errorMessage";
import type { LibraryGateway, SimilarityDecision, SimilarityReviewAsset, SimilarityReviewSummary } from "../library/types";
import { ViewToolbar } from "../layout/ViewToolbar";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { VideoSimilarityPanel } from "./video/VideoSimilarityPanel";

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

  const current = initialTotal > 0 ? initialTotal - totalCount + 1 : 0;
  return <section className="similarity-review" aria-label="유사 검토" onKeyDown={(event) => event.stopPropagation()}>
    <ViewToolbar
      title="유사 검토"
      children={review && initialTotal > 0 ? <span>{current} / {initialTotal}</span> : undefined}
      actions={<Button size="icon" variant="ghost" aria-label="유사 검토 닫기" onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>}
    />
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    {loading ? <Skeleton className="similarity-review__skeleton" label="유사 이미지를 불러오는 중" /> : !review ? (
      <EmptyState title="검토할 유사 이미지가 없습니다">새 이미지가 들어오면 여기에 표시됩니다.</EmptyState>
    ) : <>
      <div className="similarity-review__comparison">
        <ReviewAssetPanel side="기존 이미지" reviewAsset={review.existing} />
        <ReviewAssetPanel side="새 이미지" reviewAsset={review.candidate} />
      </div>
      <footer className="similarity-review__actions">
        <Button disabled={pending} onClick={() => void decide("keep_existing")}>기존 이미지 유지</Button>
        <Button disabled={pending} onClick={() => void decide("replace_existing")}>새 이미지로 교체</Button>
        <Button variant="secondary" disabled={pending} onClick={() => void decide("keep_both")}>둘 다 보관</Button>
      </footer>
    </>}
  </section>;
}

function ReviewAssetPanel({ side, reviewAsset }: { side: "기존 이미지" | "새 이미지"; reviewAsset: SimilarityReviewAsset }) {
  const { privacyMode } = usePrivacy();
  const { asset, format, classifications } = reviewAsset;
  return <section className="similarity-review__asset" aria-label={side}>
    <div className="similarity-review__preview">{privacyMode ? <Skeleton className="privacy-mask similarity-review__preview-mask" label="비공개 모드" /> : <img src={assetUrl(asset.id)} alt={side} />}</div>
    <h3>{asset.title || asset.originalName}</h3>
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
