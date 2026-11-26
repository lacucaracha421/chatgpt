import { AssetImage } from "../../privacy/AssetImage";
import { FilmIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "../../assets/assetMetadata";
import { thumbnailUrl } from "../../assets/mediaUrl";
import { commandErrorMessage } from "../../library/errorMessage";
import type { AssetSummary } from "../../library/types";
import { ViewToolbar } from "../../layout/ViewToolbar";
import { usePrivacy } from "../../privacy/PrivacyContext";
import { displayDuration } from "../../shared/displayDate";
import { Badge } from "../../shared/ui/Badge";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Skeleton } from "../../shared/ui/Skeleton";
import { Toast } from "../../shared/ui/Toast";
import { VideoPlayer } from "../../video/VideoPlayer";
import { videoSimilarityApi, type VideoDecision, type VideoReview, type VideoScanProgress, type VideoSimilarityApi } from "./client";
import "./VideoSimilarity.css";

type Props = { assetIds: string[]; onClose(): void; api?: VideoSimilarityApi };
const running = (scan: VideoScanProgress | null) => scan?.state === "queued" || scan?.state === "running";
const resumable = (scan: VideoScanProgress | null) => ["paused", "cancelled", "failed"].includes(scan?.state ?? "");
const stateLabels: Record<string, string> = { queued: "대기", running: "분석 중", paused: "일시 중지", cancelled: "중지됨", failed: "실패", completed: "완료" };
const reasonLabels: Record<string, string> = { interrupted: "앱 종료로 중단됨", cancelled: "사용자가 중지함", timeout: "처리 시간 초과", tool_unavailable: "영상 처리 도구를 찾을 수 없음", source_changed: "원본 파일이 변경됨", processing_failed: "영상 처리 실패", database_failed: "분석 기록 저장 실패", unsupported_geometry: "지원하지 않는 화면 크기", capacity_reached: "분석 저장 한도 도달", insufficient_evidence: "비교할 프레임이 부족함" };

export function VideoSimilarityPanel({ assetIds, onClose, api = videoSimilarityApi }: Props) {
  const [scan, setScan] = useState<VideoScanProgress | null>(null);
  const [review, setReview] = useState<VideoReview | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const pendingRef = useRef(false);
  const scanRef = useRef<VideoScanProgress | null>(null);
  const scanOperation = useRef(0);
  const listOperation = useRef(0);

  const acceptScan = useCallback((next: VideoScanProgress) => {
    scanRef.current = next;
    setScan(next);
  }, []);

  const load = useCallback(async (epoch: number) => {
    const operation = ++listOperation.current;
    const page = await api.list();
    if (generation.current !== epoch || operation !== listOperation.current) return;
    setReview(page.items[0] ?? null);
    setTotal(page.totalCount);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    const epoch = ++generation.current;
    setLoading(true);
    void load(epoch).catch((error: unknown) => {
      if (generation.current !== epoch) return;
      setMessage(commandErrorMessage(error, "영상 검토 목록을 불러오지 못했습니다."));
      setLoading(false);
    });
    const operation = scanOperation.current;
    void api.latest().then((next) => {
      if (next && generation.current === epoch && operation === scanOperation.current) acceptScan(next);
    }).catch((error: unknown) => {
      if (generation.current === epoch && operation === scanOperation.current) setMessage(commandErrorMessage(error, "이전 영상 분석을 불러오지 못했습니다."));
    });
    return () => { generation.current += 1; };
  }, [acceptScan, api, load]);

  useEffect(() => {
    if (!scan || !running(scan)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const epoch = generation.current;
    async function poll() {
      const operation = scanOperation.current;
      try {
        const next = await api.get(scan!.id);
        if (disposed || epoch !== generation.current) return;
        // A cancel or resume response must not be overwritten by an older poll.
        if (!pendingRef.current && operation === scanOperation.current) {
          acceptScan(next);
          await load(epoch);
        }
      } catch (error) {
        if (!disposed && epoch === generation.current && operation === scanOperation.current) setMessage(commandErrorMessage(error, "분석 상태를 확인하지 못했습니다."));
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1200);
    }
    timer = setTimeout(() => void poll(), 1200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [acceptScan, api, load, scan?.id, scan?.state]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !pendingRef.current) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  async function act(action: () => Promise<void>) {
    if (pendingRef.current) return;
    const epoch = generation.current;
    pendingRef.current = true;
    listOperation.current += 1;
    setPending(true);
    setMessage(null);
    try { await action(); }
    catch (error) {
      if (epoch === generation.current) setMessage(commandErrorMessage(error, "요청을 처리하지 못했습니다."));
    } finally {
      if (epoch === generation.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  function control(kind: "start" | "resume" | "cancel") {
    const epoch = generation.current;
    void act(async () => {
      scanOperation.current += 1;
      const next = kind === "start" ? await api.start(assetIds) : kind === "resume" ? await api.resume(scanRef.current!.id) : await api.cancel(scanRef.current!.id);
      if (generation.current === epoch) { acceptScan(next); await load(epoch); }
    });
  }

  function decide(decision: VideoDecision) {
    if (!review) return;
    const epoch = generation.current;
    void act(async () => {
      try { await api.decide(review.id, decision); }
      catch (error) {
        const message = commandErrorMessage(error, "영상 검토를 저장하지 못했습니다.");
        throw new Error(message === "영상 분석을 완료하지 못했습니다."
          ? "원본 영상 확인 중단·시간 초과 · 검토 유지됨 · 다시 시도 필요"
          : message);
      }
      await load(epoch);
    });
  }

  const processed = scan ? scan.completed + scan.failed + scan.skipped : 0;
  const leftPixels = review ? review.left.width * review.left.height : 0;
  const rightPixels = review ? review.right.width * review.right.height : 0;

  return <section className="similarity-review video-similarity" aria-label="유사 영상 검토" onKeyDown={(event) => {
    if (event.key === "Escape" && !event.defaultPrevented && !pendingRef.current) {
      event.preventDefault();
      onClose();
    }
    event.stopPropagation();
  }}>
    <ViewToolbar title="유사 영상 검토" chrome={{ status: total > 0 ? <span>검토 대기 {total.toLocaleString()}쌍</span> : undefined }} actions={<Button size="icon" variant="ghost" aria-label="영상 검토 닫기" disabled={pending} onClick={onClose}><XMarkIcon aria-hidden="true" /></Button>} />
    <div className="video-similarity__scan">
      <div className="video-similarity__scan-status">
        {scan ? <>
          <strong role="status">{stateLabels[scan.state] ?? "상태 확인 필요"} · {processed.toLocaleString()} / {scan.total.toLocaleString()}개 · 후보 {scan.candidateCount.toLocaleString()}쌍{scan.failed > 0 && ` · 실패 ${scan.failed.toLocaleString()}개`}{scan.skipped > 0 && ` · 제외 ${scan.skipped.toLocaleString()}개`}{scan.reason && ` · ${reasonLabels[scan.reason] ?? "분석 중 오류"}`}</strong>
          {scan.total > 0 && (
            <div className="similarity-review__progress" role="progressbar" aria-label="영상 분석 진행률" aria-valuemin={0} aria-valuemax={scan.total} aria-valuenow={processed}>
              <span className="similarity-review__progress-fill" style={{ width: `${Math.min(100, Math.round((processed / scan.total) * 100))}%` }} />
            </div>
          )}
        </> : <p className="video-similarity__scan-hint">선택한 영상 간 프레임 비교 · 한쪽 보관 시 다른 영상 휴지통 이동</p>}
      </div>
      <div className="video-similarity__scan-actions">
        <Button variant={assetIds.length >= 2 && assetIds.length <= 100 ? "primary" : "secondary"} disabled={pending || running(scan) || assetIds.length < 2 || assetIds.length > 100} onClick={() => control("start")}>선택한 영상 {assetIds.length}개 분석</Button>
        {running(scan) && <Button variant="secondary" disabled={pending} onClick={() => control("cancel")}>분석 중지</Button>}
        {resumable(scan) && <Button variant="secondary" disabled={pending} onClick={() => control("resume")}>이전 분석 이어서</Button>}
        <Button variant="quiet" disabled={pending} onClick={() => void act(() => load(generation.current))}>목록 새로고침</Button>
      </div>
    </div>
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    {loading ? <Skeleton className="similarity-review__skeleton" label="유사 영상을 불러오는 중" /> : !review ? <EmptyState icon={FilmIcon} title="검토할 유사 영상 없음">보관함에서 영상 2–100개 선택 후 비교</EmptyState> : <>
      <div className="video-similarity__body">
        <div className="video-similarity__comparison">
          <VideoAssetPanel
            side="왼쪽 영상"
            asset={review.left}
            betterResolution={leftPixels > rightPixels}
            betterBytes={review.left.byteSize > review.right.byteSize}
          />
          <VideoAssetPanel
            side="오른쪽 영상"
            asset={review.right}
            betterResolution={rightPixels > leftPixels}
            betterBytes={review.right.byteSize > review.left.byteSize}
          />
        </div>
        <details className="video-similarity__evidence">
          <summary>
            <span>비교 근거</span>
            <span className="video-similarity__evidence-meta numeric">
              {review.evidence.matchedFrames} / {review.evidence.attemptedFrames}프레임 일치 · 시간 구간 {Math.round(review.evidence.matchingSpanPermille / 10)}% · 유효 프레임 {review.evidence.validFrames}개
            </span>
          </summary>
          <ul className="video-similarity__matches numeric">
            {review.evidence.matches.map((match, index) => (
              <li key={index}>
                <span>{formatTimestamp(match.leftRequestedAtMs)} ↔ {formatTimestamp(match.rightRequestedAtMs)}</span>
                <span className="video-similarity__match-distance">차이 {match.distance}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
      <footer className="video-similarity__actions">
        <p className="video-similarity__action-hint">한쪽 보관 시 다른 영상 휴지통 이동 · 결정 전 원본 유지</p>
        <div className="video-similarity__buttons">
          <Button variant="secondary" disabled={pending} onClick={() => decide("keep_left")}>왼쪽 보관 · 오른쪽 휴지통</Button>
          <Button variant="secondary" disabled={pending} onClick={() => decide("keep_right")}>오른쪽 보관 · 왼쪽 휴지통</Button>
          <Button variant="secondary" disabled={pending} onClick={() => decide("keep_both")}>둘 다 보관</Button>
          <Button variant="ghost" disabled={pending} onClick={() => decide("not_similar")}>다른 영상</Button>
        </div>
      </footer>
    </>}
  </section>;
}

function formatTimestamp(ms: number) { return displayDuration(ms) || `${(ms / 1000).toFixed(1)}초`; }
function VideoAssetPanel({ side, asset, betterResolution, betterBytes }: { side: string; asset: AssetSummary; betterResolution: boolean; betterBytes: boolean }) {
  const { privacyMode } = usePrivacy();
  const duration = asset.media.kind === "video" ? displayDuration(asset.media.durationMs) : "";
  return <section className="video-similarity__asset" aria-label={side}>
    <div className="video-similarity__preview">
      <Badge variant="scrim" className="video-similarity__side-badge">{side}</Badge>
      {privacyMode ? <Skeleton className="privacy-mask video-similarity__preview-mask" label="비공개 모드" /> : asset.media.kind === "video" && asset.media.preparationState === "ready" ? <VideoPlayer key={asset.id} asset={{ ...asset, media: asset.media }} /> : <AssetImage src={thumbnailUrl(asset.id)} alt={side} />}
    </div>
    <h3 className="video-similarity__title">{asset.title || asset.originalName}</h3>
    <dl className="video-similarity__meta numeric">
      <div data-favoured={betterResolution || undefined}><dt>해상도</dt><dd>{asset.width.toLocaleString()} × {asset.height.toLocaleString()}</dd></div>
      <div data-favoured={betterBytes || undefined}><dt>파일 크기</dt><dd>{formatBytes(asset.byteSize)}</dd></div>
      {asset.media.kind === "video" && <div><dt>재생 시간</dt><dd>{duration || "알 수 없음"}</dd></div>}
    </dl>
    {!privacyMode && asset.media.kind === "video" && asset.media.preparationState !== "ready" && <p className="video-similarity__preparing">재생 준비 완료 후 확인 가능</p>}
  </section>;
}
